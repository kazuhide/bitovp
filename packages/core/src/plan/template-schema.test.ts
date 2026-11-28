import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { encodingPlanSchema } from "./schema";
import { planToEncodingTemplateYaml } from "./template";
import { loadPlan } from "./test-support";

/**
 * Every Template-YAML golden must validate against the official Bitmovin
 * template JSON schema — vendored copy of
 * https://raw.githubusercontent.com/bitmovin/bitmovin-api-sdk-examples/main/bitmovin-encoding-template.json
 * (fetched 2026-06-11; refresh deliberately, alongside SDK upgrades).
 *
 * Known exception: SFTP `port` is exported as a {{PLACEHOLDER}} string and
 * the schema wants an integer — substitution fixes it, and the YAML header
 * tells users so. Anything else failing the schema is a real bug.
 */
const KNOWN_PLACEHOLDER_PATHS = /^\/outputs\/sftp\/[^/]+\/properties\/port$/;

/*
 * TRUST LIMIT of this gate: the vendored schema contains ZERO
 * `additionalProperties: false`, so ajv accepts unknown/misplaced keys and
 * cannot express conditional field contracts (e.g. C18's "infrastructure
 * requires cloudRegion EXTERNAL"). A green run here proves the keys we emit
 * exist where we put them — NOT that the combination is valid. Semantic
 * constraints live in the validators (C-rules); don't over-trust this gate
 * in review.
 */
const dir = join(__dirname, "__fixtures__");

describe("template goldens vs the official JSON schema", () => {
	const schema = JSON.parse(
		readFileSync(join(dir, "bitmovin-encoding-template.schema.json"), "utf8"),
	) as Record<string, unknown>;
	const ajv = new Ajv2020({ strict: false, allErrors: true, logger: false });
	const validateTemplate = ajv.compile(schema);

	const goldens = readdirSync(dir).filter((f) => f.endsWith(".template.yaml"));

	it("covers every template golden", () => {
		expect(goldens.length).toBeGreaterThan(0);
	});

	it("validates native file muxings, declared DRM and timed metadata against the provider template schema", () => {
		const sample = loadPlan("fixed-bitrate-hls-on-aws");
		const output = (key: string) => ({
			outputKey: "origin",
			path: `native/${key}/`,
		});
		const plan = encodingPlanSchema.parse({
			...sample,
			renditions: [
				...sample.renditions,
				{
					key: "mp3",
					ingestKey: "audio",
					codec: "MP3",
					bitrate: 128000,
					rate: 48000,
				},
				{ key: "mpeg2", ingestKey: "video", codec: "H262", rate: 25 },
			],
			muxings: [
				{
					key: "output-ts",
					streamKey: "v360",
					kind: "BROADCAST_TS",
					filename: "clip.ts",
					destination: output("ts"),
				},
				{
					key: "output-mp3",
					streamKey: "mp3",
					kind: "MP3",
					filename: "clip.mp3",
					destination: output("mp3"),
				},
				{
					key: "output-mxf",
					streamKey: "mpeg2",
					kind: "MXF",
					filename: "clip.mxf",
					destination: output("mxf"),
				},
				{
					key: "output-packed",
					streamKey: "a128",
					kind: "PACKED_AUDIO",
					segmentLength: 5,
					segmentNaming: "packet_%number%.aac",
				},
				{
					key: "output-raw",
					streamKey: "a64",
					kind: "SEGMENTED_RAW",
					segmentLength: 5,
					segmentNaming: "packet_%number%.aac",
					destination: output("raw"),
				},
				{
					key: "output-id3",
					streamKey: "v540",
					kind: "PROGRESSIVE_TS",
					filename: "clip.ts",
					destination: output("id3"),
					id3Tags: [
						{
							key: "chapter",
							format: "PLAIN_TEXT",
							frameId: "TIT2",
							time: 1,
							positionMode: "TIME",
							text: "Chapter",
						},
					],
				},
			],
			drm: [
				{
					key: "packet-key",
					kind: "AES",
					muxingKey: "output-packed",
					method: "AES_128",
					keyFileUri: "fixture-key.bin",
					credentialId: "00000000-0000-4000-8000-000000000007",
					destination: output("encrypted"),
				},
			],
			manifests: [],
			generation: { timing: "POST_ENCODING" },
		});
		const tree = parse(planToEncodingTemplateYaml(plan));
		validateTemplate(tree);
		expect(validateTemplate.errors ?? []).toEqual([]);
		expect(tree.configurations.video.h262.mpeg2.properties).toMatchObject({
			profile: "MPEG2_422",
			bitrate: 50000000,
		});
		expect(tree.configurations.audio.mp3.mp3.properties).toMatchObject({
			bitrate: 128000,
		});
		const [encoding] = Object.values(
			tree.encodings as Record<string, { muxings: object }>,
		);
		expect(encoding?.muxings).toMatchObject({
			broadcastTs: { "output-ts": { properties: { filename: "clip.ts" } } },
			mp3: { "output-mp3": { properties: { filename: "clip.mp3" } } },
			mxf: { "output-mxf": { properties: { filename: "clip.mxf" } } },
			packedAudio: {
				"output-packed": {
					drm: {
						aes: {
							"packet-key": {
								properties: {
									key: "{{DRM_PACKET_KEY_KEY}}",
									keyFileUri: "fixture-key.bin",
								},
							},
						},
					},
				},
			},
			segmentedRaw: {
				"output-raw": { properties: { segmentNaming: "packet_%number%.aac" } },
			},
			progressiveTs: {
				"output-id3": {
					id3: { plainText: { chapter: { properties: { text: "Chapter" } } } },
				},
			},
		});
	});

	for (const file of goldens) {
		it(`validates ${file}`, () => {
			validateTemplate(parse(readFileSync(join(dir, file), "utf8")));
			const unexpected = (validateTemplate.errors ?? []).filter(
				(error) => !KNOWN_PLACEHOLDER_PATHS.test(error.instancePath),
			);
			expect(unexpected).toEqual([]);
		});
	}
});

/**
 * The official schema cannot see $/section/path references (they are plain
 * strings to it) — a template can validate while pointing at resources that
 * were never emitted (the PR #20 dolby-config bug class). Resolve every $/
 * ref against the document tree instead.
 */
describe("template goldens $/ reference integrity", () => {
	const goldens = readdirSync(dir).filter((f) => f.endsWith(".template.yaml"));

	function collectRefs(node: unknown, refs: string[]): void {
		if (typeof node === "string") {
			if (node.startsWith("$/")) {
				refs.push(node);
			}
			return;
		}
		if (Array.isArray(node)) {
			for (const item of node) {
				collectRefs(item, refs);
			}
			return;
		}
		if (node && typeof node === "object") {
			for (const value of Object.values(node)) {
				collectRefs(value, refs);
			}
		}
	}

	function resolves(tree: unknown, ref: string): boolean {
		let cursor: unknown = tree;
		for (const segment of ref.slice(2).split("/")) {
			if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
				return false;
			}
			cursor = (cursor as Record<string, unknown>)[segment];
		}
		return cursor !== undefined;
	}

	for (const file of goldens) {
		it(`resolves every $/ ref in ${file}`, () => {
			const tree = parse(readFileSync(join(dir, file), "utf8")) as unknown;
			const refs: string[] = [];
			collectRefs(tree, refs);
			const dangling = refs.filter((ref) => !resolves(tree, ref));
			expect(dangling).toEqual([]);
		});
	}
});
