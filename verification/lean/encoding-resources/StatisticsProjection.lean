import Lean

/-!
Models the normalized provider counts and offsets used by `inspectStatisticsPage`
and the JSON-only response boundary of `projectEncodingMetadata`.
The TypeScript conformance test exercises the real helpers with generated values.
-/
namespace BitOVP.StatisticsProjection

open Lean
set_option autoImplicit false
set_option warningAsError true

structure Page where
  offset : Nat
  total : Nat
  received : Nat
  providerOffset : Option Nat
  pageable : Bool
  deriving Repr

def remaining (page : Page) : Nat := page.total - page.offset

def valid (page : Page) : Prop :=
  (page.providerOffset = none ∨ page.providerOffset = some page.offset) ∧
  page.received ≤ remaining page ∧
  (page.offset < page.total → 0 < page.received) ∧
  (page.pageable = true → page.received ≤ 25)

instance (page : Page) : Decidable (valid page) := by
  unfold valid
  infer_instance

def next (page : Page) : Option Nat :=
  if page.pageable = true ∧ page.received < remaining page then
    some (page.offset + page.received)
  else none

def inspect (page : Page) : Option (Option Nat) :=
  if page.providerOffset.getD page.offset ≠ page.offset then none
  else if page.received > remaining page ∨
    (page.received = 0 ∧ remaining page > 0) ∨
    (page.pageable = true ∧ page.received > 25) then none
  else some (next page)

def reference (page : Page) : Option (Option Nat) :=
  if valid page then some (next page) else none

theorem inspectMatchesReference (page : Page) : inspect page = reference page := by
  have knownOffset :
      page.providerOffset.getD page.offset = page.offset ↔
        page.providerOffset = none ∨ page.providerOffset = some page.offset := by
    cases page.providerOffset <;> simp
  have positiveRemaining : remaining page > 0 ↔ page.offset < page.total := by
    unfold remaining
    omega
  have validBounds :
      ¬ (page.received > remaining page ∨
        (page.received = 0 ∧ remaining page > 0) ∨
        (page.pageable = true ∧ page.received > 25)) ↔
      page.received ≤ remaining page ∧
        (page.offset < page.total → 0 < page.received) ∧
        (page.pageable = true → page.received ≤ 25) := by
    rw [positiveRemaining]
    by_cases pageable : page.pageable = true <;> simp [pageable] <;> omega
  by_cases offsetAgrees : page.providerOffset.getD page.offset = page.offset
  · by_cases invalidPage :
      page.received > remaining page ∨
        (page.received = 0 ∧ remaining page > 0) ∨
        (page.pageable = true ∧ page.received > 25)
    · have rejected : ¬ valid page := fun shape => (validBounds.mpr shape.2) invalidPage
      simp [inspect, reference, offsetAgrees, invalidPage, rejected]
    · have accepted : valid page :=
        ⟨knownOffset.mp offsetAgrees, validBounds.mp invalidPage⟩
      simp [inspect, reference, offsetAgrees, invalidPage, accepted]
  · have rejected : ¬ valid page := fun shape => offsetAgrees (knownOffset.mpr shape.1)
    simp [inspect, reference, offsetAgrees, rejected]

theorem acceptance (page : Page) : (inspect page).isSome = true ↔ valid page := by
  rw [inspectMatchesReference]
  by_cases shape : valid page <;> simp [reference, shape]

theorem continuation (page : Page) (offset : Nat)
    (accepted : inspect page = some (some offset)) :
    offset = page.offset + page.received ∧ page.offset < offset ∧ offset < page.total := by
  have shape : valid page := (acceptance page).mp (by simp [accepted])
  rw [inspectMatchesReference] at accepted
  simp [reference, shape] at accepted
  unfold next at accepted
  split at accepted
  · rename_i continues
    simp only [Option.some.injEq] at accepted
    have fewer := continues.2
    have positive := shape.2.2.1
    unfold remaining at fewer
    omega
  · simp at accepted

theorem finish (page : Page) (pageable : page.pageable = true)
    (accepted : inspect page = some none) :
    page.total ≤ page.offset + page.received := by
  have shape : valid page := (acceptance page).mp (by simp [accepted])
  rw [inspectMatchesReference] at accepted
  simp [reference, shape] at accepted
  unfold next at accepted
  split at accepted
  · simp at accepted
  · rename_i unavailable
    simp only [pageable, true_and] at unavailable
    unfold remaining at unavailable
    omega

theorem exhaustedPageHasNoNext (page : Page) (shape : valid page)
    (exhausted : page.total ≤ page.offset + page.received) :
    inspect page = some none := by
  have allRows : ¬ page.received < remaining page := by
    unfold remaining
    omega
  simp [inspectMatchesReference, reference, shape, next, allRows]

theorem nonPageableHasNoNext (page : Page) (shape : valid page)
    (mode : page.pageable = false) : inspect page = some none := by
  simp [inspectMatchesReference, reference, shape, next, mode]

def metadataCount (value : Json) : Option Nat :=
  match value with
  | .obj fields => some fields.toList.length
  | _ => none

theorem metadataKeepsOnlyCount (first second : Std.TreeMap.Raw String Json compare)
    (sameCount : first.toList.length = second.toList.length) :
    metadataCount (.obj first) = metadataCount (.obj second) := by
  simp [metadataCount, sameCount]

private def pageJson (page : Page) : Json :=
  Json.mkObj [
    ("offset", toJson page.offset), ("total", toJson page.total),
    ("received", toJson page.received), ("providerOffset", toJson page.providerOffset),
    ("pageable", toJson page.pageable),
    ("expected", match reference page with
     | none => Json.null
     | some following => Json.mkObj [("nextOffset", toJson following)])
  ]

private def pages : List Page :=
  let exhaustive := [0, 1, 23, 24, 25, 26, 60].flatMap fun start =>
    [0, 1, 2, 25, 26, 30, 100].flatMap fun total =>
      [0, 1, 2, 24, 25, 26, 50].flatMap fun received =>
        [none, some start, some (start + 1)].flatMap fun reported =>
          [false, true].map fun pageable => ⟨start, total, received, reported, pageable⟩
  let maxSafe : Nat := 9007199254740991
  exhaustive ++ [
    ⟨maxSafe - 2, maxSafe, 1, some (maxSafe - 2), true⟩,
    ⟨maxSafe - 1, maxSafe, 1, none, true⟩,
    ⟨maxSafe, maxSafe, 0, none, true⟩
  ]

private def metadata : List Json := [
  Json.null, toJson false, toJson (2 : Nat), toJson "metadata",
  toJson ([1, 2] : List Nat), Json.mkObj [],
  Json.mkObj [("key", toJson "private"), ("nested", Json.mkObj [("password", toJson "private")])],
  Json.mkObj [("__proto__", Json.null), ("constructor", toJson ([1] : List Nat))],
  Json.mkObj [("first", toJson true), ("second", Json.null), ("third", toJson (1 : Nat))]
]

def fixtures : Json := Json.mkObj [
  ("pages", toJson (pages.map pageJson)),
  ("metadata", toJson (metadata.map fun value =>
    Json.mkObj [("value", value), ("keyCount", toJson (metadataCount value))]))
]

end BitOVP.StatisticsProjection

def main : IO Unit := IO.println BitOVP.StatisticsProjection.fixtures.compress
