#!/usr/bin/env python3
"""Credential-free release preflight and signed-archive regression tests."""
import importlib.util
import pathlib
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('archive_check', ROOT / 'scripts/validate-apple-release-archive.py')
archive_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive_check)


class AppleReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.archive = pathlib.Path(self.temp.name) / 'Release.xcarchive'
        self.profile = {'TeamIdentifier': ['CC8UTF7ATG'], 'Entitlements': {
            'application-identifier': 'CC8UTF7ATG.codes.autorotate.ios',
            'com.apple.security.application-groups': ['group.codes.autorotate'],
        }}
        self.signed = {'com.apple.security.application-groups': ['group.codes.autorotate']}
        self.info = {'CFBundleIdentifier': 'codes.autorotate.ios', 'CFBundleVersion': '101'}

    def make_app(self, platform='ios'):
        app = self.archive / 'Products/Applications/Autorotate.app'
        directory = app if platform == 'ios' else app / 'Contents'
        directory.mkdir(parents=True)
        (directory / 'Info.plist').write_bytes(plistlib.dumps(self.info))

    def validate(self, platform='ios', bundle='codes.autorotate.ios'):
        def tool(command, **kwargs):
            return plistlib.dumps(self.profile if command[0] == 'security' else self.signed)
        with patch.object(archive_check.subprocess, 'check_output', side_effect=tool):
            archive_check.validate(self.archive, platform, bundle, '101')

    def test_current_ios_profile_is_accepted(self):
        self.make_app()
        self.validate()

    def test_mac_target_is_separate(self):
        self.info['CFBundleIdentifier'] = 'codes.autorotate.macos'
        self.profile['Entitlements']['application-identifier'] = 'CC8UTF7ATG.codes.autorotate.macos'
        self.make_app('macos')
        self.validate('macos', 'codes.autorotate.macos')

    def test_legacy_ios_bundle_cannot_upload(self):
        self.info['CFBundleIdentifier'] = 'codes.autorotate'
        self.make_app()
        with self.assertRaises(ValueError): self.validate()

    def test_wrong_build_cannot_upload(self):
        self.info['CFBundleVersion'] = '100'
        self.make_app()
        with self.assertRaises(ValueError): self.validate()

    def test_wrong_profile_app_cannot_upload(self):
        self.profile['Entitlements']['application-identifier'] = 'CC8UTF7ATG.codes.autorotate'
        self.make_app()
        with self.assertRaises(ValueError): self.validate()

    def test_wrong_profile_team_cannot_upload(self):
        self.profile['TeamIdentifier'] = ['OTHERTEAM']
        self.make_app()
        with self.assertRaises(ValueError): self.validate()

    def test_missing_profile_group_cannot_upload(self):
        self.profile['Entitlements']['com.apple.security.application-groups'] = []
        self.make_app()
        with self.assertRaises(ValueError): self.validate()

    def test_missing_signed_group_cannot_upload(self):
        self.signed = {}
        self.make_app()
        with self.assertRaises(ValueError): self.validate()

    def test_signed_entitlements_request_xml(self):
        # codesign only writes an XML plist to stdout when --xml is passed.
        # Without it the entitlements come back as legacy NeXTSTEP "[Dict]"
        # text, which plistlib.loads() rejects with InvalidFileException.
        seen = []
        self.make_app()

        def tool(command, **kwargs):
            seen.append(command)
            return plistlib.dumps(self.profile if command[0] == 'security' else self.signed)
        with patch.object(archive_check.subprocess, 'check_output', side_effect=tool):
            archive_check.validate(self.archive, 'ios', 'codes.autorotate.ios', '101')
        codesign = next(c for c in seen if c[0] == 'codesign')
        self.assertIn('--xml', codesign, codesign)
        self.assertNotIn(':-', codesign, codesign)
        self.assertIn('-', codesign, codesign)

    @unittest.skipUnless(sys.platform == 'darwin', 'codesign entitlements require macOS')
    def test_codesign_flags_emit_parseable_xml(self):
        # Exercise the real codesign so a flag change that breaks the parse
        # fails here rather than during a TestFlight release.
        with tempfile.TemporaryDirectory() as raw:
            root = pathlib.Path(raw)
            app = root / 'Probe.app'
            (app / 'Contents/MacOS').mkdir(parents=True)
            (app / 'Contents/Info.plist').write_bytes(plistlib.dumps(self.info))
            # codesign embeds entitlements only for a real Mach-O binary.
            shutil.copy('/bin/echo', app / 'Contents/MacOS/Probe')
            (root / 'ent.plist').write_bytes(plistlib.dumps(
                {'com.apple.security.application-groups': ['group.codes.autorotate']}))
            subprocess.run(['codesign', '--force', '--sign', '-',
                            '--entitlements', str(root / 'ent.plist'), str(app)],
                           check=True, capture_output=True)
            base = ['codesign', '-d', '--entitlements', '-']
            parsed = plistlib.loads(subprocess.check_output(
                base + ['--xml', str(app)], stderr=subprocess.DEVNULL))
            self.assertEqual(parsed['com.apple.security.application-groups'],
                             ['group.codes.autorotate'])
            # Dropping --xml must break the parse, proving the flag is required.
            with self.assertRaises(plistlib.InvalidFileException):
                plistlib.loads(subprocess.check_output(base + [str(app)],
                                                       stderr=subprocess.DEVNULL))

    def test_manual_inputs_before_any_signing(self):
        for platform, build, valid in [('ios', '101', True), ('macos', '102', True),
                                       ('both', '101', False), ('ios', '0', False),
                                       ('ios', '1; echo injected', False), ('ios', '', False)]:
            result = subprocess.run(['bash', str(ROOT / 'scripts/apple-testflight-release.sh'),
                                     '--validate-only', platform, build], capture_output=True)
            self.assertEqual(result.returncode == 0, valid, (platform, build))


if __name__ == '__main__':
    unittest.main()
