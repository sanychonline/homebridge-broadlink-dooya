# homebridge-broadlink-dooya

Homebridge plugin for Dooya DT360E curtain motors controlled directly over Wi-Fi.

## What this does

- Exposes each curtain as a HomeKit `WindowCovering`
- Talks to the Dooya controller directly over the network
- Supports timed position tracking in HomeKit
- Tries both Dooya variants automatically: `DT360E` and `DT360E-2`

## Installation

### Homebridge plugin folder

Install this package in the same Homebridge environment where Homebridge runs.

If your Homebridge is in Docker, the plugin must be present inside the Homebridge container or its persistent `node_modules` volume, not only on your local machine.

### Docker example

If your Homebridge container stores plugins in a persistent data folder, install the plugin there:

```bash
cd /path/to/homebridge/data/homebridge
npm install git+ssh://git@github.com/sanychonline/homebridge-broadlink-dooya.git
```

Then restart the Homebridge container.

## Example config

```json
{
  "platform": "BroadlinkDooya",
  "name": "Broadlink Dooya",
  "devices": [
    {
      "name": "Living Room Curtain",
      "host": "192.168.1.50",
      "mac": "aa:bb:cc:dd:ee:ff",
      "type": 20045,
      "protocol": "dooya",
      "totalDurationOpen": 30,
      "totalDurationClose": 30,
      "initialPosition": 0
    }
  ]
}
```

## Config fields

- `name`: accessory name
- `host`: device IP address
- `mac`: device MAC address
- `type`: Broadlink device type, usually `20045` (`0x4e4d`) or `20141` (`0x4ead`)
- `protocol`: optional override, `dooya` or `dooya2`
- `totalDurationOpen`: seconds to fully open
- `totalDurationClose`: seconds to fully close
- `initialPosition`: starting position used before the first move

## Notes

- This plugin is for direct Wi-Fi control of the Dooya controller.
- If one device type fails during startup, the plugin automatically retries the other Dooya type.
- HomeKit position is estimated from movement time, so set the open/close durations as accurately as possible.
