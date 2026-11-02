#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Build the owned scorer with a hash-verified official CPU libvmaf oracle."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import urllib.request


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def run(arguments, *, env=None):
    subprocess.run([str(arg) for arg in arguments], env=env, check=True)


def checked_source(work, lock):
    archive = work / ("vmaf-" + lock["revision"] + ".tar.gz")
    if not archive.exists():
        temporary = archive.with_suffix(".partial")
        try:
            with urllib.request.urlopen(lock["archive"], timeout=60) as source, temporary.open("xb") as output:
                shutil.copyfileobj(source, output)
            if sha256(temporary) != lock["sha256"]:
                raise RuntimeError("Official source archive SHA-256 mismatch")
            temporary.rename(archive)
        finally:
            temporary.unlink(missing_ok=True)
    if sha256(archive) != lock["sha256"]:
        raise RuntimeError("Cached official archive SHA-256 mismatch")
    name = "vmaf-" + lock["revision"]
    source = work / name
    manifest = work / (name + ".files.json")
    if source.exists():
        if not manifest.exists():
            raise RuntimeError("Source directory exists without a verification manifest; choose a clean work directory")
        expected = json.loads(manifest.read_text())
        actual = {str(path.relative_to(source)): sha256(path)
                  for path in source.rglob("*") if path.is_file()}
        if actual != expected:
            raise RuntimeError("Cached official source was modified; choose a clean work directory")
        return source
    staging = work / (name + ".extracting")
    staging.mkdir()
    try:
        with tarfile.open(archive, "r:gz") as bundle:
            for member in bundle.getmembers():
                if member.name != name and not member.name.startswith(name + "/"):
                    raise RuntimeError("Unexpected official archive path")
            bundle.extractall(staging, filter="data")
        (staging / name).rename(source)
        manifest.write_text(json.dumps({str(path.relative_to(source)): sha256(path)
                                        for path in source.rglob("*") if path.is_file()}, sort_keys=True) + "\n")
    finally:
        shutil.rmtree(staging)
    return source


CPU_OPTIONS = {
    "buildtype": "release", "default_library": "static", "enable_cuda": False,
    "enable_float": True, "enable_tests": False, "enable_tools": True,
    "enable_docs": False, "built_in_models": False,
}


def check_cpu_cache(cpu, source, lock):
    expected = {"revision": lock["revision"], "archiveSha256": lock["sha256"],
                "source": str(source.resolve()), "options": CPU_OPTIONS}
    marker = cpu.parent / "official-cpu-source.json"
    if not (cpu / "build.ninja").exists():
        if marker.exists():
            raise RuntimeError("Incomplete official CPU build cache; choose a clean work directory")
        return marker, expected
    if not marker.exists() or json.loads(marker.read_text()) != expected:
        raise RuntimeError("Official CPU cache pin/configuration mismatch; choose a clean work directory")
    info = cpu / "meson-info"
    directories = json.loads((info / "meson-info.json").read_text())["directories"]
    actual = {entry["name"]: entry["value"] for entry in json.loads((info / "intro-buildoptions.json").read_text())}
    if Path(directories["source"]).resolve() != source.resolve() or Path(directories["build"]).resolve() != cpu.resolve():
        raise RuntimeError("Official CPU cache source directory differs from the verified source")
    if any(actual.get(name) != value for name, value in CPU_OPTIONS.items()):
        raise RuntimeError("Official CPU cache options differ from the CPU oracle configuration")
    return marker, expected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--prefix", type=Path, required=True)
    parser.add_argument("--cuda", action="store_true")
    parser.add_argument("--cuda-architectures", default="native", help="CMake CUDA architectures; native targets the visible GPU")
    parser.add_argument("--vulkan", action="store_true")
    parser.add_argument("--jobs", type=int, default=min(os.cpu_count() or 1, 32))
    parser.add_argument("--test", action="store_true", help="Run CPU and selected real-GPU tests")
    options = parser.parse_args()
    if options.jobs < 1 or options.jobs > 256:
        parser.error("--jobs must be between 1 and 256")
    root = Path(__file__).resolve().parent
    work, prefix = options.work_dir.expanduser().resolve(), options.prefix.expanduser().resolve()
    if work == root or root in work.parents:
        parser.error("Keep downloaded sources and build artifacts outside the repository")
    if prefix == root or root in prefix.parents:
        parser.error("Keep installed binaries outside the repository")
    work.mkdir(parents=True, exist_ok=True)
    build_lock = (work / ".build.lock").open("a")
    try:
        fcntl.flock(build_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        raise RuntimeError("Another build is using this work directory") from error
    lock = json.loads((root / "upstream.lock.json").read_text())
    tools = ["cmake", "meson", "ninja", "pkg-config"]
    if options.cuda:
        tools.append("nvcc")
    if options.vulkan:
        tools.append("glslangValidator")
    missing = [tool for tool in tools if not shutil.which(tool)]
    if missing:
        raise RuntimeError("Missing build tools: " + ", ".join(missing))
    source = checked_source(work, lock)
    cpu = work / "official-cpu"
    marker, cpu_identity = check_cpu_cache(cpu, source / "libvmaf", lock)
    if not (cpu / "build.ninja").exists():
        run(["meson", "setup", cpu, source / "libvmaf", "--buildtype=release",
             "--default-library=static", "--prefix=" + str(work / "official-install"),
             "-Denable_cuda=false", "-Denable_float=true", "-Denable_tests=false",
             "-Denable_tools=true", "-Denable_docs=false", "-Dbuilt_in_models=false"])
        marker.write_text(json.dumps(cpu_identity, sort_keys=True) + "\n")
    run(["meson", "compile", "-C", cpu, "-j", options.jobs])
    build = work / "owned"
    run(["cmake", "-S", root, "-B", build, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release",
         "-DCMAKE_INSTALL_PREFIX=" + str(prefix), "-DLIBVMAF_SOURCE_DIR=" + str(source / "libvmaf"),
         "-DLIBVMAF_BUILD_DIR=" + str(cpu), "-DVMAF_MODEL_DIR=" + str(source / "model"),
         "-DBITOVP_TESTS=" + ("ON" if options.test else "OFF"),
         "-DBITOVP_CUDA=" + ("ON" if options.cuda else "OFF"),
         "-DBITOVP_VULKAN=" + ("ON" if options.vulkan else "OFF"),
         *(["-DCMAKE_CUDA_ARCHITECTURES=" + options.cuda_architectures] if options.cuda else [])])
    run(["cmake", "--build", build, "-j", options.jobs])
    if options.test:
        run(["ctest", "--test-dir", build, "--output-on-failure"])
    run(["cmake", "--install", build])
    models = prefix / "share/bitovp-vmaf/model"
    models.mkdir(parents=True, exist_ok=True)
    for family in ("vmaf_v1.0.16", "vmaf_v1.0.16_hfr"):
        for model in sorted((source / "model" / family).glob("*.json")):
            shutil.copy2(model, models / model.name)
    licenses = prefix / "share/bitovp-vmaf/licenses"
    licenses.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source / "LICENSE", licenses / "Netflix-vmaf.txt")
    shutil.copy2(root / "NOTICE", licenses / "NOTICE")
    shutil.copy2(root / "licenses/LIBSVM.txt", licenses / "LIBSVM.txt")
    if options.cuda:
        shutil.copy2(root / "licenses/NVIDIA-CUB.txt", licenses / "NVIDIA-CUB.txt")
    receipt = {"official": lock, "binarySha256": sha256(prefix / "bin/bitovp-vmaf"),
               "cuda": options.cuda, "vulkan": options.vulkan, "testsRequested": options.test,
               "cudaArchitectures": options.cuda_architectures if options.cuda else None,
               "tools": {tool: subprocess.check_output([tool, "--version"], text=True).splitlines()[0]
                         for tool in tools if tool != "glslangValidator"}}
    supervisor = prefix / "bin/bitovp-vmaf-supervisor"
    if sys.platform.startswith("linux"):
        if not supervisor.is_file():
            raise RuntimeError("The native supervisor companion was not installed")
        receipt["supervisorBinarySha256"] = sha256(supervisor)
    (prefix / "share/bitovp-vmaf/build.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print("Built", prefix / "bin/bitovp-vmaf")


if __name__ == "__main__":
    main()
