"""Prove native HDR models, FFmpeg colorimetry and explicit PQ CAMBI at build time."""
import hashlib
import json
import math
import struct
import subprocess
import sys
from pathlib import Path


def hlg_display_luminance(signal):
    """BT.2100's 1000 nit reference HLG display, gamma 1.2, zero black."""
    scene = signal * signal / 3 if signal <= 0.5 else (math.exp((signal - 0.55991073) / 0.17883277) + 0.28466892) / 12
    return 1000 * scene ** 1.2


def pq_from_nits(luminance):
    power = (max(luminance, 0) / 10000) ** (2610 / 16384)
    return ((3424 / 4096 + 2413 / 128 * power) / (1 + 2392 / 128 * power)) ** (2523 / 32)


def prove_hlg_conversion(ffmpeg, output):
    # Grey anchors prove absolute display scale; saturated colours also prove
    # the luma-weighted OOTF, which per-channel approximate gamma would fail.
    samples = [(0, 0, 0), (0.5, 0.5, 0.5), (0.75, 0.75, 0.75), (1, 1, 1), (1, 0, 0), (0, 1, 0), (0, 0, 1)]
    width = len(samples)
    source = output / "hlg-reference-rgb-float.raw"
    source.write_bytes(struct.pack("<" + "f" * width * 3, *(sample[channel] for channel in (1, 2, 0) for sample in samples)))
    destination = output / "hlg-to-pq-rgb-float.raw"
    recipe = "zscale=pin=bt2020:tin=arib-std-b67:min=gbr:rin=full:p=bt2020:t=smpte2084:m=gbr:r=full:npl=1000:agamma=false,format=gbrpf32le"
    command = [str(ffmpeg), "-hide_banner", "-nostdin", "-v", "error", "-xerror", "-f", "rawvideo", "-pixel_format", "gbrpf32le", "-video_size", str(width) + "x1", "-framerate", "1", "-i", str(source), "-frames:v", "1", "-vf", recipe, "-pix_fmt", "gbrpf32le", "-f", "rawvideo", str(destination)]
    result = subprocess.run(command, capture_output=True, text=True, timeout=30)
    (output / "hlg-conversion.stderr").write_text(result.stderr)
    (output / "hlg-conversion.command.json").write_text(json.dumps(command, indent=2))
    assert result.returncode == 0, result.stderr
    raw = destination.read_bytes()
    assert len(raw) == width * 3 * 4
    planes = struct.unpack("<" + "f" * width * 3, raw)
    rows = []
    for index, sample in enumerate(samples):
        scene = [hlg_display_luminance(value) ** (1 / 1.2) / (1000 ** (1 / 1.2)) for value in sample]
        luminance = sum(weight * value for weight, value in zip((0.2627, 0.6780, 0.0593), scene))
        expected = [pq_from_nits(1000 * value * luminance ** 0.2) for value in scene]
        actual = [planes[channel * width + index] for channel in (2, 0, 1)]
        assert all(math.isfinite(value) for value in actual)
        assert max(abs(a - b) for a, b in zip(actual, expected)) < 2e-5, (sample, actual, expected)
        rows.append({"hlgRgb": sample, "pqRgb": actual, "expectedPqRgb": expected})
    return {"method": "HLG_TO_PQ_1000_NITS", "displayPeakNits": 1000, "displayBlackNits": 0, "systemGamma": 1.2, "approximateGamma": False, "recipe": recipe, "samples": rows}


def read_metric(path, key, expected_frames):
    document = json.loads(Path(path).read_text())
    assert document["version"] == "a6ed0f1", "Unexpected libvmaf revision"
    frames = document["frames"]
    assert len(frames) == expected_frames, "Incomplete scored population"
    assert [frame["frameNum"] for frame in frames] == list(range(expected_frames))
    scores = [frame["metrics"][key] for frame in frames]
    assert all(type(value) in (int, float) and math.isfinite(value) for value in scores)
    pooled = document["pooled_metrics"][key]
    assert all(type(pooled[k]) in (int, float) and math.isfinite(pooled[k]) for k in ("mean", "min", "max"))
    mean = math.fsum(scores) / expected_frames
    assert abs(mean - pooled["mean"]) < 1e-6, "Inconsistent pooled mean"
    assert min(scores) == pooled["min"] and max(scores) == pooled["max"]
    return mean


def run_case(ffmpeg, output, name, model=None, distorted_primaries="bt2020", missing_color=False, cambi=False, frame_rate=2, frame_count=2):
    log = output / (name + ".json")
    color = "range=limited:color_primaries={}:color_trc=smpte2084:colorspace=bt2020nc"
    geometry = "3840x2160" if cambi else "640x360"
    reference = f"testsrc2=size={geometry}:rate={frame_rate}:duration={frame_count / frame_rate},format=yuv444p16le,setparams=" + color.format("bt2020")
    distorted = f"testsrc2=size={geometry}:rate={frame_rate}:duration={frame_count / frame_rate},format=yuv444p16le,setparams=" + color.format("unknown" if missing_color else distorted_primaries)
    if cambi:
        metric = "model=:feature='name=cambi\\:eotf=pq\\:enc_width=3840\\:enc_height=2160\\:enc_bitdepth=10'"
    else:
        metric = f"model='path={model}'"
    graph = f"[0:v][1:v]libvmaf={metric}:log_fmt=json:log_path='{log}':n_threads=1:n_subsample=1:eof_action=endall:shortest=1:repeatlast=0[out]"
    command = [str(ffmpeg), "-hide_banner", "-nostdin", "-v", "error", "-xerror", "-threads", "1", "-f", "lavfi", "-i", distorted, "-threads", "1", "-f", "lavfi", "-i", reference, "-filter_complex_threads", "1", "-filter_complex", graph, "-map", "[out]", "-an", "-sn", "-f", "null", "-"]
    result = subprocess.run(command, capture_output=True, text=True, timeout=120)
    (output / (name + ".stderr")).write_text(result.stderr)
    (output / (name + ".command.json")).write_text(json.dumps(command, indent=2))
    if missing_color:
        assert result.returncode != 0, "HDR scorer accepted missing input colorimetry"
        assert "color" in result.stderr.lower() or "primaries" in result.stderr.lower(), result.stderr
        return {"missingColorRefused": True}
    assert result.returncode == 0, result.stderr
    if cambi:
        keys = list(json.loads(log.read_text())["pooled_metrics"])
        matches = [key for key in keys if key.startswith("cambi") and "eotf_pq" in key]
        assert len(matches) == 1, f"Expected explicitly PQ CAMBI, got {keys}"
        key = matches[0]
        return {"featureName": key, "mean": read_metric(log, key, frame_count)}
    return {"mean": read_metric(log, "vmaf", frame_count)}


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: hdr-build-proof.py <ffmpeg-hdr> <model directory> <evidence directory>")
    ffmpeg, models, output = map(Path, sys.argv[1:])
    output.mkdir(parents=True, exist_ok=False)
    rows = []
    for name in ("hdr_vmaf_v1.1.8_3d0h_2160", "hdr_vmaf_v1.1.8_1d5h_2160", "hdr_vmaf_v1.1.8_hfr_3d0h_2160", "hdr_vmaf_v1.1.8_hfr_1d5h_2160"):
        model = models / (name + ".json")
        frame_rate, frame_count = (60, 6) if "_hfr_" in name else (2, 2)
        identity = run_case(ffmpeg, output, name + "-identity", model, frame_rate=frame_rate, frame_count=frame_count)
        assert 99 <= identity["mean"] <= 110, f"Unexpected HDR identity {identity}"
        rows.append({"model": name, "sha256": hashlib.sha256(model.read_bytes()).hexdigest(), "identity": identity, "frameRate": frame_rate, "frameCount": frame_count})
    first_model = models / "hdr_vmaf_v1.1.8_3d0h_2160.json"
    mismatch = run_case(ffmpeg, output, "color-primaries-mismatch", first_model, distorted_primaries="bt709")
    assert rows[0]["identity"]["mean"] - mismatch["mean"] >= 0.1, "Input colorimetry did not affect HDR measurement"
    missing = run_case(ffmpeg, output, "missing-color", first_model, missing_color=True)
    cambi = run_case(ffmpeg, output, "cambi-pq", cambi=True)
    hlg = prove_hlg_conversion(ffmpeg, output)
    receipt = {"libvmafRevision": "a6ed0f1", "models": rows, "colorPrimariesMismatch": mismatch, "missingColor": missing, "cambiPQ": cambi, "hlgConversion": hlg, "standardCaseFrames": 2, "hfrIdentityFrames": 6}
    (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
