#!/bin/sh
# Proves that an FFmpeg build scores with a bundled VMAF v1.0 model: FFmpeg
# must end without an error, and two identical pictures must score 100.
#
#   sh docker/vmaf-acceptance.sh <ffmpeg> <model directory>
#
# The pictures are 256x144. On smaller ones the model's banding feature does
# not run: libvmaf then reports an error, FFmpeg fails, and the log still holds
# a line "VMAF score: 0.000000". So the words "VMAF score" alone prove nothing.
set -eu

ffmpeg=${1:?usage: vmaf-acceptance.sh <ffmpeg> <model directory>}
models=${2:?usage: vmaf-acceptance.sh <ffmpeg> <model directory>}
model="$models/vmaf_v1.0.16_3d0h.json"

log=$(mktemp "${TMPDIR:-/tmp}/vmaf-acceptance.XXXXXX")
trap 'rm -f "$log"' EXIT

status=0
"$ffmpeg" -hide_banner -nostdin \
	-f lavfi -i testsrc=size=256x144:rate=5:duration=0.4 \
	-f lavfi -i testsrc=size=256x144:rate=5:duration=0.4 \
	-lavfi "[0:v][1:v]libvmaf=model=path=$model" \
	-f null - >"$log" 2>&1 || status=$?

if [ "$status" -ne 0 ]; then
	tail -n 12 "$log" >&2
	echo "FFmpeg ended with status $status while scoring with $model" >&2
	exit 1
fi
if ! grep -q 'VMAF score: 100\.000000$' "$log"; then
	tail -n 12 "$log" >&2
	echo "FFmpeg did not score two identical pictures as 100 with $model" >&2
	exit 1
fi
