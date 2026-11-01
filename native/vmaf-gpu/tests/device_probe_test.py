#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Check the actual CLI before scoring and validate a real hardware probe."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

p = argparse.ArgumentParser()
p.add_argument("--binary", required=True, type=Path)
p.add_argument("--backend", choices=("cuda", "vulkan"))
p.add_argument("--vendor", choices=("amd", "nvidia"))
a = p.parse_args()
invalid = [
    ["--device-info"],
    ["--device-info", "--backend", "cpu"],
    ["--device-info", "--backend", "invalid"],
    ["--device-info", "--backend", "cuda", "--vendor", "amd"],
    ["--device-info", "--device-info", "--backend", "cuda"],
    ["--device-info", "--backend", "cuda", "--backend", "vulkan"],
    ["--device-info", "--backend", "cuda", "--profile"],
    ["--device-info", "--backend", "cuda", "--verify-cpu"],
    ["--device-info", "--backend", "cuda", "--reference", "missing-input.mp4"],
    ["--device-info", "--backend", "cuda", "--model", "invalid=missing-model.json"],
    ["--device-info", "--backend", "cuda", "--unknown", "value"],
    ["--device-info", "--backend", "cuda", "--device", "-1"],
    ["--device-info", "--backend", "cuda", "--device"],
]
for args in invalid:
    run = subprocess.run([str(a.binary), *args], text=True, capture_output=True, timeout=30)
    assert run.returncode != 0, args
    assert not run.stdout.strip(), (args, run.stdout)
    assert "Cannot open file for SHA-256" not in run.stderr, (args, run.stderr)
    assert "Required: --reference" not in run.stderr, (args, run.stderr)
if a.backend:
    command = [str(a.binary), "--device-info", "--backend", a.backend]
    if a.vendor:
        command += ["--vendor", a.vendor]
    run = subprocess.run(command, check=True, text=True, capture_output=True, timeout=60)
    result = json.loads(run.stdout)
    assert result["schemaVersion"] == 1 and result["backend"] == a.backend
    assert re.fullmatch("[0-9a-f]{64}", result["sourceSha256"])
    assert result["binarySha256"] == hashlib.sha256(a.binary.read_bytes()).hexdigest()
    assert result["officialSourceRevision"] == "74f930d17de8c58e7c2ce55e2b897b0030ebd8ef"
    capabilities = result["capabilities"]
    assert capabilities["inflightFrames"] == [1, 2, 4] and capabilities["cpuParity"] is True
    assert type(capabilities["processSupervisor"]) is bool
    if capabilities["processSupervisor"]:
        assert re.fullmatch("[0-9a-f]{64}", capabilities["supervisorBinarySha256"])
        companion = a.binary.resolve().parent / "bitovp-vmaf-supervisor"
        assert capabilities["supervisorBinarySha256"] == hashlib.sha256(companion.read_bytes()).hexdigest()
    device = result["device"]
    assert type(device["index"]) is int and device["index"] >= 0
    assert re.fullmatch("[0-9a-f]{32}", device["uuid"]) and device["uuid"] != "0" * 32
    assert isinstance(device["name"], str) and device["name"]
    assert device["pciBusId"] is None or re.fullmatch("[0-9a-f]{4}:[0-9a-f]{2}:[0-1][0-9a-f]\\.[0-7]", device["pciBusId"])
    assert type(device["integrated"]) is bool and type(device["driverVersionKnown"]) is bool
    assert isinstance(device["driverVersion"], str) and device["driverVersion"]
    assert isinstance(device["driverVersionSource"], str) and device["driverVersionSource"]
    if a.vendor:
        assert device["vendorId"] == {"amd": 0x1002, "nvidia": 0x10de}[a.vendor]
    total, available = device["memoryTotalBytes"], device["memoryAvailableBytes"]
    assert total is None or (type(total) is int and 0 < total <= 9007199254740991)
    assert available is None or (type(available) is int and total is not None and 0 <= available <= total)
    if available is None:
        assert device["memoryAvailableSource"] == "unavailable"
    elif a.backend == "cuda":
        assert device["memoryAvailableSource"] == "cuda-mem-get-info"
    else:
        assert device["memoryAvailableSource"] == "vulkan-process-budget-hint"
    explicit = subprocess.run([*command, "--device", str(device["index"])], check=True,
                              text=True, capture_output=True, timeout=60)
    selected = json.loads(explicit.stdout)
    assert selected["device"]["uuid"] == device["uuid"]
    assert selected["device"]["driverVersion"] == device["driverVersion"]
    assert selected["sourceSha256"] == result["sourceSha256"]
    assert selected["binarySha256"] == result["binarySha256"]
    print("PASS actual input-free hardware device probe:", a.backend, device["uuid"],
          "available source:", device["memoryAvailableSource"])
else:
    print("PASS actual CLI device-info argument rejection before input/model access")
