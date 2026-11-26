# Lean quality selection

Build the CLI with the pinned Lean toolchain from this directory.

```sh
rtk proxy lake build
rtk proxy lake env lean Proofs.lean
rtk proxy python3 -B test_cli.py
```

The executable is `.lake/build/bin/bitovp-quality-select`. Pass one JSON request on stdin and read one JSON result from stdout. Invalid input exits with status 2 and a message on stderr.

```json
{
  "schemaVersion": 1,
  "evaluation": "measured",
  "scoringProfileId": "vmaf-cuda:v0.6.1",
  "candidateSetSha256": "2728fd60644ba5aa407901b9075f1bc1e27d631b5b7b2af7beaba1fe0efcfdbc",
  "constraints": {
    "codec": "HEVC",
    "bitrateLimitBps": 3500000
  },
  "candidates": [
    {
      "trialId": "a",
      "codec": "HEVC",
      "scoringProfileId": "vmaf-cuda:v0.6.1",
      "scoreMilli": 94600,
      "rate": {
        "numerator": "27600000",
        "denominator": "8"
      }
    },
    {
      "trialId": "b",
      "codec": "HEVC",
      "scoringProfileId": "vmaf-cuda:v0.6.1",
      "scoreMilli": 97000,
      "rate": {
        "numerator": "28800000",
        "denominator": "8"
      }
    }
  ]
}
```

This request selects trial `a`. Trial `b` scores higher and exceeds the 3.5 Mbps limit. The rate is expressed in bits per second as an exact ratio of unsigned decimal strings with a positive denominator. The codec and GOP constraints check equality. Rate and time limits are inclusive. Encode times are in milliseconds. The caller fixes the precision and rounding used for the integer milli-VMAF score. JSON integers must fit the safe integer range of JavaScript.

The result echoes `schemaVersion`, `evaluation`, `scoringProfileId`, and `candidateSetSha256` and reports the total, eligible, ineligible, and incomplete counts. An omitted score or observation required by a constraint counts as incomplete. A row with a known constraint failure counts as ineligible, including when another observation is missing. The selection status is:

- `selected` with `trialId` for the highest-scoring eligible trial. Equal scores go to the ascending lexical trial ID.
- `insufficient_evidence` when no trial is eligible and some rows lack required observations.
- `no_feasible_candidate` when the supplied set has no eligible or incomplete trial.

The caller fixes the source window and comparison conditions and computes the candidate-set digest over its chosen representation. The example digest uses compact JSON serialization of the candidate array in the order shown. The CLI checks the digest format, unique trial IDs, and matching scoring profiles. `choose_sound` proves the winner's membership, eligibility, maximal score, and tie rule for the supplied rows. `choose_none_iff` proves that the pure selector returns no winner exactly when the supplied set has no admissible scored trial.
