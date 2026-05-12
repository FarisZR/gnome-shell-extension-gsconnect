# Bluetooth Transport

## Summary

This fork adds a working Bluetooth transport for GSConnect using BlueZ RFCOMM
profiles and the KDE Connect Bluetooth multiplexer.

The implementation goal was not just to exchange identities, but to keep a real
Android device connected long enough for GSConnect to treat the device as fully
connected and paired over Bluetooth.

## Constraints

- Keep KDE Connect protocol compatibility.
- Use BlueZ and the existing GSConnect service architecture.
- Test on a real GNOME host and a real Android phone.
- Avoid relying on KDE desktop code as a runtime dependency.

## Implementation Plan

1. Register a BlueZ `Profile1` service for the KDE Connect Bluetooth UUID.
2. Publish an SDP record Android can discover with `fetchUuidsWithSdp()`.
3. Support both incoming and outgoing RFCOMM sockets in the GSConnect backend.
4. Reuse the KDE Connect Bluetooth multiplexer layout for packet transport.
5. Reduce early Bluetooth startup traffic that causes Android to reset the link.
6. Verify behavior on the real device instead of stopping at local logs.

## Issues Found

### 1. Outgoing and incoming RFCOMM sockets were handled the same way

GSConnect originally treated every BlueZ `NewConnection` callback as an accepted
server-side socket. That was wrong for sockets created through
`Device1.ConnectProfile()`.

Effect:

- The client-side Bluetooth handshake path was never actually used.
- The socket opened, but GSConnect followed the wrong handshake sequence.

Fix:

- Outgoing BlueZ profile sockets now use `channel.open(fd)`.
- Incoming profile sockets continue to use `channel.accept(fd)`.

### 2. Android was not discovering the laptop service over SDP

The biggest blocker was service discoverability, not packet framing.

Android upstream only attempts the client-side Bluetooth path if SDP discovery
returns the KDE Connect Bluetooth UUID. The laptop adapter exposed the UUID in
BlueZ properties, but Android still did not see it during `fetchUuidsWithSdp()`.

Root causes:

- The SDP record was incomplete for RFCOMM discovery.
- BlueZ profile registration did not declare matching service metadata.
- The running user extension was still loading the old bundled SDP resource.

Fixes:

- `data/org.gnome.Shell.Extensions.GSConnect.sdp.xml`
  - removed the extra raw 128-bit UUID entry
  - added the L2CAP layer to `ProtocolDescriptorList`
  - added explicit RFCOMM channel `0x06`
  - fixed `BluetoothProfileDescriptorList`
- `src/service/backends/bluetooth.js`
  - added `Service`, `Role`, and `Channel` to `RegisterProfile()`
  - set `BLUEZ_RFCOMM_CHANNEL = 6`
  - added an on-disk SDP fallback so the active user extension can load the
    updated XML without rebuilding the bundled gresource

Result:

- Android started logging the custom Bluetooth UUID during
  `fetchUuidsWithSdp()`.
- Android then switched to `BTLinkProvider/Client` and initiated the RFCOMM
  connection itself.

### 3. Forcing Android into its server-side path was unstable

Before SDP discovery worked, GSConnect had to dial the phone with
`ConnectProfile()`. Android then took its server-side Bluetooth path.

During investigation, Android upstream code showed that this server-side path
wraps the multiplexer in a scope that closes it immediately after link setup.
That matched the observed disconnects.

The practical fix was to stop depending on that path:

- publish a discoverable service on the laptop
- let Android take the client-side path instead

### 4. Early Bluetooth plugin traffic still caused resets

Even after the socket and identity exchange were correct, Android was sensitive
to immediate plugin startup chatter.

Fixes:

- `src/service/backends/bluetooth.js`
  - delay outgoing `ConnectProfile()` attempts
  - wait briefly before starting the outgoing Bluetooth handshake
- `src/service/device.js`
  - delay plugin startup for Bluetooth links
  - suppress a narrow set of early startup packets on Bluetooth connections
- selected plugins skip their initial sync burst on Bluetooth:
  - `contacts`
  - `mpris`
  - `notification`
  - `runcommand`
  - `sms`

These changes keep Bluetooth-specific policy out of the normal LAN path.

### 5. Quick settings "Mobile Settings" stopped launching preferences

This was a follow-up regression found after Bluetooth started working.

Root cause:

- the service-side preferences action launched `gjs -m gsconnect-preferences.js`
- the installed user extension ships `gsconnect-preferences` as the stable
  launcher entry point
- the quick settings entry went through the service action, so it failed
  silently there even though the extension preferences window could still open
  GSConnect settings by another path

Fixes:

- `src/service/daemon.js`
  - spawn `Config.PACKAGE_DATADIR/gsconnect-preferences`
- `src/prefs.js`
  - use the same installed launcher path for consistency

## Final Design

The Bluetooth flow in this fork is:

1. GSConnect registers a BlueZ `Profile1` service for
   `185f3df4-3268-4e3f-9fca-d4d5059915bd`.
2. BlueZ advertises an SDP record Android can discover.
3. Android sees the UUID during `fetchUuidsWithSdp()`.
4. Android initiates the client-side RFCOMM connection to the laptop.
5. GSConnect accepts the socket and exchanges KDE Connect identities.
6. The Bluetooth multiplexer keeps the default channel and extra logical
   channels on the same RFCOMM stream.
7. Bluetooth-specific startup delays and packet suppression avoid early resets.

## Files Touched

- `src/service/backends/bluetooth.js`
- `data/org.gnome.Shell.Extensions.GSConnect.sdp.xml`
- `src/service/device.js`
- `src/service/plugins/contacts.js`
- `src/service/plugins/mpris.js`
- `src/service/plugins/notification.js`
- `src/service/plugins/runcommand.js`
- `src/service/plugins/sms.js`
- `src/service/daemon.js`
- `src/prefs.js`

## Validation

The implementation was validated on a real GNOME system and a real Android KDE
Connect device.

Successful checks included:

- Android logging the custom UUID during SDP discovery.
- Android logging `calling connectToDevice` for the laptop.
- Android taking `BTLinkProvider/Client` instead of the server path.
- GSConnect reporting the phone as connected and paired.
- The quick settings entry launching the GSConnect preferences process again.

## Notes

- The Android warning about ignoring `kdeconnect.identity` is not treated as a
  transport failure by itself.
- The Bluetooth path now works, but it is still more timing-sensitive than LAN,
  so the Bluetooth-specific startup guards are intentional.
