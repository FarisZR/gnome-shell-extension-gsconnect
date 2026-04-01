// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';

import * as Utils from '../fixtures/utils.js';

import Config from '../config.js';
const Core = await import(`file://${Config.PACKAGE_DATADIR}/service/core.js`);
const Bluetooth = await import(`file://${Config.PACKAGE_DATADIR}/service/backends/bluetooth.js`);


describe('A Bluetooth backend', function () {
    let localSettings;
    let remoteSettings;

    beforeAll(function () {
        localSettings = new Gio.Settings({
            settings_schema: Config.GSCHEMA.lookup(
                'org.gnome.Shell.Extensions.GSConnect.Device',
                true
            ),
            path: '/org/gnome/shell/extensions/gsconnect/device/localdevice000000000000000000000001/',
        });
        remoteSettings = new Gio.Settings({
            settings_schema: Config.GSCHEMA.lookup(
                'org.gnome.Shell.Extensions.GSConnect.Device',
                true
            ),
            path: '/org/gnome/shell/extensions/gsconnect/device/remotedevice00000000000000000000001/',
        });
    });

    afterAll(function () {
        localSettings.reset('certificate-pem');
        localSettings.reset('paired');
        localSettings.run_dispose();

        remoteSettings.reset('certificate-pem');
        remoteSettings.reset('paired');
        remoteSettings.run_dispose();
    });

    it('sanitizes invalid bluetooth identity names', async function () {
        const service = new Bluetooth.ChannelService();
        service.id = 'localdevice000000000000000000000001';
        service.name = 'Local Device';
        service.buildIdentity();
        service.identity.body.certificate = Utils.loadDataContents('local-certificate.pem');

        const channel = new Bluetooth.Channel({
            backend: service,
            bluetooth_address: '00:11:22:33:44:55',
            certificate: Gio.TlsCertificate.new_from_files(
                Utils.getDataPath('local-certificate.pem'),
                Utils.getDataPath('local-private.pem')
            ),
        });
        const remoteIdentity = new Core.Packet({
            type: 'kdeconnect.identity',
            body: {
                deviceId: 'remotedevice00000000000000000000001',
                deviceName: 'Bad\x00Name',
                deviceType: 'phone',
                protocolVersion: 8,
                incomingCapabilities: [],
                outgoingCapabilities: [],
                certificate: Utils.loadDataContents('remote-certificate.pem'),
            },
        });

        channel._multiplexer = {
            close() {},
            defaultChannel: {
                readLine: () => Promise.resolve(remoteIdentity.serialize()),
            },
        };

        await channel._receiveIdentity(channel.cancellable);

        expect(channel.identity.body.deviceName).toBe('Bad Name');
        channel.close();
        service.destroy();
    });

    it('rejects identities with mismatched pinned certificate', async function () {
        const service = new Bluetooth.ChannelService();
        service.id = 'localdevice000000000000000000000001';
        service.name = 'Local Device';
        service.buildIdentity();
        service.identity.body.certificate = Utils.loadDataContents('local-certificate.pem');

        const channel = new Bluetooth.Channel({
            backend: service,
            bluetooth_address: 'AA:BB:CC:DD:EE:FF',
            certificate: Gio.TlsCertificate.new_from_files(
                Utils.getDataPath('local-certificate.pem'),
                Utils.getDataPath('local-private.pem')
            ),
        });
        const remoteIdentity = new Core.Packet({
            type: 'kdeconnect.identity',
            body: {
                deviceId: 'remotedevice00000000000000000000001',
                deviceName: 'Remote Device',
                deviceType: 'phone',
                protocolVersion: 8,
                incomingCapabilities: [],
                outgoingCapabilities: [],
                certificate: Utils.loadDataContents('remote-certificate.pem'),
            },
        });

        channel._multiplexer = {
            close() {},
            defaultChannel: {
                readLine: () => Promise.resolve(remoteIdentity.serialize()),
            },
        };

        remoteSettings.set_string('certificate-pem',
            Utils.loadDataContents('local-certificate.pem'));
        remoteSettings.set_boolean('paired', true);

        let failed = false;

        try {
            await channel._receiveIdentity(channel.cancellable);
        } catch (e) {
            failed = true;
            expect(e.message).toContain('Authentication Failure');
        }

        expect(failed).toBeTrue();
        expect(remoteSettings.get_boolean('paired')).toBeFalse();
        expect(remoteSettings.get_string('certificate-pem')).toBe('');

        channel.close();
        service.destroy();
    });
});
