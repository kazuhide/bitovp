/**
 * The compiler's step-id naming, in one place.
 *
 * Every compiled step is named `<prefix>:<planKey>` (a few carry a second
 * segment). The compiler writes those strings as inline template literals at 28
 * call sites, so anything that wants to JOIN a plan key back to its step —
 * `detail-view.ts` does, to attach runtime resource ids to renditions — had to
 * re-derive the convention and hope it matched.
 *
 * This module is that convention, named. It is deliberately NOT a refactor of
 * the compiler's 28 literals: rewriting them would touch every golden's
 * provenance for no behavioural gain, and the literal is more readable inline.
 * What makes the two sides safe is not shared code but a shared TEST —
 * `step-names.test.ts` compiles all 66 VOD goldens and asserts that for every
 * plan key of every kind, the id this module produces is a step the compiler
 * actually emitted. A drift in either direction fails there rather than
 * silently emptying a column in the UI.
 */

/** Step-id prefixes the detail view joins on. Extend as consumers need them. */
export type StepPrefix =
	| "input"
	| "output"
	| "encoding"
	| "codec"
	| "ingest"
	| "file"
	| "dolby"
	| "concat"
	| "audioMix"
	| "trim"
	| "stream"
	| "stream-filters"
	| "stream-hdr"
	| "muxing"
	| "drm"
	| "qc-muxing"
	| "thumbnail"
	| "sprite"
	| "nexguard"
	| "keyframe";

/**
 * The step id the compiler emits for a plan key.
 *
 * Callers pass the prefix they expect and tolerate a miss — `detail-view`'s
 * runtime join is best-effort by design.
 *
 * An earlier version of this comment claimed trimming streams "are the one shape
 * with no prefix of their own". That is false: `compiler.ts` emits `trim:<key>`
 * uniformly for all three trimming kinds, and `trim` was simply missing from
 * `StepPrefix` — so a consumer wanting a trimming step's id was told by the doc
 * that it did not exist (review finding). All 28 emitted prefixes were then
 * diffed against the declared list; `trim` was the only discrepancy.
 */
export function stepNameFor(prefix: StepPrefix, planKey: string): string {
	return `${prefix}:${planKey}`;
}
