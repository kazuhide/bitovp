import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { liveChannelPlanSchema } from "./schema";
import { validateLiveChannel } from "./validate";

function fixture(kind: "HLS" | "DASH") {
	const plan = liveChannelPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(__dirname, "__fixtures__/live-rtmp-simple.plan.json"),
				"utf8",
			),
		),
	);
	const output = plan.outputs[0];
	const primary = plan.liveManifests.find((manifest) => manifest.kind === kind);
	if (output?.kind !== "S3" || !primary)
		throw new Error("Missing fixture resources");
	plan.outputs.push({
		...output,
		key: "recording",
		bucket: "dedicated-recordings",
	});
	plan.muxings.push({
		key: "archive",
		kind: "MP4",
		streamKey: "v1080",
		additionalStreamKeys: ["a128"],
		filename: "archive.mp4",
		destination: {
			outputKey: "recording",
			path: `${primary.destination.path}/archive`,
		},
	});
	const manifest = {
		...structuredClone(primary),
		key: "additional",
		destination: {
			...primary.destination,
			path: `${primary.destination.path}/additional`,
		},
	};
	plan.liveManifests.push(manifest);
	return { plan, manifest };
}

function unavailable(plan: ReturnType<typeof fixture>["plan"]) {
	return validateLiveChannel(plan).filter(
		(issue) => issue.code === "LIVE_MANIFEST_MEDIA_UNAVAILABLE",
	);
}

describe("Live manifest segment availability", () => {
	it.each([
		"HLS",
		"DASH",
	] as const)("rejects changing a valid %s master to archive-only storage", (kind) => {
		const { plan, manifest } = fixture(kind);
		expect(
			validateLiveChannel(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		manifest.destination.outputKey = "recording";
		expect(unavailable(plan)).toContainEqual(
			expect.objectContaining({
				level: "error",
				path: "liveManifests[2].destination.outputKey",
			}),
		);
	});

	it.each([
		"HLS",
		"DASH",
	] as const)("accepts a %s master on a physical alias of the segment storage", (kind) => {
		const { plan, manifest } = fixture(kind);
		const source = plan.outputs[0];
		if (source?.kind !== "S3") throw new Error("Missing S3 fixture");
		plan.outputs[1] = { ...source, key: "recording" };
		manifest.destination.outputKey = "recording";
		expect(
			validateLiveChannel(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
	});

	it.each([
		"HLS",
		"DASH",
	] as const)("accepts a %s master receiving segments through a delivery mirror", (kind) => {
		const { plan, manifest } = fixture(kind);
		manifest.destination.outputKey = "recording";
		plan.deliveryMirrors = [{ outputKey: "recording" }];
		expect(
			validateLiveChannel(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
	});

	it.each([
		"HLS",
		"DASH",
	] as const)("accepts explicit media destinations for a %s master", (kind) => {
		const { plan, manifest } = fixture(kind);
		manifest.destination.outputKey = "recording";
		plan.liveManifests = [manifest];
		for (const muxing of plan.muxings)
			if (muxing.kind !== "MP4" && muxing.destination)
				muxing.destination.outputKey = "recording";
		expect(
			validateLiveChannel(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
	});

	it("requires every manifest copy to receive every selected segment writer", () => {
		const { plan, manifest } = fixture("HLS");
		const source = plan.outputs[0];
		if (source?.kind !== "S3") throw new Error("Missing S3 fixture");
		plan.outputs.push({ ...source, key: "shared", bucket: "shared-delivery" });
		plan.deliveryMirrors = [{ outputKey: "shared" }];
		manifest.destination.outputKey = "recording";
		expect(unavailable(plan)).toContainEqual(
			expect.objectContaining({
				path: "liveManifests[2].destination.outputKey",
			}),
		);
	});

	it.each([
		"HLS",
		"DASH",
	] as const)("checks only the muxing legs selected by %s pins", (kind) => {
		const { plan, manifest } = fixture(kind);
		const source = plan.muxings.find((muxing) => muxing.kind === "FMP4");
		if (source?.kind !== "FMP4" || !source.destination)
			throw new Error("Missing FMP4 fixture");
		const alternate =
			kind === "HLS"
				? {
						key: source.key,
						kind: "TS" as const,
						streamKey: source.streamKey,
						segmentLength: source.segmentLength,
						segmentNaming: "segment_%number%.ts",
					}
				: { ...source, kind: "CMAF" as const };
		plan.muxings.push({
			...alternate,
			key: "alternate",
			destination: {
				outputKey: "recording",
				path: `${source.destination.path}/alternate`,
			},
		});
		for (const entry of plan.liveManifests) entry.videoMuxingKind = "FMP4";
		expect(unavailable(plan)).toEqual([]);
		delete manifest.videoMuxingKind;
		expect(unavailable(plan)).toContainEqual(
			expect.objectContaining({
				path: "liveManifests[2].destination.outputKey",
			}),
		);
	});

	it("keeps Origin media with a storage mirror available to a storage master", () => {
		const { plan, manifest } = fixture("HLS");
		const source = plan.outputs[0];
		if (!source) throw new Error("Missing output fixture");
		plan.outputs[0] = {
			key: "origin",
			kind: "LIVE_MEDIA_INGEST",
			credentialId: source.credentialId,
			name: "Origin",
		};
		manifest.destination.outputKey = "recording";
		plan.liveManifests = [manifest];
		plan.deliveryMirrors = [{ outputKey: "recording" }];
		expect(unavailable(plan)).toEqual([]);
	});
});
