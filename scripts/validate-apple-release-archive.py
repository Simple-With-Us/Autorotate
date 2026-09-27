#!/usr/bin/env python3
"""Validate the selected signed archive before export can upload it."""
import pathlib
import plistlib
import subprocess
import sys

TEAM = 'CC8UTF7ATG'
GROUP = 'group.codes.autorotate'


def validate(archive, platform, bundle, build):
    app = archive / 'Products/Applications/Autorotate.app'
    info_path = app / ('Info.plist' if platform == 'ios' else 'Contents/Info.plist')
    profile_path = app / ('embedded.mobileprovision' if platform == 'ios' else 'Contents/embedded.provisionprofile')
    info = plistlib.loads(info_path.read_bytes())
    if info.get('CFBundleIdentifier') != bundle or str(info.get('CFBundleVersion')) != build:
        raise ValueError('Archive bundle or build number does not match the selected release.')
    profile = plistlib.loads(subprocess.check_output(['security', 'cms', '-D', '-i', str(profile_path)]))
    entitlements = profile.get('Entitlements', {})
    app_id = entitlements.get('application-identifier', entitlements.get('com.apple.application-identifier'))
    if app_id != f'{TEAM}.{bundle}' or TEAM not in profile.get('TeamIdentifier', []):
        raise ValueError('Embedded profile does not match the selected app and team.')
    if GROUP not in entitlements.get('com.apple.security.application-groups', []):
        raise ValueError('Embedded profile is missing the required Autorotate App Group.')
    # '- --xml' writes the entitlements plist to stdout as XML.  Without
    # --xml codesign emits the legacy NeXTSTEP "[Dict]" text, which
    # plistlib.loads() rejects with InvalidFileException.  The older ':-'
    # spelling also emits XML today but is deprecated and warns on stderr.
    signed = plistlib.loads(subprocess.check_output(
        ['codesign', '-d', '--entitlements', '-', '--xml', str(app)], stderr=subprocess.DEVNULL))
    if GROUP not in signed.get('com.apple.security.application-groups', []):
        raise ValueError('Signed app is missing the required Autorotate App Group.')


if __name__ == '__main__':
    try:
        validate(pathlib.Path(sys.argv[1]), *sys.argv[2:5])
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        # Do not include tool output or signing material in diagnostics.
        print(f'Archive validation failed: {type(error).__name__}.  Check bundle, build, team and App Group.', file=sys.stderr)
        raise SystemExit(1)
    print('Archive bundle, build, profile and signed App Group validated.')
