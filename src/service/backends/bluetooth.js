// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Config from '../../config.js';
import * as Core from '../core.js';
import Device from '../device.js';
import * as DBus from '../utils/dbus.js';

// Retain compatibility with GLib < 2.80, which lacks GioUnix
let GioUnix;
try {
    GioUnix = (await import('gi://GioUnix')).default;
} catch {
    GioUnix = {
        InputStream: Gio.UnixInputStream,
        OutputStream: Gio.UnixOutputStream,
    };
}

const BLUEZ_NAME = 'org.bluez';
const BLUEZ_ROOT_PATH = '/';
const BLUEZ_PROFILE_PATH = `${Config.APP_PATH}/BluetoothProfile`;
const BLUEZ_SERVICE_UUID = '185f3df4-3268-4e3f-9fca-d4d5059915bd';
const BLUEZ_RFCOMM_CHANNEL = 6;

const DEVICE_IFACE = 'org.bluez.Device1';
const OBJECT_MANAGER_IFACE = 'org.freedesktop.DBus.ObjectManager';
const PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties';
const PROFILE_MANAGER_IFACE = 'org.bluez.ProfileManager1';

const MULTIPLEX_VERSION = 1;
const MULTIPLEX_BUFFER_SIZE = 4096;
const MULTIPLEX_DEFAULT_CHANNEL = 'a0d0aaf4-1072-4d81-aa35-902a954b1266';
const CONNECT_RETRY_SECONDS = 15;
const CONNECT_DELAY_MS = 20000;

const MESSAGE_PROTOCOL_VERSION = 0;
const MESSAGE_OPEN_CHANNEL = 1;
const MESSAGE_CLOSE_CHANNEL = 2;
const MESSAGE_READ = 3;
const MESSAGE_WRITE = 4;

const PROFILE_NODE = Gio.DBusNodeInfo.new_for_xml(`
<node>
  <interface name="org.bluez.Profile1">
    <method name="Release"/>
    <method name="NewConnection">
      <arg direction="in" type="o" name="device"/>
      <arg direction="in" type="h" name="fd"/>
      <arg direction="in" type="a{sv}" name="fd_properties"/>
    </method>
    <method name="RequestDisconnection">
      <arg direction="in" type="o" name="device"/>
    </method>
  </interface>
</node>
`);
const PROFILE_IFACE = PROFILE_NODE.lookup_interface('org.bluez.Profile1');


function _cancelledError() {
    return new Gio.IOErrorEnum({
        code: Gio.IOErrorEnum.CANCELLED,
        message: 'Operation cancelled',
    });
}


function _closedError(message = 'Connection closed') {
    return new Gio.IOErrorEnum({
        code: Gio.IOErrorEnum.CONNECTION_CLOSED,
        message: message,
    });
}


function _readBytesAsync(stream, count, cancellable = null) {
    return new Promise((resolve, reject) => {
        stream.read_bytes_async(count, GLib.PRIORITY_DEFAULT, cancellable,
            (stream_, res) => {
                try {
                    resolve(stream_.read_bytes_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}


function _sleepAsync(milliseconds) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}


function _appendBytes(current, addition) {
    if (current.length === 0)
        return addition.slice();

    if (addition.length === 0)
        return current.slice();

    const combined = new Uint8Array(current.length + addition.length);
    combined.set(current, 0);
    combined.set(addition, current.length);
    return combined;
}


function _decodeUtf8(bytes) {
    return new TextDecoder().decode(bytes);
}


function _encodeUtf8(text) {
    return new TextEncoder().encode(text);
}


function _readUint16(bytes, offset = 0) {
    return (bytes[offset] << 8) | bytes[offset + 1];
}


function _writeUint16(value) {
    return new Uint8Array([
        (value >> 8) & 0xff,
        value & 0xff,
    ]);
}


function _uuidToBytes(uuid) {
    const hex = uuid.replaceAll('-', '').toLowerCase();
    const bytes = new Uint8Array(16);

    for (let i = 0; i < 16; i++)
        bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);

    return bytes;
}


function _bytesToUuid(bytes) {
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'))
        .join('');

    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20),
    ].join('-');
}


function _toUint8Array(data) {
    if (data instanceof Uint8Array)
        return data;

    if (data instanceof GLib.Bytes)
        return Uint8Array.from(data.toArray());

    if (typeof data === 'string')
        return _encodeUtf8(data);

    if (Array.isArray(data))
        return Uint8Array.from(data);

    return new Uint8Array(data);
}


function _buildMessage(type, uuid, data = new Uint8Array()) {
    data = _toUint8Array(data);

    const message = new Uint8Array(19 + data.length);
    message[0] = type;
    message.set(_writeUint16(data.length), 1);

    if (uuid !== null)
        message.set(_uuidToBytes(uuid), 3);

    message.set(data, 19);
    return message;
}


function _loadResource(relativePath) {
    const localPaths = [
        GLib.build_filenamev([Config.PACKAGE_DATADIR, relativePath]),
    ];

    const modulePath = Gio.File.new_for_uri(import.meta.url).get_path();

    if (modulePath !== null) {
        localPaths.unshift(GLib.build_filenamev([
            GLib.path_get_dirname(GLib.path_get_dirname(GLib.path_get_dirname(modulePath))),
            relativePath,
        ]));
    }

    for (const localPath of localPaths) {
        if (GLib.file_test(localPath, GLib.FileTest.EXISTS))
            return String.fromCharCode(...GLib.file_get_contents(localPath)[1]);
    }

    const bytes = Gio.resources_lookup_data(
        GLib.build_filenamev([Config.APP_PATH, relativePath]),
        Gio.ResourceLookupFlags.NONE
    );

    return _decodeUtf8(Uint8Array.from(bytes.toArray()));
}


function _getDeviceSettings(id) {
    return new Gio.Settings({
        settings_schema: Config.GSCHEMA.lookup(
            'org.gnome.Shell.Extensions.GSConnect.Device',
            true
        ),
        path: `/org/gnome/shell/extensions/gsconnect/device/${id}/`,
    });
}


function _normalizeCertificate(certificate) {
    if (!certificate)
        throw new Error('missing certificate');

    if (!certificate.startsWith('-----BEGIN CERTIFICATE-----')) {
        certificate = certificate.trim();
        certificate = `-----BEGIN CERTIFICATE-----\n${certificate}\n-----END CERTIFICATE-----\n`;
    }

    return certificate;
}


function _validateIdentity(identity) {
    if (identity.type !== 'kdeconnect.identity')
        throw new Error(`unexpected packet type "${identity.type}"`);

    if (!identity.body.deviceId)
        throw new Error('missing deviceId');

    if (!Device.validateId(identity.body.deviceId))
        throw new Error(`invalid deviceId "${identity.body.deviceId}"`);

    if (!identity.body.deviceName)
        throw new Error('missing deviceName');

    if (!Device.validateName(identity.body.deviceName)) {
        const sanitized = Device.sanitizeName(identity.body.deviceName);
        debug(`Sanitized invalid device name "${identity.body.deviceName}" to "${sanitized}"`);
        identity.body.deviceName = sanitized;
    }

    if (!identity.body.certificate)
        throw new Error('missing certificate');
}


function _verifyCertificate(identity, peerCertificate) {
    const settings = _getDeviceSettings(identity.body.deviceId);
    const storedPem = settings.get_string('certificate-pem');
    settings.run_dispose();

    if (storedPem === '')
        return;

    let storedCertificate = null;
    let verified = false;

    try {
        storedCertificate = Gio.TlsCertificate.new_from_pem(storedPem, -1);
        verified = storedCertificate.is_same(peerCertificate);
    } catch (e) {
        logError(e);
    }

    if (verified)
        return;

    const deviceSettings = _getDeviceSettings(identity.body.deviceId);
    deviceSettings.reset('paired');
    deviceSettings.reset('certificate-pem');
    deviceSettings.run_dispose();

    throw new Error(`${identity.body.deviceName}: Authentication Failure`);
}


class MultiplexSubchannel {

    constructor(multiplexer, state) {
        this._multiplexer = multiplexer;
        this._state = state;
    }

    get connected() {
        return this._state.connected;
    }

    get uuid() {
        return this._state.uuid;
    }

    _consume(length) {
        const data = this._state.readBuffer.slice(0, length);
        this._state.readBuffer = this._state.readBuffer.slice(length);
        this._multiplexer.requestRead(this._state);
        return data;
    }

    _wait(kind, cancellable = null) {
        return this._multiplexer.wait(this._state, kind, cancellable);
    }

    close() {
        this._multiplexer.closeChannel(this.uuid);
    }

    async readChunk(length = MULTIPLEX_BUFFER_SIZE, cancellable = null) {
        while (this._state.readBuffer.length === 0) {
            if (!this.connected)
                return null;

            await this._wait('read', cancellable);
        }

        return this._consume(Math.min(length, this._state.readBuffer.length));
    }

    async readLine(cancellable = null) {
        while (true) {
            const newline = this._state.readBuffer.indexOf(0x0a);

            if (newline > -1)
                return _decodeUtf8(this._consume(newline + 1));

            if (!this.connected)
                throw _closedError('End of stream');

            this._multiplexer.requestRead(this._state);
            await this._wait('read', cancellable);
        }
    }

    async spliceFrom(source, size = 0, cancellable = null) {
        let transferred = 0;

        while (size === 0 || transferred < size) {
            const remaining = (size > 0)
                ? Math.min(MULTIPLEX_BUFFER_SIZE, size - transferred)
                : MULTIPLEX_BUFFER_SIZE;
            const bytes = await _readBytesAsync(source, remaining, cancellable);

            if (bytes.get_size() === 0)
                break;

            const chunk = Uint8Array.from(bytes.toArray());
            await this.write(chunk, cancellable);
            transferred += chunk.length;
        }

        this.close();
        return transferred;
    }

    async spliceTo(target, size = -1, cancellable = null) {
        let transferred = 0;

        while (size < 0 || transferred < size) {
            const remaining = (size < 0)
                ? MULTIPLEX_BUFFER_SIZE
                : Math.min(MULTIPLEX_BUFFER_SIZE, size - transferred);
            const chunk = await this.readChunk(remaining, cancellable);

            if (chunk === null)
                break;

            await target.write_all_async(chunk, GLib.PRIORITY_DEFAULT,
                cancellable);
            transferred += chunk.length;
        }

        this.close();
        return transferred;
    }

    async write(data, cancellable = null) {
        data = _toUint8Array(data);

        if (data.length === 0)
            return;

        this._state.writeBuffer = _appendBytes(this._state.writeBuffer, data);

        while (this._state.writeBuffer.length > 0) {
            if (!this.connected)
                throw _closedError('Channel is closed');

            await this._multiplexer.flushChannel(this._state, cancellable);

            if (this._state.writeBuffer.length > 0)
                await this._wait('write', cancellable);
        }
    }
}


class ConnectionMultiplexer {

    constructor(inputStream, outputStream) {
        this._cancellable = new Gio.Cancellable();
        this._inputStream = inputStream;
        this._outputStream = outputStream;
        this._receiveBuffer = new Uint8Array();
        this._channels = new Map();
        this._channelWaiters = new Map();
        this._writeChain = Promise.resolve();
        this._closed = false;
        this._receivedProtocolVersion = false;

        this._sendMessage(
            MESSAGE_PROTOCOL_VERSION,
            null,
            new Uint8Array([0x00, MULTIPLEX_VERSION, 0x00, MULTIPLEX_VERSION])
        ).catch(this._onError.bind(this));

        const defaultState = this._addChannel(MULTIPLEX_DEFAULT_CHANNEL);
        this.requestRead(defaultState);

        this._readLoop();
    }

    get defaultChannel() {
        return this._channels.get(MULTIPLEX_DEFAULT_CHANNEL)?.wrapper || null;
    }

    _addChannel(uuid) {
        if (this._channels.has(uuid))
            return this._channels.get(uuid);

        const state = {
            uuid: uuid,
            connected: true,
            closeAfterWrite: false,
            readBuffer: new Uint8Array(),
            readWaiters: [],
            requestedReadAmount: 0,
            freeWriteAmount: 0,
            writeBuffer: new Uint8Array(),
            writeWaiters: [],
            wrapper: null,
        };

        state.wrapper = new MultiplexSubchannel(this, state);
        this._channels.set(uuid, state);

        const waiters = this._channelWaiters.get(uuid) || [];
        this._channelWaiters.delete(uuid);

        for (const resolve of waiters)
            resolve(state.wrapper);

        return state;
    }

    async _readLoop() {
        try {
            while (!this._closed) {
                const bytes = await _readBytesAsync(this._inputStream,
                    MULTIPLEX_BUFFER_SIZE, this._cancellable);

                if (bytes.get_size() === 0)
                    throw _closedError();

                this._receiveBuffer = _appendBytes(this._receiveBuffer,
                    Uint8Array.from(bytes.toArray()));
                this._processMessages();
            }
        } catch (e) {
            this._onError(e);
        }
    }

    _notify(state, kind) {
        const waiters = (kind === 'read')
            ? state.readWaiters
            : state.writeWaiters;

        while (waiters.length > 0)
            waiters.shift()();
    }

    _onError(error) {
        if (this._closed)
            return;

        if (!(error instanceof GLib.Error) ||
            !error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            debug(error, 'Bluetooth');

        this.close();
    }

    _processMessages() {
        while (this._receiveBuffer.length >= 19) {
            const messageType = this._receiveBuffer[0];
            const messageLength = _readUint16(this._receiveBuffer, 1);

            if (this._receiveBuffer.length < 19 + messageLength)
                return;

            const uuidBytes = this._receiveBuffer.slice(3, 19);
            const messageUuid = _bytesToUuid(uuidBytes);
            const data = this._receiveBuffer.slice(19, 19 + messageLength);
            this._receiveBuffer = this._receiveBuffer.slice(19 + messageLength);

            this._handleMessage(messageType, messageUuid, data);
        }
    }

    _handleMessage(type, uuid, data) {
        switch (type) {
            case MESSAGE_PROTOCOL_VERSION:
                if (data.length < 4)
                    throw new Error('Invalid multiplex version packet');

                if (_readUint16(data, 0) > MULTIPLEX_VERSION ||
                    _readUint16(data, 2) < MULTIPLEX_VERSION)
                    throw new Error('Unsupported Bluetooth multiplex version');

                this._receivedProtocolVersion = true;
                break;

            case MESSAGE_OPEN_CHANNEL: {
                const state = this._addChannel(uuid);
                this.requestRead(state);
                break;
            }

            case MESSAGE_CLOSE_CHANNEL: {
                const state = this._channels.get(uuid);

                if (state === undefined)
                    return;

                this._channels.delete(uuid);
                state.connected = false;
                this._notify(state, 'read');
                this._notify(state, 'write');
                break;
            }

            case MESSAGE_READ: {
                const state = this._channels.get(uuid);

                if (state === undefined || !state.connected || data.length !== 2)
                    return;

                state.freeWriteAmount += _readUint16(data, 0);
                this._notify(state, 'write');
                this.flushChannel(state).catch(this._onError.bind(this));
                break;
            }

            case MESSAGE_WRITE: {
                const state = this._channels.get(uuid);

                if (state === undefined || !state.connected)
                    return;

                state.requestedReadAmount = Math.max(0,
                    state.requestedReadAmount - data.length);
                state.readBuffer = _appendBytes(state.readBuffer, data);
                this._notify(state, 'read');
                break;
            }
        }
    }

    _sendMessage(type, uuid, data = new Uint8Array(), cancellable = null) {
        if (cancellable === null)
            cancellable = this._cancellable;

        const payload = _buildMessage(type, uuid, data);
        const previous = this._writeChain.catch(() => {});

        const operation = previous.then(async () => {
            if (this._closed)
                throw _closedError();

            await this._outputStream.write_all_async(payload,
                GLib.PRIORITY_DEFAULT, cancellable);
        });

        this._writeChain = operation.catch(() => {});
        return operation;
    }

    acquireChannel(uuid, cancellable = null) {
        const state = this._channels.get(uuid);

        if (state !== undefined)
            return Promise.resolve(state.wrapper);

        return new Promise((resolve, reject) => {
            const waiters = this._channelWaiters.get(uuid) || [];
            waiters.push(resolve);
            this._channelWaiters.set(uuid, waiters);

            let cancelledId = 0;

            if (cancellable instanceof Gio.Cancellable) {
                if (cancellable.is_cancelled()) {
                    reject(_cancelledError());
                    return;
                }

                cancelledId = cancellable.connect(() => {
                    const channelWaiters = this._channelWaiters.get(uuid) || [];
                    const index = channelWaiters.indexOf(resolve);

                    if (index > -1)
                        channelWaiters.splice(index, 1);

                    if (channelWaiters.length === 0)
                        this._channelWaiters.delete(uuid);

                    reject(_cancelledError());
                });
            }

            const wrappedResolve = (channel) => {
                if (cancelledId > 0)
                    cancellable.disconnect(cancelledId);

                resolve(channel);
            };

            waiters[waiters.length - 1] = wrappedResolve;
        });
    }

    close() {
        if (this._closed)
            return;

        this._closed = true;
        this._cancellable.cancel();

        for (const state of this._channels.values()) {
            state.connected = false;
            this._notify(state, 'read');
            this._notify(state, 'write');
        }

        this._channels.clear();

        for (const waiters of this._channelWaiters.values()) {
            for (const resolve of waiters)
                resolve(null);
        }

        this._channelWaiters.clear();

        this._inputStream.close_async(GLib.PRIORITY_DEFAULT, null, null);
        this._outputStream.close_async(GLib.PRIORITY_DEFAULT, null, null);
    }

    closeChannel(uuid) {
        const state = this._channels.get(uuid);

        if (state === undefined)
            return;

        state.closeAfterWrite = true;
        state.readBuffer = new Uint8Array();

        if (state.writeBuffer.length > 0)
            return;

        this._channels.delete(uuid);
        state.connected = false;
        this._notify(state, 'read');
        this._notify(state, 'write');

        this._sendMessage(MESSAGE_CLOSE_CHANNEL, uuid).catch(
            this._onError.bind(this));
    }

    async flushChannel(state, cancellable = null) {
        while (state.connected && state.writeBuffer.length > 0 &&
               state.freeWriteAmount > 0) {
            const length = Math.min(state.writeBuffer.length,
                state.freeWriteAmount);
            const chunk = state.writeBuffer.slice(0, length);

            state.writeBuffer = state.writeBuffer.slice(length);
            state.freeWriteAmount -= length;

            await this._sendMessage(MESSAGE_WRITE, state.uuid, chunk,
                cancellable);
            this._notify(state, 'write');
        }

        if (state.connected && state.writeBuffer.length === 0 &&
            state.closeAfterWrite)
            this.closeChannel(state.uuid);
    }

    openChannel() {
        const uuid = GLib.uuid_string_random().toLowerCase();
        const state = this._addChannel(uuid);

        this.requestRead(state);
        this._sendMessage(MESSAGE_OPEN_CHANNEL, uuid).catch(
            this._onError.bind(this));

        return state.wrapper;
    }

    requestRead(state) {
        if (!state.connected)
            return;

        const readAmount = MULTIPLEX_BUFFER_SIZE -
            state.readBuffer.length - state.requestedReadAmount;

        if (readAmount <= 0)
            return;

        state.requestedReadAmount += readAmount;
        this._sendMessage(MESSAGE_READ, state.uuid, _writeUint16(readAmount))
            .catch(this._onError.bind(this));
    }

    tryGetChannel(uuid) {
        return this._channels.get(uuid)?.wrapper || null;
    }

    wait(state, kind, cancellable = null) {
        return new Promise((resolve, reject) => {
            const waiters = (kind === 'read')
                ? state.readWaiters
                : state.writeWaiters;
            const waiter = () => {
                if (cancelledId > 0)
                    cancellable.disconnect(cancelledId);

                resolve();
            };

            let cancelledId = 0;

            if (cancellable instanceof Gio.Cancellable) {
                if (cancellable.is_cancelled()) {
                    reject(_cancelledError());
                    return;
                }

                cancelledId = cancellable.connect(() => {
                    const index = waiters.indexOf(waiter);

                    if (index > -1)
                        waiters.splice(index, 1);

                    reject(_cancelledError());
                });
            }

            waiters.push(waiter);
        });
    }
}


const Profile = GObject.registerClass({
    GTypeName: 'GSConnectBluetoothProfile',
}, class Profile extends GObject.Object {

    _init(service) {
        super._init();
        this._service = service;
    }

    NewConnection(devicePath, fd, properties) {
        this._service.onNewConnection(devicePath, fd, properties);
    }

    Release() {
        this._service.onProfileReleased();
    }

    RequestDisconnection(devicePath) {
        this._service.onRequestDisconnection(devicePath);
    }
});


export const ChannelService = GObject.registerClass({
    GTypeName: 'GSConnectBluetoothChannelService',
}, class BluetoothChannelService extends Core.ChannelService {

    _init(params = {}) {
        super._init(params);

        this._registered = false;
        this._connectAttempts = new Map();
        this._connectTimers = new Map();
        this._deviceInfos = new Map();
        this._devicePaths = new Map();
        this._pendingOutgoing = new Set();
        this._profileExport = null;
        this._startPromise = null;
        this._system = null;
    }

    get certificate() {
        if (this._certificate === undefined)
            this._certificate = null;

        return this._certificate;
    }

    get channels() {
        if (this._channels === undefined)
            this._channels = new Map();

        return this._channels;
    }

    _addressFromDevicePath(devicePath) {
        const match = /dev_([0-9A-F_]+)$/i.exec(devicePath);

        if (!match)
            return null;

        return match[1].replaceAll('_', ':').toUpperCase();
    }

    _getCandidateDevices() {
        const result = this._system.call_sync(
            BLUEZ_NAME,
            BLUEZ_ROOT_PATH,
            OBJECT_MANAGER_IFACE,
            'GetManagedObjects',
            null,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null
        );

        const [objects] = result.recursiveUnpack();
        const devices = [];

        this._deviceInfos.clear();
        this._devicePaths.clear();

        for (const [path, interfaces] of Object.entries(objects)) {
            const info = interfaces[DEVICE_IFACE];

            if (info === undefined)
                continue;

            const address = info.Address?.toUpperCase();

            if (address)
                this._devicePaths.set(address, path);

            this._deviceInfos.set(path, info);

            if (!info.Paired || info.Blocked)
                continue;

            if (!Array.isArray(info.UUIDs) ||
                !info.UUIDs.includes(BLUEZ_SERVICE_UUID))
                continue;

            debug(`candidate ${info.Name || info.Alias || address || path} (${address || path})`, 'Bluetooth');
            devices.push({path: path, info: info});
        }

        return devices;
    }

    _getDevicePath(address) {
        if (address.startsWith('/org/bluez/'))
            return address;

        address = address.toUpperCase();

        if (this._devicePaths.has(address))
            return this._devicePaths.get(address);

        this._getCandidateDevices();
        return this._devicePaths.get(address) || null;
    }

    _getDeviceInfo(devicePath) {
        if (this._deviceInfos.has(devicePath))
            return this._deviceInfos.get(devicePath);

        const result = this._system.call_sync(
            BLUEZ_NAME,
            devicePath,
            PROPERTIES_IFACE,
            'GetAll',
            new GLib.Variant('(s)', [DEVICE_IFACE]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null
        );

        const [info] = result.recursiveUnpack();

        this._deviceInfos.set(devicePath, info);

        if (info.Address)
            this._devicePaths.set(info.Address.toUpperCase(), devicePath);

        return info;
    }

    _initCertificate() {
        this._certificate = Gio.TlsCertificate.new_for_paths(
            GLib.build_filenamev([Config.CONFIGDIR, 'certificate.pem']),
            GLib.build_filenamev([Config.CONFIGDIR, 'private.pem']),
            null
        );
    }

    async _registerProfile() {
        const options = {
            'Name': new GLib.Variant('s', 'GSConnect'),
            'Service': new GLib.Variant('s', BLUEZ_SERVICE_UUID),
            'Role': new GLib.Variant('s', 'server'),
            'Channel': new GLib.Variant('q', BLUEZ_RFCOMM_CHANNEL),
            'RequireAuthentication': new GLib.Variant('b', true),
            'ServiceRecord': new GLib.Variant('s',
                _loadResource(`${Config.APP_ID}.sdp.xml`)),
        };

        await this._system.call(
            BLUEZ_NAME,
            '/org/bluez',
            PROFILE_MANAGER_IFACE,
            'RegisterProfile',
            new GLib.Variant('(osa{sv})', [
                BLUEZ_PROFILE_PATH,
                BLUEZ_SERVICE_UUID,
                options,
            ]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null
        );

        this._registered = true;
    }

    _unregisterProfile() {
        if (!this._registered)
            return;

        try {
            this._system.call_sync(
                BLUEZ_NAME,
                '/org/bluez',
                PROFILE_MANAGER_IFACE,
                'UnregisterProfile',
                new GLib.Variant('(o)', [BLUEZ_PROFILE_PATH]),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null
            );
        } catch (e) {
            if (!e.matches || !e.matches(Gio.DBusError,
                Gio.DBusError.UNKNOWN_METHOD))
                debug(e, 'Bluetooth');
        }

        this._registered = false;
    }

    buildIdentity() {
        super.buildIdentity();

        this.identity.body.incomingCapabilities = this.identity.body.incomingCapabilities
            .filter(type => type !== 'kdeconnect.sftp');
        this.identity.body.outgoingCapabilities = this.identity.body.outgoingCapabilities
            .filter(type => type !== 'kdeconnect.sftp.request');
        this.identity.body.certificate = this.certificate.certificate_pem;
    }

    broadcast(address = null) {
        try {
            if (!this.active && this._startPromise === null)
                return;

            if (!this._registered) {
                void this._startAsync().then(() => this.broadcast(address))
                    .catch(e => debug(e, 'Bluetooth'));
                return;
            }

            if (typeof address === 'string') {
                const devicePath = this._getDevicePath(address);

                if (devicePath !== null)
                    this._scheduleConnectDevice(devicePath,
                        this._getDeviceInfo(devicePath));

                return;
            }

            for (const device of this._getCandidateDevices())
                this._scheduleConnectDevice(device.path, device.info);
        } catch (e) {
            logError(e, 'Bluetooth');
        }
    }

    _scheduleConnectDevice(devicePath, info = null) {
        info = info || this._getDeviceInfo(devicePath);

        const address = info.Address?.toUpperCase() ||
            this._addressFromDevicePath(devicePath);
        const uri = (address !== null) ? `bluetooth://${address}` : null;

        if (uri !== null && this.channels.has(uri))
            return;

        if (this._pendingOutgoing.has(devicePath) ||
            this._connectTimers.has(devicePath))
            return;

        const timerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            CONNECT_DELAY_MS,
            () => {
                this._connectTimers.delete(devicePath);

                if (uri !== null && this.channels.has(uri))
                    return GLib.SOURCE_REMOVE;

                this._connectDevice(devicePath, info);
                return GLib.SOURCE_REMOVE;
            }
        );

        this._connectTimers.set(devicePath, timerId);
        debug(`delay ConnectProfile ${info.Name || info.Alias || address || devicePath} (${address || devicePath})`, 'Bluetooth');
    }

    _unscheduleConnectDevice(devicePath) {
        const timerId = this._connectTimers.get(devicePath);

        if (!timerId)
            return;

        GLib.Source.remove(timerId);
        this._connectTimers.delete(devicePath);
    }

    _connectDevice(devicePath, info = null) {
        info = info || this._getDeviceInfo(devicePath);

        const address = info.Address?.toUpperCase() ||
            this._addressFromDevicePath(devicePath);
        const uri = (address !== null) ? `bluetooth://${address}` : null;

        if (uri !== null && this.channels.has(uri))
            return;

        if (this._pendingOutgoing.has(devicePath))
            return;

        const now = Math.floor(GLib.get_monotonic_time() / 1000000);
        const lastAttempt = this._connectAttempts.get(devicePath) || 0;

        if ((now - lastAttempt) < CONNECT_RETRY_SECONDS)
            return;

        this._connectAttempts.set(devicePath, now);
        this._pendingOutgoing.add(devicePath);

        debug(`ConnectProfile ${info.Name || info.Alias || address || devicePath} (${address || devicePath})`, 'Bluetooth');

        this._system.call(
            BLUEZ_NAME,
            devicePath,
            DEVICE_IFACE,
            'ConnectProfile',
            new GLib.Variant('(s)', [BLUEZ_SERVICE_UUID]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null
        ).catch(e => {
            this._pendingOutgoing.delete(devicePath);

            if (e.message?.includes('InProgress') ||
                e.message?.includes('AlreadyConnected'))
                return;

            debug(e, address || devicePath);
        });
    }

    async _startAsync() {
        if (this._startPromise !== null)
            return this._startPromise;

        this._startPromise = (async () => {
            if (this.certificate === null)
                this._initCertificate();

            if (this._system === null)
                this._system = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);

            if (this._profileExport === null) {
                this._profile = new Profile(this);
                this._profileExport = new DBus.Interface({
                    g_connection: this._system,
                    g_instance: this._profile,
                    g_interface_info: PROFILE_IFACE,
                    g_object_path: BLUEZ_PROFILE_PATH,
                });
            }

            this.buildIdentity();
            await this._registerProfile();

            this._active = true;
            this.notify('active');
        })().catch(e => {
            this._active = false;
            this.notify('active');

            const app = Gio.Application.get_default();

            if (app?.notify_error)
                app.notify_error(e);
            else
                logError(e, 'Bluetooth');

            throw e;
        }).finally(() => {
            this._startPromise = null;
        });

        return this._startPromise;
    }

    onNewConnection(devicePath, fd, properties) {
        debug(`NewConnection ${devicePath}`, 'Bluetooth');
        void this._handleNewConnection(devicePath, fd);
    }

    async _handleNewConnection(devicePath, fd) {
        const info = this._getDeviceInfo(devicePath);
        const address = info.Address?.toUpperCase() ||
            this._addressFromDevicePath(devicePath);
        const uri = `bluetooth://${address}`;
        this._unscheduleConnectDevice(devicePath);
        const isOutgoing = this._pendingOutgoing.delete(devicePath);
        const existing = this.channels.get(uri);
        debug(`handle connection ${info.Name || info.Alias || address} ${isOutgoing ? 'outgoing' : 'incoming'} (${uri})`, 'Bluetooth');
        const channel = new Channel({
            backend: this,
            bluetooth_address: address,
            certificate: this.certificate,
            devicePath: devicePath,
        });

        this.channels.set(uri, channel);

        try {
            if (isOutgoing)
                await channel.open(fd);
            else
                await channel.accept(fd);

            if (existing !== undefined && existing !== channel)
                existing.close();

            this.channels.set(uri, channel);
            this.channel(channel);
        } catch (e) {
            channel.close();
            logError(e, address);
        }
    }

    onProfileReleased() {
        this._registered = false;
    }

    onRequestDisconnection(devicePath) {
        const info = this._deviceInfos.get(devicePath);
        const address = info?.Address?.toUpperCase() ||
            this._addressFromDevicePath(devicePath);

        if (address === null)
            return;

        this.channels.get(`bluetooth://${address}`)?.close();
    }

    start() {
        if (this.active || this._startPromise !== null)
            return;

        void this._startAsync();
    }

    stop() {
        for (const channel of this.channels.values())
            channel.close();

        this._connectAttempts.clear();
        for (const timerId of this._connectTimers.values())
            GLib.Source.remove(timerId);
        this._connectTimers.clear();
        this._pendingOutgoing.clear();
        this._unregisterProfile();

        this._active = false;
        this.notify('active');
    }

    destroy() {
        try {
            this.stop();

            if (this._profileExport !== null) {
                this._profileExport.destroy();
                this._profileExport = null;
            }
        } catch (e) {
            debug(e, 'Bluetooth');
        }
    }
});


export const Channel = GObject.registerClass({
    GTypeName: 'GSConnectBluetoothChannel',
}, class BluetoothChannel extends Core.Channel {

    _init(params = {}) {
        super._init();

        this.allowed = true;
        Object.assign(this, params);
    }

    get address() {
        return `bluetooth://${this.bluetooth_address}`;
    }

    get bluetooth_address() {
        if (this._bluetooth_address === undefined)
            this._bluetooth_address = null;

        return this._bluetooth_address;
    }

    set bluetooth_address(address) {
        this._bluetooth_address = address;
    }

    get certificate() {
        if (this._certificate === undefined)
            this._certificate = null;

        return this._certificate;
    }

    set certificate(certificate) {
        this._certificate = certificate;
    }

    get devicePath() {
        if (this._devicePath === undefined)
            this._devicePath = null;

        return this._devicePath;
    }

    set devicePath(devicePath) {
        this._devicePath = devicePath;
    }

    get peer_certificate() {
        if (this._peerCertificate === undefined)
            this._peerCertificate = null;

        return this._peerCertificate;
    }

    set peer_certificate(certificate) {
        this._peerCertificate = certificate;
    }

    async _initConnection(fd) {
        this._fd = fd;

        const inputStream = new GioUnix.InputStream({
            fd: fd,
            close_fd: false,
        });
        const outputStream = new GioUnix.OutputStream({
            fd: fd,
            close_fd: true,
        });

        this._multiplexer = new ConnectionMultiplexer(inputStream, outputStream);
    }

    _localIdentity() {
        const identity = new Core.Packet(this.backend.identity);
        identity.body.certificate = this.certificate.certificate_pem;
        return identity;
    }

    async _receiveIdentity(cancellable = null) {
        debug(`waiting for identity ${this.address}`, 'Bluetooth');
        const data = await this._multiplexer.defaultChannel.readLine(cancellable);
        debug(`received raw identity line ${this.address}`, 'Bluetooth');
        const identity = new Core.Packet(data);
        _validateIdentity(identity);

        const certificate = Gio.TlsCertificate.new_from_pem(
            _normalizeCertificate(identity.body.certificate),
            -1
        );

        _verifyCertificate(identity, certificate);

        this.identity = identity;
        this.peer_certificate = certificate;
    }

    async accept(fd) {
        await this._initConnection(fd);
        debug(`accept ${this.address}`, 'Bluetooth');
        await this._multiplexer.defaultChannel.write(
            this._localIdentity().serialize(),
            this.cancellable
        );
        debug(`sent local identity ${this.address}`, 'Bluetooth');
        await this._receiveIdentity(this.cancellable);
        debug(`accepted identity ${this.identity.body.deviceName} (${this.address})`, 'Bluetooth');
    }

    close() {
        if (this.closed)
            return;

        this._closed = true;
        this.notify('closed');

        this.backend.channels.delete(this.address);
        this.cancellable.cancel();

        if (this._multiplexer)
            this._multiplexer.close();
    }

    async download(packet, target, cancellable = null) {
        if (cancellable === null)
            cancellable = this.cancellable;

        const uuid = packet.payloadTransferInfo?.uuid;

        if (uuid === undefined)
            throw new Error('Bluetooth payload missing channel uuid');

        const channel = await this._multiplexer.acquireChannel(uuid, cancellable);

        if (channel === null)
            throw _closedError('Bluetooth payload channel closed');

        const transferredSize = await channel.spliceTo(target, packet.payloadSize,
            cancellable);

        if (transferredSize < packet.payloadSize) {
            throw new Gio.IOErrorEnum({
                code: Gio.IOErrorEnum.FAILED,
                message: `Incomplete: ${transferredSize}/${packet.payloadSize}`,
            });
        }
    }

    async open(fd) {
        // KDE Connect delays its client-side Bluetooth handshake briefly after
        // the RFCOMM socket connects; Android drops the socket without it.
        await _sleepAsync(500);
        await this._initConnection(fd);
        debug(`open ${this.address}`, 'Bluetooth');
        await this._receiveIdentity(this.cancellable);
        debug(`received identity ${this.identity.body.deviceName} (${this.address})`, 'Bluetooth');
        await this._multiplexer.defaultChannel.write(
            this._localIdentity().serialize(),
            this.cancellable
        );
        debug(`sent local identity ${this.address}`, 'Bluetooth');
    }

    async readPacket(cancellable = null) {
        if (cancellable === null)
            cancellable = this.cancellable;

        const data = await this._multiplexer.defaultChannel.readLine(cancellable);
        return new Core.Packet(data);
    }

    async rejectTransfer(packet) {
        const uuid = packet?.payloadTransferInfo?.uuid;

        if (uuid !== undefined)
            this._multiplexer.tryGetChannel(uuid)?.close();
    }

    async sendPacket(packet, cancellable = null) {
        if (cancellable === null)
            cancellable = this.cancellable;

        await this._multiplexer.defaultChannel.write(packet.serialize(),
            cancellable);
    }

    async upload(packet, source, size, cancellable = null) {
        if (cancellable === null)
            cancellable = this.cancellable;

        const channel = this._multiplexer.openChannel();
        packet = new Core.Packet(packet);

        if (!packet.body.payloadHash)
            packet.body.payloadHash = `${Date.now()}`;

        packet.payloadSize = size;
        packet.payloadTransferInfo = {uuid: channel.uuid};

        await this.sendPacket(packet, cancellable);

        const transferredSize = await channel.spliceFrom(source, size,
            cancellable);

        if (transferredSize !== size) {
            throw new Gio.IOErrorEnum({
                code: Gio.IOErrorEnum.PARTIAL_INPUT,
                message: 'Transfer incomplete',
            });
        }
    }
});
