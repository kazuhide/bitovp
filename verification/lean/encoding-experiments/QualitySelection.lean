import Std

namespace BitOVP.QualitySelection

inductive Codec where
  | H264
  | HEVC
  | AV1
  | VP9
  deriving BEq

/-- The exact bitrate in bits per second. -/
structure Rate where
  numerator : Nat
  denominator : Nat
  denominatorPositive : 0 < denominator

structure Constraints where
  codec : Option Codec
  bitrateLimitBps : Option Nat
  encodeTimeLimitMs : Option Nat
  gopFrames : Option Nat

structure Trial where
  trialId : String
  codec : Codec
  scoreMilli : Option Int
  rate : Option Rate
  encodeMs : Option Nat
  gopFrames : Option Nat

structure ScoredTrial where
  trial : Trial
  scoreMilli : Int

inductive Assessment where
  | eligible (scoreMilli : Int)
  | ineligible
  | incomplete

private def checkConstraint (accept : α → β → Bool) (constraint : Option α)
    (observation : Option β) : Option Bool :=
  match constraint with
  | none => some true
  | some expected => observation.map (accept expected)

def constraintChecks (constraints : Constraints) (trial : Trial) : List (Option Bool) :=
  [checkConstraint (· == ·) constraints.codec (some trial.codec),
   checkConstraint (fun limit rate => decide (rate.numerator ≤ limit * rate.denominator))
     constraints.bitrateLimitBps trial.rate,
   checkConstraint (fun limit ms => decide (ms ≤ limit)) constraints.encodeTimeLimitMs trial.encodeMs,
   checkConstraint (· == ·) constraints.gopFrames trial.gopFrames]

def assess (constraints : Constraints) (trial : Trial) : Assessment :=
  let checks := constraintChecks constraints trial
  if checks.all (· == some true) then
    trial.scoreMilli.elim .incomplete .eligible
  else if checks.contains (some false) then
    .ineligible
  else
    .incomplete

def Admissible (constraints : Constraints) (row : ScoredTrial) : Prop :=
  row.trial.scoreMilli = some row.scoreMilli ∧
    ∀ check ∈ constraintChecks constraints row.trial, check = some true

private theorem assess_eligible_iff (constraints : Constraints) (row : ScoredTrial) :
    assess constraints row.trial = .eligible row.scoreMilli ↔ Admissible constraints row := by
  unfold assess Admissible
  simp only [List.all_eq_true, beq_iff_eq]
  split
  · next passed =>
    constructor
    · intro observed
      refine ⟨?_, passed⟩
      cases scored : row.trial.scoreMilli with
      | none => simp [scored, Option.elim] at observed
      | some value => simpa [scored, Option.elim] using observed
    · intro observed
      rw [observed.1]
      rfl
  · next failed =>
    simp [failed]
    split <;> simp

private def scoreEligible (constraints : Constraints) (trial : Trial) : Option ScoredTrial :=
  match assess constraints trial with
  | .eligible scoreMilli => some { trial, scoreMilli }
  | _ => none

private theorem mem_eligible_iff {constraints : Constraints} {trials : List Trial}
    {row : ScoredTrial} :
    row ∈ trials.filterMap (scoreEligible constraints) ↔
      row.trial ∈ trials ∧ Admissible constraints row := by
  rw [List.mem_filterMap]
  constructor
  · rintro ⟨trial, member, scored⟩
    unfold scoreEligible at scored
    split at scored
    · next score observed =>
      cases scored
      exact ⟨member, (assess_eligible_iff constraints _).mp observed⟩
    · contradiction
  · rintro ⟨member, admissible⟩
    exact ⟨row.trial, member, by
      simp [scoreEligible, (assess_eligible_iff constraints row).mpr admissible]⟩

private def precedesOrTies (a b : ScoredTrial) : Prop :=
  a.scoreMilli < b.scoreMilli ∨
    a.scoreMilli = b.scoreMilli ∧ b.trial.trialId ≤ a.trial.trialId

private instance : LE ScoredTrial := ⟨precedesOrTies⟩

private instance : DecidableLE ScoredTrial := fun a b =>
  inferInstanceAs (Decidable (
    a.scoreMilli < b.scoreMilli ∨
      a.scoreMilli = b.scoreMilli ∧ b.trial.trialId ≤ a.trial.trialId))

private theorem score_le {a b : ScoredTrial} (h : precedesOrTies a b) :
    a.scoreMilli ≤ b.scoreMilli :=
  h.elim Int.le_of_lt (fun equal => Int.le_of_eq equal.1)

private instance : Std.IsLinearPreorder ScoredTrial where
  le_refl a := Or.inr ⟨rfl, Std.le_refl a.trial.trialId⟩
  le_trans a b c ab bc := by
    change precedesOrTies a b at ab
    change precedesOrTies b c at bc
    change precedesOrTies a c
    rcases ab with higherB | ⟨equalAB, idAB⟩
    · exact Or.inl (Int.lt_of_lt_of_le higherB (score_le bc))
    rcases bc with higherC | ⟨equalBC, idBC⟩
    · exact Or.inl (equalAB ▸ higherC)
    exact Or.inr ⟨equalAB.trans equalBC, Std.le_trans idBC idAB⟩
  le_total a b := by
    rcases Int.lt_trichotomy a.scoreMilli b.scoreMilli with higherB | equal | higherA
    · exact Or.inl (Or.inl higherB)
    · rcases Std.le_total (a := a.trial.trialId) (b := b.trial.trialId) with idAB | idBA
      · exact Or.inr (Or.inr ⟨equal.symm, idAB⟩)
      · exact Or.inl (Or.inr ⟨equal, idBA⟩)
    · exact Or.inr (Or.inl higherA)

def choose (constraints : Constraints) (trials : List Trial) : Option ScoredTrial :=
  (trials.filterMap (scoreEligible constraints)).maxOn? id

/-- The winner is admissible and maximal in the supplied set. Equal scores
prefer the lexicographically smaller trial ID. -/
theorem choose_sound {constraints : Constraints} {trials : List Trial} {winner : ScoredTrial}
    (h : choose constraints trials = some winner) :
    winner.trial ∈ trials ∧ Admissible constraints winner ∧
      ∀ row : ScoredTrial, row.trial ∈ trials → Admissible constraints row →
        row.scoreMilli ≤ winner.scoreMilli ∧
          (row.scoreMilli = winner.scoreMilli → winner.trial.trialId ≤ row.trial.trialId) := by
  unfold choose at h
  have picked := mem_eligible_iff.mp (List.maxOn?_mem h)
  refine ⟨picked.1, picked.2, ?_⟩
  intro row member admissible
  have bound := List.le_apply_get_maxOn?_of_mem (f := id)
    (mem_eligible_iff.mpr ⟨member, admissible⟩)
  rw [Option.get_of_eq_some _ h] at bound
  change precedesOrTies row winner at bound
  exact ⟨score_le bound, fun same =>
    bound.elim (fun less => (Int.ne_of_lt less same).elim) And.right⟩

theorem choose_none_iff (constraints : Constraints) (trials : List Trial) :
    choose constraints trials = none ↔
      ∀ row : ScoredTrial, row.trial ∈ trials → ¬ Admissible constraints row := by
  constructor
  · intro empty row member admissible
    have picked := List.isSome_maxOn?_of_mem (f := id)
      (mem_eligible_iff.mpr ⟨member, admissible⟩)
    unfold choose at empty
    rw [empty] at picked
    contradiction
  · intro noCandidate
    cases selection : choose constraints trials with
    | none => rfl
    | some winner =>
      have sound := choose_sound selection
      exact (noCandidate winner sound.1 sound.2.1).elim

end BitOVP.QualitySelection
