#!/bin/sh
# Real native-HDR library/model/colorimetry proof. Requires Python only while
# building; neither Python nor this script is invoked by the measurement worker.
set -eu
exec python3 "$(dirname "$0")/hdr-build-proof.py" "$@"
