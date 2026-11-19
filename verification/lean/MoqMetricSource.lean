import Lean

/-!
Independent source policy for the MoQ viewing dashboard.
Run with `lean --run verification/lean/MoqMetricSource.lean` (Lean 4.24.0).
A reading is a single metric with its source attached. The model covers routing
and presence. The browser tests check the UI and the production source adapters.
-/

namespace BitOVP.MoqMetricSource

set_option autoImplicit false

inductive Origin where
  | timecode
  | videoPresentation
  | canvasChange
  | legacyRendering
  | playerBuffer
  | videoBuffer
  | legacyBuffer
  | encoderHeartbeat
  deriving DecidableEq

inductive ViewerField where
  | latencyMs
  | videoFps
  | canvasUpdates
  | legacyFrameRate
  | playerBufferSeconds
  | videoBufferSeconds
  | legacyBufferSeconds
  deriving DecidableEq

def Origin.viewerField : Origin → Option ViewerField
  | .timecode => some .latencyMs
  | .videoPresentation => some .videoFps
  | .canvasChange => some .canvasUpdates
  | .legacyRendering => some .legacyFrameRate
  | .playerBuffer => some .playerBufferSeconds
  | .videoBuffer => some .videoBufferSeconds
  | .legacyBuffer => some .legacyBufferSeconds
  | .encoderHeartbeat => none

def viewerReading (origin : Origin) (value : Option Nat) : Option (ViewerField × Nat) :=
  value.bind fun observed => origin.viewerField.map fun field => (field, observed)

theorem encoderIsSeparate (value : Option Nat) :
    viewerReading .encoderHeartbeat value = none := by
  cases value <;> rfl

theorem missingIsOmitted (origin : Origin) :
    viewerReading origin none = none := rfl

theorem observedZeroIsPreserved (origin : Origin) (field : ViewerField)
    (routed : origin.viewerField = some field) :
    viewerReading origin (some 0) = some (field, 0) := by
  simp [viewerReading, routed]

theorem viewerFieldHasOneSource (first second : Origin) (field : ViewerField)
    (left : first.viewerField = some field) (right : second.viewerField = some field) :
    first = second := by
  cases first <;> cases second <;> cases field <;>
    simp [Origin.viewerField] at left right ⊢

private def Origin.key : Origin → String
  | .timecode => "timecode"
  | .videoPresentation => "video"
  | .canvasChange => "canvas"
  | .legacyRendering => "legacy-rendering"
  | .playerBuffer => "player-buffer"
  | .videoBuffer => "video-buffer"
  | .legacyBuffer => "legacy-buffer"
  | .encoderHeartbeat => "encoder-heartbeat"

private def ViewerField.key : ViewerField → String
  | .latencyMs => "latencyMs"
  | .videoFps => "videoFps"
  | .canvasUpdates => "canvasUpdates"
  | .legacyFrameRate => "legacyFrameRate"
  | .playerBufferSeconds => "playerBufferSeconds"
  | .videoBufferSeconds => "videoBufferSeconds"
  | .legacyBufferSeconds => "legacyBufferSeconds"

private def exampleJson (origin : Origin) (value : Option Nat) : Lean.Json :=
  let viewer :=
    match viewerReading origin value with
    | none => Lean.Json.null
    | some (field, observed) =>
        Lean.Json.mkObj [("field", .str field.key), ("value", Lean.toJson observed)]
  Lean.Json.mkObj [
    ("origin", .str origin.key),
    ("value", value.map Lean.toJson |>.getD .null),
    ("viewer", viewer)
  ]

def casesJson : Lean.Json :=
  let origins := [
    Origin.timecode, .videoPresentation, .canvasChange, .legacyRendering,
    .playerBuffer, .videoBuffer, .legacyBuffer, .encoderHeartbeat
  ]
  let cases := origins.flatMap fun origin => [none, some 0, some 12].map (exampleJson origin)
  .arr cases.toArray

end BitOVP.MoqMetricSource

def main : IO Unit :=
  IO.println BitOVP.MoqMetricSource.casesJson.compress
