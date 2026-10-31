#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Verify cache integrity and archive confinement without any network calls."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("native_build", Path(__file__).parents[1] / "build.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class VerifiedSourceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.work = Path(self.directory.name)
        self.name = "vmaf-" + "a" * 40

    def tearDown(self):
        self.directory.cleanup()

    def archive(self, entries):
        path = self.work / (self.name + ".tar.gz")
        with tarfile.open(path, "w:gz") as out:
            for name, data in entries:
                member = tarfile.TarInfo(name)
                member.size = len(data)
                out.addfile(member, io.BytesIO(data))
        return {"revision": "a" * 40, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}

    def test_valid_cached_archive_extracts_and_is_reusable(self):
        lock = self.archive([(self.name + "/LICENSE", b"license"), (self.name + "/libvmaf/file.c", b"source")])
        source = build.checked_source(self.work, lock)
        self.assertEqual((source / "libvmaf/file.c").read_bytes(), b"source")
        self.assertEqual(build.checked_source(self.work, lock), source)

    def test_modified_source_is_never_silently_reused(self):
        lock = self.archive([(self.name + "/LICENSE", b"license")])
        source = build.checked_source(self.work, lock)
        (source / "LICENSE").write_text("modified")
        with self.assertRaisesRegex(RuntimeError, "source was modified"):
            build.checked_source(self.work, lock)

    def test_tampered_archive_fails_before_extraction(self):
        lock = self.archive([(self.name + "/LICENSE", b"license")])
        (self.work / (self.name + ".tar.gz")).write_bytes(b"replaced")
        with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
            build.checked_source(self.work, lock)
        self.assertFalse((self.work / self.name).exists())

    def test_archive_cannot_escape_the_source_directory(self):
        lock = self.archive([(self.name + "/../../outside", b"untrusted")])
        with self.assertRaises(tarfile.FilterError):
            build.checked_source(self.work, lock)
        self.assertFalse((self.work / "outside").exists())
        self.assertFalse((self.work / (self.name + ".extracting")).exists())

    def test_unverified_existing_source_is_rejected(self):
        lock = self.archive([(self.name + "/LICENSE", b"license")])
        (self.work / self.name).mkdir()
        with self.assertRaisesRegex(RuntimeError, "without a verification manifest"):
            build.checked_source(self.work, lock)

    def test_cpu_cache_checks_pin_source_and_actual_meson_options(self):
        cpu = self.work / "official-cpu"
        source = self.work / self.name / "libvmaf"
        lock = {"revision": "a" * 40, "sha256": "b" * 64}
        marker, identity = build.check_cpu_cache(cpu, source, lock)
        (cpu / "meson-info").mkdir(parents=True)
        (cpu / "build.ninja").touch()
        with self.assertRaisesRegex(RuntimeError, "pin/configuration mismatch"):
            build.check_cpu_cache(cpu, source, lock)
        marker.write_text(json.dumps(identity))
        info = cpu / "meson-info"
        (info / "meson-info.json").write_text(json.dumps({"directories": {"source": str(source), "build": str(cpu)}}))
        options = [{"name": key, "value": value} for key, value in build.CPU_OPTIONS.items()]
        (info / "intro-buildoptions.json").write_text(json.dumps(options))
        build.check_cpu_cache(cpu, source, lock)
        with self.assertRaisesRegex(RuntimeError, "pin/configuration mismatch"):
            build.check_cpu_cache(cpu, source, lock | {"revision": "c" * 40})
        (info / "meson-info.json").write_text(json.dumps({"directories": {"source": str(self.work / "other"), "build": str(cpu)}}))
        with self.assertRaisesRegex(RuntimeError, "source directory differs"):
            build.check_cpu_cache(cpu, source, lock)
        (info / "meson-info.json").write_text(json.dumps({"directories": {"source": str(source), "build": str(cpu)}}))
        options[0]["value"] = "debug"
        (info / "intro-buildoptions.json").write_text(json.dumps(options))
        with self.assertRaisesRegex(RuntimeError, "cache options differ"):
            build.check_cpu_cache(cpu, source, lock)


if __name__ == "__main__":
    unittest.main()
