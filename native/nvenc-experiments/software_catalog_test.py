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
  -bf                <int>        E..V....... B frames (from -1 to INT_MAX)
  -refs              <int>        E..V....... Reference pictures (from -1 to INT_MAX)
  -slices            <int>        E..V....... Number of slices (from 0 to INT_MAX)

other AVOptions:
  -threads           <int>        E..V....... Unrelated section
"""
    name = args[-1].removeprefix("encoder=")
    if name == "libx265":
        return "Codec 'libx265' is not recognized by FFmpeg."
    report = f"Encoder {name} [test]:\n"
    if name == "libsvtav1":
        report += """  -crf               <int>        E..V....... CRF (from 0 to 63) (default 0)
  -qp                <int>        E..V....... QP (from 0 to 63) (default 0)
"""
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
        self.assertEqual(set(fields), {"b", "bf", "refs", "g", "passes", "flags", "force_key_frames", "quality", "slices"})
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

    def test_ignored_vp9_and_svt_wrapper_controls_are_not_admitted(self):
        vp9 = next(row for row in self.encoders if row["encoder"] == "libvpx-vp9")
        self.assertIn("slices", {field["name"] for field in vp9["limitations"]})
        with self.assertRaises(ValueError):
            self.encode("libvpx-vp9", {"slices": "4"})
        for options in ({"crf": "0"}, {"qp": "0"}, {"crf": "25", "qp": "20"}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.encode("libsvtav1", options)
        self.encode("libsvtav1", {"crf": "1"})
        self.encode("libsvtav1", {"qp": "1"})
        self.encode("libsvtav1", {}, {"crf": "0"})
        for options, native in [({"crf": "20"}, {"crf": "45"}), ({"qp": "20"}, {"q": "45"}),
                                ({}, {"qp": "20", "cqp": "45"})]:
            with self.subTest(options=options, native=native), self.assertRaisesRegex(ValueError, "only one|one SVT"):
                self.encode("libsvtav1", options, native)

    def test_baseline_profile_excludes_requested_bframes_in_both_namespaces(self):
        x264 = next(row for row in self.encoders if row["encoder"] == "libx264")
        x264["options"].extend({"name": name, "type": "string", "description": ""} for name in ("profile", "coder", "wpredp"))
        for options, native in [({"profile": "Baseline", "bf": "3"}, {}), ({"profile": "baseline"}, {"bframes": "1"}),
                                ({"profile": "main"}, {"8x8dct": "true"}), ({"profile": "main"}, {"cqm": "jvt"}),
                                ({"profile": "baseline", "coder": "default"}, {"cabac": "1"}),
                                ({"profile": "Baseline", "wpredp": "0"}, {"weightp": "2"})]:
            with self.subTest(options=options, native=native), self.assertRaisesRegex(ValueError, "profile"):
                self.encode("libx264", options, native)
        self.encode("libx264", {"profile": "baseline", "bf": "0"})
        self.encode("libx264", {"profile": "main", "bf": "3"}, {"cabac": "1"})

    def test_x26x_structure_values_match_encoder_limits_in_both_namespaces(self):
        def all_help(args):
            if args[-1] == "encoder=libx265":
                return help_for([*args[:-1], "encoder=libx264"]).replace("libx264", "libx265").replace("x264-params", "x265-params")
            return help_for(args)

        self.encoders = discover_software_encoders("ffmpeg", capture_help=all_help)
        for encoder in ("libx264", "libx265"):
            for options, native in [({"bf": "30"}, {}), ({}, {"bframes": "17"}), ({"refs": "0"}, {}),
                                    ({"refs": "17"}, {}), ({}, {"ref": "17"}), ({}, {"ref": "0"}),
                                    ({"bf": "3"}, {"bframes": "4"}), ({"refs": "4"}, {"ref": "3"}),
                                    ({"g": "30"}, {"keyint": "60"})]:
                with self.subTest(encoder=encoder, options=options, native=native), self.assertRaises(ValueError):
                    self.encode(encoder, options, native)
            self.encode(encoder, {"bf": "-1", "refs": "-1"})
            self.encode(encoder, {"bf": "16", "refs": "16"})
            for options, native in [({"g": "1", "refs": "2"}, {}), ({"bf": "1"}, {"keyint": "1"}),
                                    ({"g": "-1"}, {"keyint": "4"}), ({}, {"keyint": "0x4"}),
                                    ({}, {"keyint": "+4"}), ({}, {"keyint": "04"}),
                                    ({}, {"ref": "010"}), ({}, {"bframes": "010"})]:
                with self.subTest(encoder=encoder, options=options, native=native), self.assertRaises(ValueError):
                    self.encode(encoder, options, native)
            self.encode(encoder, {"g": "0", "bf": "-1", "refs": "-1"})
        for options, native in [({}, {"dpb-size": "17"}), ({}, {"ref": "2", "frameref": "3"}),
                                ({"g": "4"}, {"bframes": "4"}), ({"bf": "4"}, {"keyint": "4"}),
                                ({"g": "0"}, {"dpb-size": "2"}), ({}, {"keyint": "1", "frameref": "2"}),
                                ({}, {"keyint": "0"}), ({}, {"keyint": "-1"}), ({}, {"keyint": "1infinite"}),
                                ({}, {"keyint": str((1 << 30) + 1)}), ({"g": str((1 << 30) + 1)}, {})]:
            with self.subTest(options=options, native=native), self.assertRaises(ValueError):
                self.encode("libx264", options, native)
        self.encode("libx264", {"bf": "3"}, {"keyint": "4"})
        self.encode("libx264", {"bf": "16"}, {"keyint": "infinite"})
        self.encode("libx264", {}, {"keyint": str(1 << 30)})
        self.encode("libx265", {"bf": "16"}, {"keyint": "-1"})
        self.encode("libx265", {"bf": "16"}, {"keyint": "16"})
        with self.assertRaises(ValueError):
            self.encode("libx265", {}, {"keyint": "0", "ref": "2"})

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
