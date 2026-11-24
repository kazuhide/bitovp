import shutil
import subprocess
import unittest

from software_catalog import ENCODERS, build_software_options, discover_software_encoders


def help_for(args):
    if args[-1] == "full":
        return """
AVCodecContext AVOptions:
  -b                 <int64>      E..VA...... set bitrate (in bits/s) (from 0 to I64_MAX) (default 200000)
  -g                 <int>        E..V....... GOP length (from INT_MIN to INT_MAX) (default 12)

other AVOptions:
  -threads           <int>        E..V....... Unrelated section
"""
    name = args[-1].removeprefix("encoder=")
    if name == "libx265":
        return "Codec 'libx265' is not recognized by FFmpeg."
    report = f"Encoder {name} [test]:\n"
    return report + f"""
  -quality           <int>        E..V....... Quality (from -1 to INT_MAX) (default good)
     good            1            E..V....... Good quality
  -passlogfile       <string>     E..V....... Write statistics to file
  -unknown-string    <string>     E..V....... A future unreviewed string option
  -read-only         <int>        .D.V....... Decoding
  -{ENCODERS[name][1]} <dictionary> E..V....... Library configuration
"""


class CatalogTest(unittest.TestCase):
    def setUp(self):
        self.encoders = discover_software_encoders("ffmpeg", capture_help=help_for)

    def encode(self, encoder, options, native=None, codec=None):
        return build_software_options({"encoder": encoder, "options": options, "nativeOptions": native or {}},
                                      codec or ENCODERS[encoder][0], self.encoders)

    def test_probe_classifies_every_private_encode_option_and_uses_only_available_encoders(self):
        self.assertEqual([r["encoder"] for r in self.encoders], ["libx264", "libvpx-vp9", "libsvtav1"])
        catalog = self.encoders[0]
        fields = {f["name"]: f for f in catalog["options"]}
        self.assertEqual(set(fields), {"b", "g", "passes", "flags", "force_key_frames", "quality"})
        self.assertEqual(fields["quality"], {"name": "quality", "type": "int", "choices": ["good"],
                         "description": "Quality", "minimum": "-1", "maximum": "INT_MAX", "default": "good"})
        self.assertNotIn("default", fields["b"])
        limits = {f["name"] for f in catalog["limitations"]}
        self.assertTrue({"passlogfile", "unknown-string", "x264-params", "cqmfile", "opencl"} <= limits)
        self.assertNotIn("read-only", limits)

    def test_argv_is_stable_and_structures_native_options_as_one_dictionary(self):
        options = self.encode("libx264", {"quality": "good", "passes": "2", "b": "1000000"},
                              {"zones": "0,9,q=20/10,19,b=0.75", "psy-rd": "1.0:0.2"})
        self.assertEqual(options, ["-c:v", "libx264", "-b:v", "1000000", "-quality:v", "good",
                         "-x264-params:v", r"psy-rd=1.0\:0.2:zones=0,9,q=20/10,19,b=0.75"])

    def test_unknown_or_out_of_contract_settings_are_rejected(self):
        for options, native in [
                ({"b": "-1"}, {}), ({"b": str(2**63)}, {}), ({"g": "xx"}, {}),
                ({"quality": "unknown"}, {}), ({"passes": "02"}, {}), ({"passlogfile": "stats"}, {}),
                ({"flags": "+pass1"}, {}), ({"flags": "0x200"}, {}), ({"force_key_frames": "0,bad"}, {}),
                ({"unknown-string": "foo"}, {}), ({"x264-params": "foo"}, {}),
                ({}, {"cqm": "custom"}), ({}, {"dump-yuv": "dump"}), ({}, {"pass": "1"}),
                ({}, {"keyint": "1:other=2"}), ({}, {"zones": "0,1,other=2"}), ({}, {"nr": "NaN"})]:
            with self.subTest(options=options, native=native), self.assertRaises(ValueError):
                self.encode("libx264", options, native)
        with self.assertRaises(ValueError):
            self.encode("libx264", {}, {}, codec="VP9")
        with self.assertRaises(ValueError):
            self.encode("libx265", {})
        with self.assertRaises(ValueError):
            self.encode("libx264", {}, {"aq-strength": "0.5"}, codec="AV1")

    def test_vp9_temporal_layers_have_libvpx_limits_and_mode_is_applied_last(self):
        args = self.encode("libvpx-vp9", {}, {"ts_target_bitrate": "200,500", "ts_layering_mode": "2",
                                               "ts_number_layers": "2"})
        self.assertEqual(args[-1], "ts_number_layers=2:ts_target_bitrate=200,500:ts_layering_mode=2")
        for key, bad in [("ts_number_layers", "6"), ("ts_rate_decimator", "0,1"),
                         ("ts_layering_mode", "1"), ("ts_layer_id", "0,5"),
                         ("ts_periodicity", "17"), ("ts_target_bitrate", "20,abc")]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.encode("libvpx-vp9", {}, {key: bad})

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg is unavailable")
    def test_installed_encoders_accept_native_settings(self):
        ffmpeg = shutil.which("ffmpeg")
        catalog = discover_software_encoders(ffmpeg)
        if not catalog:
            self.skipTest("No experiment software encoders installed")
        controls = {
            "libx264": ({"preset": "ultrafast"}, {"psy-rd": "1.0:0.1", "scenecut": "0"}),
            "libx265": ({"preset": "ultrafast"}, {"sao": "0", "frame-threads": "1"}),
            "libvpx-vp9": ({"cpu-used": "8", "deadline": "realtime"}, {}),
            "libsvtav1": ({"preset": "10"}, {"tune": "0"}),
        }
        for desc in catalog:
            encoder = desc["encoder"]
            options, native = controls[encoder]
            with self.subTest(encoder=encoder):
                args = build_software_options({"encoder": encoder, "options": {**options, "b": "250000"},
                                              "nativeOptions": native}, desc["codec"], catalog)
                result = subprocess.run([ffmpeg, "-v", "warning", "-nostdin", "-f", "lavfi", "-i",
                                         "testsrc2=size=160x120:rate=30", "-frames:v", "3", *args,
                                         "-f", "null", "-"], capture_output=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                self.assertNotRegex(result.stderr.decode(), r"(?i)unknown option|error parsing option|invalid value for")


if __name__ == "__main__":
    unittest.main()
