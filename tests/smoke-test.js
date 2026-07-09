'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'tp350-iobroker-gateway.js'),
    'utf8'
);

let scanCallback = null;
let timerCallback = null;
const published = [];

const context = {
    console: {
        log: function () {}
    },
    BLE: {
        Scanner: {
            SCAN_RESULT: 2,
            INFINITE_SCAN: -1,
            Start: function () {
                return {};
            },
            Subscribe: function (callback) {
                scanCallback = callback;
            }
        }
    },
    MQTT: {
        isConnected: function () {
            return true;
        },
        publish: function (topic, payload) {
            published.push({
                topic: topic,
                message: JSON.parse(payload)
            });
        }
    },
    Timer: {
        set: function (milliseconds, repeat, callback) {
            assert.strictEqual(milliseconds, 1000);
            assert.strictEqual(repeat, true);
            timerCallback = callback;
            return 1;
        }
    },
    Shelly: {
        getComponentConfig: function (component) {
            assert.strictEqual(component, 'ble');
            return {
                enable: true,
                rpc: {
                    enable: true
                }
            };
        },
        call: function (method, params, callback) {
            assert.strictEqual(method, 'Mqtt.GetConfig');
            callback(
                { topic_prefix: 'shelly-test' },
                0,
                '',
                null
            );
        }
    }
};

vm.runInNewContext(source, context, {
    filename: 'tp350-iobroker-gateway.js'
});

assert.strictEqual(typeof scanCallback, 'function');
assert.strictEqual(typeof timerCallback, 'function');

function binary(hex) {
    return Buffer.from(hex, 'hex').toString('latin1');
}

function feed(name, mac, key, dataHex, rssi) {
    scanCallback(2, {
        local_name: name,
        addr: mac,
        rssi: rssi,
        manufacturer_data: {
            [key]: binary(dataHex)
        }
    });
}

function tick(seconds) {
    for (let i = 0; i < seconds; i++) {
        timerCallback();
    }
}

const fixtures = [
    {
        name: 'TP350S (B109)',
        mac: 'aa:aa:aa:aa:aa:01',
        key: '26c2',
        data: '0134212b01',
        expectedPayload: '4000012e34452601'
    },
    {
        name: 'TP350S (667E)',
        mac: 'aa:aa:aa:aa:aa:02',
        key: '17c2',
        data: '0156212b01',
        expectedPayload: '4000012e56451701'
    },
    {
        name: 'TP350S (1907)',
        mac: 'aa:aa:aa:aa:aa:03',
        key: '11c2',
        data: '012e222b01',
        expectedPayload: '4000012e2e451101'
    }
];

fixtures.forEach(function (fixture) {
    feed(
        fixture.name,
        fixture.mac,
        fixture.key,
        fixture.data,
        -80
    );
});

assert.strictEqual(published.length, 3);

fixtures.forEach(function (fixture, index) {
    assert.strictEqual(
        published[index].topic,
        'shelly-test/events/ble'
    );
    assert.strictEqual(
        published[index].message.scriptVersion,
        '1.2'
    );
    assert.strictEqual(
        published[index].message.src,
        'shelly-test'
    );
    assert.strictEqual(
        published[index].message.srcBle.mac,
        fixture.mac
    );
    assert.strictEqual(
        published[index].message.payload,
        fixture.expectedPayload
    );
});

// Identical packet is throttled.
feed(
    fixtures[0].name,
    fixtures[0].mac,
    fixtures[0].key,
    fixtures[0].data,
    -79
);
assert.strictEqual(published.length, 3);

// Heartbeat republishes unchanged data and increments the per-sensor packet ID.
tick(60);
feed(
    fixtures[0].name,
    fixtures[0].mac,
    fixtures[0].key,
    fixtures[0].data,
    -78
);
assert.strictEqual(published.length, 4);
assert.strictEqual(
    published[3].message.payload,
    '4000022e34452601'
);

// A different ThermoPro family name is intentionally outside repository scope.
feed(
    'TP357 (TEST)',
    'aa:aa:aa:aa:aa:04',
    '26c2',
    '0134212b01',
    -70
);
assert.strictEqual(published.length, 4);

// Signed int16 test: -5.3 C = -53 = 0xFFCB, little-endian CB FF.
feed(
    'TP350 (NEG)',
    'aa:aa:aa:aa:aa:05',
    'cbc2',
    'ff28212b01',
    -70
);
assert.strictEqual(published.length, 5);
assert.strictEqual(
    published[4].message.payload,
    '4000012e2845cbff'
);

console.log('All TP350 gateway smoke tests passed.');
