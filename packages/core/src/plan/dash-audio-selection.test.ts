import { describe, expect, it } from "vitest";
import { compilePlan } from "./compiler";
import {
	AUDIO_CODECS,
	type EncodingPlan,
	encodingPlanSchema,
	planMuxingSchema,
} from "./schema";
import { loadPlan } from "./test-support";
import { validatePlan } from "./validate";

function fixture(audioKind: "FMP4" | "TS" = "FMP4") {
	const plan = loadPlan("fixed-bitrate-dash-hls-streamcondition-on-aws");
	plan.manifests = plan.manifests.filter((m) => m.kind === "DASH");
	plan.muxings = plan.muxings.map((m) =>
		plan.renditions.some(
			(r) => r.key === m.streamKey && AUDIO_CODECS.has(r.codec),
		)
			? planMuxingSchema.parse({
					key: m.key,
					streamKey: m.streamKey,
					destination: m.destination,
					kind: audioKind,
				})
			: m,
	);
	const dash = plan.manifests[0];
	if (dash?.kind !== "DASH") throw new Error("missing fixture DASH");
	return { plan, dash };
}

function audioIssues(plan: EncodingPlan) {
	return validatePlan(encodingPlanSchema.parse(plan)).filter(
		(i) => i.code === "PLAN_DASH_AUDIO_UNSELECTED",
	);
}

function assertAudioCompiled(plan: EncodingPlan) {
	plan = encodingPlanSchema.parse(plan);
	expect(validatePlan(plan).filter((i) => i.level === "error")).toEqual([]);
	const ops = compilePlan(plan);
	const sets = ops.filter((o) => o.kind === "CREATE_DASH_ADAPTATION_SET_AUDIO");
	expect(sets.length).toBeGreaterThan(0);
	const reps = ops.filter((o) =>
		sets.some((set) => o.refs.adaptationSetId === set.step),
	);
	expect(reps.length).toBeGreaterThan(0);
	for (const rep of reps) {
		const muxing = plan.muxings.find(
			(m) => rep.refs.muxingId === `muxing:${m.key}`,
		);
		expect(muxing).toBeDefined();
		expect(
			plan.renditions.some(
				(r) => r.key === muxing?.streamKey && AUDIO_CODECS.has(r.codec),
			),
		).toBe(true);
	}
}

describe("DASH audio selected population (#193)", () => {
	it.each([
		undefined,
		"FMP4",
	] as const)("rejects TS-only audio with %s audio pin", (pin) => {
		const { plan, dash } = fixture("TS");
		dash.audioMuxingKind = pin;
		expect(audioIssues(plan)).toMatchObject([
			{ level: "error", path: "manifests[0].audioMuxingKind" },
		]);
	});
	it("rejects audio without any muxing instead of silently producing video-only DASH", () => {
		const { plan } = fixture();
		plan.muxings = plan.muxings.filter((m) => !m.streamKey.startsWith("a"));
		expect(audioIssues(plan)).toHaveLength(1);
	});
	it("keeps explicitly selected FMP4 audio with exact representation bindings", () => {
		const { plan, dash } = fixture();
		dash.audioMuxingKind = "FMP4";
		assertAudioCompiled(plan);
	});
	it("does not widen the existing DASH schema to support an explicit TS audio pin", () => {
		const { plan, dash } = fixture("TS");
		const result = encodingPlanSchema.safeParse({
			...plan,
			manifests: [{ ...dash, audioMuxingKind: "TS" }],
		});
		expect(result.success).toBe(false);
		if (!result.success)
			expect(result.error.issues).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						path: ["manifests", 0, "audioMuxingKind"],
					}),
				]),
			);
	});
	it("keeps the default fMP4 audio", () => {
		assertAudioCompiled(fixture().plan);
	});
	it("allows a truly video-only plan", () => {
		const { plan } = fixture();
		plan.renditions = plan.renditions.filter((r) => !AUDIO_CODECS.has(r.codec));
		plan.muxings = plan.muxings.filter((m) =>
			plan.renditions.some((r) => r.key === m.streamKey),
		);
		expect(audioIssues(plan)).toEqual([]);
		expect(
			compilePlan(plan).some(
				(o) => o.kind === "CREATE_DASH_ADAPTATION_SET_AUDIO",
			),
		).toBe(false);
	});
	it("does not require every alternative audio leg to be selected", () => {
		const { plan } = fixture("TS");
		const audio = plan.muxings.find((m) => m.streamKey === "a128");
		if (!audio) throw new Error("missing audio fixture");
		plan.muxings.push(
			planMuxingSchema.parse({
				key: "a128-fmp4",
				streamKey: audio.streamKey,
				destination: audio.destination,
				kind: "FMP4",
			}),
		);
		assertAudioCompiled(plan);
	});
	it("requires actual audio membership with explicit FMP4 adaptation sets", () => {
		const { plan, dash } = fixture();
		dash.audioMuxingKind = "FMP4";
		dash.adaptationSets = [
			{ key: "video", type: "VIDEO" },
			{ key: "audio", type: "AUDIO" },
		];
		for (const r of plan.renditions)
			r.dashSetKey = AUDIO_CODECS.has(r.codec) ? "audio" : "video";
		assertAudioCompiled(plan);
		for (const r of plan.renditions)
			if (AUDIO_CODECS.has(r.codec)) r.dashSetKey = undefined;
		expect(audioIssues(plan)).toHaveLength(1);
	});
	it("ON_DEMAND selects typed MP4 audio rather than segmented fMP4", () => {
		const { plan, dash } = fixture();
		dash.profile = "ON_DEMAND";
		plan.muxings = plan.muxings.map((m) =>
			planMuxingSchema.parse({
				key: m.key,
				streamKey: m.streamKey,
				destination: m.destination,
				kind: "MP4",
				manifestType: "DASH_ON_DEMAND",
				fragmentDuration: 4000,
				filename: `${m.key}.mp4`,
			}),
		);
		assertAudioCompiled(plan);
		plan.muxings = plan.muxings.map((m) =>
			m.streamKey.startsWith("a")
				? planMuxingSchema.parse({
						key: m.key,
						streamKey: m.streamKey,
						destination: m.destination,
						kind: "FMP4",
					})
				: m,
		);
		expect(audioIssues(plan)).toHaveLength(1);
	});
	it("POST_ENCODING per-title expansion does not hide unselected static audio", () => {
		const plan = loadPlan("pertitle-h264-fmp4-ts-dash-hls-on-aws");
		plan.manifests = plan.manifests.filter((m) => m.kind === "DASH");
		assertAudioCompiled(plan);
		expect(
			compilePlan(plan).some(
				(o) => o.kind === "CREATE_DASH_PER_TITLE_REPRESENTATIONS",
			),
		).toBe(true);
		plan.muxings = plan.muxings.filter(
			(m) =>
				!(
					m.kind === "FMP4" &&
					plan.renditions.some(
						(r) => r.key === m.streamKey && AUDIO_CODECS.has(r.codec),
					)
				),
		);
		expect(audioIssues(plan)).toHaveLength(1);
	});
});
