// biome-ignore-all lint/style/noNonNullAssertion: fixed test fixture members
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildPlan, remapEncodingKeyRefs } from "../wizard/build-plan";
import {
	planToWizardState,
	tryImportPresetIntoWizard,
} from "../wizard/plan-to-wizard";
import { audioMixPreset, audioMixStreamSchema } from "./audio-mix";
import { compilePlan } from "./compiler";
import { inputFileSummaries } from "./detail-view";
import { inputStreamLeaves } from "./input-stream-graph";
import { encodingPlanSchema, renditionSchema } from "./schema";
import { planToEncodingTemplateYaml } from "./template";
import { loadPlan } from "./test-support";
import { validatePlan } from "./validate";

function plan() {
	const p = loadPlan("audio-only-aac-fmp4-hls-dash");
	p.ingest.push({
		...p.ingest[0]!,
		key: "second",
		inputPath: "/second.wav",
		position: 1,
	});
	p.audioMixStreams = [
		{
			key: "mix",
			channelLayout: "STEREO",
			audioMixChannels: audioMixPreset("mono", "audio", "second"),
		},
	];
	p.renditions[0]!.ingestKey = "mix";
	return p;
}
describe("AudioMixInputStream", () => {
	it("compiles references in creation order", () => {
		const p = plan();
		expect(validatePlan(p).filter((i) => i.level === "error")).toEqual([]);
		const ops = compilePlan(p);
		const mix = ops.find((o) => o.kind === "CREATE_AUDIO_MIX_INPUT_STREAM")!;
		expect(mix.refs).toEqual({
			encodingId: "encoding",
			source0: "ingest:audio",
			source1: "ingest:second",
		});
		expect(mix.payload).toEqual({
			channelLayout: "STEREO",
			audioMixChannels: [
				{
					outputChannelType: "FRONT_LEFT",
					sourceChannels: [{ type: "CHANNEL_NUMBER", channelNumber: 0 }],
					sourceRef: "source0",
				},
				{
					outputChannelType: "FRONT_RIGHT",
					sourceChannels: [{ type: "CHANNEL_NUMBER", channelNumber: 0 }],
					sourceRef: "source1",
				},
			],
		});
		const emitted = new Set<string>();
		for (const op of ops) {
			for (const ref of Object.values(op.refs).flat())
				expect(emitted.has(ref), ref).toBe(true);
			emitted.add(op.step);
		}
		expect(
			ops.find((o) => o.kind === "CREATE_STREAM")?.refs.inputStreamId,
		).toBe("audioMix:mix");
	});
	it("roundtrips and shows both source files", () => {
		const p = plan();
		const state = planToWizardState(p);
		expect(encodingPlanSchema.parse(buildPlan(state))).toEqual(p);
		expect(tryImportPresetIntoWizard(p).ok).toBe(true);
		expect(inputStreamLeaves(p, "mix")).toEqual(["audio", "second"]);
		expect(inputFileSummaries(p)).toHaveLength(2);
		state.sources!.audioMixStreams![0]!.encodingKey = "before";
		expect(
			remapEncodingKeyRefs(state, "before", "after").sources
				?.audioMixStreams?.[0]?.encodingKey,
		).toBe("after");
	});
	it("preserves zero gain and unset defaults", () => {
		const p = plan();
		p.audioMixStreams[0]!.audioMixChannels[0]!.sourceChannels[0]!.gain = 0;
		delete p.audioMixStreams[0]!.channelLayout;
		expect(validatePlan(p).filter((i) => i.level === "error")).toEqual([]);
		const payload = compilePlan(p).find(
			(o) => o.kind === "CREATE_AUDIO_MIX_INPUT_STREAM",
		)!.payload;
		expect(payload).not.toHaveProperty("channelLayout");
		expect(payload.audioMixChannels).toEqual([
			expect.objectContaining({
				sourceChannels: [{ type: "CHANNEL_NUMBER", channelNumber: 0, gain: 0 }],
			}),
			expect.objectContaining({
				sourceChannels: [{ type: "CHANNEL_NUMBER", channelNumber: 0 }],
			}),
		]);
	});
	it.each(["missing", "mix"])("rejects missing or self source %s", (key) => {
		const p = plan();
		p.audioMixStreams[0]!.audioMixChannels[0]!.sourceKey = key;
		expect(
			validatePlan(p).some(
				(i) => i.level === "error" && i.path?.startsWith("audioMixStreams"),
			),
		).toBe(true);
	});
	it("rejects indirect video, cross encoding and forward refs", () => {
		const p = plan();
		p.ingest[0]!.selectionMode = "VIDEO_RELATIVE";
		p.trimmingStreams = [
			{ key: "trim", kind: "TIME_BASED", sourceKey: "audio" },
		];
		p.audioMixStreams[0]!.audioMixChannels[0]!.sourceKey = "trim";
		expect(
			validatePlan(p).some(
				(i) => i.message === "Audio mix requires audio input streams",
			),
		).toBe(true);
		p.ingest[0]!.selectionMode = "AUTO";
		expect(validatePlan(p).filter((i) => i.level === "error")).toEqual([]);
		p.trimmingStreams[0]!.encodingKey = "other";
		expect(
			validatePlan(p).some((i) => i.code === "PLAN_ENCODING_SOURCE_MISMATCH"),
		).toBe(true);
		p.trimmingStreams[0]!.sourceKey = "mix";
		expect(
			validatePlan(p).some((i) => i.code === "PLAN_INPUTSTREAM_FORWARD_REF"),
		).toBe(true);
	});
	it.each([
		"mix",
		"wrapped",
	])("rejects Dolby Atmos consuming %s audio mix", (sourceKey) => {
		const p = plan();
		p.renditions = [
			renditionSchema.parse({
				key: "a128",
				codec: "DOLBY_ATMOS",
				ingestKey: sourceKey,
				bitrate: 448000,
				rate: 48000,
			}),
		];
		if (sourceKey === "wrapped")
			p.trimmingStreams = [
				{ key: "wrapped", kind: "TIME_BASED", sourceKey: "mix" },
			];
		expect(validatePlan(p)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "PLAN_STREAM_SOURCE_MISMATCH",
					path: "renditions[0].ingestKey",
					level: "error",
				}),
			]),
		);
	});
	it("checks every intermediate node's encoding ownership", () => {
		const p = plan();
		p.encodings = [
			{ key: "a", name: "A" },
			{ key: "b", name: "B" },
		];
		p.ingest = p.ingest.map((s) => ({ ...s, encodingKey: "a" }));
		p.audioMixStreams[0]!.encodingKey = "a";
		p.audioMixStreams[0]!.audioMixChannels[0]!.sourceKey = "trim2";
		p.trimmingStreams = [
			{
				key: "trim1",
				kind: "TIME_BASED",
				sourceKey: "audio",
				encodingKey: "b",
			},
			{
				key: "trim2",
				kind: "TIME_BASED",
				sourceKey: "trim1",
				encodingKey: "a",
			},
		];
		p.renditions[0]!.encodingKey = "a";
		expect(validatePlan(p)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "PLAN_ENCODING_SOURCE_MISMATCH",
					path: "audioMixStreams[0].audioMixChannels[0].sourceKey",
					level: "error",
				}),
			]),
		);
	});
	it("rejects invalid numbers and enums", () => {
		const m = plan().audioMixStreams[0]!;
		expect(
			audioMixStreamSchema.safeParse({ ...m, channelLayout: "INVALID" })
				.success,
		).toBe(false);
		expect(
			audioMixStreamSchema.safeParse({
				...m,
				audioMixChannels: [
					{
						...m.audioMixChannels[0],
						outputChannelType: "CHANNEL_NUMBER",
						outputChannelNumber: 2,
					},
				],
			}).success,
		).toBe(false);
		for (const channel of [
			{ ...m.audioMixChannels[0], outputChannelType: "CHANNEL_NUMBER" },
			{
				...m.audioMixChannels[0],
				sourceChannels: [{ type: "CHANNEL_NUMBER" }],
			},
			{
				...m.audioMixChannels[0],
				sourceChannels: [{ type: "CENTER", gain: Infinity }],
			},
		])
			expect(
				audioMixStreamSchema.safeParse({ ...m, audioMixChannels: [channel] })
					.success,
			).toBe(false);
	});
	it("exports resolvable named template resources", () => {
		const p = plan();
		p.trimmingStreams = [
			{ key: "clip", kind: "TIME_BASED", sourceKey: "audio", duration: 10 },
		];
		p.audioMixStreams[0]!.audioMixChannels[0]!.sourceKey = "clip";
		const tree = parse(planToEncodingTemplateYaml(p));
		expect(
			tree.encodings.main.inputStreams.audioMix.mix.properties
				.audioMixChannels[0].inputStreamId,
		).toBe("$/encodings/main/inputStreams/trimming/timeBased/clip");
		expect(
			tree.encodings.main.inputStreams.trimming.timeBased.clip.properties
				.inputStreamId,
		).toBe("$/encodings/main/inputStreams/ingest/audio");
		expect(tree.encodings.main.streams.a128.properties.inputStreams).toEqual([
			{ inputStreamId: "$/encodings/main/inputStreams/audioMix/mix" },
		]);
	});
});

describe("audio mix processing constraints", () => {
	it("downmix preset uses numbered sources consistently", () => {
		const channels = audioMixPreset("downmix", "surround");
		expect(channels.map((c) => c.sourceChannels.map((s) => s.type))).toEqual([
			Array(3).fill("CHANNEL_NUMBER"),
			Array(3).fill("CHANNEL_NUMBER"),
		]);
		expect(
			channels.map((c) => c.sourceChannels.map((s) => s.channelNumber)),
		).toEqual([
			[0, 2, 4],
			[1, 2, 5],
		]);
	});
	it.each([
		false,
		true,
	])("rejects named and numbered source mixing across rows=%s", (acrossRows) => {
		const mix = plan().audioMixStreams[0]!;
		if (acrossRows)
			mix.audioMixChannels[1]!.sourceChannels = [{ type: "CENTER" }];
		else mix.audioMixChannels[0]!.sourceChannels.push({ type: "CENTER" });
		const result = audioMixStreamSchema.safeParse(mix);
		expect(result.success).toBe(false);
		if (!result.success)
			expect(
				result.error.issues.some((i) => i.message.includes("names or numbers")),
			).toBe(true);
	});
	it.each([
		"STEREO",
		"MONO",
		undefined,
	] as const)("rejects repeated output targets for %s", (layout) => {
		const mix = plan().audioMixStreams[0]!;
		mix.channelLayout = layout;
		const named = layout === "MONO" ? "CENTER" : "FRONT_LEFT";
		mix.audioMixChannels[0]!.outputChannelType = named;
		mix.audioMixChannels[1]!.outputChannelType = named;
		expect(audioMixStreamSchema.safeParse(mix).success).toBe(false);
		if (layout) {
			mix.audioMixChannels[1]!.outputChannelType = "CHANNEL_NUMBER";
			mix.audioMixChannels[1]!.outputChannelNumber = 0;
			const result = audioMixStreamSchema.safeParse(mix);
			expect(result.success).toBe(false);
			if (!result.success)
				expect(
					result.error.issues.some((i) => i.message.includes("only once")),
				).toBe(true);
		}
	});
});
