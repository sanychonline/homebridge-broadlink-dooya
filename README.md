# homebridge-dooya-dt360e

Homebridge plugin for Dooya DT360E curtain motors controlled directly over Wi-Fi.

## What this does

- Exposes each curtain as a HomeKit `WindowCovering`
- Talks to the Dooya controller over local BroadLink UDP
- Reads the real DT360E motor position every 15 seconds by default
- Supports BroadLink DT360E devices such as type `20334` (`0x4f6e`)

## Installation

### Homebridge UI

Open the Homebridge UI, go to **Plugins**, search for:

```text
homebridge-dooya-dt360e
```

Install the plugin, add the platform config, then restart Homebridge.

### npm

Install the package in the same environment where Homebridge runs:

```bash
npm install -g homebridge-dooya-dt360e
```

Then restart Homebridge.

### Docker

If your Homebridge container stores plugins in a persistent `/homebridge` data folder, install the package inside that environment:

```bash
cd /homebridge
npm install homebridge-dooya-dt360e
```

Then restart the Homebridge container.

## Example config

```json
{
  "platform": "DooyaDT360E",
  "name": "Dooya DT360E",
  "devices": [
    {
      "name": "Living Room Curtain",
      "host": "192.168.1.50",
      "mac": "aa:bb:cc:dd:ee:ff",
      "invertPosition": false
    }
  ]
}
```

## Config fields

- `name`: accessory name
- `host`: device IP address
- `mac`: device MAC address
- `invertPosition`: optional, set to `true` when the motor reports open/closed backwards
- `pollIntervalSeconds`: optional, how often to read the real motor position. Defaults to `15` seconds for DT360E local mode.
- `protocol`: optional override. Normally omit it; defaults to `dt360e`.
- `type`: optional override. Normally omit it; the plugin discovers the BroadLink type automatically and falls back to DT360E type `20334` (`0x4f6e`).

## Notes

- This plugin is for direct Wi-Fi control of the Dooya controller.
- The BroadLink mobile app is only needed to pair the curtain motor to Wi-Fi. After that, the Homebridge plugin connects to the device locally.
- Local DT360E mode reads real status with `010b` frames and sends target position with `020b` frames.
- HomeKit position is resynchronized from the motor automatically every 15 seconds, so manual movement or missed state changes are corrected without extra config.
- DT360E type `20334` (`0x4f6e`) expects the encrypted BroadLink `0x6a` payload to be prefixed with the little-endian inner frame length, for example `0c00 + a5a55a5a...` for status.
- If BroadLink returns `65529` (`-7`), check that the curtain is paired on the same WLAN and that device lock is disabled in the BroadLink mobile app, then restart Homebridge.
