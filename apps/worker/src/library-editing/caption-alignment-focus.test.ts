import {
	type CaptionTimingEvidence,
	type CompositionSourceSegment,
	TRANSCRIPTION_POLICY_FINGERPRINT,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	applyCaptionAlignmentFocus,
	planCaptionAlignmentFocus,
} from "./caption-alignment-focus";

const word = (
	text: string,
	startChar: number,
	endChar: number,
	startUs: number,
	endUs: number,
) => ({ text, startChar, endChar, startUs, endUs, confidence: 0 });
const segment = (
	text: string,
	startUs: number,
	endUs: number,
): CompositionSourceSegment => ({ text, startUs, endUs });
function fixture() {
	const segments = [
		segment("あれ俺", 507220000, 514970000),
		segment("人玉と共に現れ", 617800000, 620830000),
	];
	const raw = (
		index: number,
		tokens: { text: string; startUs: number; endUs: number; p: number }[],
	) => {
		const source = segments[index];
		if (!source) throw new Error("fixture");
		return {
			...source,
			tokens,
			quality: {
				noSpeechProbability: 0,
				meanTokenLogProbability: -0.1,
				speechOverlapUs: 1900000,
				decision: "ADMITTED" as const,
			},
		};
	};
	const token = (text: string, startUs: number, endUs: number) => ({
		text,
		startUs,
		endUs,
		p: 0.9,
	});
	const evidence: CaptionTimingEvidence = {
		mediaSha256: "a".repeat(64),
		modelSha256:
			"394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
		qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
		sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
		transcriptHash: "b".repeat(64),
		rawSegments: [
			raw(0, [
				token("あれ", 507220000, 512570000),
				token("俺", 513640000, 514970000),
			]),
			raw(1, [
				token("人", 617800000, 618980000),
				token("玉", 618980000, 619600000),
				token("と", 619720000, 619880000),
				token("共", 619880000, 620110000),
				token("に", 620110000, 620340000),
				token("現", 620340000, 620570000),
				token("れ", 620570000, 620760000),
			]),
		],
		speechIntervals: [
			{ startUs: 506670000, endUs: 507330000 },
			{ startUs: 511490000, endUs: 511910000 },
			{ startUs: 512270000, endUs: 512810000 },
			{ startUs: 513640000, endUs: 515300000 },
			{ startUs: 614500000, endUs: 617850000 },
			{ startUs: 618980000, endUs: 620990000 },
		],
	};
	return {
		segments,
		captionTimingEvidence: evidence,
		selectedRanges: [
			{ startUs: 507200000, endUs: 516866667 },
			{ startUs: 613266667, endUs: 623200000 },
		],
		sourceOriginUs: 0,
		sourceDurationUs: 700000000,
		mediaSha256: "a".repeat(64),
		language: "ja" as const,
	};
}
function base(): Map<number, CompositionSourceSegment> {
	return new Map([
		[
			0,
			{
				text: "あれ俺",
				startUs: 507180000,
				endUs: 514900000,
				words: [
					word("あれ", 0, 2, 507180000, 513740000),
					word("俺", 2, 3, 513740000, 514900000),
				],
			},
		],
		[
			1,
			{
				text: "人玉と共に現れ",
				startUs: 619000000,
				endUs: 620840000,
				words: [
					word("人玉と", 0, 3, 619000000, 619400000),
					word("共", 3, 4, 619400000, 619500000),
					word("に", 4, 5, 619500000, 620760000),
					word("現れ", 5, 7, 620760000, 620840000),
				],
			},
		],
	]);
}
describe("bounded metadata-driven caption focus", () => {
	it("preplans the long-gap token and a supported suffix without forcing all paragraph143 into one island", () => {
		const f = fixture();
		const before = structuredClone(f);
		const plan = planCaptionAlignmentFocus(f);
		expect(
			plan.candidates.map((c) => [c.kind, c.text, c.startChar, c.endChar]),
		).toEqual([
			["TOKEN_END_ISLAND", "あれ", 0, 2],
			["SUPPORTED_SUFFIX", "に現れ", 4, 7],
		]);
		expect(plan.candidates[0]).toMatchObject({
			startUs: 512020000,
			endUs: 513060000,
			island: { startUs: 512270000, endUs: 512810000 },
		});
		expect(plan.candidates[1]).toMatchObject({
			startUs: 619860000,
			endUs: 621010000,
		});
		expect(f).toEqual(before);
	});
	it("adopts only measured focus words after both concrete base anomalies are confirmed", () => {
		const f = fixture(),
			plan = planCaptionAlignmentFocus(f),
			original = base();
		const focused = new Map([
			["f0", [word("あれ", 0, 2, 512280000, 512590000)]],
			[
				"f1",
				[
					word("に", 4, 5, 620110000, 620340000),
					word("現れ", 5, 7, 620340000, 620760000),
				],
			],
		]);
		const result = applyCaptionAlignmentFocus({
			segments: f.segments,
			base: original,
			candidates: plan.candidates,
			focused,
			selectedRanges: f.selectedRanges,
		});
		expect(result.outcomes.map((o) => o.outcome)).toEqual([
			"ADOPTED",
			"ADOPTED",
		]);
		expect(result.aligned.get(0)?.words?.[0]).toEqual(focused.get("f0")?.[0]);
		expect(result.aligned.get(0)?.words?.[1]).toEqual(
			original.get(0)?.words?.[1],
		);
		expect(result.aligned.get(1)?.words?.slice(0, 2)).toEqual(
			original.get(1)?.words?.slice(0, 2),
		);
		expect(result.aligned.get(1)?.words?.slice(2)).toEqual(focused.get("f1"));
		expect(original).toEqual(base());
	});
	it("keeps valid base output when focus is zero, outside speech, conflicting, or the base is already healthy", () => {
		const f = fixture(),
			plan = planCaptionAlignmentFocus(f);
		for (const words of [
			[word("あれ", 0, 2, 512500000, 512500000)],
			[word("あれ", 0, 2, 512000000, 512200000)],
			[word("あれ", 0, 2, 512280000, 514000000)],
		]) {
			const result = applyCaptionAlignmentFocus({
				segments: f.segments,
				base: base(),
				candidates: plan.candidates.slice(0, 1),
				focused: new Map([["f0", words]]),
				selectedRanges: f.selectedRanges,
			});
			expect(result.outcomes[0]?.outcome).not.toBe("ADOPTED");
			expect(result.aligned).toEqual(base());
		}
		const healthy = base();
		const first = healthy.get(0);
		if (!first?.words) throw new Error("fixture");
		first.words[0] = word("あれ", 0, 2, 512280000, 512590000);
		const result = applyCaptionAlignmentFocus({
			segments: f.segments,
			base: healthy,
			candidates: plan.candidates.slice(0, 1),
			focused: new Map([["f0", [word("あれ", 0, 2, 512300000, 512600000)]]]),
			selectedRanges: f.selectedRanges,
		});
		expect(result.outcomes[0]?.outcome).toBe("ANOMALY_NOT_CONFIRMED");
		expect(result.aligned).toEqual(healthy);
	});
	it("does not split BPE tokens or guess support from an endpoint outside speech", () => {
		const f = fixture();
		const raw = structuredClone(f.captionTimingEvidence.rawSegments);
		const first = raw[0]?.tokens?.[0];
		if (!first) throw new Error("fixture");
		first.p = 0.34;
		expect(
			planCaptionAlignmentFocus({
				...f,
				captionTimingEvidence: { ...f.captionTimingEvidence, rawSegments: raw },
			}).candidates.some((c) => c.kind === "TOKEN_END_ISLAND"),
		).toBe(false);
		first.p = 0.9;
		first.endUs = 512000000;
		expect(
			planCaptionAlignmentFocus({
				...f,
				captionTimingEvidence: { ...f.captionTimingEvidence, rawSegments: raw },
			}).candidates.some((c) => c.kind === "TOKEN_END_ISLAND"),
		).toBe(false);
		expect(() =>
			planCaptionAlignmentFocus({
				...f,
				captionTimingEvidence: {
					...f.captionTimingEvidence,
					mediaSha256: "c".repeat(64),
				},
			}),
		).toThrow();
	});
	it("keeps half-open selected boundaries and source clocks, including nonzero origin", () => {
		const f = fixture();
		const selected = [{ startUs: 507200000, endUs: 512810000 }];
		expect(
			planCaptionAlignmentFocus({ ...f, selectedRanges: selected })
				.candidates[0]?.endUs,
		).toBe(512810000);
		const plan = planCaptionAlignmentFocus({
			...f,
			sourceOriginUs: 500000000,
			sourceDurationUs: 200000000,
		});
		expect(plan.candidates[0]?.startUs).toBe(512020000);
	});
});

it("bounds speculative candidates across runs and skips accepted words without reinterpreting them", () => {
	const f = fixture();
	expect(
		planCaptionAlignmentFocus({ ...f, remainingAudioUs: 0 }).candidates,
	).toEqual([]);
	expect(
		planCaptionAlignmentFocus({ ...f, remainingWindowCount: 0 }).candidates,
	).toEqual([]);
	const segments = structuredClone(f.segments);
	const first = segments[0];
	if (!first) throw new Error("fixture");
	first.words = [
		word("あれ", 0, 2, 512280000, 512590000),
		word("俺", 2, 3, 513740000, 514900000),
	];
	expect(
		planCaptionAlignmentFocus({ ...f, segments }).candidates.map((c) => c.kind),
	).toEqual(["SUPPORTED_SUFFIX"]);
	expect(
		planCaptionAlignmentFocus({
			...f,
			selectedRanges: [...f.selectedRanges].reverse(),
		}).candidates,
	).toEqual(planCaptionAlignmentFocus(f).candidates);
});
it("never borrows neighboring paragraph words or splits a base word to apply a raw-token focus", () => {
	const f = fixture(),
		plan = planCaptionAlignmentFocus(f),
		b = base();
	const first = b.get(0);
	if (!first) throw new Error("fixture");
	first.words = [word("あれ俺", 0, 3, 507180000, 514900000)];
	const result = applyCaptionAlignmentFocus({
		segments: f.segments,
		base: b,
		candidates: plan.candidates.slice(0, 1),
		focused: new Map([["f0", [word("あれ", 0, 2, 512280000, 512590000)]]]),
		selectedRanges: f.selectedRanges,
	});
	expect(result.outcomes[0]?.outcome).toBe("ANOMALY_NOT_CONFIRMED");
	expect(result.aligned).toEqual(b);
});

it("enforces max8 and audio budgets across many independent runs", () => {
	const f = fixture(),
		offsets = Array.from({ length: 9 }, (_, i) => i * 200000000);
	const segments = offsets.flatMap((d) =>
		f.segments.map((s) => ({
			...s,
			startUs: s.startUs + d,
			endUs: s.endUs + d,
		})),
	);
	const rawSegments = offsets.flatMap((d) =>
		f.captionTimingEvidence.rawSegments.map((s) => ({
			...s,
			startUs: s.startUs + d,
			endUs: s.endUs + d,
			tokens: s.tokens?.map((t) => ({
				...t,
				startUs: t.startUs === undefined ? undefined : t.startUs + d,
				endUs: t.endUs === undefined ? undefined : t.endUs + d,
			})),
		})),
	);
	const speechIntervals = offsets.flatMap((d) =>
		f.captionTimingEvidence.speechIntervals.map((s) => ({
			startUs: s.startUs + d,
			endUs: s.endUs + d,
		})),
	);
	const selectedRanges = offsets.flatMap((d) =>
		f.selectedRanges.map((s) => ({
			startUs: s.startUs + d,
			endUs: s.endUs + d,
		})),
	);
	const input = {
		...f,
		sourceDurationUs: 2400000000,
		segments,
		selectedRanges,
		captionTimingEvidence: {
			...f.captionTimingEvidence,
			rawSegments,
			speechIntervals,
		},
	};
	const plan = planCaptionAlignmentFocus(input);
	expect(plan.candidates).toHaveLength(8);
	expect(new Set(plan.candidates.map((c) => c.id)).size).toBe(8);
	const bounded = planCaptionAlignmentFocus({
		...input,
		remainingAudioUs: 1100000,
	});
	expect(bounded.candidates).toHaveLength(1);
	expect(
		bounded.candidates.reduce((n, c) => n + c.endUs - c.startUs, 0),
	).toBeLessThanOrEqual(1100000);
});
it("clips padding before other speech and never focuses a partly unselected island", () => {
	const f = fixture();
	const intervals = [
		...f.captionTimingEvidence.speechIntervals,
		{ startUs: 512950000, endUs: 513100000 },
	].sort((a, b) => a.startUs - b.startUs);
	expect(
		planCaptionAlignmentFocus({
			...f,
			captionTimingEvidence: {
				...f.captionTimingEvidence,
				speechIntervals: intervals,
			},
		}).candidates[0]?.endUs,
	).toBe(512950000);
	expect(
		planCaptionAlignmentFocus({
			...f,
			selectedRanges: [{ startUs: 507200000, endUs: 512600000 }],
		}).candidates.some((c) => c.kind === "TOKEN_END_ISLAND"),
	).toBe(false);
});

it("preserves original UTF16 spans and refuses a BPE token containing multiple audible words", () => {
	const f = fixture(),
		raw = structuredClone(f.captionTimingEvidence.rawSegments),
		segments = structuredClone(f.segments);
	const r = raw[0],
		s = segments[0];
	if (!r?.tokens || !s) throw new Error("fixture");
	r.text = "🙂あれ俺";
	s.text = r.text;
	r.tokens.unshift({
		text: "🙂",
		startUs: 507220000,
		endUs: 507220000,
		p: 0.9,
	});
	expect(
		planCaptionAlignmentFocus({
			...f,
			segments,
			captionTimingEvidence: { ...f.captionTimingEvidence, rawSegments: raw },
		}).candidates[0],
	).toMatchObject({
		text: "あれ",
		startChar: 2,
		endChar: 4,
		rawTokenIndices: [1],
	});
	const combined = fixture(),
		c = structuredClone(combined.captionTimingEvidence.rawSegments);
	const first = c[0];
	if (!first) throw new Error("fixture");
	first.tokens = [
		{ text: "あれ俺", startUs: 507220000, endUs: 514970000, p: 0.9 },
	];
	expect(
		planCaptionAlignmentFocus({
			...combined,
			captionTimingEvidence: {
				...combined.captionTimingEvidence,
				rawSegments: c,
			},
		}).candidates.some((candidate) => candidate.segmentIndex === 0),
	).toBe(false);
});

it("does not count an unchanged short word as improved when its neighbor merely becomes shorter", () => {
	const f = fixture(),
		plan = planCaptionAlignmentFocus(f);
	const result = applyCaptionAlignmentFocus({
		segments: f.segments,
		base: base(),
		candidates: plan.candidates.slice(1),
		focused: new Map([
			[
				"f1",
				[
					word("に", 4, 5, 619860000, 620180000),
					word("現れ", 5, 7, 620340000, 620420000),
				],
			],
		]),
		selectedRanges: f.selectedRanges,
		captionTimingEvidence: f.captionTimingEvidence,
		evidence: plan.evidence,
	});
	expect(result.outcomes[0]?.outcome).toBe("RAW_SUPPORTED_GROUP");
	expect(result.aligned.get(1)?.words?.slice(2)).toEqual([
		word("に現れ", 4, 7, 620110000, 620760000),
	]);
});
it("never turns zero native focus into a raw-token fallback and honors remaining primary text budget", () => {
	const f = fixture(),
		plan = planCaptionAlignmentFocus(f);
	const result = applyCaptionAlignmentFocus({
		segments: f.segments,
		base: base(),
		candidates: plan.candidates.slice(1),
		focused: new Map([["f1", [word("に現れ", 4, 7, 620340000, 620340000)]]]),
		selectedRanges: f.selectedRanges,
		captionTimingEvidence: f.captionTimingEvidence,
		evidence: plan.evidence,
	});
	expect(result.outcomes[0]?.outcome).toBe("ZERO_OR_UNSUPPORTED");
	expect(result.aligned).toEqual(base());
	expect(
		planCaptionAlignmentFocus({ ...f, remainingTextChars: 0 }).candidates,
	).toEqual([]);
	expect(
		planCaptionAlignmentFocus({ ...f, remainingTextChars: 2 }).candidates.map(
			(c) => c.text,
		),
	).toEqual(["あれ"]);
});

it("revalidates raw proof and rejects a conflicting raw group rather than padding its timing", () => {
	const f = fixture(),
		plan = planCaptionAlignmentFocus(f),
		focus = new Map([
			[
				"f1",
				[
					word("に", 4, 5, 619860000, 620180000),
					word("現れ", 5, 7, 620340000, 620420000),
				],
			],
		]);
	const raw = structuredClone(f.captionTimingEvidence.rawSegments);
	const token = raw[1]?.tokens?.[5];
	if (!token) throw new Error("fixture");
	token.p = 0.1;
	const result = applyCaptionAlignmentFocus({
		segments: f.segments,
		base: base(),
		candidates: plan.candidates.slice(1),
		focused: focus,
		selectedRanges: f.selectedRanges,
		captionTimingEvidence: { ...f.captionTimingEvidence, rawSegments: raw },
		evidence: plan.evidence,
	});
	expect(result.outcomes[0]?.outcome).toBe("ZERO_OR_UNSUPPORTED");
	expect(result.aligned).toEqual(base());
	const conflicting = base(),
		prior = conflicting.get(1)?.words?.[1];
	if (!prior) throw new Error("fixture");
	prior.endUs = 620300000;
	const collision = applyCaptionAlignmentFocus({
		segments: f.segments,
		base: conflicting,
		candidates: plan.candidates.slice(1),
		focused: focus,
		selectedRanges: f.selectedRanges,
		captionTimingEvidence: f.captionTimingEvidence,
		evidence: plan.evidence,
	});
	expect(collision.outcomes[0]?.outcome).toBe("CONFLICT");
	expect(collision.aligned).toEqual(conflicting);
});
