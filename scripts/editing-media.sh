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
  src/vmaf/reference-preparation.media.ts
do
  GOMAXPROCS=2 node --import ./node_modules/tsx/dist/esm/index.mjs \
    --test --experimental-test-isolation=none "$media_fixture"
done
