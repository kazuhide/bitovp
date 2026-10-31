#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Compare full-frame owned GPU scoring with tuned official CPU scoring."""
import argparse
import csv
import json
import math
import os
from pathlib import Path
import statistics
import shutil
import signal
import subprocess
import time


def run_measured(command, timeout):
    # GNU time is a parent of the scorer. A timeout or interrupt must stop both,
    # including children holding the captured pipes open.
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, start_new_session=True) as child:
        try:
            stdout, stderr = child.communicate(timeout=timeout)
            return subprocess.CompletedProcess(command, child.returncode, stdout, stderr)
        except BaseException:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.communicate()
            raise


def verify(expected, actual):
    for key in ("referenceSha256", "distortedSha256", "frames", "width", "height", "bitDepth", "officialRevision", "sourceSha256"):
        if actual[key] != expected[key]:
            raise ValueError("Comparison identity differs: " + key)
    before = {(f["name"], f["index"]): f["value"] for f in expected["features"]}
    after = {(f["name"], f["index"]): f["value"] for f in actual["features"]}
    if before.keys() != after.keys() or len(after) != len(actual["features"]):
        raise ValueError("Feature coverage differs")
    feature_error = score_error = 0.0
    for key, value in before.items():
        error = abs(after[key] - value)
        if not math.isfinite(after[key]) or error > 1e-6 + abs(value) * 1e-7:
            raise ValueError(f"Feature parity failed: {key}, CPU={value}, candidate={after[key]}")
        feature_error = max(feature_error, error)
    a = {m["id"]: m for m in expected["models"]}
    b = {m["id"]: m for m in actual["models"]}
    if a.keys() != b.keys():
        raise ValueError("Model coverage differs")
    for key, model in a.items():
        if b[key]["sha256"] != model["sha256"] or len(b[key]["frames"]) != len(model["frames"]):
            raise ValueError("Model identity/frame count differs")
        for value, result in zip(model["frames"], b[key]["frames"]):
            error = abs(value - result)
            if not math.isfinite(result) or error > 1e-4:
                raise ValueError(f"VMAF parity failed: {key}, error={error}")
            score_error = max(score_error, error)
        if model["pooled"].keys() != b[key]["pooled"].keys():
            raise ValueError("Pooled metric coverage differs")
        for metric, value in model["pooled"].items():
            result = b[key]["pooled"][metric]
            error = abs(value - result)
            if not math.isfinite(result) or error > 1e-4:
                raise ValueError(f"Pooled VMAF parity failed: {key}/{metric}, error={error}")
            score_error = max(score_error, error)
    return {"maxFeatureError": feature_error, "maxScoreError": score_error}


def main():
    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)
    for signum in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--distorted", type=Path, required=True)
    parser.add_argument("--model", action="append", required=True, help="id=path; repeat for multiple models")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--backends", default="cpu,cuda,cuda-nvdec,vulkan")
    parser.add_argument("--cpu-threads", help="Comma-separated CPU worker counts; default tests the host's available CPU range")
    parser.add_argument("--decode-threads", type=int, default=2)
    parser.add_argument("--bit-depth", type=int, choices=(8, 10), default=10)
    parser.add_argument("--width", type=int)
    parser.add_argument("--height", type=int)
    parser.add_argument("--max-frames", type=int, default=0)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument("--time-command", default="/usr/bin/time", help="GNU time executable for complete process CPU/RSS accounting")
    options = parser.parse_args()
    if not 1 <= options.repeats <= 100 or options.timeout < 1:
        parser.error("Use 1 to 100 repeats and a positive timeout")
    if (options.width is None) != (options.height is None):
        parser.error("Set width and height together")
    clock = shutil.which(options.time_command)
    if not clock:
        parser.error("GNU time is required for complete process resource accounting")
    version = subprocess.run([clock, "--version"], capture_output=True, text=True)
    if version.returncode or "GNU" not in version.stdout:
        parser.error("--time-command must be GNU time (use gtime on systems with BSD time)")
    backends = options.backends.split(",")
    if len(set(backends)) != len(backends) or any(b not in ("cpu", "cuda", "cuda-nvdec", "vulkan") for b in backends):
        parser.error("Backends must be a unique list of cpu,cuda,cuda-nvdec,vulkan")
    if "cpu" not in backends:
        parser.error("CPU is required as the independent numerical reference")
    available = len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else (os.cpu_count() or 1)
    threads = sorted(set(int(n) for n in options.cpu_threads.split(","))) if options.cpu_threads else sorted({1, min(2, available), min(4, available), min(8, available), max(1, available // 4), max(1, available // 2), available})
    if not threads or threads[0] < 1 or threads[-1] > 256:
        parser.error("CPU worker counts must be between 1 and 256")
    options.output_dir.mkdir(parents=True, exist_ok=False)
    command = [str(options.binary.resolve()), "--reference", str(options.reference.resolve()),
               "--distorted", str(options.distorted.resolve()), "--bit-depth", str(options.bit_depth),
               "--decode-threads", str(options.decode_threads)]
    for model in options.model:
        command += ["--model", model]
    if options.width:
        command += ["--width", str(options.width), "--height", str(options.height)]
    if options.max_frames:
        command += ["--max-frames", str(options.max_frames)]
    # Serial trials isolate devices and CPU contention. The selected worker
    # range measures CPU scaling rather than assuming maximum threads is best.
    matrix = [("cpu", n) for n in threads]
    matrix += [(backend, 1) for backend in backends if backend != "cpu"]
    results, errors, reference = [], [], None
    for backend, count in matrix:
        for repeat in range(options.repeats):
            name = f"{backend}-t{count}-r{repeat + 1}"
            output = options.output_dir / (name + ".json")
            selected_backend = "cuda" if backend == "cuda-nvdec" else backend
            run_command = command + ["--backend", selected_backend, "--threads", str(count), "--output", str(output)]
            if backend == "cuda-nvdec":
                run_command += ["--decode", "cuda"]
            if backend == "vulkan":
                run_command += ["--vendor", "amd"]
            resource_path = options.output_dir / (name + ".time")
            measured_command = [clock, "-f", "%U\t%S\t%M", "-o", str(resource_path), "--", *run_command]
            started = time.perf_counter()
            try:
                run = run_measured(measured_command, options.timeout)
                process_ms = (time.perf_counter() - started) * 1000
                (options.output_dir / (name + ".log")).write_text(run.stdout + run.stderr)
                if run.returncode:
                    raise RuntimeError("Scorer failed: " + run.stderr[-2000:])
                receipt = json.loads(output.read_text())
                user, system, rss = map(float, resource_path.read_text().strip().split("\t"))
                if any(not math.isfinite(value) or value < 0 for value in (user, system, rss)):
                    raise ValueError("Invalid completed-process resource record")
                if reference is None:
                    if backend != "cpu":
                        raise RuntimeError("No independent CPU reference is available")
                    reference = receipt
                parity = verify(reference, receipt)
                row = {"backend": backend, "cpuThreads": count, "repeat": repeat + 1,
                       "device": receipt["device"]["name"], "frames": receipt["frames"],
                       "processWallMs": process_ms, "scoringWallMs": receipt["timingMs"]["wall"],
                       "fps": receipt["frames"] * 1000 / process_ms,
                       "cpuTimeMs": (user + system) * 1000,
                       "maxRssBytes": int(rss * 1024),
                       "gpuAllocatedBytes": receipt["memory"]["gpuAllocatedBytes"],
                       "hostCopiedInputBytes": receipt["memory"]["hostCopiedInputBytes"],
                       "hostReadbackBytes": receipt["memory"]["hostReadbackBytes"], **parity}
                results.append(row)
                print(f"PASS {name}: {process_ms:.1f} ms, {row['fps']:.2f} fps", flush=True)
            except (OSError, ValueError, RuntimeError, KeyError, TypeError, OverflowError, subprocess.TimeoutExpired) as error:
                errors.append({"trial": name, "message": str(error)})
                print(f"FAIL {name}: {error}", flush=True)
                # A broken backend is recorded; unrelated CPU/GPU trials continue.
                break
    summary = []
    for backend, count in matrix:
        rows = [r for r in results if r["backend"] == backend and r["cpuThreads"] == count]
        if not rows:
            continue
        walls = [r["processWallMs"] for r in rows]
        summary.append({"backend": backend, "cpuThreads": count, "trials": len(rows),
                        "device": rows[0]["device"], "medianWallMs": statistics.median(walls),
                        "minWallMs": min(walls), "maxWallMs": max(walls),
                        "medianFps": statistics.median(r["fps"] for r in rows),
                        "maxRssBytes": max(r["maxRssBytes"] for r in rows),
                        "gpuAllocatedBytes": max(r["gpuAllocatedBytes"] for r in rows)})
    report = {"arguments": vars(options) | {key: str(value) for key, value in vars(options).items() if isinstance(value, Path)},
              "availableLogicalCpus": available, "results": results, "summary": summary, "errors": errors}
    (options.output_dir / "summary.json").write_text(json.dumps(report, indent=2) + "\n")
    if results:
        with (options.output_dir / "trials.csv").open("w", newline="") as output:
            writer = csv.DictWriter(output, fieldnames=list(results[0]))
            writer.writeheader()
            writer.writerows(results)
    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
