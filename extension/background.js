/* eslint-disable no-console */

const nativePort = chrome.runtime.connectNative('org.urish.web_bluetooth.server');
let debugPrints = false;

let requestId = 0;
let requests = {};
async function nativeRequest(cmd, params) {
    return new Promise((resolve, reject) => {
        requests[requestId] = { resolve, reject };
        const msg = Object.assign(params || {}, {
            cmd,
            _id: requestId++,
        });
        if (debugPrints) {
            console.log('Sent native message:', msg);
        }
        nativePort.postMessage(msg);
    });
}

const subscriptions = {};
const devices = {};
nativePort.onMessage.addListener((msg) => {
    if (debugPrints) {
        console.log('Received native message:', msg);
    }
    if (msg._type === 'response' && requests[msg._id]) {
        const { reject, resolve } = requests[msg._id];
        if (msg.error) {
            reject(msg.error);
        } else {
            resolve(msg.result);
        }
        delete requests[msg._id];
    }
    if (msg._type === 'valueChangedNotification') {
        const port = subscriptions[msg.subscriptionId];
        if (port) {
            port.postMessage(msg);
        }
    }
    if (msg._type === 'disconnectEvent') {
        const gattId = msg.device;
        const device = devices[gattId];
        if (device) {
            device.forEach(port => {
                port.postMessage({ event: 'disconnectEvent', device: gattId });
                portsObjects.get(port).devices.delete(gattId);
            });
            delete characteristicCache[gattId];
            delete devices[gattId];
        }
    }
});

let portsObjects = new WeakMap();
const characteristicCache = {};

nativePort.onDisconnect.addListener(() => {
    console.log('Disconnected!', chrome.runtime.lastError.message);
});

function leftPad(s, count, pad) {
    while (s.length < count) {
        s = pad + s;
    }
    return s;
}

function normalizeUuid(uuid, standardUuids = {}) {
    const origUuid = uuid;
    if (standardUuids[uuid]) {
        uuid = standardUuids[uuid];
    }
    if (typeof uuid === 'string' && /^(0x)?[0-9a-f]{1,8}$/.test(uuid)) {
        uuid = parseInt(uuid, 16);
    }
    // 16 or 32 bit GUID
    if (typeof uuid === 'number' && uuid > 0) {
        return `${leftPad(uuid.toString(16), 8, '0')}-0000-1000-8000-00805f9b34fb`;
    }
    if (/^{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}}?$/.test(uuid)) {
        return uuid.replace('{', '').replace('}', '').toLowerCase();
    }
    throw new Error(`Invalid UUID format: ${origUuid}`);
}

function normalizeServiceUuid(uuid) {
    return normalizeUuid(uuid, STANDARD_GATT_SERVICES);
}

function normalizeCharacteristicUuid(uuid) {
    return normalizeUuid(uuid, STANDARD_GATT_CHARACTERISTICS);
}

function windowsServiceUuid(uuid) {
    return '{' + normalizeUuid(uuid, STANDARD_GATT_SERVICES) + '}';
}

function windowsCharacteristicUuid(uuid) {
    return '{' + normalizeUuid(uuid, STANDARD_GATT_CHARACTERISTICS) + '}';
}

let scanningCounter = 0;
function startScanning(port) {
    if (!scanningCounter) {
        nativeRequest('scan');
    }
    portsObjects.get(port).scanCount++;
    scanningCounter++;
}

function stopScanning(port) {
    scanningCounter--;
    portsObjects.get(port).scanCount--;
    if (!scanningCounter) {
        nativeRequest('stopScan');
    }
}

function matchDeviceFilter(filter, device) {
    if (filter.services) {
        const deviceServices = device.serviceUuids.map(normalizeServiceUuid);
        if (!filter.services.map(normalizeServiceUuid).every(uuid => deviceServices.includes(uuid))) {
            return false;
        }
    }
    if (filter.name && filter.name !== device.localName) {
        return false;
    }
    if (filter.namePrefix && (!device.localName || device.localName.indexOf(filter.namePrefix) !== 0)) {
        return false;
    }
    return true;
}

async function requestDevice(port, options) {
    if (!options.filters && !options.acceptAllDevices) {
        // TODO better filters validation, proper error message
        throw new Error('Filters must be provided');
    }

    let deviceNames = {};
    let deviceRssi = {};
    function scanResultListener(msg) {
        if (msg._type === 'scanResult') {
            if (msg.localName) {
                deviceNames[msg.bluetoothAddress] = msg.localName;
            } else {
                msg.localName = deviceNames[msg.bluetoothAddress];
            }
            deviceRssi[msg.bluetoothAddress] = msg.rssi;
            if (options.acceptAllDevices ||
                options.filters.some(filter => matchDeviceFilter(filter, msg))) {
                port.postMessage(msg);
            }
        }
    }

    nativePort.onMessage.addListener(scanResultListener);
    port.postMessage({ _type: 'showDeviceChooser' });
    startScanning(port);
    try {
        const deviceAddress = await new Promise((resolve, reject) => {
            port.onMessage.addListener(msg => {
                if (msg.type === 'WebBluetoothPolyPageToCS') {
                    // This is a message from the page itself, not from the content script.
                    // Therefore, we don't trust it.
                    return;
                }
                if (msg.cmd === 'chooserPair') {
                    resolve(msg.deviceId);
                }
                if (msg.cmd === 'chooserCancel') {
                    reject(new Error('User canceled device chooser'));
                }
            });
        });

        portsObjects.get(port).knownDeviceIds.add(deviceAddress);

        return {
            address: deviceAddress,
            __rssi: deviceRssi[deviceAddress],
            name: deviceNames[deviceAddress],
        };
    } finally {
        stopScanning(port);
        nativePort.onMessage.removeListener(scanResultListener);
    }
}

async function gattConnect(port, address) {
    /* Security measure: make sure this device address has been
       previously returned by requestDevice() */
    if (!portsObjects.get(port).knownDeviceIds.has(address)) {
        throw new Error('Unknown device address');
    }

    const gattId = await nativeRequest('connect', { address: address.replace(/:/g, '') });
    portsObjects.get(port).devices.add(gattId);
    if (!devices[gattId]) {
        devices[gattId] = new Set();
    }
    devices[gattId].add(port);
    return gattId;
}

async function gattDisconnect(port, gattId) {
    portsObjects.get(port).devices.delete(gattId);
    devices[gattId].delete(port);
    if (devices[gattId].size === 0) {
        delete characteristicCache[gattId];
        delete devices[gattId];
        return await nativeRequest('disconnect', { device: gattId });
    }
}

async function getPrimaryService(port, gattId, service) {
    return (await getPrimaryServices(port, gattId, service))[0];
}

async function getPrimaryServices(port, gattId, service) {
    let options = { device: gattId };
    if (service) {
        options.service = windowsServiceUuid(service);
    }
    const services = await nativeRequest('services', options);
    return services.map(normalizeServiceUuid);
}

async function getCharacteristic(port, gattId, service, characteristic) {
    const char = (await getCharacteristics(port, gattId, service, characteristic)).find(() => true);
    if (!char) {
        throw new Error(`Characteristic ${characteristic} not found`);
    }
    return char;
}

async function getCharacteristics(port, gattId, service, characteristic) {
    if (!characteristicCache[gattId]) {
        characteristicCache[gattId] = {};
    }
    if (!characteristicCache[gattId][service]) {
        characteristicCache[gattId][service] = nativeRequest('characteristics', {
            device: gattId,
            service: windowsServiceUuid(service),
        });
    }
    const result = await characteristicCache[gattId][service];
    const characterstics = result.map(c => Object.assign({}, c, { uuid: normalizeCharacteristicUuid(c.uuid) }));
    if (characteristic) {
        return characterstics
            .filter(c => normalizeCharacteristicUuid(c.uuid) == normalizeCharacteristicUuid(characteristic));
    } else {
        return characterstics;
    }
}

async function readValue(port, gattId, service, characteristic) {
    return await nativeRequest('read', {
        device: gattId,
        service: windowsServiceUuid(service),
        characteristic: windowsCharacteristicUuid(characteristic),
    });
}

async function writeValue(port, gattId, service, characteristic, value) {
    if (!(value instanceof Array) || !value.every(item => typeof item === 'number')) {
        throw new Error('Invalid argument: value');
    }

    return await nativeRequest('write', {
        device: gattId,
        service: windowsServiceUuid(service),
        characteristic: windowsCharacteristicUuid(characteristic),
        value,
    });
}

async function writeValueWithResponse(port, gattId, service, characteristic, value) {
    if (!(value instanceof Array) || !value.every(item => typeof item === 'number')) {
        throw new Error('Invalid argument: value');
    }

    return await nativeRequest('write', {
        device: gattId,
        service: windowsServiceUuid(service),
        characteristic: windowsCharacteristicUuid(characteristic),
        value,
    });
}

async function writeValueWithoutResponse(port, gattId, service, characteristic, value) {
    if (!(value instanceof Array) || !value.every(item => typeof item === 'number')) {
        throw new Error('Invalid argument: value');
    }

    return await nativeRequest('write', {
        device: gattId,
        service: windowsServiceUuid(service),
        characteristic: windowsCharacteristicUuid(characteristic),
        value,
    });
}

async function startNotifications(port, gattId, service, characteristic) {
    const subscriptionId = await nativeRequest('subscribe', {
        device: gattId,
        service: windowsServiceUuid(service),
        characteristic: windowsCharacteristicUuid(characteristic),
    });

    subscriptions[subscriptionId] = port;
    portsObjects.get(port).subscriptions.add(subscriptionId);
    return subscriptionId;
}

async function stopNotifications(port, gattId, service, characteristic) {
    const subscriptionId = await nativeRequest('unsubscribe', {
        device: gattId,
        service: windowsServiceUuid(service),
        characteristic: windowsCharacteristicUuid(characteristic),
    });

    delete subscriptions[subscriptionId];
    portsObjects.get(port).subscriptions.delete(subscriptionId);
    return subscriptionId;
}

const exportedMethods = {
    requestDevice,
    gattConnect,
    gattDisconnect,
    getPrimaryService,
    getPrimaryServices,
    getCharacteristic,
    getCharacteristics,
    readValue,
    writeValue,
    startNotifications,
    stopNotifications,
};

chrome.runtime.onConnect.addListener((port) => {
    portsObjects.set(port, {
        scanCount: 0,
        devices: new Set(),
        subscriptions: new Set(),
        knownDeviceIds: new Set(),
    });

    port.onDisconnect.addListener(() => {
        for (let gattDevice of portsObjects.get(port).devices.values()) {
            gattDisconnect(port, gattDevice);
        }
        while (portsObjects.get(port).scanCount > 0) {
            stopScanning(port);
        }
    });

    port.onMessage.addListener((request) => {
        function sendResponse(response) {
            port.postMessage(Object.assign(response, { id: request.id, origin: request.origin }));
        }
        if (!request.command) {
            sendResponse({ error: 'Missing `command`' });
        }
        if (!(request.args instanceof Array)) {
            sendResponse({ error: '`args` must be an array' });
        }
        const fn = exportedMethods[request.command];
        if (fn) {
            fn(port, ...request.args)
                .then(result => sendResponse({ result }))
                .catch(error => sendResponse({ error: error.toString() }));
            return true;
        } else {
            sendResponse({ error: 'Unknown command: ' + request.command });
        }
    });
});

nativeRequest('ping').then(() => {
    console.log('Connected to server');
});
