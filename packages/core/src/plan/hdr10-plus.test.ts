import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { compilePlan } from "./compiler";
import { curlForStep } from "./curl-from-step";
import { inputFileSummaries } from "./detail-view";
import { inputStreamAncestry, inputStreamLeaves } from "./input-stream-graph";
import { INTERNAL_HEVC_V2_BCF_VERSION } from "./internal-hevc-v2";
import { buildResourceTree } from "./resource-tree";
import { type EncodingPlan, encodingPlanSchema } from "./schema";
import { initStepLog, stepLogEntrySchema } from "./steplog";
import { planToEncodingTemplateYaml } from "./template";
import {
	instantiateTemplatePlan,
	templateSourceSites,
} from "./template-instantiate";
import { validatePlan } from "./validate";

function rawPlan() {
	return {
		planVersion: 1,
		name: "HDR10+ input",
		bitmovin: { encoderVersion: "2.294.0" },
		inputs: [{ key: "in", kind: "HTTPS", host: "media.example.com" }],
		outputs: [
			{
				key: "out",
				kind: "S3",
				bucket: "output",
				credentialId: "00000000-0000-4000-8000-000000000002",
			},
		],
		ingest: [],
		hdr10PlusStreams: [
			{
				key: "picture",
				inputKey: "in",
				videoInputPath: "hdr/video.mp4",
				metadataInputPath: "hdr/metadata.json",
			},
		],
		renditions: [
			{
				key: "v",
				codec: "H265",
				ingestKey: "picture",
				height: 1080,
				bitrate: 4_000_000,
			},
		],
		muxings: [
			{
				key: "v",
				kind: "FMP4",
				streamKey: "v",
				destination: { outputKey: "out", path: "video" },
			},
		],
		manifests: [],
		generation: { timing: "JUST_IN_TIME" },
	};
}

function plan(): EncodingPlan {
	return encodingPlanSchema.parse(rawPlan());
}

function errors(value: EncodingPlan) {
	return validatePlan(value).filter((issue) => issue.level === "error");
}

function first<T>(items: T[]): T {
	const item = items[0];
	if (!item) throw new Error("fixture is empty");
	return item;
}

describe("HDR10+ input contract", () => {
	it.each([
		"videoInputPath",
		"metadataInputPath",
	] as const)("accepts only a storage path in %s", (field) => {
		const raw = rawPlan();
		for (const path of [
			"https://media.example.test/asset",
			"//media.example.test/asset",
			"/archive/asset?parameter=example",
			"/archive/asset#fragment",
			"https://operator@example.test/asset",
		]) {
			const result = encodingPlanSchema.safeParse({
				...raw,
				hdr10PlusStreams: [{ ...raw.hdr10PlusStreams[0], [field]: path }],
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.issues[0]?.path).toEqual([
					"hdr10PlusStreams",
					0,
					field,
				]);
			}
		}
		const stored = "/archive/番組 A/metadata.v1+scene.json";
		const parsed = encodingPlanSchema.parse({
			...raw,
			hdr10PlusStreams: [{ ...raw.hdr10PlusStreams[0], [field]: stored }],
		});
		expect(parsed.hdr10PlusStreams[0]?.[field]).toBe(stored);
	});

	it("defaults selection to AUTO without inventing a position", () => {
		const parsed = plan();
		expect(parsed.hdr10PlusStreams[0]).toMatchObject({ selectionMode: "AUTO" });
		expect(parsed.hdr10PlusStreams[0]).not.toHaveProperty("position");
		expect(errors(parsed)).toEqual([]);
	});

	it.each([
		{ metadataInputPath: undefined },
		{ metadataInputPath: "" },
		{ metadataInputId: "other-input" },
		{ videoInputPath: "" },
		{ selectionMode: "AUDIO_RELATIVE" },
		{ selectionMode: "SUBTITLE_RELATIVE" },
		{ position: 0 },
		{ selectionMode: "VIDEO_RELATIVE", position: -1 },
		{ selectionMode: "POSITION_ABSOLUTE", position: 0.5 },
		{ selectionMode: "POSITION_ABSOLUTE", position: 2_147_483_648 },
	])("rejects invalid source fields %j", (fields) => {
		const raw = rawPlan();
		expect(
			encodingPlanSchema.safeParse({
				...raw,
				hdr10PlusStreams: [{ ...raw.hdr10PlusStreams[0], ...fields }],
			}).success,
		).toBe(false);
	});

	it.each([
		"POSITION_ABSOLUTE",
		"VIDEO_RELATIVE",
	])("preserves %s with an omitted or explicit position", (selectionMode) => {
		const raw = rawPlan();
		for (const position of [undefined, 0, 2_147_483_647]) {
			const parsed = encodingPlanSchema.parse({
				...raw,
				hdr10PlusStreams: [
					{
						...raw.hdr10PlusStreams[0],
						selectionMode,
						...(position === undefined ? {} : { position }),
					},
				],
			});
			expect(parsed.hdr10PlusStreams[0]?.position).toBe(position);
		}
	});

	it("compiles the input before its stream, preserving both paths and AUTO omission", () => {
		const ops = compilePlan(plan());
		const inputIndex = ops.findIndex(
			(op) => op.kind === "CREATE_HDR10_PLUS_INPUT_STREAM",
		);
		expect(inputIndex).toBeGreaterThan(-1);
		expect(ops[inputIndex]).toEqual({
			step: "hdr10-plus:picture",
			kind: "CREATE_HDR10_PLUS_INPUT_STREAM",
			payload: {
				videoInputPath: "hdr/video.mp4",
				metadataInputPath: "hdr/metadata.json",
				selectionMode: "AUTO",
			},
			refs: { encodingId: "encoding", inputId: "input:in" },
		});
		const streamIndex = ops.findIndex((op) => op.step === "stream:v");
		expect(streamIndex).toBeGreaterThan(inputIndex);
		expect(ops[streamIndex]?.refs.inputStreamId).toBe("hdr10-plus:picture");
	});

	it("visits shared concatenation edges once and skips HDR traversal in ordinary template previews", () => {
		const value = plan();
		value.hdr10PlusStreams = [];
		value.ingest = [
			{
				key: "picture",
				inputKey: "in",
				inputPath: "plain.mov",
				selectionMode: "VIDEO_RELATIVE",
				position: 0,
			},
		];
		let reads = 0;
		let parent = "picture";
		for (let i = 0; i < 12; i++) {
			const previous = parent;
			parent = `concat${i}`;
			value.concatenationStreams.push({
				key: parent,
				sources: [0, 1].map((position) => ({
					get sourceKey() {
						reads++;
						return previous;
					},
					position,
					isMain: position === 0,
				})),
			});
		}
		expect(inputStreamLeaves(value, parent)).toEqual(["picture"]);
		expect(reads).toBeLessThanOrEqual(24);
		reads = 0;
		expect(planToEncodingTemplateYaml(value)).toContain("plain.mov");
		expect(reads).toBe(0);
	});

	it("identifies HDR descendants and rejects an unsupported trim at its source", () => {
		const value = plan();
		value.trimmingStreams = [
			{
				key: "trimmed",
				kind: "TIME_BASED",
				sourceKey: "picture",
				offset: 1,
				duration: 3,
			},
		];
		first(value.renditions).ingestKey = "trimmed";
		expect(inputStreamAncestry(value, "trimmed")).toEqual([
			"trimmed",
			"picture",
		]);
		expect(inputStreamLeaves(value, "trimmed")).toEqual(["picture"]);
		expect(errors(value)).toContainEqual(
			expect.objectContaining({
				code: "PLAN_HDR10_PLUS_TRANSFORM",
				path: "trimmingStreams[0].sourceKey",
			}),
		);
		expect(() => planToEncodingTemplateYaml(value)).toThrow(/HDR10/);
	});

	it("checks shared keys and storage references", () => {
		const value = plan();
		value.ingest.push({
			key: "picture",
			inputKey: "in",
			inputPath: "other.mp4",
			selectionMode: "VIDEO_RELATIVE",
			position: 0,
		});
		first(value.hdr10PlusStreams).inputKey = "missing";
		expect(errors(value).map((issue) => issue.code)).toEqual(
			expect.arrayContaining(["PLAN_DUPLICATE_KEY", "PLAN_UNRESOLVED_REF"]),
		);
	});

	it("rejects an undeclared encoding owner before creating the input", () => {
		const value = plan();
		first(value.hdr10PlusStreams).encodingKey = "missing";
		expect(errors(value)).toContainEqual(
			expect.objectContaining({
				code: "PLAN_UNRESOLVED_REF",
				path: "hdr10PlusStreams[0].encodingKey",
			}),
		);
	});

	it("rejects HDR10+ video used by an audio mix even if the mix has no rendition", () => {
		const value = plan();
		value.audioMixStreams = [
			{
				key: "mix",
				audioMixChannels: [
					{
						sourceKey: "picture",
						outputChannelType: "FRONT_LEFT",
						sourceChannels: [{ type: "FRONT_LEFT" }],
					},
				],
			},
		];
		expect(errors(value)).toContainEqual(
			expect.objectContaining({
				code: "PLAN_UNRESOLVED_REF",
				path: "audioMixStreams[0].audioMixChannels[0].sourceKey",
				message: "Audio mix requires audio input streams",
			}),
		);
	});

	it.each([
		"H264",
		"AAC",
		"AV1",
	])("rejects %s consumers through a trimming wrapper", (codec) => {
		const raw = rawPlan();
		const value = encodingPlanSchema.parse({
			...raw,
			trimmingStreams: [
				{
					key: "trimmed",
					kind: "TIME_BASED",
					sourceKey: "picture",
					duration: 3,
				},
			],
			renditions: [
				{
					key: "v",
					codec,
					ingestKey: "trimmed",
					...(codec === "AAC"
						? { bitrate: 128_000, rate: 48_000 }
						: { height: 1080, bitrate: 4_000_000 }),
				},
			],
		});
		expect(errors(value)).toContainEqual(
			expect.objectContaining({
				code: "PLAN_HDR10_PLUS_CODEC",
				path: "renditions[0].ingestKey",
			}),
		);
	});

	it.each([
		"2.293.0",
		"2.293.0-beta",
		"2.292.5",
		"1.999.0",
	])("rejects known old Encoder %s", (encoderVersion) => {
		const value = plan();
		value.bitmovin.encoderVersion = encoderVersion;
		expect(errors(value)).toContainEqual(
			expect.objectContaining({ code: "PLAN_HDR10_PLUS_ENCODER_VERSION" }),
		);
	});

	it.each([
		"2.294.0",
		"2.295.0",
		"3.0.0",
		"BETA",
		"STABLE",
	])("does not forbid supported or unresolved Encoder %s", (encoderVersion) => {
		const value = plan();
		value.bitmovin.encoderVersion = encoderVersion;
		expect(errors(value)).toEqual([]);
	});

	it.each([
		"trim",
		"concat",
	] as const)("requires the %s and its HDR10+ source to share an encoding", (kind) => {
		const value = plan();
		value.encodings = [
			{ key: "a", name: "A" },
			{ key: "b", name: "B" },
		];
		value.generation.timing = "POST_ENCODING";
		first(value.hdr10PlusStreams).encodingKey = "b";
		if (kind === "trim")
			value.trimmingStreams = [
				{
					key: "wrapped",
					kind: "TIME_BASED",
					sourceKey: "picture",
					duration: 3,
					encodingKey: "a",
				},
			];
		else
			value.concatenationStreams = [
				{
					key: "wrapped",
					sources: [{ sourceKey: "picture", position: 0, isMain: true }],
					encodingKey: "a",
				},
			];
		Object.assign(first(value.renditions), {
			encodingKey: "a",
			ingestKey: "wrapped",
		});
		expect(errors(value)).toContainEqual(
			expect.objectContaining({
				code: "PLAN_ENCODING_SOURCE_MISMATCH",
				path:
					kind === "trim"
						? "trimmingStreams[0].sourceKey"
						: "concatenationStreams[0].sources[0].sourceKey",
			}),
		);
		first(value.hdr10PlusStreams).encodingKey = "a";
		expect(errors(value)).toEqual([
			expect.objectContaining({ code: "PLAN_HDR10_PLUS_TRANSFORM" }),
		]);
		expect(() => planToEncodingTemplateYaml(value)).toThrow(/HDR10/);
	});
	it("requires replacing a retained signed HDR object before generating executable YAML", () => {
		const old = plan();
		const stream = old.hdr10PlusStreams[0];
		if (!stream) throw new Error("Missing fixture stream");
		stream.metadataInputPath =
			"//fixture:FIXTURE_PRIVATE@fixture.invalid/sidecar.json";
		expect(() => planToEncodingTemplateYaml(old)).toThrow(
			"Re-select the HDR10+ video and metadata objects",
		);
	});
	it("exports every schema-valid HDR10+ resource key as an own YAML entry", () => {
		const value = plan();
		first(value.hdr10PlusStreams).key = "__proto__";
		first(value.renditions).ingestKey = "__proto__";
		expect(errors(value)).toEqual([]);
		const tree = parse(planToEncodingTemplateYaml(value)).encodings.main;
		expect(Object.hasOwn(tree.inputStreams.hdr10Plus, "__proto__")).toBe(true);
		expect(tree.streams.v.properties.inputStreams[0].inputStreamId).toBe(
			"$/encodings/main/inputStreams/hdr10Plus/__proto__",
		);
	});

	it("uses each source encoding override and rejects cross-encoding consumption", () => {
		const value = plan();
		value.encodings = [
			{ key: "old", name: "old", encoderVersion: "2.293.0" },
			{ key: "new", name: "new", encoderVersion: "2.294.0" },
		];
		value.generation.timing = "POST_ENCODING";
		first(value.hdr10PlusStreams).encodingKey = "old";
		first(value.renditions).encodingKey = "new";
		expect(errors(value).map((issue) => issue.code)).toEqual(
			expect.arrayContaining([
				"PLAN_HDR10_PLUS_ENCODER_VERSION",
				"PLAN_ENCODING_SOURCE_MISMATCH",
			]),
		);
		first(value.hdr10PlusStreams).encodingKey = "new";
		expect(errors(value)).toEqual([]);
		const input = compilePlan(value).find(
			(op) => op.kind === "CREATE_HDR10_PLUS_INPUT_STREAM",
		);
		expect(input?.refs.encodingId).toBe("encoding:new");
	});

	it("rejects Dolby Vision metadata and conflicting output conversion", () => {
		const value = plan();
		const video = value.renditions[0];
		if (video?.codec !== "H265") throw new Error("fixture");
		video.dolbyVisionMetadata = {
			profile: "DVHE_05",
			metadataSource: "EMBEDDED",
		};
		expect(errors(value)).toContainEqual(
			expect.objectContaining({
				code: "PLAN_HDR10_PLUS_DOLBY_VISION_CONFLICT",
			}),
		);
		delete video.dolbyVisionMetadata;
		video.dynamicRangeFormat = "SDR";
		expect(errors(value)).toContainEqual(
			expect.objectContaining({
				code: "PLAN_HDR10_PLUS_DYNAMIC_RANGE_CONFLICT",
			}),
		);
	});

	it.each([
		false,
		true,
	])("preserves the app's SDR-only internal HEVC v2 boundary (trimmed: %s)", (trimmed) => {
		const value = plan();
		value.internal = { hevcV2: { bcfVersion: INTERNAL_HEVC_V2_BCF_VERSION } };
		if (trimmed) {
			value.trimmingStreams = [
				{
					key: "trimmed",
					kind: "TIME_BASED",
					sourceKey: "picture",
					duration: 3,
				},
			];
			first(value.renditions).ingestKey = "trimmed";
		}
		expect(errors(value)).toContainEqual(
			expect.objectContaining({
				code: "PLAN_INTERNAL_HEVC_V2_UNSUPPORTED",
				path: "renditions.0.ingestKey",
			}),
		);
	});

	it("exports a named HDR10+ template resource and references it without a position", () => {
		const yaml = parse(planToEncodingTemplateYaml(plan()));
		expect(
			yaml.encodings.main.inputStreams.hdr10Plus.picture.properties,
		).toEqual({
			inputId: "$/inputs/https/in",
			videoInputPath: "hdr/video.mp4",
			metadataInputPath: "hdr/metadata.json",
			selectionMode: "AUTO",
		});
		expect(yaml.encodings.main.streams.v.properties.inputStreams).toEqual([
			{ inputStreamId: "$/encodings/main/inputStreams/hdr10Plus/picture" },
		]);
	});

	it.each([
		"S3",
		"HTTPS",
	] as const)("keeps the named %s storage object referenced by HDR metadata in exported YAML", (kind) => {
		const value = plan();
		value.inputs = [
			kind === "S3"
				? {
						kind,
						key: "__proto__",
						name: "storage",
						bucket: "bucket",
						credentialId: "00000000-0000-4000-8000-000000000002",
					}
				: { kind, key: "__proto__", name: "storage", host: "example.com" },
		];
		first(value.hdr10PlusStreams).inputKey = "__proto__";
		const yaml = parse(planToEncodingTemplateYaml(value)),
			section = kind.toLowerCase();
		expect(errors(value)).toEqual([]);
		expect(Object.hasOwn(yaml.inputs[section], "__proto__")).toBe(true);
		expect(
			yaml.encodings.main.inputStreams.hdr10Plus.picture.properties.inputId,
		).toBe(`$/inputs/${section}/__proto__`);
	});
	it("retains source positions in template export and compiled payloads", () => {
		const value = plan();
		first(value.hdr10PlusStreams).selectionMode = "VIDEO_RELATIVE";
		first(value.hdr10PlusStreams).position = 2;
		expect(
			compilePlan(value).find(
				(op) => op.kind === "CREATE_HDR10_PLUS_INPUT_STREAM",
			)?.payload,
		).toMatchObject({ selectionMode: "VIDEO_RELATIVE", position: 2 });
		const yaml = parse(planToEncodingTemplateYaml(value));
		expect(
			yaml.encodings.main.inputStreams.hdr10Plus.picture.properties,
		).toMatchObject({ selectionMode: "VIDEO_RELATIVE", position: 2 });
	});

	it("records and renders the source operation", () => {
		const entries = initStepLog(compilePlan(plan()));
		const source = entries.find(
			(entry) => entry.kind === "CREATE_HDR10_PLUS_INPUT_STREAM",
		);
		if (!source) throw new Error("missing HDR10+ operation");
		expect(stepLogEntrySchema.safeParse(source).success).toBe(true);
		expect(
			buildResourceTree(entries).find((group) => group.id === "inputStreams")
				?.nodes,
		).toContainEqual(
			expect.objectContaining({
				step: "hdr10-plus:picture",
				kind: "CREATE_HDR10_PLUS_INPUT_STREAM",
			}),
		);
		const request = {
			...source.payload,
			refs: { encodingId: "encoding-id", inputId: "input-id" },
		};
		expect(curlForStep(source)).toMatchObject({
			ok: false,
			code: "UNRESOLVED_PATH_PARAMS",
		});
		expect(
			curlForStep({
				...source,
				request: { ...request, refs: { encodingId: "encoding-id" } },
			}),
		).toMatchObject({ ok: false, code: "UNRESOLVED_PATH_PARAMS" });
		const curl = curlForStep({ ...source, request });
		if (curl.ok) {
			const body = curl.command.split("--data '")[1]?.slice(0, -1);
			expect(JSON.parse(body ?? "{}")).toEqual({
				type: "HDR10_PLUS",
				inputId: "input-id",
				videoInputPath: "hdr/video.mp4",
				metadataInputPath: "hdr/metadata.json",
				selectionMode: "AUTO",
			});
		}
		expect(curl.ok).toBe(true);
		if (curl.ok)
			expect(curl.command).toContain(
				"/encoding/encodings/encoding-id/input-streams/hdr10-plus",
			);
	});

	it("lists both video and metadata as independently substitutable files", () => {
		const value = plan();
		expect(
			templateSourceSites(value).map((site) => ({
				id: site.siteId,
				list: site.list,
				field: site.field,
				inputKey: site.inputKey,
			})),
		).toEqual([
			{
				id: "picture",
				list: "hdr10PlusStreams",
				field: "videoInputPath",
				inputKey: "in",
			},
			{
				id: "picture:metadata",
				list: "hdr10PlusStreams",
				field: "metadataInputPath",
				inputKey: "in",
			},
		]);
		const result = instantiateTemplatePlan({
			presetBody: value,
			sources: {
				picture: { objectKey: "new/video.mp4" },
				"picture:metadata": { objectKey: "new/meta.json" },
			},
			name: "replacement",
			templateName: "HDR10+",
			now: new Date("2026-11-18T00:00:00Z"),
			uuid: "00000000-0000-4000-8000-000000000003",
			outputPrefixTemplate: "runs/new",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("fixture");
		expect(result.plan.hdr10PlusStreams[0]).toMatchObject({
			videoInputPath: "new/video.mp4",
			metadataInputPath: "new/meta.json",
		});
		expect(
			inputFileSummaries(result.plan)
				.map((file) => file.inputPath)
				.sort(),
		).toEqual(["new/meta.json", "new/video.mp4"]);
	});

	it("keeps video and metadata on the same storage when a template is instantiated", () => {
		const raw = rawPlan();
		const value = encodingPlanSchema.parse({
			...raw,
			inputs: [
				{
					key: "in",
					kind: "S3",
					bucket: "old",
					credentialId: "00000000-0000-4000-8000-000000000001",
				},
			],
		});
		const result = instantiateTemplatePlan({
			presetBody: value,
			sources: {
				picture: {
					objectKey: "new/video.mp4",
					bucket: "one",
					credentialId: "00000000-0000-4000-8000-000000000001",
				},
				"picture:metadata": {
					objectKey: "new/meta.json",
					bucket: "two",
					credentialId: "00000000-0000-4000-8000-000000000001",
				},
			},
			name: "replacement",
			templateName: "HDR10+",
			now: new Date("2026-11-18T00:00:00Z"),
			uuid: "00000000-0000-4000-8000-000000000003",
			outputPrefixTemplate: "runs/new",
		});
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.issues).toContainEqual(
				expect.objectContaining({ code: "SHARED_INPUT_CONFLICT" }),
			);
	});
});
