import Lean

/-!
Cost model for the direct branch in `apps/worker/src/verify/one-to-one.ts`.
Run with `lean --run verification/lean/DisjointManifestMatching.lean` (Lean 4.24.0).

The edges are the real compatible cells of the assignment in canonical row
order. A valid projection of the square solver selects a subset of these
edges. For pairwise disjoint edges, a chosen edge contributes its scaled
cost and an omitted edge pays for its unmatched row and column, plus the
applicable required-row penalty. Already isolated nodes add a constant.
Dummy-column permutations have no effect on the real projection.

This model covers the exact integer cost comparison and its unique optimum.
TypeScript supplies canonical keys, compatibility, finite scaled costs and
the disjointness check. The unchanged solver handles conflicting edges.
-/

namespace BitOVP.DisjointManifestMatching

set_option autoImplicit false

structure Edge where
  row : Nat
  column : Nat
  scaledCost : Nat
  required : Bool

def unmatched (rows columns costCap : Nat) : Nat :=
  (min rows columns + 1) * costCap + 1

def omissionCost (unmatchedPenalty requiredPenalty : Nat) (edge : Edge) : Nat :=
  2 * unmatchedPenalty + (if edge.required then requiredPenalty else 0)

theorem compatibleEdgeCheaper (rows columns costCap requiredPenalty : Nat) (edge : Edge)
    (bounded : edge.scaledCost ≤ costCap) :
    edge.scaledCost < omissionCost (unmatched rows columns costCap) requiredPenalty edge := by
  have base : costCap < unmatched rows columns costCap := by
    simp [unmatched, Nat.add_mul]
    omega
  unfold omissionCost
  omega

theorem incompatibleEdgeDearer (unmatchedPenalty requiredPenalty costCap : Nat)
    (edge : Edge) :
    omissionCost unmatchedPenalty requiredPenalty edge <
      2 * unmatchedPenalty + requiredPenalty + costCap + 1 := by
  unfold omissionCost
  cases edge.required <;> simp <;> omega

def totalCost (omitted : Edge → Nat) (chosen : Edge → Bool) : List Edge → Nat
  | [] => 0
  | edge :: tail =>
    (if chosen edge then edge.scaledCost else omitted edge) + totalCost omitted chosen tail

theorem usingAllCostsNoMore (omitted : Edge → Nat) (chosen : Edge → Bool)
    (edges : List Edge) (cheaper : ∀ edge ∈ edges, edge.scaledCost < omitted edge) :
    totalCost omitted (fun _ => true) edges ≤ totalCost omitted chosen edges := by
  induction edges with
  | nil => exact Nat.le_refl 0
  | cons edge tail ih =>
    have rest := ih (fun next member => cheaper next (by simp [member]))
    have head := cheaper edge (by simp)
    cases selected : chosen edge <;> simp [totalCost, selected] <;> omega

theorem optimumKeepsEveryEdge (omitted : Edge → Nat) (chosen : Edge → Bool)
    (edges : List Edge) (cheaper : ∀ edge ∈ edges, edge.scaledCost < omitted edge)
    (optimal : totalCost omitted chosen edges ≤ totalCost omitted (fun _ => true) edges) :
    edges.filter chosen = edges := by
  induction edges with
  | nil => rfl
  | cons edge tail ih =>
    have tailCheaper : ∀ next ∈ tail, next.scaledCost < omitted next :=
      fun next member => cheaper next (by simp [member])
    have head := cheaper edge (by simp)
    have rest := usingAllCostsNoMore omitted chosen tail tailCheaper
    cases selected : chosen edge with
    | false =>
      simp [totalCost, selected] at optimal
      omega
    | true =>
      have tailOptimal : totalCost omitted chosen tail ≤ totalCost omitted (fun _ => true) tail := by
        simp [totalCost, selected] at optimal
        omega
      simp [selected, ih tailCheaper tailOptimal]

def endpointIndependent (edges : List Edge) : Prop :=
  edges.Pairwise fun first second => first.row ≠ second.row ∧ first.column ≠ second.column

def direct (edges : List Edge) : Option (List Edge) :=
  if edges.Pairwise (fun first second => first.row ≠ second.row ∧ first.column ≠ second.column)
  then some edges else none

theorem directIffIndependent (edges : List Edge) :
    direct edges = some edges ↔ endpointIndependent edges := by
  simp [direct, endpointIndependent]

theorem disjointOptimumHasDirectProjection (rows columns costCap requiredPenalty : Nat)
    (edges : List Edge) (chosen : Edge → Bool)
    (disjoint : endpointIndependent edges)
    (bounded : ∀ edge ∈ edges, edge.scaledCost ≤ costCap)
    (optimal : totalCost (omissionCost (unmatched rows columns costCap) requiredPenalty) chosen edges ≤
      totalCost (omissionCost (unmatched rows columns costCap) requiredPenalty) (fun _ => true) edges) :
    direct edges = some (edges.filter chosen) := by
  have projected := optimumKeepsEveryEdge
    (omissionCost (unmatched rows columns costCap) requiredPenalty) chosen edges
    (fun edge member => compatibleEdgeCheaper rows columns costCap requiredPenalty edge
      (bounded edge member)) optimal
  simpa [direct, endpointIndependent, projected] using disjoint

private def pairJson (edge : Edge) : Lean.Json :=
  Lean.toJson [edge.row, edge.column]

private def fixture (rows columns : Nat) (edges : List Edge) : Lean.Json :=
  Lean.Json.mkObj [
    ("rows", Lean.toJson rows),
    ("columns", Lean.toJson columns),
    ("edges", Lean.Json.arr (edges.map (fun edge =>
      Lean.toJson [edge.row, edge.column, edge.scaledCost])).toArray),
    ("direct", (direct edges).map (fun matched =>
      Lean.Json.arr (matched.map pairJson).toArray) |>.getD Lean.Json.null)
  ]

def examples : Lean.Json :=
  Lean.Json.arr #[
    fixture 0 2 [],
    fixture 2 2 [],
    fixture 3 4 [⟨0, 2, 1000, false⟩, ⟨2, 1, 2000, false⟩],
    fixture 2 3 [⟨0, 0, 1000, false⟩, ⟨1, 1, 2000, false⟩, ⟨1, 2, 3000, false⟩],
    fixture 3 2 [⟨0, 0, 1000, false⟩, ⟨1, 1, 2000, false⟩, ⟨2, 1, 3000, false⟩]
  ]

end BitOVP.DisjointManifestMatching

def main : IO Unit := IO.println BitOVP.DisjointManifestMatching.examples.compress
