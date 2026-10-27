import { z } from "zod";
import type { CompiledOperation, OperationKind } from "./compiler";

/**
 * Persisted step log = the compiled ops plus execution state. Jobs replay
 * THIS (never recompile mid-flight — schema header contract). Single
 * writer: the orchestrator worker. request/response snapshots are stored
 * redacted (schema CONTRACT comments in prisma).
 */

export const OPERATION_KINDS = [
	"CREATE_INPUT_S3",
	"CREATE_INPUT_AZURE",
	"CREATE_INPUT_HTTPS",
	"CREATE_INPUT_GENERIC_S3",
	"CREATE_INPUT_GCS",
	"CREATE_INPUT_GCS_SERVICE_ACCOUNT",
	"CREATE_INPUT_AKAMAI_NETSTORAGE",
	"CREATE_OUTPUT_S3",
	"CREATE_OUTPUT_AZURE",
	"CREATE_OUTPUT_SFTP",
	"CREATE_OUTPUT_GENERIC_S3",
	"CREATE_OUTPUT_GCS",
	"CREATE_OUTPUT_GCS_SERVICE_ACCOUNT",
	"CREATE_OUTPUT_LIVE_MEDIA_INGEST",
	"CREATE_OUTPUT_AKAMAI_MSL",
	"CREATE_OUTPUT_AKAMAI_NETSTORAGE",
	"CREATE_ENCODING",
	"CREATE_INGEST_INPUT_STREAM",
	"CREATE_FILE_INPUT_STREAM",
	"CREATE_DOLBY_ATMOS_INPUT_STREAM",
	"CREATE_DOLBY_VISION_INPUT_STREAM",
	"CREATE_DOLBY_VISION_METADATA_INPUT_STREAM",
	"CREATE_TRIMMING_TIME_BASED",
	"CREATE_TRIMMING_TIMECODE_TRACK",
	"CREATE_TRIMMING_H264_PICTURE_TIMING",
	"CREATE_CONCATENATION_INPUT_STREAM",
	"CREATE_AUDIO_MIX_INPUT_STREAM",
	"CREATE_CODEC_H264",
	"CREATE_CODEC_H265",
	"CREATE_CODEC_VP9",
	"CREATE_CODEC_AV1",
	"CREATE_CODEC_AAC",
	"CREATE_CODEC_OPUS",
	"CREATE_CODEC_IMSC",

	"CREATE_CODEC_DOLBY_ATMOS",
	"CREATE_CODEC_AC3",
	"CREATE_CODEC_EAC3",
	"CREATE_CODEC_DDPLUS",
	"CREATE_CODEC_DD",
	"CREATE_CODEC_WEBVTT",
	"CREATE_STREAM",
	"CREATE_STREAM_HDR_DOLBY_VISION",
	"CREATE_BURN_IN_SRT",
	"CREATE_DASH_ADAPTATION_SET_SUBTITLE",
	"CREATE_DASH_REPRESENTATION_CHUNKED_TEXT",
	"CREATE_DASH_REPRESENTATION_IMSC",

	"CREATE_FILTER_DEINTERLACE",
	"CREATE_FILTER_EBU_R128_SINGLE_PASS",
	"CREATE_FILTER_AUDIO_VOLUME",
	"CREATE_FILTER_TEXT",
	"CREATE_FILTER_WATERMARK",
	"CREATE_FILTER_ROTATE",
	"CREATE_FILTER_CROP",
	"CREATE_FILTER_SCALE",
	"CREATE_FILTER_DENOISE_HQDN3D",
	"CREATE_FILTER_UNSHARP",

	"CREATE_STREAM_FILTERS",
	"CREATE_KEYFRAME",
	"CREATE_MUXING_FMP4",
	"CREATE_MUXING_CMAF",
	"CREATE_MUXING_MP4",
	"CREATE_MUXING_CHUNKED_TEXT",
	"CREATE_MUXING_TEXT",

	"CREATE_MUXING_TS",
	"CREATE_MUXING_WEBM",
	"CREATE_DRM_CENC",
	"CREATE_DRM_FAIRPLAY",
	"CREATE_DRM_SPEKE",
	"CREATE_KANTAR_WATERMARK",
	"CREATE_NEXGUARD_FILE_MARKER",
	"CREATE_THUMBNAIL",
	"CREATE_SPRITE",
	"CREATE_MANIFEST_HLS",
	"CREATE_HLS_AUDIO_MEDIA",
	"CREATE_HLS_STREAM_INFO",
	"CREATE_HLS_SUBTITLES_MEDIA",
	"CREATE_HLS_IFRAME_PLAYLIST",
	"CREATE_HLS_PER_TITLE_VARIANTS",
	"CREATE_MANIFEST_DASH",
	"CREATE_DASH_PERIOD",
	"CREATE_DASH_ADAPTATION_SET_VIDEO",
	"CREATE_DASH_ADAPTATION_SET_AUDIO",
	"CREATE_DASH_REPRESENTATION_FMP4",
	"CREATE_DASH_REPRESENTATION_CMAF",
	"CREATE_DASH_REPRESENTATION_WEBM",
	"CREATE_MUXING_PROGRESSIVE_WEBM",
	"CREATE_DASH_REPRESENTATION_MP4",
	"CREATE_DASH_PER_TITLE_REPRESENTATIONS",
	"CREATE_DASH_CONTENT_PROTECTION",
	"CREATE_MANIFEST_SMOOTH",
	"CREATE_SMOOTH_REPRESENTATION_MP4",
	"CREATE_SMOOTH_CONTENT_PROTECTION",
	"CREATE_SMOOTH_PER_TITLE_ENTRIES",
	"START_ENCODING",
	"AWAIT_ENCODING",
	"CAPTURE_PER_TITLE_RESULTS",
	"START_MANIFEST_HLS",
	"AWAIT_MANIFEST_HLS",
	"START_MANIFEST_DASH",
	"AWAIT_MANIFEST_DASH",
	"START_MANIFEST_SMOOTH",
	"AWAIT_MANIFEST_SMOOTH",
	// P3 live (compileLiveChannel) — additive, VOD kinds above are frozen.
	"CREATE_INPUT_RTMP",
	"CREATE_INPUT_REDUNDANT_RTMP",
	"CREATE_INPUT_SRT",
	"CREATE_INPUT_ZIXI",
	"CREATE_INPUT_HLS_LIVE",
	"START_LIVE_ENCODING",
	"AWAIT_LIVE_RUNNING",
	// Post-provisioning runtime record (NOT a provisioning step): the worker
	// appends one DONE entry per inserted SCTE-35 cue so the UI confirms the
	// cue fired. status DONE ⇒ the provision/restart replay skips it; carries
	// only cueDuration/manifestIds (secret-free) in payload.
	"SCTE35_CUE",
	"LIVE_AUTO_SHUTDOWN_UPDATE",
	// Fired slate insertion  — same replay-skip discipline;
	// payload carries insertableContentId + durationSeconds only.
	//
	//  took its DONE away. It is appended the moment the schedule
	// POST returns, which is BEFORE anyone knows what the provider did with
	// it — the 2026-08-29 audit's paid run #4 has this entry sitting DONE
	// beside a provider entry in ERROR and a program that never got covered.
	// It now lands RUNNING and one of the three verdict kinds below closes
	// it. It keeps its kind and payload verbatim because the slate
	// idempotency guard reads THIS record to decide whether a provider entry
	// is one of ours: moving it after the confirmation poll would leave a
	// crashed attempt unaccounted for, and the retry would then read the
	// provider's own entry as a stranger and SKIP the cover — the one
	// direction (an uncovered program) the guard exists to prevent.
	"SLATE_INSERTED",
	// The three verdicts , appended once the provider's own
	// scheduled entry is read back. DONE / FAILED / RUNNING respectively —
	// runtime records all, so the replay skips them like their sibling.
	"SLATE_CONFIRMED",
	"SLATE_FAILED",
	"SLATE_UNCONFIRMED",
	// Same shape for out-of-band ESAM (SCTE-250) media points inserted into a
	// RUNNING channel. Split from SCTE35_CUE rather than reusing it: the two
	// signalling paths have different payloads and different Bitmovin endpoints,
	// and a step log that calls an ESAM insertion a "cue" would misreport what
	// the operator did. Payload carries matchTime, the signal count
	// and each signal's offset; the base64 SCTE-35 BINARY is deliberately NOT
	// persisted here — it is already in the C7 audit row, and copying a
	// multi-KB blob into every step-log read costs bytes no reader wants.
	"ESAM_MEDIA_POINT",
] as const;

/**
 * The array above and `OperationKind` (the compiler's union) are ONE contract in
 * two shapes: the union is what the compiler and executor switch on, the array
 * is what `compiledOperationSchema` validates the persisted log against. Adding
 * a kind to only one of them used to be a runtime failure discovered at
 * persistence time — the step log would refuse to parse an op the compiler had
 * just emitted, and nothing in the type system objected.
 *
 * These two conditional types close it in both directions at COMPILE time.
 */
type KindInArray = (typeof OPERATION_KINDS)[number];
const _arrayIsSubsetOfUnion: KindInArray extends OperationKind ? true : never =
	true;
const _unionIsSubsetOfArray: OperationKind extends KindInArray ? true : never =
	true;
void _arrayIsSubsetOfUnion;
void _unionIsSubsetOfArray;

/**
 * Kinds that RECORD something that already happened, rather than describing a
 * step to execute. They are appended post-provisioning and must never be
 * handed to `executeStep` — re-firing them would inject signalling into a
 * live stream a second time.
 *
 * They are NOT all DONE any more : a slate's insertion record
 * lands RUNNING and one of SLATE_CONFIRMED / SLATE_FAILED / SLATE_UNCONFIRMED
 * closes it, the last two with status FAILED. That only makes the rule below
 * more load-bearing than when it was written.
 *
 * This exists because "always DONE" turned out not to be a safe proxy for
 * "never executed" (review catch): the live provision path re-seeds every entry
 * from the RTMP step to the END of the array to PENDING when the account's RTMP
 * input id has changed, and runtime records are appended at the end — so the
 * codebase's own guard revives them. A replay loop must therefore filter on the
 * KIND, which is intrinsic, not on the status, which anything can rewrite.
 *
 * THE enumeration — every other site derives from it rather than restating it.
 *
 * `SLATE_INSERTED` was missing here for its whole life while being declared
 * "same DONE/replay-skip discipline" at its OPERATION_KINDS entry, listed
 * beside the other two in the executor's runtime-record arm, and described by
 * the guard comment above. Three sites named the concept, one of them held the
 * behaviour, and that one was short a member: any channel that had ever fired a
 * slate  wedged permanently on its next Start
 * once the stale-RTMP reset revived the record. The test written for exactly
 * this failure seeded "one of each kind" and seeded two of three.
 *
 * So: restating this list anywhere is the bug. Read it, do not copy it — the
 * executor arm derives from `isRuntimeRecordKind`, and the revival test derives
 * its fixtures from `RUNTIME_RECORD_KINDS`, so a fourth kind is covered by
 * construction rather than by whoever remembers.
 */
/**
 * EVERY operation kind, classified. Exhaustive by TYPE, which is the whole
 * point: `Record<OperationKind, …>` means a kind added to the union without a
 * line here is a COMPILE error, so the next author is asked the runtime-record
 * question instead of being trusted to remember it.
 *
 * The first version of this fix was a hand-written list of the three
 * runtime-record kinds, and review proved it closed the drift in only one
 * direction. Deriving the revival test's fixtures from that list covered kinds
 * that were IN it (downward) and said nothing about a kind that should have
 * been in it and was not (upward) — which is precisely the direction
 * `SLATE_INSERTED` drifted. A reviewer demonstrated it by adding a fourth kind,
 * wiring it through the union, OPERATION_KINDS and the executor, "forgetting"
 * this classification, and watching the whole suite stay green. The two guards
 * that did fire (resource-tree's Record, curl-from-step's endpoint list) ask
 * "did you add a kind", never "is it a runtime record", and are satisfied by a
 * one-word answer that ships the same wedge.
 *
 * So the classification is the source now, and the set is computed from it.
 */
const OPERATION_KIND_EXECUTION = {
	CREATE_INPUT_S3: "executable",
	CREATE_INPUT_AZURE: "executable",
	CREATE_INPUT_HTTPS: "executable",
	CREATE_INPUT_GENERIC_S3: "executable",
	CREATE_INPUT_GCS: "executable",
	CREATE_INPUT_GCS_SERVICE_ACCOUNT: "executable",
	CREATE_INPUT_AKAMAI_NETSTORAGE: "executable",
	CREATE_OUTPUT_S3: "executable",
	CREATE_OUTPUT_AZURE: "executable",
	CREATE_OUTPUT_SFTP: "executable",
	CREATE_OUTPUT_GENERIC_S3: "executable",
	CREATE_OUTPUT_GCS: "executable",
	CREATE_OUTPUT_GCS_SERVICE_ACCOUNT: "executable",
	CREATE_OUTPUT_LIVE_MEDIA_INGEST: "executable",
	CREATE_OUTPUT_AKAMAI_MSL: "executable",
	CREATE_OUTPUT_AKAMAI_NETSTORAGE: "executable",
	CREATE_ENCODING: "executable",
	CREATE_INGEST_INPUT_STREAM: "executable",
	CREATE_FILE_INPUT_STREAM: "executable",
	CREATE_DOLBY_ATMOS_INPUT_STREAM: "executable",
	CREATE_DOLBY_VISION_INPUT_STREAM: "executable",
	CREATE_DOLBY_VISION_METADATA_INPUT_STREAM: "executable",
	CREATE_TRIMMING_TIME_BASED: "executable",
	CREATE_TRIMMING_TIMECODE_TRACK: "executable",
	CREATE_TRIMMING_H264_PICTURE_TIMING: "executable",
	CREATE_CONCATENATION_INPUT_STREAM: "executable",
	CREATE_AUDIO_MIX_INPUT_STREAM: "executable",
	CREATE_CODEC_H264: "executable",
	CREATE_CODEC_H265: "executable",
	CREATE_CODEC_VP9: "executable",
	CREATE_CODEC_AV1: "executable",
	CREATE_CODEC_AAC: "executable",
	CREATE_CODEC_OPUS: "executable",
	CREATE_CODEC_IMSC: "executable",

	CREATE_CODEC_DOLBY_ATMOS: "executable",
	CREATE_CODEC_AC3: "executable",
	CREATE_CODEC_EAC3: "executable",
	CREATE_CODEC_DDPLUS: "executable",
	CREATE_CODEC_DD: "executable",
	CREATE_CODEC_WEBVTT: "executable",
	CREATE_STREAM: "executable",
	CREATE_STREAM_HDR_DOLBY_VISION: "executable",
	CREATE_BURN_IN_SRT: "executable",
	CREATE_DASH_ADAPTATION_SET_SUBTITLE: "executable",
	CREATE_DASH_REPRESENTATION_CHUNKED_TEXT: "executable",
	CREATE_DASH_REPRESENTATION_IMSC: "executable",

	CREATE_FILTER_DEINTERLACE: "executable",
	CREATE_FILTER_EBU_R128_SINGLE_PASS: "executable",
	CREATE_FILTER_AUDIO_VOLUME: "executable",
	CREATE_FILTER_TEXT: "executable",
	CREATE_FILTER_WATERMARK: "executable",
	CREATE_FILTER_ROTATE: "executable",
	CREATE_FILTER_CROP: "executable",
	CREATE_FILTER_SCALE: "executable",
	CREATE_FILTER_DENOISE_HQDN3D: "executable",
	CREATE_FILTER_UNSHARP: "executable",

	CREATE_STREAM_FILTERS: "executable",
	CREATE_KEYFRAME: "executable",
	CREATE_MUXING_FMP4: "executable",
	CREATE_MUXING_CMAF: "executable",
	CREATE_MUXING_MP4: "executable",
	CREATE_MUXING_CHUNKED_TEXT: "executable",
	CREATE_MUXING_TEXT: "executable",

	CREATE_MUXING_TS: "executable",
	CREATE_MUXING_WEBM: "executable",
	CREATE_DRM_CENC: "executable",
	CREATE_DRM_FAIRPLAY: "executable",
	CREATE_DRM_SPEKE: "executable",
	CREATE_KANTAR_WATERMARK: "executable",
	CREATE_NEXGUARD_FILE_MARKER: "executable",
	CREATE_THUMBNAIL: "executable",
	CREATE_SPRITE: "executable",
	CREATE_MANIFEST_HLS: "executable",
	CREATE_HLS_AUDIO_MEDIA: "executable",
	CREATE_HLS_STREAM_INFO: "executable",
	CREATE_HLS_SUBTITLES_MEDIA: "executable",
	CREATE_HLS_IFRAME_PLAYLIST: "executable",
	CREATE_HLS_PER_TITLE_VARIANTS: "executable",
	CREATE_MANIFEST_DASH: "executable",
	CREATE_DASH_PERIOD: "executable",
	CREATE_DASH_ADAPTATION_SET_VIDEO: "executable",
	CREATE_DASH_ADAPTATION_SET_AUDIO: "executable",
	CREATE_DASH_REPRESENTATION_FMP4: "executable",
	CREATE_DASH_REPRESENTATION_CMAF: "executable",
	CREATE_DASH_REPRESENTATION_WEBM: "executable",
	CREATE_MUXING_PROGRESSIVE_WEBM: "executable",
	CREATE_DASH_REPRESENTATION_MP4: "executable",
	CREATE_DASH_PER_TITLE_REPRESENTATIONS: "executable",
	CREATE_DASH_CONTENT_PROTECTION: "executable",
	CREATE_MANIFEST_SMOOTH: "executable",
	CREATE_SMOOTH_REPRESENTATION_MP4: "executable",
	CREATE_SMOOTH_CONTENT_PROTECTION: "executable",
	CREATE_SMOOTH_PER_TITLE_ENTRIES: "executable",
	START_ENCODING: "executable",
	AWAIT_ENCODING: "executable",
	CAPTURE_PER_TITLE_RESULTS: "executable",
	START_MANIFEST_HLS: "executable",
	AWAIT_MANIFEST_HLS: "executable",
	START_MANIFEST_DASH: "executable",
	AWAIT_MANIFEST_DASH: "executable",
	START_MANIFEST_SMOOTH: "executable",
	AWAIT_MANIFEST_SMOOTH: "executable",
	CREATE_INPUT_RTMP: "executable",
	CREATE_INPUT_REDUNDANT_RTMP: "executable",
	CREATE_INPUT_SRT: "executable",
	CREATE_INPUT_ZIXI: "executable",
	CREATE_INPUT_HLS_LIVE: "executable",
	START_LIVE_ENCODING: "executable",
	AWAIT_LIVE_RUNNING: "executable",
	SCTE35_CUE: "runtime-record",
	LIVE_AUTO_SHUTDOWN_UPDATE: "runtime-record",
	SLATE_INSERTED: "runtime-record",
	SLATE_CONFIRMED: "runtime-record",
	SLATE_FAILED: "runtime-record",
	SLATE_UNCONFIRMED: "runtime-record",
	ESAM_MEDIA_POINT: "runtime-record",
	// `satisfies`, NEVER a type annotation. An annotation widens every value to
	// the union, so `RuntimeRecordKind` below resolves to `never` and the whole
	// derivation silently produces an empty set — a mistake this file made for
	// one compile and tsc caught. `satisfies` keeps the literal values AND still
	// requires every OperationKind to appear.
} satisfies Record<OperationKind, "runtime-record" | "executable">;

export type RuntimeRecordKind = {
	[K in OperationKind]: (typeof OPERATION_KIND_EXECUTION)[K] extends "runtime-record"
		? K
		: never;
}[OperationKind];

export const RUNTIME_RECORD_KINDS: ReadonlySet<RuntimeRecordKind> = new Set(
	(Object.keys(OPERATION_KIND_EXECUTION) as OperationKind[]).filter(
		(kind): kind is RuntimeRecordKind =>
			OPERATION_KIND_EXECUTION[kind] === "runtime-record",
	),
);

/**
 * A TYPE PREDICATE, not a boolean. `exec-live.ts` narrows on this before its
 * switch, so without the predicate the switch could no longer carry a `never`
 * default — and that file's header still promises "the default is unreachable
 * by construction". A boolean made that promise true only at runtime; this
 * makes the compiler prove it again (review Suggestion 1).
 */
export function isRuntimeRecordKind(kind: string): kind is RuntimeRecordKind {
	return (RUNTIME_RECORD_KINDS as ReadonlySet<string>).has(kind);
}

export const compiledOperationSchema = z.strictObject({
	step: z.string().min(1),
	kind: z.enum(OPERATION_KINDS),
	payload: z.record(z.string(), z.unknown()),
	refs: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
	/** Deferred-group marker  — see CompiledOperation.phase. */
	phase: z.literal("post-qc").optional(),
});

export const stepStatusSchema = z.enum([
	"PENDING",
	"RUNNING",
	"DONE",
	"FAILED",
]);
export type StepStatus = z.infer<typeof stepStatusSchema>;

export const stepLogEntrySchema = z.strictObject({
	...compiledOperationSchema.shape,
	status: stepStatusSchema,
	/** Bitmovin resource id created by this step (create ops only). */
	resourceId: z.string().optional(),
	/**
	 * Rebuild generation . The live stale-RTMP guard
	 * re-seeds steps to PENDING and re-executes them — the ONE path that
	 * legitimately creates twice from the same step id. Each re-seed bumps
	 * this, and the stamp's step identity becomes `step#attempt`, so a later
	 * failed-create re-look can never adopt the ABANDONED generation's
	 * resource (a zombie encoding frozen onto a stale input). Absent for VOD
	 * and for never-re-seeded live steps.
	 */
	attempt: z.number().int().positive().optional(),
	/** Redacted request/response snapshots (C7). */
	request: z.unknown().optional(),
	response: z.unknown().optional(),
	error: z.string().optional(),
	startedAt: z.string().optional(),
	finishedAt: z.string().optional(),
});

export type StepLogEntry = z.infer<typeof stepLogEntrySchema>;

export const stepLogSchema = z.array(stepLogEntrySchema);

export function initStepLog(ops: CompiledOperation[]): StepLogEntry[] {
	return ops.map((op) => ({ ...op, status: "PENDING" as const }));
}

/**
 * The step id of the plan's ONLY encoding, or null when there is not exactly
 * one.
 *
 * Exists because `"encoding"` is not a reliable stand-in for "the only
 * encoding": a plan that names one encoding explicitly compiles to
 * `encoding:<key>`, since `plan.encodings` carries no `.min(2)`. Keying on the
 * literal id left `EncodingJob.bitmovinEncodingId` null and made every runtime
 * action 409 on an ordinary single-encoding job (review catch).
 *
 * null for a ladder is deliberate, not a fallback: with siblings there is no
 * unambiguous encoding, and denormalizing one of them would point cancel /
 * reprioritize / reschedule / transfer-retry at the wrong one.
 *
 * Structural on purpose — a strict parse must not be able to hide the answer.
 */
export function soleEncodingStepId(stepLog: unknown): string | null {
	if (!Array.isArray(stepLog)) {
		return null;
	}
	// TWO signals, and the rationale I first wrote for this was FALSE. I claimed
	// the worker sees CREATE while a status reader has only AWAIT/START — a
	// reviewer showed there is no such split: the compiler emits both ids from the
	// same `enc.step` in the same loop, and `initStepLog` seeds every op, so a
	// persisted log carries the CREATE entry from the moment the row exists. They
	// cannot disagree by construction.
	//
	// What actually made keying on CREATE alone go red was the TEST FIXTURES —
	// `bitmovin-encoding-status.test.ts` contains no CREATE_ENCODING entries at
	// all, so the suite was measuring its own fixture shape, not caller reality.
	//
	// Both are kept anyway: the refs signal answers for every current caller, and
	// the CREATE signal is the only one that answers for a log with no
	// AWAIT_ENCODING — i.e. a LIVE log, which does not use this helper yet
	// (live-processor keys on `kind === "CREATE_ENCODING"` directly). Converting
	// live is ledgered, and this keeps that conversion from running on an
	// unexercised path.
	const created = new Set<string>();
	const referenced = new Set<string>();
	for (const raw of stepLog) {
		const entry = raw as {
			kind?: unknown;
			step?: unknown;
			refs?: unknown;
		} | null;
		if (!entry || typeof entry !== "object") {
			continue;
		}
		if (entry.kind === "CREATE_ENCODING" && typeof entry.step === "string") {
			created.add(entry.step);
		}
		if (entry.kind === "AWAIT_ENCODING" || entry.kind === "START_ENCODING") {
			const refs = entry.refs as { encodingId?: unknown } | null | undefined;
			if (typeof refs?.encodingId === "string") {
				referenced.add(refs.encodingId);
			}
		}
	}
	// UNION, and this is a revert: I replaced it with an intersection and argued
	// that a union would accept a `refs.encodingId` naming a non-encoding step.
	// That is impossible, and a reviewer proved it by enumeration — whenever the
	// union answers, the intersection answers identically, so intersecting never
	// tightens. It only LOOSENS, in 4 of 16 subset pairs, including
	// `created={dv,sdr}, referenced={dv}`: a ladder log where one sibling's AWAIT
	// carries the ref. The intersection named that sibling as "the sole encoding",
	// which is precisely what the note above forbids — and it would have been
	// denormalized into `EncodingJob.bitmovinEncodingId`, pointing reprioritize and
	// reschedule at the wrong encoding of a ladder.
	//
	// A union of "every id this log mentions" is the honest reading of "is there
	// exactly one encoding here". Anything unexpected in either signal makes the
	// set bigger, which fails closed.
	const steps = new Set([...created, ...referenced]);
	if (steps.size === 1) {
		return (steps.values().next().value as string) ?? null;
	}
	// Null is right for a ladder AND for an inconsistent log, but they are not the
	// same situation and the caller cannot tell them apart — it just renders "no
	// encoding yet" while the encoding exists. Exactly one CREATE entry means this
	// is not a ladder, so say so rather than failing closed in silence.
	if (created.size === 1 && steps.size !== 1) {
		console.warn(
			`[steplog] step log names one encoding (${[...created][0]}) but its status entries reference ${
				[...referenced].join(", ") || "nothing"
			} — treating the encoding as unidentifiable`,
		);
	}
	return null;
}

/**
 * The ERROR-resume reseed : FAILED
 * and RUNNING entries return to PENDING (their error cleared) so the worker
 * resumes instead of recreating; DONE entries keep their resource ids.
 * Extracted (review-190 re-verify N3) because the route and the schedule
 * sweep had verbatim copies — cross-process contracts live in core.
 */
export function reseedFailedSteps(entries: StepLogEntry[]): StepLogEntry[] {
	return entries.map((entry) =>
		entry.status === "FAILED" || entry.status === "RUNNING"
			? { ...entry, status: "PENDING" as const, error: undefined }
			: entry,
	);
}
