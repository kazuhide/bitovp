import Lean

/-!
Model for the clock used by scene-scoped clip analysis.
Run with `lean verification/lean/ScopedClipWindow.lean` (Lean 4.24.0).

The caller supplies a validated scene and a local decoder interval. All values
are integer microseconds on the same clock. The model does not establish the
identity of an AISA scene, the accuracy of decoded timestamps, or the quality
of a generated edit.
-/

namespace BitOVP.ScopedClip

set_option autoImplicit false

structure Range where
  startUs : Nat
  endUs : Nat

def Range.duration (range : Range) : Nat :=
  range.endUs - range.startUs

def Range.contains (outer inner : Range) : Prop :=
  outer.startUs ≤ inner.startUs ∧
    inner.startUs < inner.endUs ∧ inner.endUs ≤ outer.endUs

def Range.onClock (range : Range) (originUs : Nat) : Range :=
  ⟨originUs + range.startUs, originUs + range.endUs⟩

theorem localWindowStaysInScene
    (scene window : Range)
    (validScene : scene.startUs < scene.endUs)
    (fits : (Range.mk 0 scene.duration).contains window) :
    scene.contains (window.onClock scene.startUs) := by
  unfold Range.contains Range.onClock Range.duration at *
  dsimp at *
  omega

theorem admittedWindowStaysInSource
    (source scene window : Range)
    (admitted : source.contains scene)
    (fits : (Range.mk 0 scene.duration).contains window) :
    source.contains (window.onClock scene.startUs) := by
  have inScene := localWindowStaysInScene scene window admitted.2.1 fits
  unfold Range.contains at *
  omega

theorem durationUnaffectedByOrigin (range : Range) (originUs : Nat) :
    (range.onClock originUs).duration = range.duration := by
  unfold Range.duration Range.onClock
  dsimp
  omega

theorem originalClockRoundTrip (startUs timestampUs : Nat)
    (afterStart : startUs ≤ timestampUs) :
    startUs + (timestampUs - startUs) = timestampUs := by
  omega

theorem decodedWindowOriginalTime (sourceStartUs sceneStartUs windowOffsetUs : Nat)
    (insideSource : sourceStartUs ≤ sceneStartUs) :
    sourceStartUs + ((sceneStartUs - sourceStartUs) + windowOffsetUs) =
      sceneStartUs + windowOffsetUs := by
  omega

def firstCfrFrame (startUs : Nat) : Nat :=
  (startUs * 30 + 999999) / 1000000

def pastLastCfrFrame (endUs : Nat) : Nat :=
  endUs * 30 / 1000000

theorem firstFrameRoundsInward (startUs : Nat) :
    startUs * 30 ≤ firstCfrFrame startUs * 1000000 := by
  unfold firstCfrFrame
  omega

theorem endFrameRoundsInward (endUs : Nat) :
    pastLastCfrFrame endUs * 1000000 ≤ endUs * 30 := by
  unfold pastLastCfrFrame
  omega

theorem admittedFramesStayInScene (sceneStartUs sceneEndUs startFrame endFrame : Nat)
    (admittedStart : firstCfrFrame sceneStartUs ≤ startFrame)
    (admittedEnd : endFrame ≤ pastLastCfrFrame sceneEndUs) :
    sceneStartUs * 30 ≤ startFrame * 1000000 ∧
      endFrame * 1000000 ≤ sceneEndUs * 30 := by
  have first := firstFrameRoundsInward sceneStartUs
  have last := endFrameRoundsInward sceneEndUs
  omega

end BitOVP.ScopedClip
