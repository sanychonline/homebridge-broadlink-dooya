'use strict';

const dgram = require('dgram');
const crypto = require('crypto');
const os = require('os');

const PLUGIN_NAME = 'homebridge-broadlink-dooya';
const PLATFORM_NAME = 'BroadlinkDooya';
const DEFAULT_BROADLINK_KEY = Buffer.from([
  0x09, 0x76, 0x28, 0x34, 0x3f, 0xe9, 0x9e, 0x23,
  0x76, 0x5c, 0x15, 0x13, 0xac, 0xcf, 0x8b, 0x02,
]);
const DEFAULT_BROADLINK_IV = Buffer.from([
  0x56, 0x2e, 0x17, 0x99, 0x6d, 0x09, 0x3d, 0x28,
  0xdd, 0xb3, 0xba, 0x69, 0x5a, 0x2e, 0x6f, 0x58,
]);

const DOOYA_TYPES = new Set([0x4e4d, 0x4ead, 0x4f6e]);
const DOOYA_V2_COMMANDS = {
  open: Buffer.from([0x4a, 0x31, 0xa0]),
  close: Buffer.from([0x61, 0x32, 0xa0]),
  stop: Buffer.from([0x4c, 0x73, 0xa0]),
};
const BROADLINK_ERRORS = new Map([
  [-1, 'authentication failed; the auth code changed, pair the device again'],
  [-4, 'command is not supported by this device or firmware'],
  [-6, 'packet structure is invalid'],
  [-7, 'control key is expired or local control is locked; disable Lock Device in the Broadlink app or re-pair the device on this WLAN'],
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseMac(mac) {
  if (!mac) {
    return null;
  }

  const hex = mac.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
  if (hex.length !== 12) {
    return null;
  }

  return Buffer.from(hex, 'hex');
}

function formatMac(buffer) {
  return Array.from(buffer)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join(':');
}

function makeDeviceId(mac) {
  if (!mac) {
    return '';
  }
  const macHex = Buffer.isBuffer(mac)
    ? mac.toString('hex')
    : String(mac).replace(/[^a-fA-F0-9]/g, '').toLowerCase();
  return macHex.length === 12 ? `${'0'.repeat(20)}${macHex}` : '';
}

function parsePosition(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return clamp(Math.round(parsed), 0, 100);
}

function parseControlKey(value) {
  if (!value) {
    return null;
  }

  if (Buffer.isBuffer(value) && value.length === 16) {
    return Buffer.from(value);
  }

  const text = String(value).trim();
  if (/^[0-9a-fA-F]{32}$/.test(text)) {
    return Buffer.from(text, 'hex');
  }

  const decoded = Buffer.from(text, 'base64');
  return decoded.length === 16 ? decoded : null;
}

function resolveProtocol(config, deviceType) {
  const configured = String(config.protocol || '').trim().toLowerCase();
  if (configured === 'dna' || configured === 'profile' || configured === 'broadlink') {
    return 'dna';
  }
  if (configured === 'dooya2' || configured === 'v2') {
    return 'dooya2';
  }
  if (configured === 'dooya' || configured === 'v1' || configured === 'original') {
    return 'dooya';
  }

  if (deviceType === 0x4ead) {
    return 'dooya2';
  }
  if (deviceType === 0x4f6e) {
    return 'dna';
  }

  return 'dooya';
}

function getAlternateDooyaType(type) {
  if (type === 0x4ead) {
    return 0x4e4d;
  }
  if (type === 0x4e4d) {
    return 0x4ead;
  }
  if (type === 0x4f6e) {
    return 0x4ead;
  }
  return null;
}

function decodeBroadlinkError(value) {
  const signed = value > 0x7fff ? value - 0x10000 : value;
  const description = BROADLINK_ERRORS.get(signed);
  if (!description) {
    return `Broadlink device returned error ${value} (${signed})`;
  }
  return `Broadlink device returned error ${value} (${signed}): ${description}`;
}

class BroadlinkSession {
  constructor({ host, mac, type = 0x4e4d, port = 80, log, debug, name = 'Homebridge', deviceId, serviceId, controlKey, controlId }) {
    this.host = host;
    this.mac = mac;
    this.type = type;
    this.port = port;
    this.log = log;
    this.debug = debug;
    this.name = name;
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.key = Buffer.from(DEFAULT_BROADLINK_KEY);
    this.iv = Buffer.from(DEFAULT_BROADLINK_IV);
    this.id = Buffer.alloc(4, 0);
    this.count = Math.floor(Math.random() * 0xffff);
    this.pending = new Map();
    this.ready = false;
    this.deviceId = deviceId || makeDeviceId(mac);
    this.serviceId = serviceId || '112.1.173';

    const parsedControlKey = parseControlKey(controlKey);
    const parsedControlId = Number(controlId);
    if (parsedControlKey && Number.isFinite(parsedControlId)) {
      this.key = parsedControlKey;
      this.id.writeUInt32LE(parsedControlId >>> 0, 0);
      this.ready = true;
    }

    this.socket.on('message', (message, rinfo) => {
      this._handleMessage(message, rinfo);
    });

    this.socket.on('error', (error) => {
      if (this.log) {
        this.log.error?.(error);
      }
    });
  }

  async close() {
    for (const pending of this.pending.values()) {
      pending.reject(new Error('Broadlink session closed'));
    }
    this.pending.clear();

    await new Promise((resolve) => {
      try {
        this.socket.close(() => resolve());
      } catch (error) {
        resolve();
      }
    });
  }

  async authenticate() {
    if (this.ready) {
      return true;
    }

    const payload = Buffer.alloc(0x50, 0);
    payload.fill(0x31, 0x04, 0x13);
    payload[0x1e] = 0x01;
    payload[0x2d] = 0x01;
    payload[0x30] = 'T'.charCodeAt(0);
    payload[0x31] = 'e'.charCodeAt(0);
    payload[0x32] = 's'.charCodeAt(0);
    payload[0x33] = 't'.charCodeAt(0);
    payload[0x34] = ' '.charCodeAt(0);
    payload[0x35] = ' '.charCodeAt(0);
    payload[0x36] = '1'.charCodeAt(0);

    const response = await this.request(0x65, payload);
    if (response.payload.length >= 0x14) {
      this.key = Buffer.alloc(0x10, 0);
      response.payload.copy(this.key, 0, 0x04, 0x14);
      this.id = Buffer.alloc(4, 0);
      response.payload.copy(this.id, 0, 0x00, 0x04);
      this.ready = true;
    }
    return this.ready;
  }

  async request(command, payload) {
    const count = (this.count + 1) & 0xffff;
    this.count = count;

    const packet = this._buildPacket(command, payload, count);
    const responsePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(count);
        reject(new Error(`Broadlink request timed out (${command.toString(16)})`));
      }, 4000);

      this.pending.set(count, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });

    await new Promise((resolve, reject) => {
      this.socket.send(packet, 0, packet.length, this.port, this.host.address, (error) => {
        if (error) {
          this.pending.delete(count);
          reject(error);
          return;
        }
        resolve();
      });
    });

    return responsePromise;
  }

  _buildPacket(command, payload, count) {
    let packet = Buffer.alloc(0x38, 0);
    packet[0x00] = 0x5a;
    packet[0x01] = 0xa5;
    packet[0x02] = 0xaa;
    packet[0x03] = 0x55;
    packet[0x04] = 0x5a;
    packet[0x05] = 0xa5;
    packet[0x06] = 0xaa;
    packet[0x07] = 0x55;
    packet[0x24] = this.type & 0xff;
    packet[0x25] = (this.type >> 8) & 0xff;
    packet[0x26] = command;
    packet[0x28] = count & 0xff;
    packet[0x29] = (count >> 8) & 0xff;
    packet[0x2a] = this.mac[2];
    packet[0x2b] = this.mac[1];
    packet[0x2c] = this.mac[0];
    packet[0x2d] = this.mac[3];
    packet[0x2e] = this.mac[4];
    packet[0x2f] = this.mac[5];
    packet[0x30] = this.id[0];
    packet[0x31] = this.id[1];
    packet[0x32] = this.id[2];
    packet[0x33] = this.id[3];

    let encryptedPayload = Buffer.alloc(0);
    if (payload && payload.length) {
      const padLength = 16 - (payload.length % 16);
      const padded = Buffer.concat([payload, Buffer.alloc(padLength || 16, 0)]);
      const cipher = crypto.createCipheriv('aes-128-cbc', this.key, this.iv);
      encryptedPayload = Buffer.concat([cipher.update(padded), cipher.final()]);
      let checksum = 0xbeaf;
      for (const byte of padded) {
        checksum = (checksum + byte) & 0xffff;
      }
      packet[0x34] = checksum & 0xff;
      packet[0x35] = (checksum >> 8) & 0xff;
    }

    packet = Buffer.concat([packet, encryptedPayload]);
    let checksum = 0xbeaf;
    for (const byte of packet) {
      checksum = (checksum + byte) & 0xffff;
    }
    packet[0x20] = checksum & 0xff;
    packet[0x21] = (checksum >> 8) & 0xff;
    return packet;
  }

  _handleMessage(message, rinfo) {
    if (!rinfo || rinfo.address !== this.host.address || rinfo.port !== this.port) {
      return;
    }

    if (message.length < 0x38) {
      return;
    }

    const count = message.readUInt16LE(0x28);
    const pending = this.pending.get(count);
    if (!pending) {
      return;
    }

    this.pending.delete(count);

    const err = message.readUInt16LE(0x22);
    if (err !== 0) {
      pending.reject(new Error(decodeBroadlinkError(err)));
      return;
    }

    const encryptedPayload = message.subarray(0x38);
    let payload = Buffer.alloc(0);

    if (encryptedPayload.length) {
      const decipher = crypto.createDecipheriv('aes-128-cbc', this.key, this.iv);
      payload = Buffer.concat([decipher.update(encryptedPayload), decipher.final()]);
    }

    pending.resolve({
      raw: message,
      payload,
      command: message[0x26],
    });
  }

  static async discover({ timeoutMs = 4000, log } = {}) {
    const sockets = [];
    const devices = new Map();

    const localIps = BroadlinkSession._getLocalIps();
    const finished = new Promise((resolve) => {
      setTimeout(resolve, timeoutMs);
    });

    const onMessage = (message, rinfo) => {
      if (message.length < 0x40) {
        return;
      }
      const mac = Buffer.alloc(6, 0);
      message.copy(mac, 0x00, 0x3f);
      message.copy(mac, 0x01, 0x3e);
      message.copy(mac, 0x02, 0x3d);
      message.copy(mac, 0x03, 0x3c);
      message.copy(mac, 0x04, 0x3b);
      message.copy(mac, 0x05, 0x3a);
      const deviceType = message[0x34] | (message[0x35] << 8);
      const key = mac.toString('hex');
      if (!devices.has(key)) {
        devices.set(key, {
          host: { address: rinfo.address, port: rinfo.port },
          mac,
          type: deviceType,
          macAddress: formatMac(mac),
        });
      }
    };

    try {
      for (const ipAddress of localIps) {
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        sockets.push(socket);
        await new Promise((resolve, reject) => {
          socket.once('listening', resolve);
          socket.once('error', reject);
          socket.bind(0, ipAddress);
        });
        socket.on('message', onMessage);
        socket.setBroadcast(true);
        const packet = BroadlinkSession._buildDiscoveryPacket(ipAddress, socket.address().port);
        socket.send(packet, 0, packet.length, 80, '255.255.255.255');
        if (log) {
          log.debug?.(`Broadlink discovery broadcast from ${ipAddress}:${socket.address().port}`);
        }
      }

      await finished;
    } finally {
      for (const socket of sockets) {
        try {
          socket.close();
        } catch (error) {
          // Ignore close errors.
        }
      }
    }

    return Array.from(devices.values());
  }

  static _buildDiscoveryPacket(ipAddress, port) {
    const packet = Buffer.alloc(0x30, 0);
    const now = new Date();
    const timezone = Math.round(-now.getTimezoneOffset() / 60);
    const splitIPAddress = ipAddress.split('.');
    const year = now.getFullYear();

    if (timezone < 0) {
      packet[0x08] = 0xff + timezone - 1;
      packet[0x09] = 0xff;
      packet[0x0a] = 0xff;
      packet[0x0b] = 0xff;
    } else {
      packet[0x08] = timezone;
      packet[0x09] = 0;
      packet[0x0a] = 0;
      packet[0x0b] = 0;
    }

    packet[0x0c] = year & 0xff;
    packet[0x0d] = year >> 8;
    packet[0x0e] = now.getMinutes();
    packet[0x0f] = now.getHours();
    packet[0x10] = year % 100;
    packet[0x11] = now.getDay();
    packet[0x12] = now.getDate();
    packet[0x13] = now.getMonth();
    packet[0x18] = parseInt(splitIPAddress[0], 10);
    packet[0x19] = parseInt(splitIPAddress[1], 10);
    packet[0x1a] = parseInt(splitIPAddress[2], 10);
    packet[0x1b] = parseInt(splitIPAddress[3], 10);
    packet[0x1c] = port & 0xff;
    packet[0x1d] = port >> 8;
    packet[0x26] = 0x06;

    let checksum = 0xbeaf;
    for (const byte of packet) {
      checksum = (checksum + byte) & 0xffff;
    }
    packet[0x20] = checksum & 0xff;
    packet[0x21] = (checksum >> 8) & 0xff;
    return packet;
  }

  static _getLocalIps() {
    const interfaces = os.networkInterfaces();
    const ips = [];

    for (const entries of Object.values(interfaces)) {
      for (const entry of entries || []) {
        if ((entry.family === 'IPv4' || entry.family === 4) && !entry.internal) {
          ips.push(entry.address);
        }
      }
    }

    return ips;
  }
}

class DooyaCurtain {
  constructor(session, log) {
    this.session = session;
    this.log = log;
  }

  async open(protocol = 'dooya') {
    if (protocol === 'dna') {
      return this._sendDnaStatus('curtain_work', 1);
    }
    return protocol === 'dooya2'
      ? this._sendDooya2(DOOYA_V2_COMMANDS.open)
      : this._sendDooya(0x01, 0x00);
  }

  async close(protocol = 'dooya') {
    if (protocol === 'dna') {
      return this._sendDnaStatus('curtain_work', 0);
    }
    return protocol === 'dooya2'
      ? this._sendDooya2(DOOYA_V2_COMMANDS.close)
      : this._sendDooya(0x02, 0x00);
  }

  async stop(protocol = 'dooya') {
    if (protocol === 'dna') {
      return this._sendDnaStatus('curtain_work', 2);
    }
    return protocol === 'dooya2'
      ? this._sendDooya2(DOOYA_V2_COMMANDS.stop)
      : this._sendDooya(0x03, 0x00);
  }

  async getPercentage(protocol = 'dooya') {
    if (protocol === 'dna') {
      return null;
    }
    if (protocol === 'dooya2') {
      return null;
    }
    return this._sendDooya(0x06, 0x5d);
  }

  async setPercentage(position, protocol = 'dooya') {
    if (protocol === 'dna') {
      const percent = clamp(Number(position), 0, 100);
      return this._sendDnaStatus('curtain_targetpos', percent);
    }
    if (protocol === 'dooya2') {
      const percent = clamp(Number(position), 0, 100);
      return this._sendDooya2(Buffer.from([percent, 0x70, 0xa0]));
    }

    throw new Error('Direct percentage setting is only available for Dooya DT360E-2');
  }

  async _sendDnaStatus(param, value) {
    const command = {
      did: this.session.deviceId || '',
      srv: this.session.serviceId || '',
      act: 'set',
      params: [param],
      vals: [[{ val: value, idx: 1 }]],
    };
    return this._sendDnaCommand(command);
  }

  async _sendDnaCommand(command) {
    const packet = Buffer.from(JSON.stringify(command), 'utf8');
    const response = await this.session.request(0x6a, packet);
    if (!response.payload || response.payload.length < 1) {
      return null;
    }
    return response.payload;
  }

  async _sendDooya(magic1, magic2) {
    const packet = Buffer.alloc(16, 0);
    packet[0x00] = 0x09;
    packet[0x02] = 0xbb;
    packet[0x03] = magic1;
    packet[0x04] = magic2;
    packet[0x09] = 0xfa;
    packet[0x0a] = 0x44;

    const response = await this.session.request(0x6a, packet);
    if (!response.payload || response.payload.length < 5) {
      return null;
    }

    return response.payload[4];
  }

  async _sendDooya2(command) {
    const payload = Buffer.isBuffer(command) ? Buffer.from(command) : Buffer.from(command || []);
    const packet = Buffer.alloc(0x0c + payload.length, 0);
    packet[0x02] = 0xa5;
    packet[0x03] = 0xa5;
    packet[0x04] = 0x5a;
    packet[0x05] = 0x5a;
    packet[0x08] = 0x01;
    packet[0x09] = 0x0b;
    packet[0x0a] = payload.length & 0xff;
    packet[0x0b] = (payload.length >> 8) & 0xff;
    payload.copy(packet, 0x0c);

    let checksum = 0xbeaf;
    for (const byte of packet) {
      checksum = (checksum + byte) & 0xffff;
    }
    packet[0x06] = checksum & 0xff;
    packet[0x07] = (checksum >> 8) & 0xff;

    const response = await this.session.request(0x6a, packet);
    if (!response.payload || response.payload.length < 1) {
      return null;
    }
    return response.payload[0];
  }
}

class DooyaCurtainAccessory {
  constructor(platform, config, session) {
    this.platform = platform;
    this.config = config;
    this.session = session;
    this.accessory = null;
    this.service = null;
    this.controller = new DooyaCurtain(session, platform.log);
    this.protocol = String(config.protocol || 'dooya').toLowerCase();
    this.queue = Promise.resolve();
    this.currentPosition = parsePosition(config.initialPosition, undefined);
    this.targetPosition = parsePosition(config.initialPosition, 0);
    this.positionState = platform.hap.Characteristic.PositionState.STOPPED;
    this.motionTimer = null;
    this.refreshTimer = null;
    this.lastKnownPosition = null;
  }

  get name() {
    return this.config.name;
  }

  async initialize(accessory) {
    this.accessory = accessory;
    const { Service, Characteristic, Categories } = this.platform.hap;

    accessory.getService(Service.AccessoryInformation)
      || accessory.addService(Service.AccessoryInformation);
    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Broadlink')
      .setCharacteristic(Characteristic.Model, this.protocol === 'dna' ? 'Dooya DT360E DNA' : this.protocol === 'dooya2' ? 'Dooya DT360E-2' : 'Dooya DT360E')
      .setCharacteristic(Characteristic.SerialNumber, this.config.mac || this.config.host || this.name);

    this.service = accessory.getService(Service.WindowCovering)
      || accessory.addService(Service.WindowCovering, this.name);

    accessory.category = Categories.WINDOW_COVERING;

    this.service
      .getCharacteristic(Characteristic.CurrentPosition)
      .onGet(() => this.getCurrentPosition())
      .onSet((value, callback) => this.setTargetPosition(value).then(() => callback()).catch(callback));

    this.service
      .getCharacteristic(Characteristic.TargetPosition)
      .onGet(() => this.getTargetPosition())
      .onSet((value, callback) => this.setTargetPosition(value).then(() => callback()).catch(callback));

    this.service
      .getCharacteristic(Characteristic.PositionState)
      .onGet(() => this.getPositionState());

    if (Characteristic.HoldPosition) {
      this.service
        .getCharacteristic(Characteristic.HoldPosition)
        .onSet((value, callback) => this.handleHoldPosition(value).then(() => callback()).catch(callback));
    }

    this._restoreContext(accessory.context || {});
    this._publishState();

    if (this.config.refreshOnStartup !== false) {
      this.refresh().catch((error) => {
        this.platform.log.warn(`Initial position refresh failed for ${this.name}: ${error.message}`);
      });
    }

    const pollInterval = Number(this.config.pollIntervalSeconds || 0);
    if (pollInterval > 0) {
      this.refreshTimer = setInterval(() => {
        this.refresh().catch((error) => {
          this.platform.log.debug?.(`Position refresh failed for ${this.name}: ${error.message}`);
        });
      }, pollInterval * 1000);
    }
  }

  shutdown() {
    if (this.motionTimer) {
      clearTimeout(this.motionTimer);
      this.motionTimer = null;
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  _restoreContext(context) {
    if (Number.isFinite(context.lastKnownPosition)) {
      this.currentPosition = parsePosition(context.lastKnownPosition, this.currentPosition ?? 0);
      this.lastKnownPosition = this.currentPosition;
    }
    if (Number.isFinite(context.targetPosition)) {
      this.targetPosition = parsePosition(context.targetPosition, this.targetPosition ?? 0);
    }
  }

  _persistContext() {
    if (!this.accessory) {
      return;
    }

    this.accessory.context.lastKnownPosition = this.lastKnownPosition;
    this.accessory.context.targetPosition = this.targetPosition;
    this.accessory.context.mac = this.config.mac || null;
    this.accessory.context.host = this.config.host || null;
  }

  _publishState() {
    const { Characteristic } = this.platform.hap;
    const currentPosition = this.getCurrentPosition();
    const targetPosition = this.getTargetPosition();
    const positionState = this.getPositionState();

    if (this.service) {
      this.service.updateCharacteristic(Characteristic.CurrentPosition, currentPosition);
      this.service.updateCharacteristic(Characteristic.TargetPosition, targetPosition);
      this.service.updateCharacteristic(Characteristic.PositionState, positionState);
    }

    this._persistContext();
  }

  getCurrentPosition() {
    if (Number.isFinite(this.currentPosition)) {
      return clamp(this.currentPosition, 0, 100);
    }
    if (Number.isFinite(this.lastKnownPosition)) {
      return clamp(this.lastKnownPosition, 0, 100);
    }
    return 0;
  }

  getTargetPosition() {
    return clamp(Number.isFinite(this.targetPosition) ? this.targetPosition : this.getCurrentPosition(), 0, 100);
  }

  getPositionState() {
    return this.positionState;
  }

  async refresh() {
    return;
  }

  async handleHoldPosition(value) {
    if (!value) {
      return;
    }
    await this.stopMotion();
  }

  async setTargetPosition(value) {
    const target = parsePosition(value, this.getTargetPosition());
    return this._enqueue(async () => {
      await this._moveTo(target);
    });
  }

  async stopMotion() {
    return this._enqueue(async () => {
      if (this.motionTimer) {
        clearTimeout(this.motionTimer);
        this.motionTimer = null;
      }
      await this.controller.stop(this.protocol);
      if (Number.isFinite(this.currentPosition)) {
        this.lastKnownPosition = this.currentPosition;
      }
      this.positionState = this.platform.hap.Characteristic.PositionState.STOPPED;
      this._publishState();
    });
  }

  async _moveTo(target) {
    const current = this.getCurrentPosition();
    this.targetPosition = target;

    if (target === current) {
      await this.controller.stop(this.protocol);
      this.positionState = this.platform.hap.Characteristic.PositionState.STOPPED;
      this._publishState();
      return;
    }

    const movingUp = target > current;
    const totalDuration = movingUp
      ? Number(this.config.totalDurationOpen || this.config.totalDuration || 30)
      : Number(this.config.totalDurationClose || this.config.totalDuration || 30);
    const duration = Math.max(1, Math.round(totalDuration * Math.abs(target - current) / 100));

    if (this.motionTimer) {
      clearTimeout(this.motionTimer);
      this.motionTimer = null;
    }

    this.positionState = movingUp
      ? this.platform.hap.Characteristic.PositionState.INCREASING
      : this.platform.hap.Characteristic.PositionState.DECREASING;
    this._publishState();

    try {
      if (this.protocol === 'dna') {
        await this.controller.setPercentage(target, this.protocol);
      } else {
        await (movingUp
          ? this.controller.open(this.protocol)
          : this.controller.close(this.protocol));
      }
    } catch (error) {
      this.targetPosition = current;
      this.positionState = this.platform.hap.Characteristic.PositionState.STOPPED;
      this._publishState();
      throw error;
    }

    this.motionTimer = setTimeout(async () => {
      try {
        await this.controller.stop(this.protocol);
      } catch (error) {
        this.platform.log.warn(`Failed to stop ${this.name}: ${error.message}`);
      } finally {
        this.motionTimer = null;
        this.currentPosition = target;
        this.lastKnownPosition = target;
        this.targetPosition = target;
        this.positionState = this.platform.hap.Characteristic.PositionState.STOPPED;
        this._publishState();
      }
    }, duration * 1000);
  }

  async _enqueue(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch((error) => {
      this.platform.log.error(`Curtain command failed for ${this.name}: ${error.message}`);
      return undefined;
    });
    return this.queue;
  }
}

class BroadlinkDooyaPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = [];
    this.curtains = [];
    this.sessions = [];
    this.hap = api.hap;

    api.on('didFinishLaunching', this.didFinishLaunching.bind(this));
    api.on('shutdown', this.shutdown.bind(this));
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }

  async didFinishLaunching() {
    const devices = Array.isArray(this.config.devices) ? this.config.devices : [];

    if (!devices.length) {
      this.log.warn('No devices configured for BroadlinkDooya, skipping startup.');
      return;
    }

    const discovered = await BroadlinkSession.discover({ timeoutMs: Number(this.config.discoveryTimeoutMs || 4000), log: this.log });
    const discoveredByMac = new Map(discovered.map((device) => [device.macAddress, device]));

    for (const deviceConfig of devices) {
      try {
        const resolved = await this._resolveDevice(deviceConfig, discoveredByMac);
        if (!resolved) {
          this.log.warn(`Could not resolve Broadlink device for ${deviceConfig.name}`);
          continue;
        }

        const sessionResult = await this._openSession(deviceConfig, resolved);
        const session = sessionResult.session;
        const protocol = sessionResult.protocol;
        this.sessions.push(session);

        const accessory = this._getAccessory(deviceConfig, resolved);
        const curtain = new DooyaCurtainAccessory(this, { ...deviceConfig, protocol }, session);
        await curtain.initialize(accessory);
        this.curtains.push(curtain);
        this.log.info(`Configured Dooya curtain ${deviceConfig.name} at ${resolved.host.address}`);
      } catch (error) {
        this.log.error(`Failed to configure ${deviceConfig.name}: ${error.message}`);
      }
    }
  }

  async _resolveDevice(deviceConfig, discoveredByMac) {
    const protocol = resolveProtocol(deviceConfig, Number(deviceConfig.type || 0));

    if (deviceConfig.mac) {
      const normalized = deviceConfig.mac.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
      const discovered = discoveredByMac.get(normalized);
      if (discovered) {
        return {
          ...discovered,
          host: {
            address: deviceConfig.host || discovered.host.address,
            port: Number(deviceConfig.port || discovered.host.port || 80),
          },
          type: Number(deviceConfig.type || discovered.type || 0x4e4d),
          protocol: resolveProtocol(deviceConfig, Number(deviceConfig.type || discovered.type || 0x4e4d)),
        };
      }
    }

    if (deviceConfig.host) {
      const found = Array.from(discoveredByMac.values()).find((device) => device.host.address === deviceConfig.host);
      if (found) {
        return {
          ...found,
          host: {
            address: deviceConfig.host,
            port: Number(deviceConfig.port || found.host.port || 80),
          },
          type: Number(deviceConfig.type || found.type || 0x4e4d),
          protocol: resolveProtocol(deviceConfig, Number(deviceConfig.type || found.type || 0x4e4d)),
        };
      }
    }

    if (deviceConfig.host && deviceConfig.mac) {
      const mac = parseMac(deviceConfig.mac);
      if (!mac) {
        throw new Error(`Invalid MAC address for ${deviceConfig.name}: ${deviceConfig.mac}`);
      }

      return {
        host: { address: deviceConfig.host, port: Number(deviceConfig.port || 80) },
        mac,
        type: Number(deviceConfig.type || 0x4e4d),
        protocol,
      };
    }

    if (deviceConfig.host || deviceConfig.mac) {
      const mac = parseMac(deviceConfig.mac);
      if (!mac) {
        throw new Error(`Invalid MAC address for ${deviceConfig.name}: ${deviceConfig.mac}`);
      }
      return {
        host: { address: deviceConfig.host, port: Number(deviceConfig.port || 80) },
        mac,
        type: Number(deviceConfig.type || 0x4e4d),
        protocol,
      };
    }

    const firstDooya = Array.from(discoveredByMac.values()).find((device) => DOOYA_TYPES.has(device.type));
    if (!firstDooya) {
      return null;
    }

    return {
      ...firstDooya,
      protocol: resolveProtocol(deviceConfig, firstDooya.type),
    };
  }

  async _openSession(deviceConfig, resolved) {
    const typeCandidates = [];
    const preferredType = Number(deviceConfig.type || resolved.type || 0x4e4d);
    const discoveredType = Number(resolved.type || 0);
    const alternateType = getAlternateDooyaType(preferredType);

    if (Number.isFinite(preferredType)) {
      typeCandidates.push(preferredType);
    }
    if (Number.isFinite(discoveredType)) {
      typeCandidates.push(discoveredType);
    }
    if (Number.isFinite(alternateType)) {
      typeCandidates.push(alternateType);
    }

    const uniqueTypes = [...new Set(typeCandidates.filter((type) => Number.isFinite(type)))];
    let lastError = null;

    for (const type of uniqueTypes) {
      const session = new BroadlinkSession({
        host: resolved.host,
        mac: resolved.mac,
        type,
        port: resolved.host.port || 80,
        log: this.log,
        debug: Boolean(this.config.debug),
        name: deviceConfig.name,
        deviceId: deviceConfig.did || deviceConfig.deviceId,
        serviceId: deviceConfig.serviceId || deviceConfig.srv || '112.1.173',
        controlKey: deviceConfig.controlKey || deviceConfig.aesKey || deviceConfig.aeskey,
        controlId: deviceConfig.controlId || deviceConfig.terminalId || deviceConfig.terminalid,
      });

      try {
        const ready = await session.authenticate();
        if (!ready) {
          throw new Error('Broadlink authentication failed');
        }
        return {
          session,
          protocol: resolveProtocol({ ...deviceConfig, type }, type),
        };
      } catch (error) {
        lastError = error;
        await session.close();
      }
    }

    throw lastError || new Error(`Unable to authenticate ${deviceConfig.name}`);
  }

  _getAccessory(deviceConfig, resolved) {
    const uuid = this.api.hap.uuid.generate(`${deviceConfig.name}-${deviceConfig.mac || resolved.macAddress || resolved.host.address}`);
    let accessory = this.accessories.find((item) => item.UUID === uuid);

    if (!accessory) {
      accessory = new this.api.platformAccessory(deviceConfig.name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    accessory.displayName = deviceConfig.name;
    return accessory;
  }

  async shutdown() {
    for (const curtain of this.curtains) {
      curtain.shutdown();
    }
    this.curtains = [];

    for (const session of this.sessions) {
      await session.close();
    }
    this.sessions = [];
  }
}

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, BroadlinkDooyaPlatform);
};

module.exports.PLUGIN_NAME = PLUGIN_NAME;
module.exports.PLATFORM_NAME = PLATFORM_NAME;
