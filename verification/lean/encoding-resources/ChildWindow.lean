import Lean

/-!
Verification model for apps/web/src/lib/server/encoding-resources/child-window.ts.
A present natural identifies a UUID accepted by the caller. An absent ID
represents a missing or invalid UUID. Page arithmetic models validated
nonnegative integers.
-/

namespace BitOVP.ChildWindow

open Lean

set_option autoImplicit false
set_option warningAsError true

abbrev RowId := Option Nat

structure Page where
  offset : Nat
  limit : Nat
  deriving ToJson

structure ProviderPage where
  offset : Option Nat
  total : Nat
  rows : List RowId
  deriving ToJson

def windowStart (page : Page) (whole : Bool) : Nat :=
  if whole then page.offset else 0

def validShape (page : Page) (whole : Bool) (result : ProviderPage) : Prop :=
  (result.offset = none ∨ result.offset = some (if whole then 0 else page.offset)) ∧
  if whole then
    result.rows.length ≤ result.total ∧ (result.total = 0 ∨ result.rows ≠ [])
  else
    result.rows.length = min page.limit (result.total - page.offset)

instance (page : Page) (whole : Bool) (result : ProviderPage) :
    Decidable (validShape page whole result) := by
  unfold validShape
  cases whole <;> infer_instance

def cleanAfter (seen rows : List RowId) : Prop :=
  (∀ id ∈ rows, id ≠ none ∧ id ∉ seen) ∧ rows.Nodup

instance (seen rows : List RowId) : Decidable (cleanAfter seen rows) := by
  unfold cleanAfter
  infer_instance

def hasTarget (target : RowId) (skip limit : Nat) (rows : List RowId) : Bool :=
  target.isSome && ((rows.drop skip).take limit).contains target

def scan (target : RowId) (start endIndex index : Nat) (seen : List RowId) (found : Bool) :
    List RowId → Option Bool
  | [] => some found
  | none :: _ => none
  | some id :: rows =>
    if some id ∈ seen then none
    else scan target start endIndex (index + 1) (some id :: seen)
      (found || (start ≤ index && index < endIndex && some id == target)) rows

private theorem cleanAfterCons (seen : List RowId) (id : RowId) (rows : List RowId) :
    cleanAfter seen (id :: rows) ↔ id ≠ none ∧ id ∉ seen ∧ cleanAfter (id :: seen) rows := by
  simp only [cleanAfter, List.nodup_cons, List.mem_cons, not_or]
  constructor
  · rintro ⟨validRows, absent, distinct⟩
    have ⟨valid, fresh⟩ := validRows id (Or.inl rfl)
    refine ⟨valid, fresh, ?_, distinct⟩
    intro other member
    have ⟨validOther, freshOther⟩ := validRows other (Or.inr member)
    exact ⟨validOther, fun same => absent (same ▸ member), freshOther⟩
  · rintro ⟨valid, fresh, validRows, distinct⟩
    refine ⟨?_, ?_, distinct⟩
    · intro other member
      rcases member with equal | member
      · subst other
        exact ⟨valid, fresh⟩
      · have ⟨validOther, _, freshOther⟩ := validRows other member
        exact ⟨validOther, freshOther⟩
    · intro member
      exact (validRows id member).2.1 rfl

private theorem hasTargetCons (target : RowId) (skip limit id : Nat) (rows : List RowId) :
    hasTarget target skip limit (some id :: rows) =
      ((skip == 0 && 0 < limit && some id == target) ||
      hasTarget target (skip - 1) (if skip = 0 then limit - 1 else limit) rows) := by
  cases target with
  | none => cases skip <;> cases limit <;> simp [hasTarget]
  | some target =>
    cases skip <;> cases limit <;> simp [hasTarget]
    by_cases same : target = id
    · simp [same]
    · simp [same, Ne.symm same]

private theorem indexIsInWindow (index start limit : Nat) :
    (start ≤ index ∧ index < start + limit) ↔
      (start - index = 0 ∧ 0 < limit - (index - start)) := by
  omega

theorem scanMatchesReference (target : RowId) (rows : List RowId) (start limit index : Nat)
    (seen : List RowId) (found : Bool) :
    scan target start (start + limit) index seen found rows =
      if cleanAfter seen rows then
        some (found || hasTarget target (start - index) (limit - (index - start)) rows)
      else none := by
  induction rows generalizing index seen found with
  | nil => simp [scan, cleanAfter, hasTarget]
  | cons id rows ih =>
    cases id with
    | none => simp [scan, cleanAfterCons]
    | some id =>
      simp only [scan, cleanAfterCons, hasTargetCons]
      by_cases member : some id ∈ seen
      · simp [member]
      · have skipNext : start - (index + 1) = start - index - 1 := by omega
        have limitNext : limit - (index + 1 - start) =
            if start - index = 0 then (limit - (index - start)) - 1
            else limit - (index - start) := by
          split <;> omega
        have inWindow :
            (decide (start ≤ index) && decide (index < start + limit)) =
              ((start - index == 0) && decide (0 < limit - (index - start))) := by
          apply Bool.eq_iff_iff.mpr
          simpa using indexIsInWindow index start limit
        rw [ite_eq_right member, ih, skipNext, limitNext, inWindow]
        simp [member, Bool.or_assoc]

structure Inspection where
  start : Nat
  endIndex : Nat
  total : Nat
  available : Nat
  containsTarget : Bool
  deriving ToJson, DecidableEq

def metadata (page : Page) (whole : Bool) (result : ProviderPage)
    (containsTarget : Bool) : Inspection :=
  let start := windowStart page whole
  ⟨start, start + page.limit, result.total,
   if whole then result.rows.length else result.total, containsTarget⟩

def inspect (page : Page) (whole : Bool) (result : ProviderPage) (target : RowId) :
    Option Inspection :=
  if validShape page whole result then
    let start := windowStart page whole
    (scan target start (start + page.limit) 0 [] false result.rows).map
      (metadata page whole result)
  else none

def reference (page : Page) (whole : Bool) (result : ProviderPage) (target : RowId) :
    Option Inspection :=
  if validShape page whole result ∧ cleanAfter [] result.rows then
    some (metadata page whole result (hasTarget target (windowStart page whole) page.limit result.rows))
  else none

theorem inspectMatchesReference (page : Page) (whole : Bool) (result : ProviderPage)
    (target : RowId) : inspect page whole result target = reference page whole result target := by
  by_cases shape : validShape page whole result <;>
    by_cases clean : cleanAfter [] result.rows <;>
    simp [inspect, reference, scanMatchesReference, shape, clean]

theorem acceptedImpliesCleanShapeAndMembership (page : Page) (whole : Bool)
    (result : ProviderPage) (target : RowId) (value : Inspection)
    (accepted : inspect page whole result target = some value) :
    validShape page whole result ∧
      cleanAfter [] result.rows ∧
      (value.containsTarget = true ↔
        target ≠ none ∧ target ∈ (result.rows.drop (windowStart page whole)).take page.limit) := by
  rw [inspectMatchesReference] at accepted
  unfold reference at accepted
  split at accepted
  · rename_i valid
    cases accepted
    refine ⟨valid.1, valid.2, ?_⟩
    cases target <;> simp [metadata, hasTarget]
  · contradiction

theorem pagedShapeUsesProviderOffset (page : Page) (result : ProviderPage)
    (shape : validShape page false result) :
    (result.offset = none ∨ result.offset = some page.offset) ∧
    result.rows.length = min page.limit (result.total - page.offset) ∧ windowStart page false = 0 := by
  exact ⟨shape.1, shape.2, rfl⟩

theorem wholeShapeUsesLocalWindow (page : Page) (result : ProviderPage)
    (shape : validShape page true result) :
    (result.offset = none ∨ result.offset = some 0) ∧
    result.rows.length ≤ result.total ∧
    (result.total = 0 ∨ result.rows ≠ []) ∧ windowStart page true = page.offset := by
  exact ⟨shape.1, shape.2.1, shape.2.2, rfl⟩

private structure Fixture where
  page : Page
  whole : Bool
  response : ProviderPage
  target : RowId
  expected : Option Inspection
  deriving ToJson

private def fixture (page : Page) (whole : Bool) (response : ProviderPage)
    (target : RowId) : Fixture :=
  ⟨page, whole, response, target, reference page whole response target⟩

private def shortRows : Nat → List (List RowId)
  | 0 => [[]]
  | length + 1 =>
    [] :: [none, some 0, some 1].flatMap fun id => (shortRows length).map (id :: ·)

private def exhaustiveFixtures : List Fixture :=
  (shortRows 3).flatMap fun rows =>
    [⟨0, 0⟩, ⟨0, 1⟩, ⟨1, 1⟩, ⟨1, 3⟩, ⟨2, 2⟩, ⟨4, 1⟩].flatMap fun (page : Page) =>
      [false, true].flatMap fun whole =>
        [none, some 0, some 2].flatMap fun target =>
          let equalTotal := rows.length + if whole then 0 else page.offset
          [equalTotal, equalTotal + 1].map fun total =>
            let offset := if total % 2 = 0 then none else some (if whole then 0 else page.offset)
            fixture page whole ⟨offset, total, rows⟩ target

private def providerFixtures : List Fixture :=
  let rows := (List.range 30).map some
  [ fixture ⟨25, 25⟩ false ⟨some 25, 80, rows.take 25⟩ (some 24),
    fixture ⟨25, 25⟩ false ⟨none, 30, rows.take 5⟩ (some 0),
    fixture ⟨25, 25⟩ false ⟨some 0, 30, rows.take 5⟩ (some 0),
    fixture ⟨25, 25⟩ false ⟨some 25, 20, []⟩ (some 0),
    fixture ⟨25, 25⟩ true ⟨some 0, 100, rows⟩ (some 29),
    fixture ⟨25, 25⟩ true ⟨some 25, 100, rows⟩ (some 29),
    fixture ⟨25, 25⟩ true ⟨some 0, 100, rows.set 1 none⟩ (some 29),
    fixture ⟨25, 25⟩ true ⟨some 0, 100, rows.set 1 (some 2)⟩ (some 29),
    fixture ⟨0, 25⟩ true ⟨none, 100, rows.set 29 none⟩ (some 0),
    fixture ⟨0, 25⟩ true ⟨none, 100, rows.set 29 (some 1)⟩ (some 0),
    fixture ⟨25, 25⟩ true ⟨none, 100, rows.take 25⟩ (some 0),
    fixture ⟨25, 25⟩ true ⟨none, 100, []⟩ (some 0),
    fixture ⟨25, 25⟩ true ⟨none, 29, rows⟩ (some 29) ]

def fixtures : Json := toJson (exhaustiveFixtures ++ providerFixtures)

end BitOVP.ChildWindow

def main : IO Unit := IO.println BitOVP.ChildWindow.fixtures.compress
