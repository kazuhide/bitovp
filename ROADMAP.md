# Roadmap

Upcoming release scope. Scope and timing may change after testing and feedback.

## Next: v1.2.0 (not released)

- **Banding detection in quality control:** Show banding scores and affected
  time ranges, with configurable warning and failure thresholds. Support local
  CPU and CPU-verified CUDA/Vulkan processing, including banding-only measurements.

## Later (release not assigned)

- **Content Library clip editor:** Create highlight and vertical clips through
  range selection, preview, and adjustable cropping. Save edits and export new
  assets while preserving the originals.

## Keeping this file current

Feature PRs update the intended scope here and describe implemented behavior in
the changelog's **Unreleased** section. A merge into `main` means implemented;
it does not mean released. Release preparation checks this list, and published
items are removed from the plan when their tagged release is available.
The [PR template](./.github/pull_request_template.md) records these updates or
explains why a change has no roadmap or changelog impact.

Published changes are recorded in the [changelog](./CHANGELOG.md). Experimental
GPU decoding and VMAF v1.0 processing first shipped in v1.1.0; their current
conditions are in the [GPU quality guide](./docs/user-guide/GPU-QUALITY.md).
