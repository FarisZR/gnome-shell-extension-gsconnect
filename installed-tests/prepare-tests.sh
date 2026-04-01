#!/usr/bin/env bash

# SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
#
# SPDX-License-Identifier: GPL-2.0-or-later

APP_ID="org.gnome.Shell.Extensions.GSConnect"
#G_TEST_BUILDDIR=${MESON_BUILD_ROOT}/installed-tests

# Copy source files
rm -rf ${G_TEST_BUILDDIR}/src
cp -R ${MESON_SOURCE_ROOT}/src ${G_TEST_BUILDDIR}
cp ${G_TEST_BUILDDIR}/config.js ${G_TEST_BUILDDIR}/src

# Copy the installed-test support files into the same relative layout the test
# modules expect when running from the build tree.
mkdir -p ${G_TEST_BUILDDIR}/suites
rm -rf ${G_TEST_BUILDDIR}/suites/data ${G_TEST_BUILDDIR}/suites/fixtures
cp ${G_TEST_BUILDDIR}/config.js ${G_TEST_BUILDDIR}/suites
cp -R ${MESON_SOURCE_ROOT}/installed-tests/data ${G_TEST_BUILDDIR}/suites
cp -R ${MESON_SOURCE_ROOT}/installed-tests/fixtures ${G_TEST_BUILDDIR}/suites

# Compile GResources
glib-compile-resources --external-data \
                       --sourcedir=${MESON_BUILD_ROOT}/data \
                       --sourcedir=${MESON_SOURCE_ROOT}/data \
                       --target=${G_TEST_BUILDDIR}/src/${APP_ID}.gresource \
                       ${MESON_SOURCE_ROOT}/data/${APP_ID}.gresource.xml

# Compile GSettings Schema
glib-compile-schemas --targetdir=${G_TEST_BUILDDIR} \
                     ${MESON_SOURCE_ROOT}/data
