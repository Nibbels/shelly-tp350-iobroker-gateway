# shelly-tp350-iobroker-gateway

Bridge **ThermoPro TP350 / TP350S** Bluetooth temperature and humidity advertisements through a **Shelly Gen2+ device** into the **ioBroker Shelly adapter**.

The Shelly decodes ThermoPro manufacturer data locally, converts temperature and humidity into a small **BTHome v2** payload, and publishes the MQTT BLE-event message format already consumed by `ioBroker.shelly`.

```text
ThermoPro TP350 / TP350S
        |
        | BLE advertisements
        v
Shelly Gen2+ / Plus / Pro
        |
        | Shelly Script
        | TP350 decode -> synthetic BTHome v2
        v
MQTT <shelly-topic-prefix>/events/ble
        |
        v
ioBroker Shelly adapter
        |
        +-- shelly.0.ble.<mac>.temperature
        +-- shelly.0.ble.<mac>.humidity
        +-- shelly.0.ble.<mac>.receivedBy
```

## Motivation

The project started from a real home-automation use case by **Stefan Bek ([@Nibbels](https://github.com/Nibbels))**.

Several TP350S sensors were already deployed and easy to read in the ThermoPro app, but opening an app is inconvenient when the measurements are actually needed as automation inputs: for example, controlling dehumidifiers through switchable sockets.

Stefan proposed reusing an already-running Shelly as the BLE receiver instead of installing another Bluetooth gateway stack. Real TP350S advertisements were captured on a Shelly, the packet layout was verified against the open Theengs decoder, and the bridge implemented collaboratively with ChatGPT.

The result is intentionally small: **no ThermoPro cloud, no phone bridge, no Raspberry Pi BLE daemon, and no hard-coded sensor names or MAC addresses**.

## What the script does

- Detects any received BLE device whose local name starts with `TP350`.
- Validates the observed ThermoPro manufacturer-data signature.
- Decodes signed temperature in `0.1 °C` and humidity in whole `%RH`.
- Converts those values to valid BTHome v2 objects.
- Publishes the same MQTT BLE-event envelope used by the ioBroker Shelly adapter.
- Keeps sensors separate by their BLE MAC address.
- Publishes changes with rate limiting and sends a periodic heartbeat.
- Can run as a second script next to the normal ioBroker Shelly BTHome gateway script on current Shelly firmware.

## Hardware and software

### 1. ThermoPro TP350 / TP350S

The TP350 is a Bluetooth 5.0 thermometer/hygrometer. ThermoPro documents local Bluetooth operation without Wi-Fi or an account and a 10-second measurement refresh rate.

- [ThermoPro TP350 product page](https://buythermopro.com/product/tp350/)
- [Amazon Germany TP350 / TP350S listing used during the original project](https://www.amazon.de/ThermoPro-Thermometer-Raumthermometer-Luftfeuchtigkeitsmesser-TP350/dp/B0CRY35J2R)

The bridge was field-tested with three TP350S units.

### 2. A script-capable Shelly with Bluetooth

Use a Shelly Gen2+ / Plus / Pro device with BLE and Shelly Scripting support. It does **not** need to switch the sensor or dehumidifier itself; it can simply act as the distributed BLE receiver.

Examples:

- [Shelly 1 Mini Gen3](https://www.shelly.com/products/shelly-1-mini-gen3)
- [Shelly Plus 2PM](https://www.shelly.com/products/shelly-plus-2pm-1)

The initial installation was validated on a Shelly 1 Mini Gen2 with firmware `20260311-095841/1.7.5-g9979d16`.

Shelly documents the BLE scanner API and, since firmware 1.5.0, an Enhanced Scan Manager that merges scan requests from multiple clients/scripts:

- [Shelly BLE Script API](https://shelly-api-docs.shelly.cloud/gen2/Scripts/APIs/BLE/)
- [Shelly BLE component and Scan Manager](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/BLE/)

**Firmware 1.5.0 or newer is recommended.**

### 3. ioBroker with the Shelly adapter using MQTT

The ioBroker Shelly adapter documents a Shelly-side BLE gateway script and the `<topic-prefix>/events/ble` message flow. Since script version 1.0, BTHome payload processing happens in ioBroker.

- [ioBroker Shelly BLE device documentation](https://github.com/iobroker-community-adapters/ioBroker.shelly/blob/master/docs/en/ble-devices.md)

The adapter requires the MQTT gateway `scriptVersion` to match the adapter generation. At the time this repository was created, the official documentation listed:

| ioBroker.shelly adapter | BLE script version |
|---|---|
| `>= 11.0.0` | `1.3` |
| `>= 10.3.0` | `1.2` |
| `>= 10.2.0` | `1.1` |
| `>= 10.0.0` | `1.0` |

The project defaults to `1.2` because that is the version used in the initial working installation.

## Installation

1. Configure the Shelly as an MQTT device for your ioBroker Shelly adapter.
2. Enable Bluetooth on the Shelly.
3. Keep the official ioBroker Shelly BLE/BTHome script if you already use Shelly BLU buttons or other BTHome devices.
4. In the Shelly web interface, create a **second script**.
5. Copy [`src/tp350-iobroker-gateway.js`](src/tp350-iobroker-gateway.js) into that script.
6. Check `CONFIG.ioBrokerShellyScriptVersion` at the top of the file and set the version required by your installed `ioBroker.shelly` adapter.
7. Start the script.
8. After verifying the values, enable script auto-start.

The Shelly log should contain a startup line similar to:

```text
TP350 ioBroker gateway active; scriptVersion=1.2
```

With `CONFIG.debug = true`, received values are also logged:

```text
TP350 aa:bb:cc:dd:ee:ff: 27.9 C / 67 % / RSSI -82 -> 4000012e43451701
```

## ioBroker result and sensor identification

Each TP350 appears by BLE MAC address under:

```text
shelly.0.ble.<mac-address>
```

Expected states include:

```text
temperature
humidity
pid
receivedBy
```

The script intentionally contains **no room names and no sensor allow-list**. Any compatible TP350/TP350S in BLE range is processed.

To identify multiple identical sensors, compare the temperature/humidity shown on the physical TP350 display with the values in ioBroker. Then rename the BLE device object in ioBroker. This keeps physical-room mapping out of the gateway code and avoids accidental sensor swaps after moving devices.

## Protocol mapping

An observed TP350S advertisement contained this manufacturer data:

```text
c2 26 01 34 21 2b 01
```

It decodes as:

```text
c2 | 26 01 | 34 | ...
     temp     humidity
```

```text
0x0126 little-endian = 294 -> 29.4 °C
0x34                  = 52  -> 52 %RH
```

Shelly exposes the same data as:

```js
{
    "26c2": "\x01\x34\x21\x2b\x01"
}
```

The first two manufacturer bytes become the manufacturer-data object key, so the decoder reconstructs the first temperature byte from that key.

The format was cross-checked against the open-source [Theengs TP35X/393 decoder](https://github.com/theengs/decoder/blob/development/src/devices/TPTH_json.h), which decodes the temperature as signed little-endian `int16 / 10` and humidity as the following `uint8`.

The synthetic BTHome v2 payload uses:

| Object | BTHome ID | Encoding |
|---|---:|---|
| packet id | `0x00` | `uint8` |
| humidity | `0x2E` | `uint8`, factor 1 |
| temperature | `0x45` | `sint16 LE`, factor 0.1 |

BTHome requires object IDs in numerical order. See the [BTHome v2 format specification](https://bthome.io/format/).

Example for `29.4 °C / 52 %RH`:

```text
40 00 01 2e 34 45 26 01
```

The message published to ioBroker looks like:

```json
{
  "scriptVersion": "1.2",
  "src": "shelly1mini-xxxxxxxxxxxx",
  "srcBle": {
    "type": "TP350S (B109)",
    "mac": "aa:bb:cc:dd:ee:ff",
    "rssi": -82
  },
  "payload": "4000012e34452601"
}
```

## Publish throttling

TP350 sensors advertise frequently. Forwarding every identical packet would create unnecessary MQTT and ioBroker traffic.

Defaults:

```js
minChangeIntervalSeconds: 10,
heartbeatIntervalSeconds: 60
```

A changed temperature or humidity value is forwarded at most once per 10 seconds. Unchanged values are republished after 60 seconds with a new BTHome packet ID so the ioBroker receiver/RSSI information continues to refresh.

## Battery status

The Theengs decoder exposes a **low-battery boolean** for this ThermoPro frame. The TP350 does not provide a validated battery percentage in the advertisement used here.

This project deliberately does **not** invent a percentage or map the low-battery bit into ioBroker yet. BTHome has a binary low-battery object, but adding it should first be tested against `ioBroker.shelly` state typing and with an actual low-battery TP350 sample.

See [`AI_CONTEXT.md`](AI_CONTEXT.md) for the extension notes.

## Limitations and compatibility

- This is an independent community project and is not affiliated with ThermoPro, Shelly, ioBroker, Theengs, or BTHome.
- ThermoPro's BLE manufacturer-data layout is not documented here as an official ThermoPro API. The decoder is based on observed advertisements and the open Theengs decoder, then validated with real TP350S hardware.
- Only names beginning with `TP350` are accepted. Although the referenced Theengs decoder also covers other TP35X/393 names, this repository intentionally limits its scope to TP350/TP350S.
- The `ioBroker.shelly` script-version compatibility check is external to this project. Update `CONFIG.ioBrokerShellyScriptVersion` after relevant adapter upgrades.
- BLE is unencrypted on the sensor side. Anyone in radio range may be able to observe the same environmental advertisements.
- Secure your MQTT transport and ioBroker installation according to your own network requirements.

## AI-assisted maintenance / handoff

This repository intentionally contains [`AI_CONTEXT.md`](AI_CONTEXT.md).

When discussing a bug, new ThermoPro model, additional BTHome field, or another home-automation target with an AI assistant, provide at least:

1. `AI_CONTEXT.md`
2. `src/tp350-iobroker-gateway.js`
3. the relevant new BLE advertisement/log sample

The context file contains the protocol findings, Shelly-specific manufacturer-data quirk, ioBroker MQTT envelope, design decisions, tested samples, and known extension points. The goal is to avoid rediscovering the protocol from scratch in every future AI conversation.

When the implementation changes materially, update `AI_CONTEXT.md` in the same commit.

## Testing

The repository includes a zero-dependency Node.js smoke test for the exact Shelly script using mocked Shelly/BLE/MQTT globals.

```bash
npm test
```

The test validates the three original TP350S packet shapes, duplicate throttling, the heartbeat path, an ignored non-TP350 packet, and negative signed temperature handling.

## Credits

- **Stefan Bek / [@Nibbels](https://github.com/Nibbels)** — motivation, real-world use case, Shelly gateway idea, hardware setup, BLE captures, and validation.
- **ChatGPT by OpenAI (GPT-5.5 Thinking)** — protocol analysis, bridge design, Shelly Script implementation, BTHome mapping, tests, and repository documentation, developed collaboratively from Stefan's captures and design direction.

### Acknowledgements

- [Theengs Decoder](https://github.com/theengs/decoder) for the open TP35X/393 BLE decoder used to cross-check the observed packet layout.
- [BTHome](https://bthome.io/) for the open BLE sensor-data format.
- [ioBroker.shelly](https://github.com/iobroker-community-adapters/ioBroker.shelly) for the existing MQTT BLE-event processing path.
- [Shelly](https://shelly-api-docs.shelly.cloud/) for the device-side BLE and scripting APIs.

Product links are included for identification and setup convenience. They are not affiliate links.

## License

MIT. See [`LICENSE`](LICENSE).
