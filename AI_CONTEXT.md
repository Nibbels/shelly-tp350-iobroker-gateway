# AI context: Shelly TP350 -> ioBroker gateway

This file is a compact technical handoff for an AI assistant or developer extending this repository. Read it together with `src/tp350-iobroker-gateway.js`.

## Project goal

Receive ThermoPro TP350 / TP350S BLE advertisements on a Shelly Gen2+ device, decode temperature and humidity locally, translate them into BTHome v2 measurement objects, and publish the MQTT BLE-event envelope expected by the `ioBroker.shelly` adapter.

The gateway must remain generic:

- no room names
- no fixed MAC allow-list
- every compatible TP350/TP350S in range should work
- identity is the BLE MAC address
- human room assignment happens in ioBroker after comparing the TP350 display with live values

## Origin and credits

- Stefan Bek / GitHub `@Nibbels`: motivation, home-automation use case, the idea to use an existing Shelly as the BLE receiver/gateway, three real TP350S devices, advertisement captures, and validation.
- ChatGPT by OpenAI (GPT-5.5 Thinking): protocol analysis, Shelly decoder implementation, synthetic BTHome bridge, test harness, and repository documentation.

## Validated environment

Initial field validation:

- three ThermoPro TP350S sensors
- Shelly 1 Mini Gen2
- Shelly firmware `20260311-095841/1.7.5-g9979d16`
- an existing ioBroker Shelly BLE gateway script v1.2 was running in parallel
- ioBroker created `temperature`, `humidity`, `pid`, and `receivedBy` states under `shelly.0.ble.<mac>`

The Shelly Enhanced Scan Manager is documented as effective since firmware 1.5.0-beta1. Current Shelly BLE API documentation says multiple scan requests are merged and each script should submit its own request. The gateway therefore calls `BLE.Scanner.Start(...)` even if another BLE script is running.

## Real observed TP350S advertisements

The original capture yielded these three manufacturer-data representations from Shelly:

```text
{"26c2":"0134212b01"} -> 29.4 C / 52 %RH
{"17c2":"0156212b01"} -> 27.9 C / 86 %RH
{"11c2":"012e222b01"} -> 27.3 C / 46 %RH
```

One complete observed advertisement was:

```text
0201060e085450333530532028423130392908ffc2260134212b01
```

AD structure breakdown:

```text
02 01 06
0e 08 54503335305320284231303929
08 ff c2 26 01 34 21 2b 01
```

The local name decodes to `TP350S (B109)`.

The manufacturer data is:

```text
c2 26 01 34 21 2b 01
```

Temperature:

```text
26 01 little-endian = 0x0126 = 294
294 / 10 = 29.4 C
```

Humidity:

```text
34 hex = 52 decimal = 52 %RH
```

## Shelly manufacturer_data quirk

Shelly exposes parsed manufacturer data as an object keyed by a 16-bit manufacturer/company identifier.

For raw bytes:

```text
c2 26 01 34 21 2b 01
```

Shelly returned:

```js
{
    "26c2": "\x01\x34\x21\x2b\x01"
}
```

This means the first temperature byte (`0x26`) is embedded in the object key. The script therefore:

1. requires a four-character manufacturer-data key ending in `c2`
2. reads the first two key characters as `temperatureLow`
3. reads `data[0]` as `temperatureHigh`
4. reads `data[1]` as humidity
5. combines temperature as signed int16 little-endian and divides by 10

The name must begin with `TP350`, which matches both `TP350` and `TP350S (...)`.

## Cross-check with Theengs Decoder

Primary source:

`https://github.com/theengs/decoder/blob/development/src/devices/TPTH_json.h`

Relevant Theengs logic:

- condition includes local names beginning with `TP350`
- manufacturerdata begins with `c2`
- temperature: `value_from_hex_data` at hex offset 2, length 4, little-endian, signed, then `/ 10`
- humidity: hex offset 6, length 2, unsigned
- a low-battery boolean is also decoded

The Theengs decoder groups TP350/357/358/359/393. This repository intentionally limits detection to names beginning with `TP350`.

## Synthetic BTHome v2 payload

Primary source:

`https://bthome.io/format/`

The payload starts with BTHome v2 device info `0x40`:

- unencrypted
- regular updates
- BTHome version 2

Objects are emitted in ascending numeric ID order:

```text
0x00 packet id           uint8
0x2E humidity            uint8, factor 1
0x45 temperature         sint16 LE, factor 0.1
```

Example, 29.4 C / 52 %RH, packet ID 1:

```text
40 00 01 2e 34 45 26 01
```

Hex payload:

```text
4000012e34452601
```

The packet ID is maintained per BLE MAC address. It increments for every MQTT publish, including heartbeat publishes, so the receiver processes the fresh receiver/RSSI event.

## ioBroker Shelly MQTT envelope

Primary source:

`https://github.com/iobroker-community-adapters/ioBroker.shelly/blob/master/docs/en/ble-devices.md`

Publish topic:

```text
<SHELLY_MQTT_TOPIC_PREFIX>/events/ble
```

JSON envelope:

```json
{
  "scriptVersion": "1.2",
  "src": "<shelly topic prefix>",
  "srcBle": {
    "type": "TP350S (B109)",
    "mac": "aa:bb:cc:dd:ee:ff",
    "rssi": -82
  },
  "payload": "4000012e34452601"
}
```

`scriptVersion` is checked by the external ioBroker Shelly adapter. The repository exposes it as `CONFIG.ioBrokerShellyScriptVersion`.

Official adapter documentation at repository creation time:

```text
adapter >= 11.0.0 -> script 1.3
adapter >= 10.3.0 -> script 1.2
adapter >= 10.2.0 -> script 1.1
adapter >= 10.0.0 -> script 1.0
```

Do not silently change the default without documenting why and updating README compatibility notes.

## Publish strategy

Default settings:

```js
minChangeIntervalSeconds: 10,
heartbeatIntervalSeconds: 60
```

State is tracked dynamically per MAC address:

```text
lastRawTemperature
lastHumidity
lastPublish
packetId
```

Rules:

- first valid packet -> publish immediately
- changed value -> publish once the minimum interval has elapsed
- unchanged value -> publish after heartbeat interval
- MQTT disconnected -> do not update last published state; the next received advertisement can publish after reconnect

Raw temperature integer is used for comparisons and BTHome encoding to avoid unnecessary floating-point round-trips.

## Battery-low status: intentionally not forwarded yet

The Theengs decoder exposes a boolean low-battery state. The advertisement used here does not provide a validated battery percentage.

BTHome defines binary sensor object `0x15` as battery normal/low. However, the current project only sends temperature and humidity because:

1. no real low-battery TP350 sample was captured during initial validation
2. `ioBroker.shelly` also uses a numeric `battery` state for BTHome battery percentage object `0x01`
3. a boolean `battery` object may create a type/semantic collision depending on adapter behavior and existing states

Extension strategy:

- capture a TP350 advertisement with the physical device actually showing low battery
- verify the exact Shelly-side byte/bit mapping against Theengs
- feed a synthetic BTHome `0x15` payload through the target `ioBroker.shelly` adapter version
- inspect resulting state name and type
- only then add it to the production payload and tests

Never invent a battery percentage from the low-battery boolean.

## Compatibility and design constraints

- Shelly Script runtime is not a browser or Node.js runtime. Keep code conservative and ES5-ish despite `let`/`const` support.
- Avoid imports and dependencies; the final source file must be directly pasteable into the Shelly web UI.
- Keep early BLE filtering cheap because the callback receives many unrelated advertisements.
- Do not add sensor names or MAC addresses to the gateway script.
- Do not publish every identical TP350 advertisement; retain throttling.
- Keep BTHome object IDs numerically ordered.
- Preserve signed 16-bit temperature handling, including negative temperatures.
- Preserve the actual TP350 local name in `srcBle.type`; use the MAC as the stable identity.
- The project is a bridge into the ioBroker Shelly adapter, not a general MQTT JSON gateway.

## Existing smoke test

`tests/smoke-test.js` executes the real Shelly script in a Node `vm` with mocked:

- `BLE`
- `MQTT`
- `Shelly`
- `Timer`

It checks:

- all three original packet shapes
- expected BTHome payloads
- duplicate suppression before the minimum/heartbeat interval
- heartbeat republish with incremented packet ID
- non-TP350 name ignored
- negative signed temperature encoding

Run:

```bash
npm test
```

When changing the parser or payload builder, update fixtures/tests and this context file together.

## Useful primary references

- Shelly BLE Script API: `https://shelly-api-docs.shelly.cloud/gen2/Scripts/APIs/BLE/`
- Shelly BLE Scan Manager: `https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/BLE/`
- ioBroker Shelly BLE docs: `https://github.com/iobroker-community-adapters/ioBroker.shelly/blob/master/docs/en/ble-devices.md`
- BTHome v2 format: `https://bthome.io/format/`
- Theengs TP35X/393 decoder: `https://github.com/theengs/decoder/blob/development/src/devices/TPTH_json.h`
- ThermoPro TP350 product page: `https://buythermopro.com/product/tp350/`
