# Delivery preset authoring

How to encode a platform delivery spec as a `.bitovp-preset.json` file. We ship the mechanism and generic examples — third-party delivery specifications are their owners' documents; encode them privately with this format.

## File format

```json
{
  "formatVersion": 1,
  "spec": {
    "id": "your-spec-id",
    "name": "Human name",
    "category": "MEZZANINE" | "BROADCAST_TS" | "AUDIO_MASTER",
    "description": "One paragraph.",
    "plan": { /* EncodingPlan with placeholder credential ids */ },
    "constraints": [
      { "requirement": "Video bitrate 45–55 Mbps", "path": "renditions.0.bitrate", "expect": { "gte": 45000000, "lte": 55000000 } }
    ],
    "suggestedGate": { "rules": [{ "metric": "VMAF_MEAN", "scope": "OVERALL", "gte": 95 }], "onFail": "MARK_ONLY" },
    "sources": ["optional spec-document references"]
  }
}
```

- Use placeholder credential IDs and remove private account names, paths, and source references before sharing a preset. Import re-binds credential IDs through the wizard's placeholder checklist.
- Import is strict: the container shape, the plan (full schema), and every constraint row are validated; the spec is then run against its OWN plan and any **self-deviations are shown before saving** — an example plan that under-fills its own constraints imports, but never silently.
- Saved rows keep `body` = the bare plan (the wizard's load path parses it as such) and the constraints beside it in `spec`.

## Constraint grammar (deliberately small — v1)

One operator per row: `eq` (deep-equal), `oneOf`, or a numeric window via `gte`/`lte` (use both for a range). Paths are dot-joined with numeric array indices (`renditions.0.codec`). **An unresolved path is a deviation, never a pass** — a spec whose field the plan dropped must say so. No cross-field expressions in v1.

Conformance checks plan INTENT, not output bytes — pairing with the verify engine's artefact checks is future work; a ✔ is not a measurement.

## Verification checklist for a new spec

1. `checkDeliverySpec(spec.plan, spec)` returns `[]` (the self-pinning rule — shipped specs enforce this in `delivery-presets.test.ts`).
2. The plan compiles (`compilePlan`) and exports to template YAML (`planToEncodingTemplateYaml`).
3. **C25 applies to codec enums too**: an SDK model is not evidence the endpoint/field exists. Verify unusual codec/muxing combinations against the live API with a real encode before trusting the preset.

## Worked examples the schema cannot express yet

These two were in the design's v1 list and are documented here INSTEAD of shipping as presets, because the plan schema has no H.262/MP2/PCM codec configs and no WAV/MOV/MXF/Broadcast-TS muxings today (REQUIREMENTS §4.2 is the API-parity target, not the implemented surface). Row 82 records the schema gap as the reopening condition.

### broadcast-ts-mpeg2 (example only)

H.262 (MPEG-2 Video) 4:2:0 @ 15 Mbps + MP2 audio in a Broadcast TS container, field-encoded where the source is interlaced. When the schema gains `codec: "H262"` / `codec: "MP2"` and a `BROADCAST_TS` muxing, the constraint rows are: codec eq H262; bitrate window 12–18 Mbps; audio eq MP2 @ 256k; muxing eq BROADCAST_TS; interlace flags verified against the live SDK **in the shipping PR** (the C25 caveat — field/interlace combinations are exactly the territory where an SDK model exists and the endpoint refuses).

### audio-master-wav (example only)

PCM 24-bit/48 kHz WAV progressive, audio-only (the audio-only manifest machinery exists; the PCM codec config and WAV muxing do not). Constraint rows when expressible: codec eq PCM; sample rate eq 48000; bit depth eq 24; muxing eq PROGRESSIVE_WAV.
