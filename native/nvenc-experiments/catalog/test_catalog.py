import json
from pathlib import Path
import runpy
import unittest


CATALOG = Path(__file__).with_name("sdk-13.0.json")
RUNNER = CATALOG.parent.parent / "runner.py"
HEADER_SHA256 = "4fe4094541ef0f8a13249d97a8692dc5f835a6e9dd42eeadb3e2f7321d54dc7e"


class CatalogTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
        cls.types = {record["name"]: record for record in cls.catalog["types"]}

    def fields(self, type_name):
        return {field["name"]: field for field in self.types[type_name]["fields"]}

    def test_pinned_header_and_inventory_denominator(self):
        self.assertEqual(self.catalog["schemaVersion"], 1)
        upstream = self.catalog["upstream"]
        self.assertEqual(upstream["tag"], "n13.0.19.0")
        self.assertEqual(upstream["commit"], "e844e5b26f46bb77479f063029595293aa8f812d")
        self.assertEqual(upstream["headerSha256"], HEADER_SHA256)
        self.assertEqual(upstream["sdkVersion"], "13.0")
        self.assertEqual(len(self.types), 97)
        expected = {
            "structs": 56,
            "unions": 3,
            "enums": 38,
            "fields": 778,
            "enumValues": 350,
            "guids": 24,
            "aliases": 48,
        }
        actual = {
            "structs": sum(record["kind"] == "struct" for record in self.types.values()),
            "unions": sum(record["kind"] == "union" for record in self.types.values()),
            "enums": sum(record["kind"] == "enum" for record in self.types.values()),
            "fields": sum(len(record.get("fields", [])) for record in self.types.values()),
            "enumValues": sum(len(record.get("values", [])) for record in self.types.values()),
            "guids": len(self.catalog["guids"]),
            "aliases": len(self.catalog["aliases"]),
        }
        self.assertEqual(actual, expected)
        self.assertEqual(self.catalog["denominator"], expected)

    def test_core_and_codec_specific_record_denominators(self):
        expected = {
            "NV_ENC_INITIALIZE_PARAMS": 35,
            "NV_ENC_CONFIG": 11,
            "NV_ENC_RC_PARAMS": 44,
            "NV_ENC_CONFIG_H264": 53,
            "NV_ENC_CONFIG_HEVC": 51,
            "NV_ENC_CONFIG_AV1": 47,
            "NV_ENC_PIC_PARAMS": 31,
            "NV_ENC_PIC_PARAMS_H264": 25,
            "NV_ENC_PIC_PARAMS_HEVC": 29,
            "NV_ENC_PIC_PARAMS_AV1": 35,
            "NV_ENC_RECONFIGURE_PARAMS": 7,
            "NV_ENC_CODEC_CONFIG": 6,
            "NV_ENC_CODEC_PIC_PARAMS": 4,
            "HEVC_3D_REFERENCE_DISPLAY_INFO": 15,
            "MASTERING_DISPLAY_INFO": 6,
        }
        for type_name, count in expected.items():
            with self.subTest(type_name=type_name):
                fields = self.fields(type_name)
                self.assertEqual(len(fields), count)
                self.assertEqual(len(self.types[type_name]["fields"]), count)
                self.assertTrue(all(field["sourceLine"] > 0 for field in fields.values()))
                self.assertTrue(all(field["type"] for field in fields.values()))

    def test_classification_separates_static_fields_runtime_inputs_and_internal_state(self):
        cases = [
            ("NV_ENC_INITIALIZE_PARAMS", "privData", "reserved", "initialize", "in"),
            ("NV_ENC_INITIALIZE_PARAMS", "encodeWidth", "runner_managed", "initialize", "in"),
            ("NV_ENC_INITIALIZE_PARAMS", "encodeConfig", "pointer", "initialize", "in"),
            ("NV_ENC_CONFIG", "version", "runner_managed", "configuration", "in"),
            ("NV_ENC_CONFIG_AV1", "enableFilmGrainParams", "inventoried_unbound",
             "configuration", "in"),
            ("NV_ENC_PIC_PARAMS", "encodePicFlags", "per_frame", "picture", "in"),
            ("NV_ENC_PIC_PARAMS", "inputTimeStamp", "runner_managed", "picture", "in"),
            ("NV_ENC_PIC_PARAMS", "inputBuffer", "pointer", "picture", "in"),
            ("NV_ENC_PIC_PARAMS_AV1", "goldenFrameFlag", "per_frame", "picture", "in"),
            ("NV_ENC_PIC_PARAMS_H264", "ltrUsageMode", "reserved", "picture", "in"),
            ("NV_ENC_RECONFIGURE_PARAMS", "resetEncoder", "inventoried_unbound",
             "reconfigure", "in"),
            ("NV_ENC_H264_MV_DATA", "mbCost", "runner_managed", "output", "unspecified"),
            ("NV_ENC_HEVC_MV_DATA", "cuType", "runner_managed", "output", "unspecified"),
            ("NV_ENC_MVECTOR", "mvx", "runner_managed", "output", "unspecified"),
            ("NV_ENC_LOCK_BITSTREAM", "doNotWait", "inventoried_unbound", "output", "in"),
        ]
        for type_name, field_name, classification, lifecycle, direction in cases:
            with self.subTest(type_name=type_name, field_name=field_name):
                field = self.fields(type_name)[field_name]
                self.assertEqual(field["classification"], classification)
                self.assertEqual(field["lifecycle"], lifecycle)
                self.assertEqual(field["direction"], direction)
                self.assertNotIn("binding", field)
        self.assertEqual(self.fields("NV_ENC_RC_PARAMS")["enableAQ"]["bitWidth"], 1)
        self.assertEqual(self.fields("NV_ENC_RECONFIGURE_PARAMS")["resetEncoder"]["bitWidth"], 1)
        self.assertEqual(self.types["NV_ENC_CONFIG"]["versionMacro"], "NV_ENC_CONFIG_VER")

    def test_constants_include_implicit_enum_values_guid_values_and_aliases(self):
        modes = {row["name"]: row["value"] for row in self.types["NV_ENC_PARAMS_RC_MODE"]["values"]}
        self.assertEqual(modes["NV_ENC_PARAMS_RC_VBR"], 1)
        statuses = {row["name"]: row["value"] for row in self.types["NVENCSTATUS"]["values"]}
        self.assertEqual(statuses["NV_ENC_SUCCESS"], 0)
        self.assertEqual(statuses["NV_ENC_ERR_NO_ENCODE_DEVICE"], 1)
        guids = {row["name"]: row["value"] for row in self.catalog["guids"]}
        self.assertEqual(guids["NV_ENC_CODEC_H264_GUID"], "6bc82762-4e63-4ca4-aa85-1e50f321f6bf")
        self.assertEqual(guids["NV_ENC_CODEC_HEVC_GUID"], "790cdc88-4522-4d7b-9425-bda9975f7603")
        self.assertIn("NV_ENC_PRESET_P7_GUID", guids)
        aliases = {row["name"]: row["type"] for row in self.catalog["aliases"]}
        self.assertEqual(aliases["NV_ENC_CONFIG_HEVC_VUI_PARAMETERS"], "NV_ENC_CONFIG_H264_VUI_PARAMETERS")

    def test_only_declared_runner_bindings_and_cli_spellings(self):
        expected = {
            "codec": ("-c:v", "hevc_nvenc"),
            "preset": ("-preset", "p4"),
            "tuning": ("-tune", "hq"),
            "config.gopLength": ("-g", "60"),
            "config.frameIntervalP": ("-bf", "2"),
            "config.rcParams.rateControlMode": ("-rc", "vbr"),
            "config.rcParams.averageBitRate": ("-b:v", "3500000"),
            "config.rcParams.maxBitRate": ("-maxrate:v", "4000000"),
            "config.rcParams.vbvBufferSize": ("-bufsize:v", "7000000"),
            "config.rcParams.enableAQ": ("-spatial-aq", "1"),
            "config.rcParams.enableTemporalAQ": ("-temporal-aq", "0"),
            "config.rcParams.lookaheadDepth": ("-rc-lookahead", "0"),
        }
        fields = [
            field
            for record in self.types.values()
            for field in record.get("fields", [])
        ]
        bindings = [field["binding"] for field in fields if field["classification"] == "ffmpeg_vbr_binding"]
        self.assertEqual(len(bindings), len(expected))
        by_trial_field = {binding["trialField"]: binding["ffmpegOption"] for binding in bindings}
        self.assertEqual(by_trial_field, {key: option for key, (option, _) in expected.items()})
        self.assertTrue(all("binding" not in field for field in fields
                            if field["classification"] != "ffmpeg_vbr_binding"))
        runner = runpy.run_path(str(RUNNER))
        trial = runner["parse_trial"]({
            "schemaVersion": 1,
            "sourcePath": "/test/registered/source",
            "trial": {
                "sourceId": "test-source",
                "window": {"timeBase": {"num": 1, "den": 30}, "startPts": "0", "endPtsExclusive": "3"},
                "codec": "HEVC",
                "preset": "P4",
                "tuning": "HIGH_QUALITY",
                "config": {
                    "gopLength": 60,
                    "frameIntervalP": 3,
                    "rcParams": {
                        "rateControlMode": "VBR",
                        "averageBitRate": 3500000,
                        "maxBitRate": 4000000,
                        "vbvBufferSize": 7000000,
                        "enableAQ": True,
                        "enableTemporalAQ": False,
                        "lookaheadDepth": 0,
                    },
                },
            },
        })
        args = runner["encode_options"](trial)
        self.assertEqual(len(args), 2 * len(expected))
        self.assertEqual(dict(zip(args[::2], args[1::2])), dict(expected.values()))

    def test_rate_bindings_expose_ffmpeg_option_bounds(self):
        rates = self.fields("NV_ENC_RC_PARAMS")
        for name in ("maxBitRate", "vbvBufferSize"):
            with self.subTest(name=name):
                self.assertEqual(rates[name]["binding"]["maximum"], (1 << 31) - 1)
        self.assertEqual(rates["averageBitRate"]["binding"]["maximum"], (1 << 32) - 1)

    def test_sdk_bindings_cover_session_and_picture_fields(self):
        fields = self.catalog["sdkBindings"]
        by_name = {field["field"]: field for field in fields if field["phase"] != "reconfigure"}
        self.assertEqual(len(fields), len({(field["phase"], field["field"]) for field in fields}))
        self.assertGreater(len(fields), 150)
        all_codecs = ["H264", "HEVC", "AV1"]
        for field, phase, codecs in (
            ("NV_ENC_RC_PARAMS.aqStrength", "session", all_codecs),
            ("NV_ENC_RC_PARAMS.constQP.qpInterP", "session", all_codecs),
            ("NV_ENC_RC_PARAMS.temporalLayerQP[7]", "session", all_codecs),
            ("NV_ENC_CONFIG_H264_VUI_PARAMETERS.videoFullRangeFlag", "session", ["H264"]),
            ("NV_ENC_CONFIG_HEVC_VUI_PARAMETERS.videoFullRangeFlag", "session", ["HEVC"]),
            ("NV_ENC_CONFIG.profileGUID", "session", all_codecs),
            ("NV_ENC_PIC_PARAMS_HEVC.ltrMarkFrame", "picture", ["HEVC"]),
            ("NV_ENC_PIC_PARAMS_AV1.temporalConfigUpdate", "picture", ["AV1"]),
            ("NV_ENC_CONFIG_AV1.tileWidths[63]", "session", ["AV1"]),
            ("NV_ENC_PIC_PARAMS_AV1.tileHeights[0]", "picture", ["AV1"]),
        ):
            with self.subTest(field=field):
                self.assertEqual(by_name[field]["phase"], phase)
                self.assertEqual(by_name[field]["codecs"], codecs)
        self.assertEqual(by_name["NV_ENC_RC_PARAMS.aqStrength"]["maximum"], 15)
        self.assertEqual(by_name["NV_ENC_RC_PARAMS.enableAQ"]["type"], "boolean")
        self.assertEqual(by_name["NV_ENC_RC_PARAMS.qpMapMode"]["values"], [0, 1, 2])
        self.assertEqual(by_name["NV_ENC_RC_PARAMS.qpMapMode"]["choices"][1]["codecs"], ["H264"])
        self.assertEqual(by_name["NV_ENC_CONFIG_AV1.filmGrainParams.numYPoints"]["maximum"], 14)
        self.assertEqual(by_name["NV_ENC_CONFIG_AV1.level"]["maximum"], 24)
        self.assertEqual(by_name["NV_ENC_CONFIG_HEVC.tier"]["values"], [0, 1])
        self.assertEqual(by_name["NV_ENC_CONFIG_HEVC.maxCUSize"]["values"], [0, 3])
        self.assertEqual(by_name["NV_ENC_CONFIG_AV1.tileWidths[63]"]["minimum"], 1)
        for field in (
            "NV_ENC_INITIALIZE_PARAMS.enableOutputInVidmem",
            "NV_ENC_INITIALIZE_PARAMS.encodeWidth",
            "NV_ENC_CONFIG.version",
            "NV_ENC_CONFIG.profileGUID.Data1",
            "NV_ENC_PIC_PARAMS.inputBuffer",
            "NV_ENC_PIC_PARAMS.inputTimeStamp",
            "NV_ENC_PIC_PARAMS_AV1.tileWidths",
        ):
            self.assertNotIn(field, by_name)

    def test_timed_rate_change_has_its_own_schema(self):
        by_name = {row["field"]: row for row in self.catalog["sdkBindings"] if row["phase"] == "reconfigure"}
        self.assertEqual(by_name.keys(), {
            "NV_ENC_RC_PARAMS.averageBitRate", "NV_ENC_RC_PARAMS.maxBitRate", "NV_ENC_RC_PARAMS.vbvBufferSize",
            "NV_ENC_RECONFIGURE_PARAMS.resetEncoder", "NV_ENC_RECONFIGURE_PARAMS.forceIDR",
        })
        self.assertEqual(by_name["NV_ENC_RECONFIGURE_PARAMS.forceIDR"]["type"], "boolean")

    def test_typed_metadata_owns_codec_payload_arrays(self):
        for codec, prefix in (("H264", "sei"), ("HEVC", "sei"), ("AV1", "obu")):
            for suffix in ("PayloadArray", "PayloadArrayCnt"):
                field = f"NV_ENC_PIC_PARAMS_{codec}.{prefix}{suffix}"
                with self.subTest(field=field):
                    self.assertEqual(self.catalog["sdkLimitations"][field]["role"], "typed_payload")


if __name__ == "__main__":
    unittest.main(verbosity=2)
