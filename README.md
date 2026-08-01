# homebridge-broadlink-dooya

Homebridge plugin for Dooya DT360E curtain motors controlled through a Broadlink Wi-Fi bridge.

## What this does

- Exposes each curtain as a HomeKit `WindowCovering`
- Sends Broadlink `open`, `close`, `stop`, and `get position` commands to a Dooya DT360E controller
- Keeps an estimated position in HomeKit when the curtain is moved by time rather than feedback

## Important note

The Dooya curtain motor itself is usually not Wi-Fi. In most setups, the Wi-Fi device is a Broadlink RM controller that transmits RF to the curtain motor.

## Installation

Place this repository in your Homebridge plugins folder or link it locally:

```bash
npm link
```

Then restart Homebridge.

## Example config

```json
{
  "platform": "BroadlinkDooya",
  "name": "Broadlink Dooya",
  "discoveryTimeoutMs": 4000,
  "devices": [
    {
      "name": "Living Room Curtain",
      "host": "192.168.1.50",
      "mac": "aa:bb:cc:dd:ee:ff",
      "totalDurationOpen": 30,
      "totalDurationClose": 30,
      "initialPosition": 0,
      "pollIntervalSeconds": 120
    }
  ]
}
```

## Config fields

- `name`: accessory name
- `host`: Broadlink device IP address
- `mac`: Broadlink device MAC address
- `totalDurationOpen`: seconds to fully open
- `totalDurationClose`: seconds to fully close
- `initialPosition`: starting position used before the first refresh
- `pollIntervalSeconds`: optional periodic refresh of actual position
- `refreshOnStartup`: refresh position once after startup, default `true`

## Notes

- If you know the Broadlink IP and MAC, set both directly.
- If you only set one of them, the plugin will try to resolve the device from discovery.
- If the curtain does not report position reliably, HomeKit will still work with timed movement.
