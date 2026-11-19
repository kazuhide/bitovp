import Lean

/-!
Model for reusing completed VMAF scores on retry.
Run with `lean verification/lean/VerifiedVmafReuse.lean` (Lean 4.24.0).

The two input identities and the scoring settings stand for the data bound by
the worker's validated key. The worker must authenticate the predecessor,
check the actual input and payload bytes, and validate full-frame CPU parity.
The model treats those checks as inputs and makes no claim about hashes or
the numerical equivalence of libvmaf and a GPU implementation.
-/

namespace BitOVP.VerifiedVmafReuse

set_option autoImplicit false

structure ScoreKey where
  organization : String
  reference : String
  distorted : String
  frameBasis : String
  model : String
  scorer : String
  deriving DecidableEq

structure Certificate where
  key : ScoreKey
  allFramesCpuVerified : Bool
  framesDigest : String

def Certificate.matches (receipt : Certificate) (requested : ScoreKey)
    (actualFramesDigest : String) : Prop :=
  receipt.key = requested ∧ receipt.allFramesCpuVerified = true ∧
    actualFramesDigest = receipt.framesDigest

instance (receipt : Certificate) (requested : ScoreKey) (digest : String) :
    Decidable (receipt.matches requested digest) := by
  unfold Certificate.matches
  infer_instance

def reusable (requested : ScoreKey) (actualFramesDigest : String)
    (prior : Option Certificate) : Bool :=
  match prior with
  | none => false
  | some receipt => decide (receipt.matches requested actualFramesDigest)

theorem hitRequiresAllChecks (requested : ScoreKey) (actualFramesDigest : String)
    (receipt : Certificate) :
    reusable requested actualFramesDigest (some receipt) = true ↔
      receipt.matches requested actualFramesDigest := by
  simp [reusable]

theorem changedKeyIsMiss (requested : ScoreKey) (actualFramesDigest : String)
    (receipt : Certificate) (different : receipt.key ≠ requested) :
    reusable requested actualFramesDigest (some receipt) = false := by
  simp [reusable, Certificate.matches, different]

theorem changedPayloadIsMiss (requested : ScoreKey) (actualFramesDigest : String)
    (receipt : Certificate) (different : actualFramesDigest ≠ receipt.framesDigest) :
    reusable requested actualFramesDigest (some receipt) = false := by
  simp [reusable, Certificate.matches, different]

theorem incompleteParityIsMiss (requested : ScoreKey) (actualFramesDigest : String)
    (receipt : Certificate) (incomplete : receipt.allFramesCpuVerified = false) :
    reusable requested actualFramesDigest (some receipt) = false := by
  simp [reusable, Certificate.matches, incomplete]

def scoreOrReuse {Report : Type} (fresh : ScoreKey → Report)
    (requested : ScoreKey) (actualFramesDigest : String)
    (prior : Option (Certificate × Report)) : Report :=
  match prior with
  | none => fresh requested
  | some (receipt, report) =>
      if reusable requested actualFramesDigest (some receipt) then report
      else fresh requested

theorem certificatePreservesResult {Report : Type}
    (fresh : ScoreKey → Report) (requested : ScoreKey)
    (actualFramesDigest : String) (receipt : Certificate) (oldReport : Report)
    (certified : receipt.matches requested actualFramesDigest →
      oldReport = fresh receipt.key) :
    scoreOrReuse fresh requested actualFramesDigest (some (receipt, oldReport)) =
      fresh requested := by
  by_cases h : receipt.matches requested actualFramesDigest
  · simp only [scoreOrReuse, reusable, decide_eq_true_eq, if_pos h]
    rw [certified h, h.1]
  · simp [scoreOrReuse, reusable, h]

end BitOVP.VerifiedVmafReuse
