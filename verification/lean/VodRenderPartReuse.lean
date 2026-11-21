import Lean

/-!
Within-job reuse for the VOD renderer. The worker uses an immutable input version
or generated input and the full render arguments, excluding the destination path.
The model assumes that equal eligible keys produce equal parts. Real FFmpeg
comparisons check the assumption for representative media and codec settings.
Run with Lean 4.24.0 using `lean --run verification/lean/VodRenderPartReuse.lean`.
-/

namespace BitOVP.VodRenderPartReuse

set_option autoImplicit false

variable {Request Key Part : Type} [DecidableEq Key]

abbrev Cache (Key Part : Type) := Key → Option Part

def HaveSameParts (identify : Request → Option Key) (render : Request → Part) : Prop :=
  ∀ first second key, identify first = some key → identify second = some key →
    render first = render second

def Sound (identify : Request → Option Key) (render : Request → Part)
    (cache : Cache Key Part) : Prop :=
  ∀ request key part, identify request = some key → cache key = some part →
    part = render request

def renderPart (identify : Request → Option Key) (render : Request → Part)
    (cache : Cache Key Part) (request : Request) : Part × Cache Key Part × Nat :=
  match identify request with
  | none => (render request, cache, 1)
  | some key =>
    match cache key with
    | some part => (part, cache, 0)
    | none =>
      (render request, fun other => if other = key then some (render request) else cache other, 1)

theorem renderPartSound (identify : Request → Option Key) (render : Request → Part)
    (same : HaveSameParts identify render) (cache : Cache Key Part)
    (sound : Sound identify render cache) (request : Request) :
    (renderPart identify render cache request).1 = render request ∧
    Sound identify render (renderPart identify render cache request).2.1 := by
  cases indexed : identify request with
  | none =>
    simpa only [renderPart, indexed] using And.intro (rfl : render request = render request) sound
  | some key =>
    cases stored : cache key with
    | some part =>
      simpa only [renderPart, indexed, stored] using
        And.intro (sound request key part indexed stored) sound
    | none =>
      simp only [renderPart, indexed, stored]
      refine ⟨True.intro, ?_⟩
      intro other otherKey part located cached
      by_cases equalKey : otherKey = key
      · subst otherKey
        simp at cached
        exact cached.symm.trans (same request other key indexed located)
      · exact sound other otherKey part located (by simpa only [if_neg equalKey] using cached)

def renderTrack (identify : Request → Option Key) (render : Request → Part)
    (cache : Cache Key Part) : List Request → List Part × Nat
  | [] => ([], 0)
  | request :: more =>
    let first := renderPart identify render cache request
    let rest := renderTrack identify render first.2.1 more
    (first.1 :: rest.1, first.2.2 + rest.2)

theorem renderTrackPreservesOrder (identify : Request → Option Key) (render : Request → Part)
    (same : HaveSameParts identify render) (requests : List Request)
    (cache : Cache Key Part) (sound : Sound identify render cache) :
    (renderTrack identify render cache requests).1 = requests.map render := by
  induction requests generalizing cache with
  | nil => rfl
  | cons request more inductionHypothesis =>
    let first := renderPart identify render cache request
    have firstSound := renderPartSound identify render same cache sound request
    change first.1 :: (renderTrack identify render first.2.1 more).1 =
      render request :: more.map render
    rw [show first.1 = render request from firstSound.1]
    rw [inductionHypothesis first.2.1 firstSound.2]

theorem renderTrackPreservesSamples {Sample : Type} (identify : Request → Option Key)
    (render : Request → Part) (samples : Part → List Sample)
    (same : HaveSameParts identify render) (requests : List Request)
    (cache : Cache Key Part) (sound : Sound identify render cache) :
    (renderTrack identify render cache requests).1.flatMap samples =
      (requests.map render).flatMap samples := by
  rw [renderTrackPreservesOrder identify render same requests cache sound]

omit [DecidableEq Key] in
theorem emptyCacheSound (identify : Request → Option Key) (render : Request → Part) :
    Sound identify render (fun _ => none) := by
  intro _ _ _ _ impossible
  cases impossible

theorem renderFromEmptyPreservesSamples {Sample : Type} (identify : Request → Option Key)
    (render : Request → Part) (samples : Part → List Sample)
    (same : HaveSameParts identify render) (requests : List Request) :
    (renderTrack identify render (fun _ => none) requests).1.flatMap samples =
      (requests.map render).flatMap samples :=
  renderTrackPreservesSamples identify render samples same requests _
    (emptyCacheSound identify render)

private def label (track : String) (index : Nat) : String :=
  track ++ "-" ++ toString index

private def fixture (unique : Bool) : Lean.Json := Id.run do
  let cuts := List.range 8
  let video := cuts.map (fun i => label "video" (if unique then i else i % 2))
  let audio := cuts.map (fun i => label "audio" (if unique then i else 0))
  let (videoParts, videoCalls) := renderTrack some id (fun _ => none) video
  let (audioParts, audioCalls) := renderTrack some id (fun _ => none) audio
  return Lean.Json.mkObj [
    ("label", .str (if unique then "unique" else "repeated")),
    ("videoParts", Lean.toJson videoParts),
    ("audioParts", Lean.toJson audioParts),
    ("calls", Lean.toJson (videoCalls + audioCalls))]

def fixtures : Lean.Json := .arr #[fixture false, fixture true]

end BitOVP.VodRenderPartReuse

def main : IO Unit := IO.println BitOVP.VodRenderPartReuse.fixtures.compress
