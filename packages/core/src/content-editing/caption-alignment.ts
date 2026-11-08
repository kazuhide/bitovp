import { z } from "zod";
import {
	transcriptionRawSegmentSchema,
	transcriptionSpeechIntervalSchema,
} from "../content-production/transcription-quality";
import type { CompositionSourceSegment } from "./composition-evidence";

/** Caption-only timing. Sealed ASR and semantic input retain their identities. */
export const CAPTION_ALIGNMENT_POLICY = {
	version: "qwen3-caption-alignment-v7",
	engine: "qwen-asr",
	device: "cpu",
	dtype: "bfloat16",
	engineVersion: "0.0.6",
	transformersVersion: "4.57.6",
	torchVersion: "2.10.0+cpu",
	modelRevision: "c7cbfc2048c462b0d63a45797104fc9db3ad62b7",
	modelWeightsSha256:
		"47831d0e82f96b20e9034dba01a075ee06436654719f6a68289e49f1b65ce0e7",
	modelManifestHash:
		"56bd14afb7a1dc2e8e9b462ff0ad6de028fc565e53567c7edcc3b887f4ff448f",
	textProjection: "unicode-letter-number-ascii-apostrophe-v1",
	alignmentScope: "selected-zero-points-v1",
	zeroDurationDecoding: "anchored-zero-logit-path-v1",
	zeroDurationHandling: "same-paragraph-exact-endpoint-v1",
	confidence: "NOT_REPORTED",
	contextUs: 3_000_000,
	maxWindowUs: 60_000_000,
	maxAudioUs: 240_000_000,
	timeoutMs: 600_000,
	focus: {
		version: "raw-vad-focus-v2",
		contextUs: 250_000,
		maxCandidates: 8,
		maxRawTokens: 3,
		maxChars: 32,
		maxWindowUs: 5_000_000,
		minProbability: 0.35,
		longGapUs: 600_000,
		shortWordMaxUs: 80_000,
		adjacentLongMinUs: 600_000,
		adjacentDurationRatio: 8,
	},
} as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const us = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const elapsed = z
	.number()
	.finite()
	.nonnegative()
	.max(CAPTION_ALIGNMENT_POLICY.timeoutMs);
export const captionTimingEvidenceSchema = z.strictObject({
	sourceTimeDomain: z.literal("ORIGINAL_PRESENTATION_US"),
	mediaSha256: digest,
	modelSha256: digest,
	qualityPolicyFingerprint: digest,
	transcriptHash: digest,
	rawSegments: z.array(transcriptionRawSegmentSchema).max(5000),
	speechIntervals: z.array(transcriptionSpeechIntervalSchema).max(10000),
});
export type CaptionTimingEvidence = Omit<
	z.infer<typeof captionTimingEvidenceSchema>,
	"rawSegments" | "speechIntervals"
> & {
	rawSegments: readonly z.infer<typeof transcriptionRawSegmentSchema>[];
	speechIntervals: readonly z.infer<typeof transcriptionSpeechIntervalSchema>[];
};
const provenanceSchema = captionTimingEvidenceSchema
	.omit({ rawSegments: true, speechIntervals: true })
	.extend({ rawSegmentsHash: digest, speechIntervalsHash: digest });
const windowSchema = z.strictObject({
	startUs: us,
	endUs: us,
	inputTextHash: digest,
	pcmSha256: digest,
});
const common = {
	engineVersion: z.literal(CAPTION_ALIGNMENT_POLICY.engineVersion),
	modelRevision: z.literal(CAPTION_ALIGNMENT_POLICY.modelRevision),
	confidence: z.literal("NOT_REPORTED"),
	mediaSha256: digest,
	inputHash: digest,
	outputHash: digest,
	sourceAudioUs: us.positive().max(CAPTION_ALIGNMENT_POLICY.maxAudioUs),
	modelLoadMs: elapsed,
	alignmentMs: elapsed,
	windows: z.array(windowSchema).min(1).max(80),
};
const measurement = z
	.strictObject({
		windowIndex: us.max(79),
		segmentIndex: us.max(4999),
		startChar: us,
		endChar: us,
		startUs: us,
		endUs: us,
	})
	.refine((v) => v.endChar > v.startChar && v.endUs >= v.startUs);
const focusWindow = windowSchema
	.extend({
		id: z.string().regex(/^f[0-7]$/),
		nativeWindowIndex: us.max(79),
		kind: z.enum(["TOKEN_END_ISLAND", "SUPPORTED_SUFFIX"]),
		segmentIndex: us.max(4999),
		startChar: us,
		endChar: us,
		rawSegmentIndex: us.max(4999),
		rawTokenIndices: z.array(us.max(1023)).min(1).max(3),
		outcome: z.enum([
			"ADOPTED",
			"ANOMALY_NOT_CONFIRMED",
			"ZERO_OR_UNSUPPORTED",
			"CONFLICT",
		]),
	})
	.refine(
		(v) =>
			v.endChar > v.startChar &&
			v.endChar - v.startChar <= CAPTION_ALIGNMENT_POLICY.focus.maxChars &&
			new Set(v.rawTokenIndices).size === v.rawTokenIndices.length,
	);
function checkWindows(
	receipt: {
		windows: z.infer<typeof windowSchema>[];
		sourceAudioUs: number;
		focusWindows?: { startUs: number; endUs: number }[];
	},
	ctx: z.RefinementCtx,
) {
	let previousEnd = -1;
	let duration = 0n;
	for (const w of receipt.windows) {
		if (
			w.startUs < previousEnd ||
			w.endUs <= w.startUs ||
			w.endUs - w.startUs > CAPTION_ALIGNMENT_POLICY.maxWindowUs
		)
			ctx.addIssue({
				code: "custom",
				message: "Expected ordered bounded primary alignment windows",
			});
		previousEnd = w.endUs;
		duration += BigInt(w.endUs) - BigInt(w.startUs);
	}
	for (const w of receipt.focusWindows ?? []) {
		if (
			w.endUs <= w.startUs ||
			w.endUs - w.startUs > CAPTION_ALIGNMENT_POLICY.focus.maxWindowUs
		)
			ctx.addIssue({
				code: "custom",
				message: "Expected bounded focus alignment windows",
			});
		duration += BigInt(w.endUs) - BigInt(w.startUs);
	}
	if (duration !== BigInt(receipt.sourceAudioUs))
		ctx.addIssue({
			code: "custom",
			message: "Alignment audio budget must match primary and focus windows",
		});
}
/** Historical successful outputs remain readable; fresh generation uses current schema only. */
const legacyCaptionAlignmentReceiptSchema = z
	.strictObject({
		...common,
		version: z.literal("qwen3-caption-alignment-v5"),
		modelManifestHash: z.enum([
			"56bd14afb7a1dc2e8e9b462ff0ad6de028fc565e53567c7edcc3b887f4ff448f",
			"a6aca0028948f61eeee609020c9f85a4b327fd345d647667857a6a9be13e5402",
		]),
	})
	.superRefine(checkWindows);
const legacyV6CaptionAlignmentReceiptSchema = z
	.strictObject({
		...common,
		version: z.literal("qwen3-caption-alignment-v6"),
		baseOutputHash: digest,
		modelManifestHash: z.literal(CAPTION_ALIGNMENT_POLICY.modelManifestHash),
		evidence: provenanceSchema.optional(),
		focusWindows: z
			.array(focusWindow)
			.max(CAPTION_ALIGNMENT_POLICY.focus.maxCandidates),
		measurements: z.strictObject({
			base: z.array(measurement).max(30000),
			focus: z.array(measurement).max(30000),
			final: z.array(measurement).max(30000),
		}),
	})
	.superRefine((r, ctx) => {
		checkWindows(r, ctx);
		if (r.evidence && r.evidence.mediaSha256 !== r.mediaSha256)
			ctx.addIssue({
				code: "custom",
				message: "Expected source-bound timing provenance",
			});
		if (
			r.windows.length + r.focusWindows.length > 80 ||
			new Set(r.focusWindows.map((w) => w.id)).size !== r.focusWindows.length ||
			r.focusWindows.some(
				(w, i) => w.nativeWindowIndex !== r.windows.length + i,
			) ||
			(r.focusWindows.length && !r.evidence)
		)
			ctx.addIssue({
				code: "custom",
				message: "Expected bound unique focus windows",
			});
		const bounds = new Map(r.windows.map((w, i) => [i, w]));
		for (const w of r.focusWindows) bounds.set(w.nativeWindowIndex, w);
		for (const kind of ["base", "focus", "final"] as const)
			for (const m of r.measurements[kind]) {
				const w = bounds.get(m.windowIndex);
				const f = r.focusWindows.find(
					(f) => f.nativeWindowIndex === m.windowIndex,
				);
				if (
					!w ||
					m.startUs < w.startUs ||
					m.endUs > w.endUs ||
					(kind === "base" && m.windowIndex >= r.windows.length) ||
					(kind === "focus" && m.windowIndex < r.windows.length) ||
					(kind === "final" && m.endUs <= m.startUs) ||
					(f &&
						(m.segmentIndex !== f.segmentIndex ||
							m.startChar < f.startChar ||
							m.endChar > f.endChar ||
							(kind === "final" && f.outcome !== "ADOPTED")))
				)
					ctx.addIssue({
						code: "custom",
						message: "Expected exact bounded alignment measurement",
					});
			}
	});

const currentFocusWindow = z
	.strictObject({
		...focusWindow.shape,
		rawStartUs: us,
		rawEndUs: us,
		outcome: z.enum([
			"ADOPTED",
			"ANOMALY_NOT_CONFIRMED",
			"ZERO_OR_UNSUPPORTED",
			"CONFLICT",
			"RAW_SUPPORTED_GROUP",
		]),
	})
	.refine(
		(v) =>
			v.endChar > v.startChar &&
			v.endChar - v.startChar <= CAPTION_ALIGNMENT_POLICY.focus.maxChars &&
			v.rawEndUs > v.rawStartUs &&
			new Set(v.rawTokenIndices).size === v.rawTokenIndices.length,
	);
const nativeMeasurement = z
	.strictObject({
		...measurement.shape,
		timingSource: z.enum(["MODEL_BASE", "MODEL_FOCUS"]),
	})
	.refine((v) => v.endChar > v.startChar && v.endUs >= v.startUs);
const rawGroupMeasurement = z
	.strictObject({
		timingSource: z.literal("ASR_TOKEN_GROUP"),
		focusId: z.string().regex(/^f[0-7]$/),
		segmentIndex: us.max(4999),
		startChar: us,
		endChar: us,
		startUs: us,
		endUs: us,
	})
	.refine((v) => v.endChar > v.startChar && v.endUs > v.startUs);
const finalMeasurement = z.union([nativeMeasurement, rawGroupMeasurement]);
export const currentCaptionAlignmentReceiptSchema = z
	.strictObject({
		...common,
		version: z.literal(CAPTION_ALIGNMENT_POLICY.version),
		baseOutputHash: digest,
		modelManifestHash: z.literal(CAPTION_ALIGNMENT_POLICY.modelManifestHash),
		evidence: provenanceSchema.optional(),
		focusWindows: z
			.array(currentFocusWindow)
			.max(CAPTION_ALIGNMENT_POLICY.focus.maxCandidates),
		measurements: z.strictObject({
			base: z.array(nativeMeasurement).max(30000),
			focus: z.array(nativeMeasurement).max(30000),
			final: z.array(finalMeasurement).max(30000),
		}),
	})
	.superRefine((r, ctx) => {
		checkWindows(r, ctx);
		if (r.evidence && r.evidence.mediaSha256 !== r.mediaSha256)
			ctx.addIssue({
				code: "custom",
				message: "Expected source-bound timing provenance",
			});
		if (
			r.windows.length + r.focusWindows.length > 80 ||
			new Set(r.focusWindows.map((w) => w.id)).size !== r.focusWindows.length ||
			r.focusWindows.some(
				(w, i) => w.nativeWindowIndex !== r.windows.length + i,
			) ||
			(r.focusWindows.length && !r.evidence)
		)
			ctx.addIssue({
				code: "custom",
				message: "Expected bound unique focus windows",
			});
		const bounds = new Map(r.windows.map((w, i) => [i, w]));
		for (const w of r.focusWindows) bounds.set(w.nativeWindowIndex, w);
		for (const kind of ["base", "focus", "final"] as const)
			for (const m of r.measurements[kind]) {
				if (m.timingSource === "ASR_TOKEN_GROUP") {
					const f = r.focusWindows.find((f) => f.id === m.focusId);
					if (
						kind !== "final" ||
						!f ||
						f.kind !== "SUPPORTED_SUFFIX" ||
						f.outcome !== "RAW_SUPPORTED_GROUP" ||
						m.segmentIndex !== f.segmentIndex ||
						m.startChar !== f.startChar ||
						m.endChar !== f.endChar ||
						m.startUs !== f.rawStartUs ||
						m.endUs !== f.rawEndUs ||
						m.startUs < f.startUs ||
						m.endUs > f.endUs
					)
						ctx.addIssue({
							code: "custom",
							message: "Expected exact original raw-token group provenance",
						});
					continue;
				}
				const w = bounds.get(m.windowIndex),
					f = r.focusWindows.find((f) => f.nativeWindowIndex === m.windowIndex);
				if (
					!w ||
					m.startUs < w.startUs ||
					m.endUs > w.endUs ||
					(kind === "base" &&
						(m.windowIndex >= r.windows.length ||
							m.timingSource !== "MODEL_BASE")) ||
					(kind === "focus" &&
						(m.windowIndex < r.windows.length ||
							m.timingSource !== "MODEL_FOCUS")) ||
					(kind === "final" &&
						(m.endUs <= m.startUs ||
							m.timingSource !==
								(m.windowIndex < r.windows.length
									? "MODEL_BASE"
									: "MODEL_FOCUS"))) ||
					(f &&
						(m.segmentIndex !== f.segmentIndex ||
							m.startChar < f.startChar ||
							m.endChar > f.endChar ||
							(kind === "final" && f.outcome !== "ADOPTED")))
				)
					ctx.addIssue({
						code: "custom",
						message: "Expected exact bounded native alignment measurement",
					});
			}
	});
export const captionAlignmentReceiptSchema = z.union([
	currentCaptionAlignmentReceiptSchema,
	legacyV6CaptionAlignmentReceiptSchema,
	legacyCaptionAlignmentReceiptSchema,
]);
export type CaptionAlignmentReceipt = z.infer<
	typeof captionAlignmentReceiptSchema
>;
export type CurrentCaptionAlignmentReceipt = z.infer<
	typeof currentCaptionAlignmentReceiptSchema
>;
export type CaptionAlignmentMeasurement = z.infer<typeof nativeMeasurement>;
export type CaptionAlignmentFinalMeasurement = z.infer<typeof finalMeasurement>;
/** Pure adoption guard. Original paragraph indices may differ from compact output indices. */
export function matchesFinalCaptionAlignmentMeasurements(
	receipt: CurrentCaptionAlignmentReceipt,
	segments: readonly CompositionSourceSegment[],
): boolean {
	const nativeByKey = new Map<string, CaptionAlignmentMeasurement[]>(),
		cursors = new Map<string, number>();
	const key = (m: CaptionAlignmentMeasurement) =>
		`${m.timingSource}:${m.windowIndex}:${m.segmentIndex}`;
	for (const m of [
		...receipt.measurements.base,
		...receipt.measurements.focus,
	]) {
		const k = key(m),
			rows = nativeByKey.get(k) ?? [],
			prior = rows.at(-1);
		if (prior && (prior.endChar > m.startChar || prior.endUs > m.startUs))
			return false;
		rows.push(m);
		nativeByKey.set(k, rows);
	}
	const groups: (typeof receipt.measurements.final)[] = [];
	let previous = -1;
	for (const m of receipt.measurements.final) {
		if (m.segmentIndex < previous) return false;
		if (m.segmentIndex !== previous) groups.push([]);
		groups.at(-1)?.push(m);
		previous = m.segmentIndex;
	}
	if (groups.length !== segments.length) return false;
	for (const [index, group] of groups.entries()) {
		const segment = segments[index],
			words = segment?.words ?? [];
		if (!segment || words.length !== group.length || !words.length)
			return false;
		if (
			segment.startUs !== words[0]?.startUs ||
			segment.endUs !== words.at(-1)?.endUs
		)
			return false;
		for (const [i, m] of group.entries()) {
			const word = words[i],
				prior = words[i - 1];
			if (
				!word ||
				word.startChar !== m.startChar ||
				word.endChar !== m.endChar ||
				word.startUs !== m.startUs ||
				word.endUs !== m.endUs ||
				word.text !== segment.text.slice(m.startChar, m.endChar) ||
				m.endUs <= m.startUs ||
				(prior && (prior.endChar > m.startChar || prior.endUs > m.startUs))
			)
				return false;
			if (m.timingSource === "ASR_TOKEN_GROUP") continue;
			const k = key(m),
				rows = nativeByKey.get(k) ?? [];
			let from = cursors.get(k) ?? 0;
			while (from < rows.length && (rows[from]?.endChar ?? 0) <= m.startChar)
				from++;
			let to = from;
			while (to < rows.length && (rows[to]?.startChar ?? Infinity) < m.endChar)
				to++;
			cursors.set(k, to);
			const native = rows.slice(from, to);
			if (
				!native.length ||
				native[0]?.startChar !== m.startChar ||
				native.at(-1)?.endChar !== m.endChar
			)
				return false;
			const anchors = native.filter((n) => n.endUs > n.startUs);
			if (anchors.length !== 1) return false;
			const anchor = anchors[0];
			if (!anchor || anchor.startUs !== m.startUs || anchor.endUs !== m.endUs)
				return false;
			for (const [j, n] of native.entries()) {
				const prev = native[j - 1];
				if (
					prev &&
					/[\p{L}\p{N}']/u.test(segment.text.slice(prev.endChar, n.startChar))
				)
					return false;
				if (
					n !== anchor &&
					(n.startUs !== n.endUs ||
						(n.endChar <= anchor.startChar
							? n.startUs !== anchor.startUs
							: n.startChar >= anchor.endChar
								? n.startUs !== anchor.endUs
								: true))
				)
					return false;
			}
		}
	}
	return true;
}
