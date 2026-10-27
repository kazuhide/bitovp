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
	it("preserves unset payloads and emits the configured order", () => {
		const p = fixture();
		expect(
			compileLiveChannel(p).find((o) => o.kind === "CREATE_ENCODING")?.payload
				.fallbackCloudRegions,
		).toBeUndefined();
		p.bitmovin.cloudRegion = "AWS_US_EAST_1";
		p.bitmovin.fallbackCloudRegions = ["AWS_US_WEST_2", "AUTO"];
		expect(errors(p)).toEqual([]);
		expect(
			compileLiveChannel(p).find((o) => o.kind === "CREATE_ENCODING")?.payload
				.fallbackCloudRegions,
		).toEqual(["AWS_US_WEST_2", "AUTO"]);
	});
	for (const regions of [
		["GOOGLE_US_CENTRAL_1"],
		["AWS_EU"],
		["INVALID"],
		["AUTO", "AUTO"],
		["AUTO", "AWS_US_EAST_1", "AWS_US_EAST_2", "AWS_US_WEST_1"],
	])
		it(`rejects invalid fallbacks ${regions.join(",")}`, () => {
			const p = fixture();
			p.bitmovin.cloudRegion = "AWS_US_EAST_1";
			p.bitmovin.fallbackCloudRegions = regions;
			expect(errors(p).some((i) => i.code === "LIVE_FALLBACK_REGIONS")).toBe(
				true,
			);
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
