# SPDX-License-Identifier: MIT
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def fingerprint(binary: str, *libraries: Path) -> str:
    completed = subprocess.run(
        [binary, "--print-fingerprint"],
        capture_output=True,
        text=True,
        env={**os.environ, "LD_PRELOAD": " ".join(map(str, libraries))},
    )
    if completed.returncode == 77:
        sys.exit(77)
    completed.check_returncode()
    digest = completed.stdout.strip()
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise AssertionError(f"Invalid decoder runtime identity {digest!r}")
    return digest


if __name__ == "__main__":
    binary, fixture = sys.argv[1:]
    with tempfile.TemporaryDirectory(prefix="bitovp-runtime-order-") as directory:
        first = Path(directory) / "first.so"
        second = Path(directory) / "second.so"
        shutil.copyfile(fixture, first)
        shutil.copyfile(fixture, second)
        if fingerprint(binary, first, second) == fingerprint(binary, second, first):
            raise AssertionError("Changing decoder symbol lookup order kept the runtime identity")
