// ThermoPro TP350 / TP350S -> synthetic BTHome v2 -> ioBroker Shelly adapter
//
// Repository: shelly-tp350-iobroker-gateway
//
// The script listens for TP350-family BLE advertisements, decodes temperature
// and humidity from ThermoPro manufacturer data, converts the measurements to
// BTHome v2, and publishes them to the MQTT BLE event topic consumed by the
// ioBroker Shelly adapter.

const CONFIG = {
    // Must match the script version required by your ioBroker.shelly adapter.
    // See README.md. v1.2 is the version used for the initial field test.
    ioBrokerShellyScriptVersion: '1.2',

    // Publish a changed value at most once during this interval.
    minChangeIntervalSeconds: 10,

    // Republish unchanged values periodically so receiver/RSSI timestamps stay fresh.
    heartbeatIntervalSeconds: 60,

    // Emit one compact gateway/sensor diagnostic summary at this interval.
    // This is intentionally much quieter than the raw BLE sniffer.
    diagnostics: true,
    diagnosticIntervalSeconds: 60,

    // Emit one line for every successful TP350 MQTT publication.
    debug: false
};

let SHELLY_ID = undefined;
let sensors = {};


function nowSeconds() {
    return Shelly.getUptimeMs() / 1000;
}


function byteToHex(value) {
    return ('00' + (value & 0xff).toString(16)).slice(-2);
}


function isTP350Name(name) {
    return (
        typeof name === 'string' &&
        name.indexOf('TP350') === 0
    );
}


function decodeTP350(result) {
    if (
        !isTP350Name(result.local_name) ||
        typeof result.manufacturer_data === 'undefined' ||
        result.manufacturer_data === null
    ) {
        return null;
    }

    let keys = Object.keys(result.manufacturer_data);

    for (let i = 0; i < keys.length; i++) {
        let originalKey = keys[i];
        let key = originalKey.toLowerCase();

        // Observed TP350 manufacturer frame starts with 0xC2.
        // Shelly exposes the first two manufacturer bytes as a little-endian
        // company identifier key. Example:
        //
        // Raw manufacturer data: c2 26 01 34 21 2b 01
        // Shelly object:         { "26c2": "\x01\x34\x21\x2b\x01" }
        //
        // The low temperature byte is therefore the first byte of the key.
        if (
            key.length !== 4 ||
            key.slice(2) !== 'c2'
        ) {
            continue;
        }

        let data = result.manufacturer_data[originalKey];

        // The known decoder requires at least six manufacturer bytes total.
        // Two bytes are represented by the key, so require four data bytes.
        if (
            typeof data !== 'string' ||
            data.length < 4
        ) {
            continue;
        }

        let temperatureLow = parseInt(key.slice(0, 2), 16);
        let temperatureHigh = data.charCodeAt(0) & 0xff;
        let humidity = data.charCodeAt(1) & 0xff;

        if (isNaN(temperatureLow)) {
            continue;
        }

        let rawTemperature =
            temperatureLow |
            (temperatureHigh << 8);

        // Signed int16, little-endian.
        if ((rawTemperature & 0x8000) !== 0) {
            rawTemperature -= 65536;
        }

        let temperature = rawTemperature / 10;

        // Defensive sanity checks against malformed or unrelated packets.
        if (
            temperature < -100 ||
            temperature > 150 ||
            humidity > 100
        ) {
            continue;
        }

        return {
            rawTemperature: rawTemperature,
            temperature: temperature,
            humidity: humidity
        };
    }

    return null;
}


function getSensorState(mac) {
    if (typeof sensors[mac] === 'undefined') {
        sensors[mac] = {
            lastRawTemperature: null,
            lastHumidity: null,
            lastSeen: null,
            lastPublishAttempt: null,
            lastPublish: -CONFIG.heartbeatIntervalSeconds,
            lastPublishReason: null,
            lastRssi: null,
            advertisementCount: 0,
            publishAttemptCount: 0,
            publishSuccessCount: 0,
            mqttDisconnectedSkipCount: 0,
            mqttQueueFailureCount: 0,
            packetId: 0
        };
    }

    return sensors[mac];
}


function getPublishReason(sensor, values) {
    let secondsSinceLastPublish =
        nowSeconds() - sensor.lastPublish;

    if (
        sensor.lastRawTemperature === null ||
        sensor.lastHumidity === null
    ) {
        return 'first';
    }

    let changed =
        sensor.lastRawTemperature !== values.rawTemperature ||
        sensor.lastHumidity !== values.humidity;

    if (
        changed &&
        secondsSinceLastPublish >= CONFIG.minChangeIntervalSeconds
    ) {
        return 'changed';
    }

    if (
        secondsSinceLastPublish >=
        CONFIG.heartbeatIntervalSeconds
    ) {
        return 'heartbeat';
    }

    return null;
}


function buildBTHomePayload(sensor, values) {
    sensor.packetId = (sensor.packetId + 1) & 0xff;

    let rawTemperature = values.rawTemperature;

    if (rawTemperature < 0) {
        rawTemperature += 65536;
    }

    // BTHome v2 object order is numeric:
    // 0x00 packet id
    // 0x2E humidity uint8, factor 1
    // 0x45 temperature sint16 LE, factor 0.1
    return (
        '40' +
        '00' + byteToHex(sensor.packetId) +
        '2e' + byteToHex(values.humidity) +
        '45' +
        byteToHex(rawTemperature) +
        byteToHex(rawTemperature >> 8)
    );
}


function publishSensor(result, sensor, values, reason) {
    sensor.lastPublishAttempt = nowSeconds();
    sensor.publishAttemptCount += 1;

    if (!MQTT.isConnected()) {
        sensor.mqttDisconnectedSkipCount += 1;
        return;
    }

    let payload = buildBTHomePayload(sensor, values);

    let message = {
        scriptVersion: CONFIG.ioBrokerShellyScriptVersion,
        src: SHELLY_ID,
        srcBle: {
            type: result.local_name || 'TP350',
            mac: result.addr,
            rssi: result.rssi
        },
        payload: payload
    };

    let publishResult = MQTT.publish(
        SHELLY_ID + '/events/ble',
        JSON.stringify(message)
    );

    // Current Shelly firmware returns true when the message was queued and
    // false when it could not be queued. Older firmware documented no return
    // value, so only an explicit false is treated as a queue failure.
    if (publishResult === false) {
        sensor.mqttQueueFailureCount += 1;
        return;
    }

    sensor.lastRawTemperature = values.rawTemperature;
    sensor.lastHumidity = values.humidity;
    sensor.lastPublish = nowSeconds();
    sensor.lastPublishReason = reason;
    sensor.publishSuccessCount += 1;

    if (CONFIG.debug) {
        console.log(
            'TP350 ' +
            result.addr +
            ': ' +
            values.temperature +
            ' C / ' +
            values.humidity +
            ' % / RSSI ' +
            result.rssi +
            ' / reason=' +
            reason +
            ' -> ' +
            payload
        );
    }
}


function bleScanCallback(event, result) {
    if (event !== BLE.Scanner.SCAN_RESULT) {
        return;
    }

    if (
        typeof result.addr === 'undefined' ||
        !isTP350Name(result.local_name)
    ) {
        return;
    }

    let values = decodeTP350(result);

    if (values === null) {
        if (CONFIG.debug) {
            console.log(
                'TP350 ' +
                result.addr +
                ': matching name, unsupported manufacturer payload'
            );
        }

        return;
    }

    let mac = result.addr.toLowerCase();
    let sensor = getSensorState(mac);

    sensor.lastSeen = nowSeconds();
    sensor.lastRssi = result.rssi;
    sensor.advertisementCount += 1;

    let reason = getPublishReason(sensor, values);

    if (reason === null) {
        return;
    }

    publishSensor(result, sensor, values, reason);
}


function formatAge(timestamp, now) {
    if (timestamp === null) {
        return 'never';
    }

    let age = now - timestamp;

    if (age < 0) {
        age = 0;
    }

    return age.toFixed(1) + 's';
}


function logDiagnostics() {
    if (!CONFIG.diagnostics) {
        return;
    }

    let now = nowSeconds();
    let macs = Object.keys(sensors).sort();

    console.log(
        'TP350 DIAG gateway=' +
        SHELLY_ID +
        ' mqtt=' +
        MQTT.isConnected() +
        ' scan=' +
        BLE.Scanner.isRunning() +
        ' sensors=' +
        macs.length
    );

    for (let i = 0; i < macs.length; i++) {
        let mac = macs[i];
        let sensor = sensors[mac];

        console.log(
            'TP350 DIAG mac=' +
            mac +
            ' seen=' +
            formatAge(sensor.lastSeen, now) +
            ' publish=' +
            formatAge(
                sensor.publishSuccessCount > 0 ? sensor.lastPublish : null,
                now
            ) +
            ' attempt=' +
            formatAge(sensor.lastPublishAttempt, now) +
            ' adv=' +
            sensor.advertisementCount +
            ' attempts=' +
            sensor.publishAttemptCount +
            ' ok=' +
            sensor.publishSuccessCount +
            ' mqttSkip=' +
            sensor.mqttDisconnectedSkipCount +
            ' queueFail=' +
            sensor.mqttQueueFailureCount +
            ' rssi=' +
            sensor.lastRssi +
            ' reason=' +
            (sensor.lastPublishReason || 'none')
        );
    }
}


function isBleEnabled(bleConfig) {
    if (bleConfig === null || typeof bleConfig === 'undefined') {
        return false;
    }

    // Firmware/API variants observed in the wild and in current examples.
    if (typeof bleConfig.enable !== 'undefined') {
        return bleConfig.enable;
    }

    if (
        typeof bleConfig.rpc !== 'undefined' &&
        bleConfig.rpc !== null &&
        typeof bleConfig.rpc.enable !== 'undefined'
    ) {
        return bleConfig.rpc.enable;
    }

    return false;
}


function init() {
    let bleConfig = Shelly.getComponentConfig('ble');

    if (!isBleEnabled(bleConfig)) {
        console.log(
            'Error: Bluetooth is not enabled on this Shelly'
        );

        return;
    }

    // Firmware 1.5.0+ uses Shelly's Enhanced Scan Manager. Each script should
    // submit its own scan request; requests are merged by the device.
    let scanner = BLE.Scanner.Start({
        duration_ms: BLE.Scanner.INFINITE_SCAN,
        active: true
    });

    if (!scanner) {
        console.log(
            'Error: BLE scan request failed; firmware 1.5.0+ is recommended'
        );

        return;
    }

    BLE.Scanner.Subscribe(bleScanCallback);

    if (CONFIG.diagnostics) {
        Timer.set(
            CONFIG.diagnosticIntervalSeconds * 1000,
            true,
            logDiagnostics
        );
    }

    console.log(
        'TP350 ioBroker gateway active; scriptVersion=' +
        CONFIG.ioBrokerShellyScriptVersion +
        '; diagnostics=' +
        CONFIG.diagnostics
    );
}


Shelly.call(
    'Mqtt.GetConfig',
    '',
    function (res, errCode, errMessage, userdata) {
        if (
            errCode !== 0 ||
            typeof res === 'undefined' ||
            typeof res.topic_prefix === 'undefined' ||
            res.topic_prefix === ''
        ) {
            console.log(
                'Error: MQTT topic prefix unavailable: ' +
                errMessage
            );

            return;
        }

        SHELLY_ID = res.topic_prefix;
        init();
    }
);
