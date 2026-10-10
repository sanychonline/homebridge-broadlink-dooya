# homebridge-dooya-dt360e

Homebridge plugin for Dooya DT360E curtain motors controlled directly over Wi-Fi.

## What this does

- Exposes each curtain as a HomeKit `WindowCovering`
- Talks to the Dooya controller over local BroadLink UDP
- Reads the real DT360E motor position every 15 seconds by default
- Persists the last known position in Homebridge storage for restarts and power cuts
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

Minimal DT360E config:

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

Do not add `type`, `protocol`, durations, device IDs, or cloud fields unless you are deliberately overriding a default. For normal DT360E local Wi-Fi control, the plugin discovers the BroadLink type and uses the DT360E protocol automatically.

## Config fields

- `name`: accessory name
- `host`: device IP address
- `mac`: device MAC address
- `invertPosition`: optional, set to `true` when the motor reports open/closed backwards
- `pollIntervalSeconds`: optional, how often to read the real motor position. Defaults to `15` seconds for DT360E local mode.
- `positionStorePath`: optional override for the JSON file used to persist the last known position. Normally omit it; the default is `dooya-dt360e-positions.json` in the Homebridge storage folder.
- `trustEndpointPositionOnPoll`: optional, defaults to `false`. Set to `true` only if your motor reliably reports `0%` and `100%` after startup or communication loss. By default, passive polling will not overwrite a mid-range stored position with a sudden endpoint value immediately after startup or a failed status read.
- `protocol`: optional override. Normally omit it; defaults to `dt360e`.
- `type`: optional override. Normally omit it; the plugin discovers the BroadLink type automatically and falls back to DT360E type `20334` (`0x4f6e`).

## Position updates

The plugin reads the real motor position every 15 seconds by default. Each successful status read updates:

- HomeKit `CurrentPosition`
- HomeKit `TargetPosition`
- the persistent position file

If the motor does not answer a polling request, Homebridge keeps running and the plugin keeps the last known position. The failed poll is logged only in debug mode, so temporary Wi-Fi or power issues should not spam normal logs.

You can change the interval with `pollIntervalSeconds`, but the default `15` seconds is recommended for HomeKit/Siri accuracy.

## Persistent position store

The plugin writes the last known position to `dooya-dt360e-positions.json` in the Homebridge storage folder. In the official Homebridge Docker layout this is typically the persistent `/homebridge` folder, so the file survives container restarts.

The file is used on Homebridge startup before the first successful motor response. This helps Siri avoid guessing from `0%` or `100%` after:

- Homebridge restarts
- Docker/container restarts
- power cuts
- temporary motor or Wi-Fi unavailability

Once the motor responds again, the next 15-second status read replaces the stored value with the real position.

To avoid losing a good mid-range estimate after a power cut, passive polling treats a sudden `0%` or `100%` report as suspicious only while the accessory is recovering from startup or a failed status read. In normal online operation, an endpoint can still be accepted, so a real manual close/open is reflected by the next 15-second poll. The plugin keeps the stored mid-range value unless the endpoint came from a command sent by HomeKit/Siri, the motor later reports a non-endpoint position, or you opt out with `trustEndpointPositionOnPoll: true`.

## Notes

- This plugin is for direct Wi-Fi control of the Dooya controller.
- The BroadLink mobile app is only needed to pair the curtain motor to Wi-Fi. After that, the Homebridge plugin connects to the device locally.
- Local DT360E mode reads real status with `010b` frames and sends target position with `020b` frames.
- HomeKit position is resynchronized from the motor automatically every 15 seconds, so manual movement or missed state changes are corrected without extra config.
- If the motor is temporarily offline, HomeKit keeps the last known position from `dooya-dt360e-positions.json` until the next successful status read.
- DT360E type `20334` (`0x4f6e`) expects the encrypted BroadLink `0x6a` payload to be prefixed with the little-endian inner frame length, for example `0c00 + a5a55a5a...` for status.
- If BroadLink returns `65529` (`-7`), check that the curtain is paired on the same WLAN and that device lock is disabled in the BroadLink mobile app, then restart Homebridge.
