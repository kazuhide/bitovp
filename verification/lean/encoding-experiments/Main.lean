import QualitySelection
import Lean.Data.Json

open Lean

namespace BitOVP.QualitySelection

private inductive Evaluation where
  | measured
  | predicted
  deriving FromJson, ToJson

private abbrev JsonObject := Std.TreeMap.Raw String Json

private def readObject (value : Json) (fields : List String) : Except String JsonObject := do
  let object ← value.getObj?
  unless object.all (fun field _ => fields.contains field) do
    throw "unsupported field"
  return object

private def required (object : JsonObject) (field : String)
    (parse : Json → Except String α) : Except String α := do
  let some value := object.get? field | throw s!"{field}: required"
  (parse value).mapError fun message => s!"{field}: {message}"

private def optional (object : JsonObject) (field : String)
    (parse : Json → Except String α) : Except String (Option α) :=
  match object.get? field with
  | none => pure none
  | some value => (some <$> parse value).mapError fun message => s!"{field}: {message}"

private def parseNonblank (value : Json) : Except String String := do
  let string ← value.getStr?
  if string.trimAscii.isEmpty then throw "expected a nonblank string"
  return string

private def parseDigest (value : Json) : Except String String := do
  let string ← value.getStr?
  unless string.utf8ByteSize == 64 && string.toList.all (fun c => c.isDigit || ('a' ≤ c && c ≤ 'f')) do
    throw "expected a lowercase SHA-256 digest"
  return string

private def largestSafeInteger : Nat := 9007199254740991

private def parseNat (value : Json) : Except String Nat := do
  let n ← value.getNat?
  if n > largestSafeInteger then throw "outside the JSON safe integer range"
  return n

private def parseInt (value : Json) : Except String Int := do
  let n ← value.getInt?
  if n.natAbs > largestSafeInteger then throw "outside the JSON safe integer range"
  return n

private def parseDecimal (value : Json) : Except String Nat := do
  let string ← value.getStr?
  let some n := string.toNat? | throw "expected an unsigned decimal string"
  return n

private def parseRate (value : Json) : Except String Rate := do
  let object ← readObject value ["numerator", "denominator"]
  let numerator ← required object "numerator" parseDecimal
  let denominator ← required object "denominator" parseDecimal
  if positive : 0 < denominator then
    return { numerator, denominator, denominatorPositive := positive }
  else
    throw "denominator must be positive"

private def parseCodec (value : Json) : Except String Codec := do
  match ← value.getStr? with
  | "H264" => return .H264
  | "HEVC" => return .HEVC
  | "AV1" => return .AV1
  | "VP9" => return .VP9
  | _ => throw "expected H264, HEVC, AV1, or VP9"

private def parseConstraints (value : Json) : Except String Constraints := do
  let object ← readObject value ["codec", "bitrateLimitBps", "encodeTimeLimitMs", "gopFrames"]
  return {
    codec := ← optional object "codec" parseCodec
    bitrateLimitBps := ← optional object "bitrateLimitBps" parseNat
    encodeTimeLimitMs := ← optional object "encodeTimeLimitMs" parseNat
    gopFrames := ← optional object "gopFrames" parseNat
  }

private def parseTrial (scoringProfileId : String) (value : Json) : Except String Trial := do
  let object ← readObject value
    ["trialId", "codec", "scoringProfileId", "scoreMilli", "rate", "encodeMs", "gopFrames"]
  let rowProfile ← required object "scoringProfileId" parseNonblank
  unless rowProfile == scoringProfileId do throw "scoring profile does not match"
  return {
    trialId := ← required object "trialId" parseNonblank
    codec := ← required object "codec" parseCodec
    scoreMilli := ← optional object "scoreMilli" parseInt
    rate := ← optional object "rate" parseRate
    encodeMs := ← optional object "encodeMs" parseNat
    gopFrames := ← optional object "gopFrames" parseNat
  }

private structure Request where
  evaluation : Evaluation
  scoringProfileId : String
  candidateSetSha256 : String
  constraints : Constraints
  candidates : List Trial

private def parseRequest (value : Json) : Except String Request := do
  let object ← readObject value
    ["schemaVersion", "evaluation", "scoringProfileId", "candidateSetSha256", "constraints", "candidates"]
  let version ← required object "schemaVersion" parseNat
  unless version == 1 do throw "unsupported schemaVersion"
  let evaluation ← required object "evaluation" fromJson?
  let scoringProfileId ← required object "scoringProfileId" parseNonblank
  let candidateSetSha256 ← required object "candidateSetSha256" parseDigest
  let constraints ← required object "constraints" parseConstraints
  let rows ← required object "candidates" Json.getArr?
  let mut candidates := #[]
  let mut trialIds : Std.HashSet String := {}
  let mut i := 0
  for row in rows do
    let trial ← (parseTrial scoringProfileId row).mapError fun msg => s!"candidates[{i}]: {msg}"
    if trialIds.contains trial.trialId then throw s!"candidates[{i}]: duplicate trialId"
    trialIds := trialIds.insert trial.trialId
    candidates := candidates.push trial
    i := i + 1
  return { evaluation, scoringProfileId, candidateSetSha256, constraints, candidates := candidates.toList }

private structure Counts where
  eligibleCount : Nat := 0
  ineligibleCount : Nat := 0
  incompleteCount : Nat := 0

private def Counts.add (counts : Counts) (assessment : Assessment) : Counts :=
  match assessment with
  | .eligible _ => { counts with eligibleCount := counts.eligibleCount + 1 }
  | .ineligible => { counts with ineligibleCount := counts.ineligibleCount + 1 }
  | .incomplete => { counts with incompleteCount := counts.incompleteCount + 1 }

private structure Decision where
  schemaVersion : Nat := 1
  evaluation : Evaluation
  scoringProfileId : String
  candidateSetSha256 : String
  candidateCount : Nat
  eligibleCount : Nat
  ineligibleCount : Nat
  incompleteCount : Nat
  status : String
  trialId? : Option String
  deriving ToJson

private def select (request : Request) : Decision :=
  let counts : Counts := request.candidates.foldl
    (fun counts trial => counts.add (assess request.constraints trial)) {}
  let trialId := (choose request.constraints request.candidates).map (·.trial.trialId)
  {
    evaluation := request.evaluation
    scoringProfileId := request.scoringProfileId
    candidateSetSha256 := request.candidateSetSha256
    candidateCount := request.candidates.length
    eligibleCount := counts.eligibleCount
    ineligibleCount := counts.ineligibleCount
    incompleteCount := counts.incompleteCount
    status := if trialId.isSome then "selected"
      else if counts.incompleteCount > 0 then "insufficient_evidence"
      else "no_feasible_candidate"
    trialId? := trialId
  }

def runCLI (args : List String) : IO UInt32 := do
  let stderr ← IO.getStderr
  unless args.isEmpty do
    stderr.putStrLn "Usage: bitovp-quality-select < request.json"
    return 2
  let input ← (← IO.getStdin).readToEnd
  match Json.parse input >>= parseRequest with
  | .error message =>
    stderr.putStrLn s!"Invalid request: {message}"
    return 2
  | .ok request =>
    IO.println (toJson (select request)).compress
    return 0

end BitOVP.QualitySelection

def main (args : List String) : IO UInt32 := BitOVP.QualitySelection.runCLI args
