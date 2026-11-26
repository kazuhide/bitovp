import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("ci_apt", Path(__file__).with_name("prepare-browser-ci-apt.py"))
apt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(apt)
BLOCK = (b"Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\n"
         b"Suites: noble noble-updates noble-backports\nComponents: main restricted universe multiverse\n"
         b"Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n")
CI = {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "ImageOS": "ubuntu24"}


class MirrorTests(unittest.TestCase):
    def test_only_uri_bytes_change_in_every_signed_stanza(self):
        source = b"# existing comment\n" + BLOCK + b"\n" + BLOCK.replace(b"noble noble-updates noble-backports", b"noble-security").replace(b"mirror+file:/etc/apt/apt-mirrors.txt", b"https://security.ubuntu.com/ubuntu/")
        expected = source.replace(b"mirror+file:/etc/apt/apt-mirrors.txt", apt.MIRROR).replace(b"https://security.ubuntu.com/ubuntu/", apt.MIRROR)
        self.assertEqual(apt.fallback_sources(source), expected)

    def test_rejects_unknown_uri_missing_key_and_trust_overrides(self):
        for source in (BLOCK.replace(b"mirror+file:/etc/apt/apt-mirrors.txt", b"https://other.invalid/ubuntu/"), BLOCK.replace(b"Signed-By:", b"#Signed-By:"), BLOCK + b"Trusted: yes\n", BLOCK + b"\n" + BLOCK.replace(b"Signed-By:", b"#Signed-By:"), b"# no sources\n"):
            with self.subTest(source=source), self.assertRaises(ValueError):
                apt.fallback_sources(source)

    def test_normal_dns_never_reads_or_changes_sources(self):
        with patch.object(apt.sys, "platform", "linux"), patch.dict(apt.os.environ, CI, clear=True), patch.object(apt, "resolves", side_effect=[False, True, False]) as resolve, patch.object(apt.subprocess, "run") as run:
            apt.main()
            self.assertEqual(resolve.call_count, 3)
            run.assert_not_called()

    def test_missing_fallback_dns_never_runs_privileged_commands(self):
        with patch.object(apt.sys, "platform", "linux"), patch.dict(apt.os.environ, CI, clear=True), patch.object(apt, "resolves", return_value=False), patch.object(apt.subprocess, "run") as run:
            with self.assertRaises(RuntimeError):
                apt.main()
            run.assert_not_called()

    def test_non_hosted_execution_stops_before_dns(self):
        with patch.dict(apt.os.environ, {}, clear=True), patch.object(apt, "resolves") as resolve:
            with self.assertRaises(RuntimeError):
                apt.main()
            resolve.assert_not_called()

    def test_https_failure_stops_before_privileged_write(self):
        failure = subprocess.CalledProcessError(22, "curl")
        with patch.object(apt.sys, "platform", "linux"), patch.dict(apt.os.environ, CI, clear=True), patch.object(apt, "resolves", side_effect=[False, False, False, True]), patch.object(apt.subprocess, "run", side_effect=failure) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                apt.main()
            self.assertEqual(run.call_count, 1)
            self.assertEqual(run.call_args.args[0][0], "curl")

    def test_unexpected_sources_stop_before_privileged_write(self):
        with patch.object(apt.sys, "platform", "linux"), patch.dict(apt.os.environ, CI, clear=True), patch.object(apt, "resolves", side_effect=[False, False, False, True]), patch.object(apt, "SOURCE") as source, patch.object(apt.subprocess, "run") as run:
            source.is_symlink.return_value = False
            source.is_file.return_value = True
            source.read_bytes.return_value = BLOCK.replace(b"Signed-By:", b"#Signed-By:")
            with self.assertRaises(ValueError):
                apt.main()
            self.assertEqual(run.call_count, 1)
            self.assertEqual(run.call_args.args[0][0], "curl")

    def test_signed_update_failure_is_not_ignored(self):
        expected = apt.fallback_sources(BLOCK)
        failure = subprocess.CalledProcessError(100, "apt-get")
        with patch.object(apt.sys, "platform", "linux"), patch.dict(apt.os.environ, CI, clear=True), patch.object(apt, "resolves", side_effect=[False, False, False, True]), patch.object(apt, "SOURCE") as source, patch.object(apt.subprocess, "run", side_effect=[None, None, failure]) as run:
            source.is_symlink.return_value = False
            source.is_file.return_value = True
            source.read_bytes.side_effect = [BLOCK, expected]
            with self.assertRaises(subprocess.CalledProcessError):
                apt.main()
            self.assertEqual(run.call_args_list[1].args[0][:2], ["sudo", "tee"])
            self.assertEqual(run.call_args_list[1].kwargs["input"], expected)
            self.assertIn("APT::Update::Error-Mode=any", run.call_args.args[0])
            self.assertTrue(run.call_args.kwargs["check"])


if __name__ == "__main__":
    unittest.main()
