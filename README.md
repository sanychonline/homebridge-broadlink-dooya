# homebridge-broadlink-dooya

Homebridge plugin for Dooya DT360E curtain motors controlled directly over Wi-Fi.

## What this does

- Exposes each curtain as a HomeKit `WindowCovering`
- Talks to the Dooya controller directly over the network
- Supports timed position tracking in HomeKit
- Tries both Dooya variants automatically: `DT360E` and `DT360E-2`
- Supports BroadLink profile/DNA devices such as type `20334` (`0x4f6e`)

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
      "type": 20334,
      "protocol": "dna",
      "controlId": 1,
      "controlKey": "32_HEX_CHARS_FROM_BROADLINK_APP",
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
- `type`: Broadlink device type, usually `20045` (`0x4e4d`), `20141` (`0x4ead`), or `20334` (`0x4f6e`)
- `protocol`: optional override, `dooya`, `dooya2`, or `dna`
- `controlId`: optional BroadLink paired terminal/control id
- `controlKey`: optional BroadLink paired AES/control key, 32 hex characters
- `controlIdEndian`: optional BroadLink control id byte order, `auto`, `le`, or `be`. Defaults to `auto`.
- `did`: optional BroadLink DID/endpointId. If omitted, the plugin builds one from the MAC for DNA devices.
- `serviceId`: optional BroadLink profile service id. Defaults to `112.1.173`, which is used by DT360E `0x4f6e`.
- `dnaCommandMode`: optional DNA command strategy, `raw` or `stdctrl`. Defaults to `raw`.
- `totalDurationOpen`: seconds to fully open
- `totalDurationClose`: seconds to fully close
- `initialPosition`: starting position used before the first move

## Notes

- This plugin is for direct Wi-Fi control of the Dooya controller.
- If one device type fails during startup, the plugin automatically retries the other Dooya type.
- HomeKit position is estimated from movement time, so set the open/close durations as accurately as possible.
- A local capture from a DT360E named `Shades` reported type `20334` (`0x4f6e`).
- For type `20334` (`0x4f6e`), use `protocol: "dna"` so the plugin sends BroadLink profile commands such as `curtain_work` and `curtain_targetpos`.
- DNA mode sends BroadLink SDK-style raw Dooya frames by default and retries `controlId` byte order automatically when the device returns `-7`.
- Set `dnaCommandMode` to `stdctrl` only when testing BroadLink profile JSON payloads.

## Error 65529

`65529` is Broadlink error `-7`. The device is rejecting local control because the control key is expired or local device locking is enabled.

In the Broadlink app, open the device settings and switch off `Lock Device` / device lock. If the setting is missing or the device still rejects auth, remove and pair the device again on the same 2.4 GHz WLAN, then restart Homebridge.

If you use the macOS BroadLink app, paired device data may be available in:

```bash
sqlite3 -json ~/Library/Containers/cn.com.broadlink.econtrol.international/Data/Documents/BLDataManager001.sqlite \
  "select endpointId,friendlyName,mac,productId,cookie from BL_DeviceInfo_List;"
```

Decode the `cookie` value from base64. For DNA devices, `terminalid` can be used as `controlId`, and `aeskey` can be used as `controlKey`.
