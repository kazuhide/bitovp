import Lean

open Lean

namespace BitOVP.ConfirmedResourceIds

private def consume [BEq α] : List (Option α) → List (Option α) → Bool
  | [], pending => pending.isEmpty
  | id :: rest, pending => pending.contains id && consume rest (pending.erase id)

private theorem consumeMatchesPermutation [BEq α] [LawfulBEq α]
    (observed pending : List (Option α)) :
    consume observed pending = true ↔ observed.Perm pending := by
  induction observed generalizing pending with
  | nil => simp [consume]
  | cons id rest ih =>
    simp [consume, ih, List.cons_perm_iff_perm_erase]

def accepts [DecidableEq α] (observed : List (Option α)) (confirmed : List α) : Bool :=
  decide (confirmed ≠ [] ∧ confirmed.Nodup) && consume observed (confirmed.map some)

def exactMatch (observed : List (Option α)) (confirmed : List α) : Prop :=
  confirmed ≠ [] ∧ confirmed.Nodup ∧ observed.Perm (confirmed.map some)

private instance [DecidableEq α] (observed : List (Option α)) (confirmed : List α) :
    Decidable (exactMatch observed confirmed) := by
  unfold exactMatch
  infer_instance

theorem acceptsIffExactMatch [DecidableEq α]
    (observed : List (Option α)) (confirmed : List α) :
    accepts observed confirmed = true ↔ exactMatch observed confirmed := by
  simp [accepts, exactMatch, consumeMatchesPermutation, and_assoc]

theorem acceptedMembership [DecidableEq α]
    (accepted : accepts observed confirmed = true) (id : Option α) :
    id ∈ observed ↔ ∃ resource ∈ confirmed, some resource = id := by
  have same := ((acceptsIffExactMatch observed confirmed).mp accepted).2.2
  exact same.mem_iff.trans List.mem_map

private structure Fixture where
  observed : List (Option Nat)
  confirmed : List Nat
  expected : Bool
  deriving ToJson

private def fixture (observed : List (Option Nat)) (confirmed : List Nat) : Fixture :=
  ⟨observed, confirmed, decide (exactMatch observed confirmed)⟩

private def listsUpTo (values : List α) : Nat → List (List α)
  | 0 => [[]]
  | length + 1 =>
    [] :: values.flatMap fun value => (listsUpTo values length).map (value :: ·)

def fixtures : Json :=
  let bounded := (listsUpTo [none, some 0, some 1, some 2] 3).flatMap fun observed =>
    (listsUpTo [0, 1, 2] 3).map (fixture observed)
  let full := List.range 100
  toJson (bounded ++ [
    fixture (full.reverse.map some) full,
    fixture (full.reverse.map some |>.set 0 none) full,
    fixture (full.reverse.map some |>.set 0 (some 100)) full
  ])

end BitOVP.ConfirmedResourceIds

def main : IO Unit := IO.println BitOVP.ConfirmedResourceIds.fixtures.compress
