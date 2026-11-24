"""Versioned controls for replayable FFmpeg software-encoder experiments.

FFmpeg supplies its own AVOption metadata. Library dictionary keys below are
the public parser inventory from x264 b35605a common/base.c, x265 4.3
source/common/param.cpp and SVT-AV1 v4.3.0 Source/Lib/Globals/enc_settings.c.
VP9 temporal keys come from FFmpeg libavcodec/libvpxenc.c. A library can
decline keys on a different build; the worker checks its diagnostics.
"""

import re
import subprocess
from decimal import Decimal

ENCODERS = {
    "libx264": ("H264", "x264-params"),
    "libx265": ("HEVC", "x265-params"),
    "libvpx-vp9": ("VP9", "ts-parameters"),
    "libsvtav1": ("AV1", "svtav1-params"),
}

# AVCodecContext fields actually consumed by the respective FFmpeg wrappers.
COMMON = {
    "libx264": "b g qcomp qblur qmin qmax qdiff bf b_qfactor i_qfactor maxrate bufsize rc_init_occupancy "
               "threads thread_type keyint_min refs slices trellis subq me_range cmp level",
    "libx265": "b g qcomp qblur qmin qmax qdiff bf b_qfactor i_qfactor maxrate bufsize rc_init_occupancy "
               "threads keyint_min refs",
    "libvpx-vp9": "b g qcomp qmin qmax minrate maxrate bufsize rc_init_occupancy threads keyint_min slices profile",
    "libsvtav1": "b g qmin qmax maxrate bufsize profile level",
}

NATIVE_KEYS = {
    "libx264": {
        "boolean": """
            8x8dct annexb aud bluray-compat cabac chroma-me constrained-intra cpu-independent
            dct-decimate deterministic fake-interlaced fast-pskip filler interlaced intra-refresh
            mbtree mixed-refs n-deterministic open-gop opencl pic-struct psnr psy repeat-headers
            sliced-threads ssim stitchable tff weight-b weightb
        """,
        "int": """
            aq-mode avcintra-class b-bias bframes cabac-idc chroma-qp-offset deadzone-inter
            deadzone-intra dpb-size frame-packing frameref log me-range merange mv-range
            mv-range-thread mvrange mvrange-thread nr qp-max qp-min qp-step qpmax qpmin qpstep
            rc-lookahead ref slice-max-mbs slice-max-size slice-min-mbs slices slices-max sps-id
            subme subq trellis vbv-bufsize vbv-maxrate weightp
        """,
        "float": """
            aq-strength cplx-blur cplxblur crf-max ip-factor ipratio pb-factor pbratio qblur qcomp
            vbv-init
        """,
        "string": """
            alternative-transfer analyse asm avcintra-flavor b-adapt b-pyramid bff bitrate chromaloc
            cll colormatrix colorprim cqm cqm4 cqm4i cqm4ic cqm4iy cqm4p cqm4pc cqm4py cqm8 cqm8i
            cqm8p cqmfile crf crop-rect deblock direct direct-pred dump-yuv filter force-cfr fps
            fullrange global-header keyint keyint-min level level-idc lookahead-threads
            mastering-display me min-keyint nal-hrd nf opencl-clbin opencl-device overscan
            partitions pass psy-rd qp qp_constant ratetol sar scenecut stats sync-lookahead threads
            transfer videoformat zones
        """,
    },
    "libx265": {
        "boolean": """
            allow-non-conformance amp analyze-src-pics annexb aq-motion aud b-intra b-pyramid cip
            cll const-vbv constrained-intra copy-pic cra-nal cu-lossless cu-stats cutree dhdr10-opt
            dynamic-refine early-skip eob eos fades fast-intra field frame-dup frame-rc hdr10
            hdr10-opt hevc-aq high-tier hist-scenecut hme hrd hrd-concat idr-recovery-sei info
            intra-refresh limit-modes limit-sao lossless lowpass-dct mcstf multi-pass-opt-analysis
            multi-pass-opt-distortion multi-pass-opt-rps no-tskip-fast open-gop opt-cu-delta-qp
            opt-qp-pps opt-ref-list-length-pps pme pmode psnr rc-grain rd-refine rect repeat-headers
            sao sao-non-deblock sbrc selective-mcstf signhide single-sei slow-firstpass splitrd-skip
            ssim strong-intra-smoothing temporal-mvp threaded-me tskip tskip-fast uhd-bd
            vbv-live-multi-pass vui-hrd-info vui-timing-info weightb weightp wpp
        """,
        "int": """
            analysis-load-reuse-level analysis-save-reuse-level aq-mode atc-sei bframe-bias bframes
            cbqpoffs chunk-end chunk-start crqpoffs csv-log-level ctu-info dup-threshold force-flush
            format frame-threads gop-lookahead hash keyint limit-refs limit-tu log2-max-poc-lsb
            lookahead-slices lookahead-threads mcstf-ref-range merange min-keyint nr-inter nr-intra
            pic-struct qg-size qpmax qpmin qpstep radl rc-lookahead rd rdpenalty ref
            refine-ctu-distortion refine-inter refine-intra refine-mv rskip scale-factor
            scenecut-aware-qp slices subme temporal-layers total-frames vbv-bufsize vbv-maxrate
        """,
        "float": """
            aq-strength cplxblur crf-max crf-min dynamic-rd ip-factor ipratio max-ausize-factor
            max-vbv-fullness min-vbv-fullness pb-factor pbratio qblur qcomp qp-adaptation-range
            scenecut-bias vbv-end vbv-end-fr-adj vbv-init
        """,
        "string": """
            alpha analysis-load analysis-reuse-file analysis-reuse-level analysis-reuse-mode
            analysis-save aom-film-grain asm b-adapt bitrate chromaloc colormatrix colorprim crf
            crop-rect csv ctu deblock dhdr10-info display-window dolby-vision-profile film-grain
            fovea-delta fovea-gaze fovea-gaze-file fovea-sigma fps hdr hdr-opt hme-range hme-search
            input-csp input-depth input-res interlace lambda-file level level-idc lft log log-level
            masking-strength master-display max-cll max-luma max-merge max-tu-size me min-cu-size
            min-luma nalu-file num-views numa-pools overscan pass pools psy-rd psy-rdoq qp range
            rdoq rdoq-level refine-analysis-type rskip-edge-threshold sar scaling-list scc scenecut
            selective-sao ssim-rd stats strict-cbr svt svt-base-layer-switch-mode
            svt-compressed-ten-bit-format svt-fps-in-vps svt-hierarchical-level svt-hme
            svt-pred-struct svt-preset-tuner svt-search-height svt-search-width svt-speed-control
            transfer tu-inter-depth tu-intra-depth video-signal-type-preset videoformat zones
        """,
    },
    "libsvtav1": {
        "boolean": """
            adaptive-film-grain avif enable-dg enable-force-key-frames enable-intrabc enable-kf-tf
            enable-overlays enable-qm enable-variance-boost gop-constraint-rc lossless rtc
            use-q-file
        """,
        "int": """
            aq-mode buf-initial-sz buf-optimal-sz buf-sz chroma-qm-max chroma-qm-min
            chroma-u-ac-qindex-offset chroma-u-dc-qindex-offset chroma-v-ac-qindex-offset
            chroma-v-dc-qindex-offset enable-cdef enable-dlf enable-mfmv enable-restoration
            enable-stat-report enable-tf fast-decode film-grain film-grain-denoise
            forced-max-frame-height forced-max-frame-width fps-denom fps-num h hbd-mds height
            hierarchical-levels input-depth intra-period key-frame-chroma-qindex-offset
            key-frame-qindex-offset level lookahead lp luma-y-dc-qindex-offset luminance-qp-bias
            max-inter-bitrate-pct max-intra-bitrate-pct max-qp max-tx-size maxsection-pct
            mbr-overshoot-pct min-qp minsection-pct overshoot-pct pass preset q qm-max qm-min qp
            qp-scale-compress-strength recode-loop resize-denom resize-kf-denom resize-mode scd scm
            sframe-dist sharpness startup-mg-size startup-qp-offset superres-denom superres-kf-denom
            superres-kf-qthres superres-mode superres-qthres tf-strength tier tile-columns tile-rows
            tune undershoot-pct use-fixed-qindex-offsets variance-boost-curve
            variance-boost-strength variance-octile w width
        """,
        "float": """
            ac-bias
        """,
        "string": """
            asm chroma-qindex-offsets chroma-sample-position color-format color-primaries
            color-range content-light cqp crf frame-resz-denoms frame-resz-events
            frame-resz-kf-denoms irefresh-type keyint lambda-scale-factors mastering-display
            matrix-coefficients mbr pred-struct profile qindex-offsets rc sframe-mode sframe-posi
            sframe-qp sframe-qp-offset tbr transfer-characteristics
        """,
    },
}

VP9_LAYERS = {
    "ts_number_layers": ("int", "Number of temporal layers", "1", "5"),
    "ts_target_bitrate": ("string", "Comma-separated target rates per layer, in kb/s", None, None),
    "ts_rate_decimator": ("string", "Comma-separated positive rate decimators per layer", None, None),
    "ts_periodicity": ("int", "Length of the repeating temporal pattern", "1", "16"),
    "ts_layer_id": ("string", "Comma-separated temporal layer IDs in display order", None, None),
    "ts_layering_mode": ("int", "Predefined temporal layer pattern: 0, 2, 3 or 4", "0", "4"),
}

# Controls in vpx/vp8cx.h without an option or scalar dictionary binding in
# stock FFmpeg's VP9 wrapper. In particular, ts-parameters is not a generic
# gateway to vpx_codec_control(). Report these alongside the selectable keys.
VP9_API_ONLY = """
    VP9E_SET_MAX_INTER_BITRATE_PCT VP9E_SET_GF_CBR_BOOST_PCT VP9E_SET_FRAME_PERIODIC_BOOST
    VP9E_SET_MAX_GF_INTERVAL VP9E_SET_ALT_REF_AQ VP9E_SET_POSTENCODE_DROP
    VP9E_SET_DELTA_Q_UV VP9E_SET_DISABLE_OVERSHOOT_MAXQ_CBR VP9E_SET_DISABLE_LOOPFILTER
    VP9E_SET_QUANTIZER_ONE_PASS VP9E_SET_KEY_FRAME_FILTERING VP9E_SET_VALIDATE_HBD_INPUT
    VP9E_SET_EXTERNAL_RATE_CONTROL VP9E_SET_RTC_EXTERNAL_RATECTRL VP9E_SET_ROI_MAP
    VP9E_SET_SVC_INTER_LAYER_PRED VP9E_SET_SVC_FRAME_DROP_LAYER VP9E_SET_SVC_GF_TEMPORAL_REF
    VP9E_SET_SVC_SPATIAL_LAYER_SYNC VP9E_SET_SVC_REF_FRAME_CONFIG VP9E_SET_SVC_PARAMETERS
    VP9E_SET_SVC_LAYER_ID VP9E_SET_RENDER_SIZE VP8E_SET_ACTIVEMAP
""".split()

BITSTREAM_FLAGS = {
    "libx264": ("cgop", "loop", "psnr"),
    "libx265": ("cgop", "psnr"),
    "libvpx-vp9": ("psnr",),
    "libsvtav1": ("cgop",),
}

# A field may accept a filesystem path even when its name suggests a tuning
# setting (e.g. x264's cqm). Such fields must only offer path-free alternatives.
VALUE_CHOICES = {
    ("libx264", "cqm"): ("flat", "jvt"),
    ("libx265", "scaling-list"): ("off", "default"),
}
FILE_CONTROLS = set("""
    pass stats passlogfile x265-stats dump-yuv cqmfile opencl-clbin opencl
    analysis-load analysis-save analysis-reuse-file analysis-reuse-mode
    analysis-save-reuse-level analysis-load-reuse-level analysis-reuse-level
    lambda-file nalu-file csv csv-log-level dhdr10-info aom-film-grain fovea-gaze-file
    use-q-file
""".split())
MEDIA_CONTROLS = set("""
    fps timebase fps-num fps-denom width height h w total-frames input-depth input-csp input-res
    color-format field interlace interlaced fake-interlaced tff bff crop-rect display-window
    chunk-start chunk-end annexb global-header force-cfr frame-dup format num-views alpha
    resize-mode resize-denom resize-kf-denom frame-resz-events frame-resz-denoms frame-resz-kf-denoms
    sar avif colormatrix colorprim transfer fullrange range color-primaries color-range
    transfer-characteristics matrix-coefficients video-signal-type-preset
""".split())
API_CONTROLS = {"mb_info", "ctu-info", "frame-rc", "force-flush", "opencl-device", "svt"}
# Logging controls can silence a library's rejected-option diagnostics.
DIAGNOSTICS = {"log", "log-level"}
PRIVATE_STRINGS = {"preset", "tune", "profile", "level", "wpredp", "psy-rd", "deblock", "partitions"}
OPTION_LINE = re.compile(r"^\s{2}-([A-Za-z0-9_-]+)\s+<(\w+)>\s+([A-Z.]{8,})\s*(.*)$")
CHOICE_LINE = re.compile(r"^\s{4,}([A-Za-z0-9_.-]+)\s+(?:(-?\d+)\s+)?[A-Z.]{8,}(?:\s|$)")
RANGE = re.compile(r" \(from ([^ )]+) to ([^ )]+)\)")
DEFAULT = re.compile(r' \(default ("[^"]*"|[^)]+)\)')
NUMBER = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d{1,3})?")
INTEGER = re.compile(r"[+-]?\d+")
VALUE = re.compile(r"[A-Za-z0-9._+(),:\[\]/=-]+")
ZONE = re.compile(r"\d+,\d+,(?:q=\d+|b=(?:\d+(?:\.\d*)?|\.\d+))")
SCALE = {"INT_MIN": -(2**31), "INT_MAX": 2**31 - 1, "I64_MAX": 2**63 - 1,
         "I64_MIN": -(2**63), "FLT_MAX": Decimal("3.40282347e38"),
         "-FLT_MAX": Decimal("-3.40282347e38")}


def parse_avoptions(text):
    """Read one help section (private AVOptions or AVCodecContext)."""
    fields = {}
    current = None
    for line in text.splitlines():
        match = OPTION_LINE.match(line)
        if match:
            name, kind, flags, description = match.groups()
            current = None
            if "E" not in flags or "V" not in flags:
                continue
            current = {"name": name, "type": kind, "description": description}
            bounds = RANGE.search(" " + description)
            default = DEFAULT.search(" " + description)
            if bounds:
                current.update(minimum=bounds[1], maximum=bounds[2])
            if default:
                current["default"] = default[1].strip('"')
            current["description"] = DEFAULT.sub("", RANGE.sub("", " " + description)).strip()
            fields[name] = current
        elif current:
            choice = CHOICE_LINE.match(line)
            if choice:
                current.setdefault("choices", []).append(choice[1])
    return fields


def limitation(encoder, name):
    if name in FILE_CONTROLS or (encoder == "libx265" and name == "film-grain"):
        return "File-backed control; the worker owns paths and pass statistics."
    if name in MEDIA_CONTROLS:
        return "The trial owns source geometry, format, timeline and output container."
    if name in DIAGNOSTICS:
        return "The worker owns diagnostics to verify that settings were accepted."
    if name in API_CONTROLS or name.startswith("svt-"):
        return "Requires a different encoder API, input or device."
    return None


def encoder_catalog(encoder, private, generic):
    codec, dictionary = ENCODERS[encoder]
    # A codec can override AVCodecContext defaults in its FFCodecDefault
    # table or via its own preset. Only private defaults describe this wrapper.
    options = {name: {k: v for k, v in generic[name].items() if k != "default"}
               for name in COMMON[encoder].split() if name in generic}
    # The shared AVCodecContext table includes enum constants from different
    # codecs (e.g. HEVC main10 in the generic AV1 profile list).
    for name in ("profile", "level"):
        if name in options:
            options[name].pop("choices", None)
    limitations = {}
    native = {}
    for name, field in private.items():
        if name in {dictionary, "x264opts"}:
            limitations[name] = "Set individual entries in Native parameters."
            continue
        reason = limitation(encoder, name)
        if not reason and (field["type"] in {"dictionary", "binary"} or
                           (field["type"] == "string" and name not in PRIVATE_STRINGS)):
            reason = "This private option has no reviewed value binding in this runtime."
        if reason:
            limitations[name] = reason
        else:
            options[name] = field
    if dictionary in private:
        for kind, names in NATIVE_KEYS.get(encoder, {}).items():
            for name in names.split():
                reason = limitation(encoder, name)
                if reason:
                    limitations[name] = reason
                    continue
                field = {"name": name, "type": kind, "description": "Native key; the installed library checks support."}
                if name in private:
                    field["description"] = private[name]["description"] or field["description"]
                if (encoder, name) in VALUE_CHOICES:
                    field["choices"] = list(VALUE_CHOICES[encoder, name])
                native[name] = field
        if encoder == "libvpx-vp9":
            for name in VP9_API_ONLY:
                limitations[name] = "No user setting for this libvpx C API control in the stock FFmpeg VP9 wrapper."
            for name, (kind, help_text, lower, upper) in VP9_LAYERS.items():
                field = {"name": name, "type": kind, "description": help_text}
                if lower is not None:
                    field.update(minimum=lower, maximum=upper)
                native[name] = field
    # Use +/- modifiers so FFmpeg retains muxer-required flags. The raw bitmask
    # also includes pass1/pass2, which are managed by the worker.
    options["flags"] = {
        "name": "flags", "type": "flags", "description": "Set (+) or clear (-) individual codec flags.",
        "choices": [prefix + key for key in BITSTREAM_FLAGS[encoder] for prefix in ("+", "-")],
    }
    options["force_key_frames"] = {
        "name": "force_key_frames", "type": "string",
        "description": "Force key frames at source key frames (source) or comma-separated times in seconds.",
    }
    options["passes"] = {"name": "passes", "type": "int", "minimum": "1", "maximum": "2",
                         "default": "1", "choices": ["1", "2"],
                         "description": "Managed encoding passes; two-pass support depends on the installed library."}
    return {"encoder": encoder, "codec": codec, "options": [options[k] for k in sorted(options)],
            "nativeOptions": [native[k] for k in sorted(native)],
            "limitations": [{"name": k, "reason": v} for k, v in sorted(limitations.items())]}


def read_help(args):
    result = subprocess.run(args, capture_output=True, timeout=15, text=True, errors="replace")
    return result.stdout + result.stderr


def discover_software_encoders(ffmpeg, *, capture_help=None):
    help_text = capture_help or read_help
    prefix = [str(ffmpeg), "-hide_banner", "-h"]
    full_help = help_text([*prefix, "full"])
    common_help = full_help.partition("AVCodecContext AVOptions:")[2]
    common = parse_avoptions(re.split(r"\n\S", common_help, maxsplit=1)[0])
    result = []
    for encoder in ENCODERS:
        output = help_text([*prefix, "encoder=" + encoder])
        if any(line.startswith("Encoder " + encoder + " [") for line in output.splitlines()):
            result.append(encoder_catalog(encoder, parse_avoptions(output), common))
    return result


def bound_value(label):
    if NUMBER.fullmatch(label):
        return Decimal(label)
    if label in SCALE:
        return SCALE[label]
    return None


def validate_value(encoder, field, value, *, native):
    name = field["name"]
    if not isinstance(value, str) or not 0 < len(value) <= 4096 or not VALUE.fullmatch(value):
        raise ValueError("Invalid software option value: " + name)
    if name == "passes" and value not in {"1", "2"}:
        raise ValueError("Use 1 or 2 managed passes")
    if not native and name == "flags":
        tokens = re.findall(r"[+-][a-z0-9_]+", value)
        if "".join(tokens) != value or any(token[1:] not in BITSTREAM_FLAGS[encoder] for token in tokens):
            raise ValueError("Use signed codec flag names from the catalog")
    if not native and name == "force_key_frames" and value != "source":
        if not all(re.fullmatch(r"\d+(?:\.\d+)?", t) for t in value.split(",")):
            raise ValueError("Use source or comma-separated key frame times in seconds")
    if native and (encoder, name) in VALUE_CHOICES and value not in VALUE_CHOICES[encoder, name]:
        raise ValueError("Invalid builtin matrix: " + name)
    if native and name == "zones":
        if not all(ZONE.fullmatch(zone) for zone in value.split("/")):
            raise ValueError("Specify QP or bitrate zones")
        return
    if encoder == "libvpx-vp9" and native:
        if name == "ts_layering_mode" and value not in {"0", "2", "3", "4"}:
            raise ValueError("Invalid temporal layering mode")
        if name in {"ts_target_bitrate", "ts_rate_decimator", "ts_layer_id"}:
            max_count, minimum, maximum = (16, 0, 4) if name == "ts_layer_id" else (5, 1, 2**32 - 1)
            parts = value.split(",")
            if len(parts) > max_count or any(not re.fullmatch(r"\d{1,10}", part) or
                                             not minimum <= int(part) <= maximum for part in parts):
                raise ValueError("Invalid temporal layer vector: " + name)
    # Slash only has meaning in numeric fractions. Dictionary separators are
    # escaped on serialization; a value can never introduce a second key.
    if "=" in value or ("/" in value and not re.fullmatch(r"\d+/\d+", value)):
        raise ValueError("Invalid software option value: " + name)
    kind = field["type"]
    choices = field.get("choices", [])
    if value in choices:
        return
    if kind == "boolean":
        if value not in ("0", "1", "true", "false") and (native or value not in ("auto", "-1")):
            raise ValueError("Invalid boolean: " + name)
    elif kind in {"int", "int64", "uint", "uint64", "float", "double"}:
        pattern = NUMBER if kind in {"float", "double"} else INTEGER
        if not pattern.fullmatch(value):
            raise ValueError("Invalid number: " + name)
        number = Decimal(value)
        for label in ("minimum", "maximum"):
            limit = bound_value(field.get(label, ""))
            if limit is not None and ((label == "minimum" and number < limit) or
                                      (label == "maximum" and number > limit)):
                raise ValueError("Out of range: " + name)


def build_software_options(software, codec, encoders):
    if not isinstance(software, dict) or not {"encoder", "options"} <= software.keys() <= {
            "encoder", "options", "nativeOptions"}:
        raise ValueError("Invalid software settings")
    encoder = software["encoder"]
    catalog = next((row for row in encoders if row["encoder"] == encoder and row["codec"] == codec), None)
    if catalog is None:
        raise ValueError("Unsupported software encoder")
    args = ["-c:v", encoder]
    for namespace in ("options", "nativeOptions"):
        values = software.get(namespace, {})
        if not isinstance(values, dict):
            raise ValueError("Invalid software option dictionary")
        fields = {field["name"]: field for field in catalog[namespace]}
        if not values.keys() <= fields.keys():
            raise ValueError("Unknown software option")
        native = namespace == "nativeOptions"
        entries = []
        for name, value in sorted(values.items(), key=lambda pair: (pair[0] == "ts_layering_mode", pair[0])):
            validate_value(encoder, fields[name], value, native=native)
            if native:
                entries.append(name + "=" + value.replace(":", r"\:"))
            elif name != "passes":
                args.extend(["-" + name + ":v", value])
        if entries:
            args.extend(["-" + ENCODERS[encoder][1] + ":v", ":".join(entries)])
    return args
