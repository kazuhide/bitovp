#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Parse the real serializer output, including locale and unknown-memory cases."""
import argparse
import json
import subprocess

p = argparse.ArgumentParser()
p.add_argument("--fixture", required=True)
a = p.parse_args()
for kind in ("unknown", "zero", "known", "binary-unknown"):
    run = subprocess.run([a.fixture, "--fixture", kind], check=True, text=True, capture_output=True, timeout=15)
    result = json.loads(run.stdout)
    assert result["schemaVersion"] == 1
    assert result["sourceSha256"] == "a" * 64
    assert result["binarySha256"] == (None if kind == "binary-unknown" else "b" * 64)
    assert result["capabilities"] == {"inflightFrames": [1, 2, 4], "cpuParity": True,
                                      "processSupervisor": False, "supervisorBinarySha256": None}
    device = result["device"]
    assert device["name"] == 'GPU "reference"\n\\path 日本語'
    assert device["index"] == 0 and device["memoryHeapIndex"] == 0
    assert device["integrated"] is True and device["vendorId"] == 0x1002
    assert device["pciBusId"] == (None if kind == "unknown" else "0000:c6:00.0")
    assert device["memoryTotalBytes"] == device["memoryBudgetBytes"] == 1073741824
    assert device["memoryAvailableBytes"] == {"unknown": None, "zero": 0, "known": 536870912, "binary-unknown": 536870912}[kind]
    assert device["driverVersionKnown"] is (kind != "unknown")
    if kind == "unknown":
        assert device["driverVersion"] == "unknown" and device["memoryAvailableSource"] == "unavailable"
    else:
        assert device["driverVersion"].startswith("1048678;RADV;")
        assert device["memoryAvailableSource"] == "vulkan-process-budget-hint"
print("PASS parsed native device JSON, escaping, locale, zero and unknown memory")
