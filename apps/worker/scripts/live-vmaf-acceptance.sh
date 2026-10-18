#!/bin/sh
# Live (pseudo-live) VMAF acceptance proof (P4-PR6b). Thin wrapper that runs
# the TS harness (live-vmaf-acceptance.ts) with the image's bundled tsx, so the
# proof reuses the SHIPPED modules — the real ffmpeg `signalstats` signature
# extraction (signatures.ts), the PR6a alignment engine (alignLoopedSignatures),
# and the same buildVmafCommand the live processor runs.
#
# Runs INSIDE the pinned worker image (bitovp-worker:latest), which bundles the
# static libvmaf ffmpeg + tsx. NOT a CI gate (CI has no ffmpeg). Run it locally:
#
#   docker compose run --rm --entrypoint sh worker \
#       /app/apps/worker/scripts/live-vmaf-acceptance.sh
#
# What it proves (the part PR6a's synthetic in-memory test could NOT — the real
# ffmpeg → engine → libvmaf path):
#  1. A "captured" clip = the source looped ≥3× at a KNOWN frame offset, run
#     through the REAL signalstats signature extraction on BOTH sides, feeds the
#     engine and recovers the offset to ±1 frame with confidence above the
#     processor threshold and ≥3 loop-map entries.
#  2. The aligned reference (source looped + trimmed to that offset) scored with
#     the real libvmaf yields a HIGH mean VMAF (~95+) — i.e. the alignment +
#     aligned-reference build actually line the frames up.
#
# Observed offset, confidence, and VMAF are printed by the harness.
#
# HONEST SCOPE: this validates the SYNTHETIC looped-capture path end-to-end
# through the real ffmpeg/libvmaf. The live-SEGMENT discovery against a real
# running Bitmovin pseudo-live channel (listing/downloading actual HLS/DASH
# output segments) is the documented MANUAL acceptance — it needs a live feed
# and is not exercised here.
set -eu

DIR="$(cd "$(dirname "$0")" && pwd)"
# tsx resolves the workspace deps (@bitovp/core, the worker src) from the image.
exec npx --yes tsx "$DIR/live-vmaf-acceptance.ts"
