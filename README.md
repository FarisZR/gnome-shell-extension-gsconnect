<!--
SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect

SPDX-License-Identifier: GPL-2.0-or-later
-->

# GSConnect

[<img src="https://raw.githubusercontent.com/andyholmes/gnome-shell-extensions-badge/master/get-it-on-ego.svg?sanitize=true" alt="Get it on GNOME Extensions" height="100" align="middle">][ego] [<img alt="Available in the Chrome Web Store" src="https://raw.githubusercontent.com/GSConnect/gnome-shell-extension-gsconnect/main/data/images/chrome-badge.png" align="middle" hspace="12"/>][chrome] [<img src="https://raw.githubusercontent.com/GSConnect/gnome-shell-extension-gsconnect/main/data/images/firefox-badge.png" alt="Get the Add-On" align="middle">][firefox]

## Overview

[GSConnect][ego] is a complete implementation of [KDE Connect][kdeconnect]
especially for GNOME Shell with Nautilus, [Chrome][chrome] and
[Firefox][firefox] integration. The KDE Connect team has applications for Linux,
BSD, Android, Sailfish, iOS, macOS and Windows.

With GSConnect you can securely connect to mobile devices and other desktops to:

* Share files, links and text
* Send and receive messages
* Sync clipboard content
* Sync contacts
* Sync notifications
* Control media players
* Control system volume
* Execute predefined commands
* And more…

Please see the **[Wiki][wiki]** for more information about
**[Features][features]** and **[Help][help]**.

## Fork Notes

This fork includes a working Bluetooth transport for GSConnect in addition to
the existing LAN transport.

### Bluetooth Transport In This Fork

- Registers a BlueZ `Profile1` service for KDE Connect's Bluetooth UUID.
- Publishes an RFCOMM SDP record Android can discover with SDP.
- Uses the KDE Connect Bluetooth multiplexer over a single RFCOMM socket.
- Supports both accepted sockets and `ConnectProfile()` sockets correctly.
- Adds Bluetooth-specific startup delays and packet suppression to avoid early
  Android disconnects during plugin startup.

The practical effect is that Android can discover the GNOME host over Bluetooth,
initiate the correct client-side connection path, and stay connected long enough
for GSConnect to operate normally.

Implementation details are documented in `docs/bluetooth-transport.md`.

## Project Status

GSConnect is now under the GitHub organisation [GSConnect][gsconnect-org].

Please note, this project has migrated from a developer-driven model to a
community-driven model. This means that GSConnect does not have dedicated
developers working on new features or bug fixes. Instead, the project relies on
contributions from its users and distributions that choose to package it.

If you would like to take a more active role in the development and maintenance
of GSConnect, you can start by [triaging new issues][issues],
[fixing confirmed issues][help-wanted] and [reviewing contributions][needs-review].
If you need additional permissions, you may request them from one of the
[current maintainers][people].

## Nightly Builds

For early updaters of GNOME Shell and those that wish to test the upcoming version
of GSConnect, there are automated builds available for [download][nightly-build].
See [Installing from Nightly Build][nightly-install] for installation instructions.

[ego]: https://extensions.gnome.org/extension/1319/gsconnect/
[chrome]: https://chrome.google.com/webstore/detail/gsconnect/jfnifeihccihocjbfcfhicmmgpjicaec
[firefox]: https://addons.mozilla.org/firefox/addon/gsconnect/
[kdeconnect]: https://userbase.kde.org/KDEConnect
[wiki]: https://github.com/GSConnect/gnome-shell-extension-gsconnect/wiki/
[features]: https://github.com/GSConnect/gnome-shell-extension-gsconnect/wiki/Features
[help]: https://github.com/GSConnect/gnome-shell-extension-gsconnect/wiki/Help

[gsconnect-org]: https://github.com/GSConnect
[issues]: https://github.com/GSConnect/gnome-shell-extension-gsconnect/issues
[help-wanted]: https://github.com/GSConnect/gnome-shell-extension-gsconnect/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22
[needs-review]: https://github.com/GSConnect/gnome-shell-extension-gsconnect/pulls?q=is%3Apr+is%3Aopen+label%3A%22needs+review%22
[people]: https://github.com/orgs/GSConnect/people
[nightly-build]: https://nightly.link/GSConnect/gnome-shell-extension-gsconnect/workflows/main/main/gsconnect@andyholmes.github.io.zip
[nightly-install]: https://github.com/GSConnect/gnome-shell-extension-gsconnect/wiki/Installation#install-from-nightly-build
