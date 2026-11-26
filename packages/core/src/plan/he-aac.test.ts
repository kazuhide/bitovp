import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { compileLiveChannel } from "../live/compiler";
import { liveChannelPlanSchema } from "../live/schema";
import { validateLiveChannel } from "../live/validate";
import { compilePlan } from "./compiler";
import { HE_AAC_CODECS } from "./he-aac";
import { encodingPlanSchema, renditionSchema } from "./schema";
import { planToEncodingTemplateYaml } from "./template";
import { loadPlan } from "./test-support";
import { validatePlan } from "./validate";

const templateSchema = JSON.parse(
	readFileSync(
		join(__dirname, "__fixtures__/bitmovin-encoding-template.schema.json"),
		"utf8",
	),
);
const validateTemplate = new Ajv2020({
	strict: false,
	allErrors: true,
	logger: false,
}).compile(templateSchema);
const identity = { key: "a128", ingestKey: "audio" };
const fields = {
	HE_AAC_V1: { codec: "HE_AAC_V1", bitrate: 128000 },
	HE_AAC_V2: {
		codec: "HE_AAC_V2",
		name: "Japanese stereo",
		bitrate: 64000,
		signaling: "EXPLICIT_PS",
		channelLayout: "CL_STEREO",
		rate: 48000,
	},
} as const;
it.each(
	HE_AAC_CODECS,
)("compiles and exports %s in VOD fMP4 HLS/DASH", (codec) => {
	const config = fields[codec];
	const plan = encodingPlanSchema.parse({
		...loadPlan("audio-only-aac-fmp4-hls-dash"),
		renditions: [{ ...identity, ...config }],
	});
	expect(validatePlan(plan).filter((i) => i.level === "error")).toEqual([]);
	const ops = compilePlan(plan);
	expect(ops.find((op) => op.step === "codec:a128")).toMatchObject({
		kind: `CREATE_CODEC_${codec}`,
	});
	expect(
		ops.find((op) => op.kind === "CREATE_STREAM")?.refs.codecConfigId,
	).toBe("codec:a128");
	const template = parse(planToEncodingTemplateYaml(plan));
	expect(
		validateTemplate(template),
		JSON.stringify(validateTemplate.errors),
	).toBe(true);
	const group = codec === "HE_AAC_V1" ? "heAacV1" : "heAacV2";
	const props = template.configurations.audio[group].a128.properties;
	expect(props).toEqual(
		codec === "HE_AAC_V1"
			? { name: "a128", bitrate: 128000 }
			: {
					name: "Japanese stereo",
					bitrate: 64000,
					signaling: "EXPLICIT_PS",
					channelLayout: "STEREO",
					rate: 48000,
				},
	);
	expect(template.encodings.main.streams.a128.properties.codecConfigId).toBe(
		`$/configurations/audio/${group}/a128`,
	);
	expect(template.manifests.hls.hls.media.audio.a128.properties.muxingId).toBe(
		"$/encodings/main/muxings/fmp4/a128",
	);
	expect(
		ops.some(
			(op) =>
				op.kind === "CREATE_DASH_REPRESENTATION_FMP4" &&
				op.refs.adaptationSetId === "manifest:dash:aset-audio" &&
				op.refs.muxingId === "muxing:a128",
		),
	).toBe(true);
});
it.each([
	["HE_AAC_V1", 128001, undefined],
	["HE_AAC_V2", 64001, undefined],
	["HE_AAC_V2", 0, undefined],
	["HE_AAC_V1", 32000.5, undefined],
	["HE_AAC_V1", 64000, "EXPLICIT_PS"],
])("rejects invalid %s bitrate %s or signaling %s", (codec, bitrate, signaling) => {
	expect(
		renditionSchema.safeParse({ ...identity, codec, bitrate, signaling })
			.success,
	).toBe(false);
});
it.each(
	HE_AAC_CODECS,
)("accepts ordinary %s Live fMP4 and both standalone and muxed HLS TS, but refuses Live HD/CMAF", (codec) => {
	const source = JSON.parse(
		readFileSync(
			join(__dirname, "../live/__fixtures__/live-rtmp-simple.plan.json"),
			"utf8",
		),
	);
	const plan = liveChannelPlanSchema.parse({
		...source,
		renditions: source.renditions.map((r: { codec: string }) =>
			r.codec === "AAC" ? { ...identity, ...fields[codec] } : r,
		),
	});
	expect(validateLiveChannel(plan).filter((i) => i.level === "error")).toEqual(
		[],
	);
	const ops = compileLiveChannel(plan);
	expect(ops.find((op) => op.step === "codec:a128")?.kind).toBe(
		`CREATE_CODEC_${codec}`,
	);
	expect(ops.find((op) => op.step === "stream:a128")?.refs.codecConfigId).toBe(
		"codec:a128",
	);
	for (const standalone of [true, false]) {
		const muxings = plan.muxings
			.filter(
				(m) =>
					m.streamKey === "v1080" || (standalone && m.streamKey === "a128"),
			)
			.map((m) => ({
				key: m.key,
				kind: "TS",
				streamKey: m.streamKey,
				segmentLength: 6,
				segmentNaming: "seg_%number%.ts",
				destination: m.destination,
				...(m.streamKey === "v1080" && !standalone
					? { additionalStreamKeys: ["a128"] }
					: {}),
			}));
		const ts = liveChannelPlanSchema.parse({
			...plan,
			renditions: plan.renditions.filter((r) =>
				["v1080", "a128"].includes(r.key),
			),
			muxings,
			liveManifests: plan.liveManifests.filter((m) => m.kind === "HLS"),
		});
		expect(validateLiveChannel(ts).filter((i) => i.level === "error")).toEqual(
			[],
		);
		expect(
			compileLiveChannel(ts).some((op) => op.kind === "CREATE_MUXING_TS"),
		).toBe(true);
	}
	const hd = {
		...plan,
		start: { ...plan.start, encodingOption: "HD" as const },
	};
	expect(validateLiveChannel(hd).some((i) => i.level === "error")).toBe(true);
	const cmaf = liveChannelPlanSchema.parse({
		...plan,
		muxings: plan.muxings.map((m) =>
			m.streamKey === "a128" ? { ...m, kind: "CMAF" } : m,
		),
	});
	expect(
		validateLiveChannel(cmaf).some(
			(i) => i.code === "LIVE_MUXING_CODEC_MISMATCH",
		),
	).toBe(true);
});
