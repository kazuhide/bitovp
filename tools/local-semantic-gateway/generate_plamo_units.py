#!/usr/bin/env python3
"""Verify installed private artifact pins and generate inactive unit files only."""
import argparse
import os
from pathlib import Path
from plamo_runtime import InstalledPlamoRuntime, render_unit, unit_name

def generate(directory, output):
    runtime = InstalledPlamoRuntime(Path(directory).resolve())
    if runtime.invalid or not runtime.profiles:
        raise ValueError('MODEL_NOT_INSTALLED_OR_MISMATCH')
    output = Path(output)
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    for profile, item in runtime.profiles.items():
        path = output / unit_name(profile)
        with path.open('x') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(render_unit(profile, item))
    return sorted(runtime.profiles)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    profiles = generate(args.directory, args.output)
    print('generated-inactive-unit-files:' + ','.join(profiles))
