import Lean

/-!
CAMBI tiled score shortcut. Run with `lean --run verification/lean/VulkanCambiHalo.lean`.

The loaded halo contains each output's clipped window, including its center.
A missing sample represents a zero mask. Scores are represented by the ordered
nonnegative output values. The score conversion must map a zero count product
to zero, as the shader's integer weight and finite reciprocal lookup do.
Shader execution, synchronization, and binary32 parity are checked separately.
-/

namespace BitOVP.VulkanCambiHalo

set_option autoImplicit false

theorem windowCoordinateInHalo (origin lane offset radius : Int)
    (laneStart : 0 ≤ lane) (laneEnd : lane < 16)
    (windowStart : -radius ≤ offset) (windowEnd : offset ≤ radius) :
    0 ≤ origin + lane + offset - (origin - radius) ∧
      origin + lane + offset - (origin - radius) < 16 + 2 * radius := by
  omega

def matchesAnchor (anchor : Int) (sample : Option Int) : Bool :=
  match sample with
  | none => true
  | some value => value == anchor

def haloIsUniform (anchor : Int) (halo : List (Option Int)) : Bool :=
  halo.all (matchesAnchor anchor)

def countValue (window : List (Option Int)) (value : Int) : Nat :=
  window.countP (· == some value)

def contrastProduct (window : List (Option Int)) (center : Int) (index : Nat) : Nat :=
  let offset : Int := (index : Int) + 1
  countValue window center *
    max (countValue window (center + offset)) (countValue window (center - offset))

def score (window : List (Option Int)) (center : Option Int) (bins : List Nat)
    (evaluate : Nat → Nat → Nat) : Nat :=
  match center with
  | none => 0
  | some value =>
    bins.foldl (fun best index => max best (evaluate index (contrastProduct window value index))) 0

def scoreWithHalo (anchor : Int) (halo window : List (Option Int)) (center : Option Int)
    (bins : List Nat) (evaluate : Nat → Nat → Nat) : Nat :=
  if haloIsUniform anchor halo then 0 else score window center bins evaluate

private theorem anchorOfMember (anchor sample : Int) (halo : List (Option Int))
    (uniform : haloIsUniform anchor halo = true) (member : some sample ∈ halo) :
    sample = anchor := by
  exact of_decide_eq_true (List.all_eq_true.mp uniform _ member)

private theorem countOfDifferentValue (anchor value : Int) (halo window : List (Option Int))
    (uniform : haloIsUniform anchor halo = true)
    (contained : ∀ sample ∈ window, sample ∈ halo) (different : value ≠ anchor) :
    countValue window value = 0 := by
  apply List.countP_eq_zero.mpr
  intro sample member sameValue
  have equality : sample = some value := beq_iff_eq.mp sameValue
  rw [equality] at member
  exact different (anchorOfMember anchor value halo uniform (contained _ member))

private theorem zeroContrast (anchor : Int) (halo window : List (Option Int)) (index : Nat)
    (uniform : haloIsUniform anchor halo = true)
    (contained : ∀ sample ∈ window, sample ∈ halo) :
    contrastProduct window anchor index = 0 := by
  have plus : anchor + ((index : Int) + 1) ≠ anchor := by omega
  have minus : anchor - ((index : Int) + 1) ≠ anchor := by omega
  simp only [contrastProduct]
  rw [countOfDifferentValue anchor _ halo window uniform contained plus,
    countOfDifferentValue anchor _ halo window uniform contained minus]
  simp

theorem haloShortcutPreservesScore (anchor : Int) (halo window : List (Option Int))
    (center : Option Int) (bins : List Nat) (evaluate : Nat → Nat → Nat)
    (contained : ∀ sample ∈ window, sample ∈ halo)
    (centerInWindow : ∀ value, center = some value → some value ∈ window)
    (zeroScore : ∀ index, evaluate index 0 = 0) :
    scoreWithHalo anchor halo window center bins evaluate = score window center bins evaluate := by
  by_cases uniform : haloIsUniform anchor halo = true
  · simp [scoreWithHalo, uniform]
    cases center with
    | none => rfl
    | some value =>
      have equal : value = anchor :=
        anchorOfMember anchor value halo uniform (contained _ (centerInWindow _ rfl))
      subst value
      have evaluatedZero :
          ∀ index, evaluate index (contrastProduct window anchor index) = 0 := by
        intro index
        rw [zeroContrast anchor halo window index uniform contained, zeroScore]
      simp only [score, evaluatedZero]
      induction bins with
      | nil => rfl
      | cons _ rest ih => simpa using ih
  · simp [scoreWithHalo, uniform]

private def pairs : List (String × Int × Option Int × List (Option Int) × List (Option Int)) :=
  [("uniform", 64, some 64, [some 64, none, some 64], [some 64, none]),
   ("all masked", 64, none, [none, none], [none]),
   ("contrast across group edge", 64, some 64, [some 64, some 64, some 65], [some 64, some 65]),
   ("masked anchor", 64, some 68, [none, some 68, some 68], [some 68])]

private def casesJson : Lean.Json :=
  .arr (pairs.map fun (name, anchor, center, halo, window) =>
    let evaluate := fun _ product => product
    Lean.Json.mkObj [
      ("case", .str name),
      ("uniform", .bool (haloIsUniform anchor halo)),
      ("direct", Lean.toJson (score window center [0, 1] evaluate)),
      ("shortened", Lean.toJson (scoreWithHalo anchor halo window center [0, 1] evaluate))
    ]).toArray

end BitOVP.VulkanCambiHalo

def main : IO Unit :=
  IO.println BitOVP.VulkanCambiHalo.casesJson.compress
