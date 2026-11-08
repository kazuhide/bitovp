import { describe, expect, it } from "vitest";
import {
	CAPTION_ALIGNMENT_POLICY,
	captionAlignmentReceiptSchema,
	captionTimingEvidenceSchema,
	currentCaptionAlignmentReceiptSchema,
	matchesFinalCaptionAlignmentMeasurements,
} from "./caption-alignment";

const receipt = () => ({
	version: "qwen3-caption-alignment-v5",
	engineVersion: "0.0.6",
	modelRevision: "c7cbfc2048c462b0d63a45797104fc9db3ad62b7",
	confidence: "NOT_REPORTED",
	modelManifestHash: CAPTION_ALIGNMENT_POLICY.modelManifestHash,
	mediaSha256: "b".repeat(64),
	inputHash: "c".repeat(64),
	outputHash: "d".repeat(64),
	sourceAudioUs: 10_000_000,
	modelLoadMs: 500,
	alignmentMs: 750,
	windows: [
		{
			startUs: 507_000_000,
			endUs: 517_000_000,
			inputTextHash: "e".repeat(64),
			pcmSha256: "f".repeat(64),
		},
	],
});

describe("caption-only alignment evidence", () => {
	it("separately identifies the pinned aligner, source, input and output", () => {
		expect(captionAlignmentReceiptSchema.parse(receipt())).toEqual(receipt());
		expect(CAPTION_ALIGNMENT_POLICY.contextUs).toBe(3_000_000);
	});

	it("identifies anchored zero-logit BF16 timing and rejects prior receipt identities", () => {
		expect(CAPTION_ALIGNMENT_POLICY).toMatchObject({
			version: "qwen3-caption-alignment-v7",
			device: "cpu",
			dtype: "bfloat16",
			alignmentScope: "selected-zero-points-v1",
			zeroDurationDecoding: "anchored-zero-logit-path-v1",
			zeroDurationHandling: "same-paragraph-exact-endpoint-v1",
		});
		for (const old of [
			{ version: "qwen3-caption-alignment-v1" },
			{ version: "qwen3-caption-alignment-v2" },
			{ version: "qwen3-caption-alignment-v3" },
			{ version: "qwen3-caption-alignment-v4" },
			{
				modelManifestHash:
					"7fe6893e3258a61df11754b065b611842fb8a73cc006655e4d4b51a3944036d0",
			},
			{
				modelManifestHash:
					"a404fe470396d62f32cdd45029d98689d9ba3413793b6f5afefee0a6bec8c2e8",
			},
		])
			expect(
				captionAlignmentReceiptSchema.safeParse({ ...receipt(), ...old })
					.success,
			).toBe(false);
	});

	it.each([
		"engineVersion",
		"modelRevision",
		"modelManifestHash",
	] as const)("rejects a changed %s rather than reinterpreting an old receipt", (key) => {
		expect(
			captionAlignmentReceiptSchema.safeParse({
				...receipt(),
				[key]: "changed",
			}).success,
		).toBe(false);
	});

	it("rejects a forged audio budget and overlapping or excessive windows", () => {
		expect(
			captionAlignmentReceiptSchema.safeParse({
				...receipt(),
				sourceAudioUs: 1,
			}).success,
		).toBe(false);
		const item = receipt().windows[0];
		if (!item) throw new Error("Missing authored window");
		expect(
			captionAlignmentReceiptSchema.safeParse({
				...receipt(),
				windows: [item, item],
				sourceAudioUs: 20_000_000,
			}).success,
		).toBe(false);
		expect(
			captionAlignmentReceiptSchema.safeParse({
				...receipt(),
				sourceAudioUs: 60_000_001,
				windows: [{ ...item, endUs: item.startUs + 60_000_001 }],
			}).success,
		).toBe(false);
	});

	it("rejects missing hashes, unbounded timings, and unrecorded evidence fields", () => {
		expect(
			captionAlignmentReceiptSchema.safeParse({ ...receipt(), outputHash: "" })
				.success,
		).toBe(false);
		expect(
			captionAlignmentReceiptSchema.safeParse({
				...receipt(),
				alignmentMs: Infinity,
			}).success,
		).toBe(false);
		expect(
			captionAlignmentReceiptSchema.safeParse({
				...receipt(),
				inferredWordConfidence: 1,
			}).success,
		).toBe(false);
	});
});

describe("v6 focus receipt compatibility", () => {
	it("reads the two pinned v5 receipts but never accepts them as fresh v6 output", () => {
		for (const modelManifestHash of [
			"56bd14afb7a1dc2e8e9b462ff0ad6de028fc565e53567c7edcc3b887f4ff448f",
			"a6aca0028948f61eeee609020c9f85a4b327fd345d647667857a6a9be13e5402",
		]) {
			const old = { ...receipt(), modelManifestHash };
			expect(captionAlignmentReceiptSchema.parse(old)).toEqual(old);
			expect(currentCaptionAlignmentReceiptSchema.safeParse(old).success).toBe(
				false,
			);
		}
	});
	it("requires v6 focus provenance and counts overlapping focus audio separately", () => {
		const primary = receipt().windows[0];
		if (!primary) throw new Error("fixture");
		const current = {
			...receipt(),
			version: "qwen3-caption-alignment-v7",
			baseOutputHash: "1".repeat(64),
			focusWindows: [],
			measurements: { base: [], focus: [], final: [] },
		};
		expect(currentCaptionAlignmentReceiptSchema.parse(current)).toEqual(
			current,
		);
		const focus = {
			...primary,
			startUs: 512_000_000,
			endUs: 513_000_000,
			id: "f0",
			nativeWindowIndex: 1,
			kind: "TOKEN_END_ISLAND",
			segmentIndex: 0,
			startChar: 0,
			endChar: 2,
			rawSegmentIndex: 0,
			rawTokenIndices: [0],
			rawStartUs: 512200000,
			rawEndUs: 512600000,
			outcome: "ANOMALY_NOT_CONFIRMED",
		};
		expect(
			currentCaptionAlignmentReceiptSchema.safeParse({
				...current,
				focusWindows: [focus],
			}).success,
		).toBe(false);
		expect(
			currentCaptionAlignmentReceiptSchema.safeParse({
				...current,
				sourceAudioUs: 11_000_000,
				focusWindows: [focus],
				evidence: {
					sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
					mediaSha256: receipt().mediaSha256,
					modelSha256: "b".repeat(64),
					qualityPolicyFingerprint: "c".repeat(64),
					transcriptHash: "d".repeat(64),
					rawSegmentsHash: "e".repeat(64),
					speechIntervalsHash: "f".repeat(64),
				},
			}).success,
		).toBe(true);
		expect(
			currentCaptionAlignmentReceiptSchema.safeParse({
				...current,
				measurements: undefined,
			}).success,
		).toBe(false);
	});
	it("validates bounded caption-only evidence without requiring a segments-only transcript hash", () => {
		const evidence = {
			sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
			mediaSha256: "a".repeat(64),
			modelSha256: "b".repeat(64),
			qualityPolicyFingerprint: "c".repeat(64),
			transcriptHash: "d".repeat(64),
			rawSegments: [],
			speechIntervals: [],
		};
		expect(captionTimingEvidenceSchema.parse(evidence)).toEqual(evidence);
		expect(
			captionTimingEvidenceSchema.safeParse({
				...evidence,
				sourceTimeDomain: "MEDIA_RELATIVE",
			}).success,
		).toBe(false);
		expect(CAPTION_ALIGNMENT_POLICY.version).toBe("qwen3-caption-alignment-v7");
	});
});

it("matches exact final tuples to segments while preserving legitimate anchored-zero groups", () => {
	const m = {
		windowIndex: 0,
		segmentIndex: 101,
		startChar: 0,
		endChar: 1,
		startUs: 508000000,
		endUs: 508200000,
	};
	const r = {
		...receipt(),
		version: "qwen3-caption-alignment-v7",
		baseOutputHash: "1".repeat(64),
		focusWindows: [],
		measurements: {
			base: [{ ...m, timingSource: "MODEL_BASE" }],
			focus: [],
			final: [{ ...m, timingSource: "MODEL_BASE" }],
		},
	};
	const parsed = currentCaptionAlignmentReceiptSchema.parse(r);
	const segments = [
		{
			text: "俺",
			startUs: m.startUs,
			endUs: m.endUs,
			words: [
				{
					text: "俺",
					startChar: 0,
					endChar: 1,
					startUs: m.startUs,
					endUs: m.endUs,
					confidence: 0,
				},
			],
		},
	];
	expect(matchesFinalCaptionAlignmentMeasurements(parsed, segments)).toBe(true);
	const changed = structuredClone(parsed);
	const first = changed.measurements.final[0];
	if (!first) throw new Error("fixture");
	first.startUs++;
	expect(matchesFinalCaptionAlignmentMeasurements(changed, segments)).toBe(
		false,
	);
	const both = structuredClone(parsed);
	const b = both.measurements.base[0],
		f = both.measurements.final[0];
	if (!b || !f) throw new Error("fixture");
	b.startUs++;
	f.startUs++;
	expect(matchesFinalCaptionAlignmentMeasurements(both, segments)).toBe(false);
	const group = {
		...parsed,
		measurements: {
			base: [
				{ ...m, timingSource: "MODEL_BASE" as const, endUs: m.startUs },
				{ ...m, timingSource: "MODEL_BASE" as const, startChar: 1, endChar: 2 },
			],
			focus: [],
			final: [{ ...m, timingSource: "MODEL_BASE" as const, endChar: 2 }],
		},
	};
	expect(
		matchesFinalCaptionAlignmentMeasurements(group, [
			{
				text: "あれ",
				startUs: m.startUs,
				endUs: m.endUs,
				words: [
					{
						text: "あれ",
						startChar: 0,
						endChar: 2,
						startUs: m.startUs,
						endUs: m.endUs,
						confidence: 0,
					},
				],
			},
		]),
	).toBe(true);
});

it("reads frozen v6 without source-tag reinterpretation while requiring fresh v7", () => {
	const old = {
		...receipt(),
		version: "qwen3-caption-alignment-v6",
		baseOutputHash: "1".repeat(64),
		focusWindows: [],
		measurements: { base: [], focus: [], final: [] },
	};
	expect(captionAlignmentReceiptSchema.parse(old)).toEqual(old);
	expect(currentCaptionAlignmentReceiptSchema.safeParse(old).success).toBe(
		false,
	);
});
