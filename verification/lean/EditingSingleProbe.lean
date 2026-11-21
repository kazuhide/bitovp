/-
Model of the two frame-clock checks when identity normalization reads both
timestamps from one probe. A stable decode of the same prepared bytes supplies
the same frame observations to both projections. The model takes parsed
nonnegative ticks and microseconds as inputs. It does not verify FFprobe's
writer, floating-point conversion, file identity, or the process error checks.

Run with `lean --run verification/lean/EditingSingleProbe.lean`.
-/
namespace BitOVP.EditingSingleProbe

structure Frame where
  ticks : Nat
  usec : Nat

def checkFrom (check : Nat → α → Bool) (i : Nat) (rows : List α) : Bool :=
  match rows with
  | [] => true
  | row :: rest => check i row && checkFrom check (i + 1) rest

def exactTicks (timeBaseNum timeBaseDen i ticks : Nat) : Bool :=
  decide (ticks * timeBaseNum * 30 = i * timeBaseDen)

def withinTwoUsec (i usec : Nat) : Bool :=
  decide (i * 1000000 ≤ usec * 30 + 60 ∧ usec * 30 ≤ i * 1000000 + 60)

def separateCheck (num den count : Nat) (ticks times : List Nat) : Option (List Nat) :=
  if ticks.length == count && times.length == count &&
      checkFrom (exactTicks num den) 0 ticks && checkFrom withinTwoUsec 0 times
  then some ticks
  else none

def pairedCheck (num den count : Nat) (frames : List Frame) : Option (List Nat) :=
  if frames.length == count &&
      checkFrom (fun i f => exactTicks num den i f.ticks && withinTwoUsec i f.usec) 0 frames
  then some (frames.map Frame.ticks)
  else none

theorem pairedFrameChecks (num den i : Nat) (frames : List Frame) :
    checkFrom (fun j f => exactTicks num den j f.ticks && withinTwoUsec j f.usec) i frames =
      (checkFrom (exactTicks num den) i (frames.map Frame.ticks) &&
        checkFrom withinTwoUsec i (frames.map Frame.usec)) := by
  induction frames generalizing i with
  | nil => rfl
  | cons row rest ih =>
    simp [checkFrom, ih, Bool.and_assoc, Bool.and_left_comm]

/-- With identical observations the old and new gates return the same ordered tick list. -/
theorem pairedPreservesClock (num den count : Nat) (frames : List Frame) :
    pairedCheck num den count frames =
      separateCheck num den count (frames.map Frame.ticks) (frames.map Frame.usec) := by
  simp [pairedCheck, separateCheck, pairedFrameChecks, Bool.and_assoc]

def roundedCfr30Usec (i : Nat) : Nat := (i * 1000000 + 15) / 30

theorem roundedCfr30PassesTimeCheck (i : Nat) :
    withinTwoUsec i (roundedCfr30Usec i) = true := by
  unfold withinTwoUsec roundedCfr30Usec
  apply decide_eq_true
  constructor <;> omega

def firstThree : List Frame := [⟨0, 0⟩, ⟨3000, 33333⟩, ⟨6000, 66667⟩]

example : pairedCheck 1 90000 3 firstThree = some [0, 3000, 6000] := by decide
example : pairedCheck 1 90000 4 firstThree = none := by decide
example : pairedCheck 1 90000 2 [⟨0, 0⟩, ⟨2999, 33333⟩] = none := by decide
example : pairedCheck 1 90000 2 [⟨0, 0⟩, ⟨3000, 33339⟩] = none := by decide

end BitOVP.EditingSingleProbe

open BitOVP.EditingSingleProbe in
def main : IO Unit := do
  IO.println (repr (pairedCheck 1 90000 3 firstThree))
  IO.println (repr (pairedCheck 1 90000 4 firstThree))
  IO.println (repr (pairedCheck 1 90000 2 [⟨0, 0⟩, ⟨2999, 33333⟩]))
  IO.println (repr (pairedCheck 1 90000 2 [⟨0, 0⟩, ⟨3000, 33339⟩]))
