#!/bin/sh
set -eu
CDPATH= cd "$(dirname "$0")/../apps/worker"

# Each fixture keeps OS process isolation without nesting another Node test process.
# Bound the TypeScript transformer's Go pool to the offline container's two CPUs.
for media_fixture in \
  src/library-editing/hls-preparation.media.ts \
  src/library-editing/normalization.media.ts \
  src/library-editing/normalization-untagged-color.media.ts \
  src/library-editing/render.media.ts \
  src/library-editing/render-movie-clock.media.ts \
  src/vmaf/reference-preparation.media.ts \
  src/vod-input-preview/preview.media.ts
do
  # The media runner matches this line with the totals the reporter prints, and
  # fails unless every fixture ran once and passed its required number of tests.
  # The leading newline starts the line even after output that did not end one.
  printf '\nmedia fixture: %s\n' "$media_fixture"
  GOMAXPROCS=2 node --import ./node_modules/tsx/dist/esm/index.mjs \
    --test --experimental-test-isolation=none \
    --test-reporter=spec --test-reporter-destination=stdout \
    --test-reporter=../../scripts/media-smoke-reporter.mjs \
    --test-reporter-destination=stdout \
    "$media_fixture"
done
