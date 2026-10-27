import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileExpectedLiveArtefacts } from "../verify/expected-live";
import { compileLiveChannel } from "./compiler";
import { liveChannelPlanSchema } from "./schema";
import { validateLiveChannel } from "./validate";

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing fixture value");
	return value;
}
const cred = "00000000-0000-4000-8000-000000000003";
function fixture() {
	return liveChannelPlanSchema.parse(
		JSON.parse(
			readFileSync(
				new URL("./__fixtures__/live-rtmp-simple.plan.json", import.meta.url),
				"utf8",
			),
		),
	);
}
function encrypted(
	kind: "CENC" | "FAIRPLAY" | "SPEKE",
	container: "FMP4" | "TS" = "FMP4",
) {
	const p = fixture();
	p.drm = p.muxings.map((m) => ({
		key: `${m.key}-enc`,
		kind,
		muxingKey: m.key,
		credentialId: cred,
		destination: required(m.destination),
		...(kind === "CENC"
			? {
					kid: "a".repeat(32),
					encryptionMode: "CBC" as const,
					ivSize: "IV_16_BYTES" as const,
					fairPlay: { iv: "b".repeat(32), uri: "skd://test" },
				}
			: kind === "FAIRPLAY"
				? { iv: "b".repeat(32), uri: "skd://test" }
				: { systemIds: ["edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"] }),
	})) as NonNullable<typeof p.drm>;
	p.muxings = p.muxings.map((m) => {
		const { destination: _d, ...rest } = m;
		if (container === "TS")
			delete (rest as Record<string, unknown>).initSegmentName;
		return {
			...rest,
			kind: container,
			segmentNaming:
				container === "TS" ? "segment_%number%.ts" : "segment_%number%.m4s",
		};
	}) as typeof p.muxings;
	p.liveManifests = p.liveManifests
		.filter((m) => container !== "TS" || m.kind === "HLS")
		.map((m) => ({ ...m, drmKind: kind }));
	return liveChannelPlanSchema.parse(p);
}
const errors = (p: ReturnType<typeof fixture>) =>
	validateLiveChannel(p).filter((i) => i.level === "error");
describe("Live encrypted output compilation", () => {
	for (const [kind, container] of [
		["CENC", "FMP4"],
		["FAIRPLAY", "FMP4"],
		["FAIRPLAY", "TS"],
		["SPEKE", "FMP4"],
	] as const) {
		it(`${kind} ${container} emits vault refs, encrypted destinations and manifest protection`, () => {
			const p = encrypted(kind, container);
			expect(errors(p)).toEqual([]);
			const ops = compileLiveChannel(p);
			const drm = ops.filter((o) => o.kind === `CREATE_DRM_${kind}`);
			expect(drm).toHaveLength(p.muxings.length);
			for (const op of drm) {
				expect(op.payload.credentialId).toBe(cred);
				expect(op.refs.outputId).toBe("output:origin");
				expect(op.payload.outputPath).toBeTruthy();
			}
			for (const op of ops.filter((o) =>
				["CREATE_MUXING_FMP4", "CREATE_MUXING_TS"].includes(o.kind),
			))
				expect(op.refs.outputId).toBeUndefined();
			for (const op of ops.filter((o) =>
				["CREATE_HLS_AUDIO_MEDIA", "CREATE_HLS_STREAM_INFO"].includes(o.kind),
			)) {
				expect(op.refs.drmId).toMatch(/^drm:/);
				expect(op.payload.segmentPath).not.toBe("");
			}
			if (container === "FMP4")
				expect(
					ops.filter((o) => o.kind === "CREATE_DASH_CONTENT_PROTECTION"),
				).toHaveLength(p.muxings.length);
		});
	}
	it("observes encrypted folders and rejects clear/encrypted writes to the same TS folder", () => {
		const p = encrypted("FAIRPLAY", "TS");
		const first = required(p.drm?.[0]),
			muxing = required(p.muxings[0]);
		const expected = compileExpectedLiveArtefacts(p);
		expect(expected.muxings[0]).toMatchObject({
			muxingKey: muxing.key,
			drmKey: first.key,
			drmKind: "FAIRPLAY",
			outputKey: first.destination.outputKey,
		});
		muxing.destination = first.destination;
		expect(errors(p).some((i) => i.code === "LIVE_DRM_OUTPUT_COLLISION")).toBe(
			true,
		);
		muxing.destination = { ...first.destination, path: "clear/independent" };
		expect(errors(p)).toEqual([]);
		expect(
			compileExpectedLiveArtefacts(p).muxings.filter(
				(m) => m.muxingKey === muxing.key,
			),
		).toHaveLength(2);
	});
	it("rejects a clear manifest with only encrypted output", () => {
		const p = encrypted("CENC");
		delete required(p.liveManifests[0]).drmKind;
		expect(
			errors(p).some((i) => i.code === "LIVE_MANIFEST_CLEAR_OUTPUT_MISSING"),
		).toBe(true);
	});
	it("rejects missing encryption legs and unsupported CENC TS/CMAF", () => {
		for (const container of ["TS", "CMAF"] as const) {
			const p = encrypted("CENC");
			required(p.muxings[0]).kind = container;
			expect(errors(p).some((i) => i.code === "LIVE_DRM_MUXING_MISMATCH")).toBe(
				true,
			);
		}
	});
	it("rejects wrong/missing vault providers before provision", () => {
		const p = encrypted("SPEKE");
		expect(
			validateLiveChannel(p, {
				credentialProviders: new Map([[cred, "DRM_CENC"]]),
			}).some((i) => i.code === "DRM_CREDENTIAL"),
		).toBe(true);
	});
	it("rejects ambiguous legs and FairPlay metadata on CTR CENC", () => {
		const p = encrypted("CENC");
		required(p.drm).push({ ...required(p.drm?.[0]), key: "another" });
		expect(errors(p).some((i) => i.code === "LIVE_DRM_AMBIGUOUS")).toBe(true);
		const c = required(p.drm?.[0]);
		if (c.kind === "CENC") {
			c.encryptionMode = "CTR";
		}
		expect(errors(p).some((i) => i.code === "LIVE_DRM_FAIRPLAY_CBC")).toBe(
			true,
		);
	});
});
describe("Live fallback regions", () => {
	it.each([
		{ regions: undefined },
		{ regions: [] },
	])("accepts omitted or empty fallbacks without emitting an API field (%j)", ({
		regions,
	}) => {
		const p = fixture();
		p.bitmovin.fallbackCloudRegions = regions;
		expect(errors(p)).toEqual([]);
		expect(
			compileLiveChannel(p).find((o) => o.kind === "CREATE_ENCODING")?.payload,
		).not.toHaveProperty("fallbackCloudRegions");
	});
	for (const regions of [
		["AWS_US_WEST_2"],
		["AUTO"],
		["AWS_US_WEST_2", "AUTO"],
		["GOOGLE_US_CENTRAL_1"],
		["AWS_EU"],
		["INVALID"],
		["AUTO", "AUTO"],
		["AUTO", "AWS_US_EAST_1", "AWS_US_EAST_2", "AWS_US_WEST_1"],
	])
		it(`rejects unsupported Live fallbacks before compilation: ${regions.join(",")}`, () => {
			const p = fixture();
			p.bitmovin.cloudRegion = "AWS_US_EAST_1";
			p.bitmovin.fallbackCloudRegions = regions;
			expect(errors(p)).toContainEqual(
				expect.objectContaining({
					code: "LIVE_FALLBACK_REGIONS",
					level: "error",
					path: "bitmovin.fallbackCloudRegions",
					message: expect.stringMatching(
						/Live Encoding does not support fallback regions/,
					),
				}),
			);
			expect(() => compileLiveChannel(p)).toThrow(
				/Live Encoding does not support fallback regions/,
			);
			expect(p.bitmovin.fallbackCloudRegions).toEqual(regions);
		});
});

it("rejects encrypted TS writers from different muxings sharing a physical path through aliases and mirrors", () => {
	const p = encrypted("FAIRPLAY", "TS");
	const first = required(p.drm?.[0]),
		second = required(p.drm?.[1]);
	second.destination = { ...first.destination };
	expect(errors(p).some((i) => i.code === "LIVE_DRM_OUTPUT_COLLISION")).toBe(
		true,
	);
	const output = required(p.outputs[0]);
	p.outputs.push({ ...output, key: "same-bucket-alias" });
	second.destination = { ...first.destination, outputKey: "same-bucket-alias" };
	expect(errors(p).some((i) => i.code === "LIVE_DRM_OUTPUT_COLLISION")).toBe(
		true,
	);
	second.destination = { ...first.destination, path: "separate/track" };
	expect(errors(p).some((i) => i.code === "LIVE_DRM_OUTPUT_COLLISION")).toBe(
		false,
	);
	if (output.kind !== "S3") throw new Error("Missing S3 fixture");
	p.outputs.push({
		...output,
		key: "other-bucket",
		bucket: "separate-live-bucket",
	});
	second.destination = { ...first.destination, outputKey: "other-bucket" };
	expect(errors(p).some((i) => i.code === "LIVE_DRM_OUTPUT_COLLISION")).toBe(
		false,
	);
	p.deliveryMirrors = [{ outputKey: "origin" }];
	expect(errors(p).some((i) => i.code === "LIVE_DRM_OUTPUT_COLLISION")).toBe(
		true,
	);
});

describe("Live output filename field provenance", () => {
	it.each([
		["FMP4", "init_%number%.mp4", "init_1.mp4", false, false],
		["FMP4", "init_%provider%.mp4", "init_custom.mp4", false, false],
		["FMP4", "init_{rand_chars:8}.mp4", "init_Ab12Cd34.mp4", false, false],
		["FMP4", "init_%number%.mp4", "init_%number%.mp4", false, true],
		["CMAF", "init_%number%.mp4", "init_1.mp4", false, false],
		[
			"CMAF",
			"init_{rand_chars:8}_%number%.mp4",
			"init_Ab12Cd34_1.mp4",
			true,
			false,
		],
		[
			"CMAF",
			"init_{rand_chars:8}_%number%.mp4",
			"init_Ab12Cd34_%number%.mp4",
			true,
			true,
		],
		[
			"CMAF",
			"init_{rand_chars:8}_%number%.mp4",
			"init_Ab12Cd34_%number%.mp4",
			false,
			false,
		],
		["MP4", "archive_%number%.mp4", "archive_1.mp4", false, false],
		["MP4", "archive_%provider%.mp4", "archive_custom.mp4", false, false],
		["MP4", "archive_{rand_chars:8}.mp4", "archive_Ab12Cd34.mp4", false, false],
		["MP4", "archive_%number%.mp4", "archive_%number%.mp4", false, true],
	] as const)("keeps %s filename provenance for %s against %s", (kind, left, right, template, collision) => {
		const p = fixture();
		const destination = required(required(p.muxings[0]).destination);
		const sources = [required(p.muxings[0]), required(p.muxings[3])];
		p.muxings = [left, right].map((pattern, i) => {
			const source = required(sources[i]);
			if (source.kind !== "FMP4") throw new Error("Missing fMP4 fixture");
			if (kind === "MP4")
				return {
					key: source.key,
					kind,
					streamKey: source.streamKey,
					filename: pattern,
					destination: { ...destination },
				};
			return {
				...source,
				kind,
				segmentNaming: `writer_${i}_%number%.m4s`,
				initSegmentName: pattern,
				...(kind === "CMAF" && template && i === 0
					? { initSegmentNameTemplate: pattern }
					: {}),
				destination: { ...destination },
			};
		});
		if (kind === "CMAF")
			p.liveManifests = p.liveManifests.filter((m) => m.kind === "DASH");
		expect(errors(p).some((i) => i.code === "LIVE_DRM_OUTPUT_COLLISION")).toBe(
			collision,
		);
		if (!collision && kind !== "MP4") expect(errors(p)).toEqual([]);
	});
	it("still expands segment-policy tokens against a literal init filename", () => {
		const p = fixture();
		const a = required(p.muxings[0]);
		const b = required(p.muxings[1]);
		if (a.kind !== "FMP4" || b.kind !== "FMP4")
			throw new Error("Missing fMP4 fixtures");
		p.muxings = [a, b];
		b.destination = { ...required(a.destination) };
		a.segmentNaming = "init_%number%.mp4";
		a.initSegmentName = "a-init.mp4";
		b.segmentNaming = "b_%number%.m4s";
		b.initSegmentName = "init_1.mp4";
		expect(errors(p).some((i) => i.code === "LIVE_DRM_OUTPUT_COLLISION")).toBe(
			true,
		);
	});
});

describe("Live output filename expansion collisions", () => {
	it("rejects an unrepresentable pattern even with only one encrypted writer", () => {
		const p = encrypted("FAIRPLAY", "TS");
		const first = required(p.muxings[0]);
		if (first.kind !== "TS") throw new Error("Missing TS fixture");
		p.muxings = [first];
		p.drm = [required(p.drm?.[0])];
		p.liveManifests = p.liveManifests.filter((m) => m.kind === "HLS");
		first.segmentNamingTemplate = "segment-{rand_chars:2049}-%number%.ts";
		expect(
			errors(p).some((i) => i.code === "LIVE_OUTPUT_PATTERN_UNVERIFIED"),
		).toBe(true);
	});
	it.each([
		["seg_%number%.ts", "seg_1%number%.ts", false, true],
		["nested/seg_%number%.ts", "nested/seg_1%number%.ts", false, true],
		["seg_%number%.ts", "seg_11.ts", false, true],
		["video_%number%.ts", "audio_%number%.ts", false, false],
		["seg_%number%_video.ts", "seg_%number%_audio.ts", false, false],
		["seg_%number%.ts", "seg_a%number%.ts", false, false],
		["seg-{rand_chars:8}-%number%.ts", "seg-Ab12Cd34-%number%.ts", true, true],
		[
			"seg-{rand_chars}-%number%.ts",
			`seg-${"A".repeat(32)}-%number%.ts`,
			true,
			true,
		],
		[
			"seg-{rand_chars:8}-%number%.ts",
			"seg-Ab12Cd34-%number%.ts",
			false,
			false,
		],
	] as const)("checks expanded %s against %s", (left, right, template, collision) => {
		const p = encrypted("FAIRPLAY", "TS");
		const a = required(p.muxings[0]);
		const b = required(p.muxings[1]);
		if (a.kind !== "TS" || b.kind !== "TS")
			throw new Error("Missing TS fixture");
		a.segmentNaming = left;
		if (template) a.segmentNamingTemplate = left;
		b.segmentNaming = right;
		required(p.drm?.[1]).destination = { ...required(p.drm?.[0]).destination };
		expect(errors(p).some((i) => i.code === "LIVE_DRM_OUTPUT_COLLISION")).toBe(
			collision,
		);
	});
	it.each([
		"alias",
		"mirror",
	] as const)("detects overlapping expansions through an output %s", (route) => {
		const p = encrypted("FAIRPLAY", "TS");
		const a = required(p.muxings[0]);
		const b = required(p.muxings[1]);
		if (a.kind !== "TS" || b.kind !== "TS")
			throw new Error("Missing TS fixture");
		a.segmentNaming = "seg_%number%.ts";
		b.segmentNaming = "seg_1%number%.ts";
		const output = required(p.outputs[0]);
		if (output.kind !== "S3") throw new Error("Missing S3 fixture");
		p.outputs.push({
			...output,
			key: "other",
			...(route === "mirror" ? { bucket: "other-live-bucket" } : {}),
		});
		required(p.drm?.[1]).destination = {
			...required(p.drm?.[0]).destination,
			outputKey: "other",
		};
		if (route === "mirror") p.deliveryMirrors = [{ outputKey: "origin" }];
		expect(errors(p).some((i) => i.code === "LIVE_DRM_OUTPUT_COLLISION")).toBe(
			true,
		);
	});
});
