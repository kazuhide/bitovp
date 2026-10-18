import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileLiveChannel } from "./compiler";
import { liveChannelPlanSchema } from "./schema";

/**
 * Review-323 I1, live twin: the HLS media NAME suffix is decided by how many
 * audio entries THIS manifest lists, not by how many audio renditions the
 * channel carries. Two manifests partitioned by `audioMuxingKind`, one audio
 * each — neither has anything to disambiguate.
 */
function twoManifestChannel() {
	const plan = liveChannelPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(__dirname, "__fixtures__/live-rtmp-simple.plan.json"),
				"utf8",
			),
		),
	);
	const a128 = plan.renditions.find((r) => r.key === "a128");
	const a128Mux = plan.muxings.find((m) => m.streamKey === "a128");
	if (!a128 || a128Mux?.kind !== "FMP4") {
		throw new Error("fixture drift: live-rtmp-simple has no fMP4 audio a128");
	}
	plan.renditions.push({ ...a128, key: "a2" });
	plan.muxings.push({
		key: "a2",
		kind: "TS",
		streamKey: "a2",
		segmentLength: a128Mux.segmentLength,
		segmentNaming: "seg_%number%.ts",
		destination: a128Mux.destination,
	} as (typeof plan.muxings)[number]);
	const hls = plan.liveManifests.find((m) => m.kind === "HLS");
	if (hls?.kind !== "HLS") {
		throw new Error("fixture drift: no HLS manifest");
	}
	hls.audioMuxingKind = "FMP4";
	plan.liveManifests.push({
		...hls,
		key: "hls-ts",
		manifestName: "stream-ts.m3u8",
		audioMuxingKind: "TS",
	} as (typeof plan.liveManifests)[number]);
	return liveChannelPlanSchema.parse(plan);
}

describe("live HLS audio media names are scoped to the manifest", () => {
	it("one audio per manifest keeps the vendor literal in both masters", () => {
		const names = compileLiveChannel(twoManifestChannel())
			.filter((op) => op.kind === "CREATE_HLS_AUDIO_MEDIA")
			.map((op) => [op.step, (op.payload as { name: string }).name]);
		expect(names).toEqual([
			["hls-media:hls:a128", "HLS Audio Media"],
			["hls-media:hls-ts:a2", "HLS Audio Media"],
		]);
	});

	it("two audios in ONE manifest still get the suffix (the HIGH-8 fix stands)", () => {
		const plan = twoManifestChannel();
		// Drop the partition: the first manifest now lists both legs.
		const hls = plan.liveManifests.find((m) => m.key === "hls");
		if (hls && hls.kind === "HLS") {
			hls.audioMuxingKind = undefined;
		}
		plan.liveManifests = plan.liveManifests.filter((m) => m.key !== "hls-ts");
		const names = compileLiveChannel(plan)
			.filter((op) => op.kind === "CREATE_HLS_AUDIO_MEDIA")
			.map((op) => (op.payload as { name: string }).name)
			.sort();
		expect(names).toEqual(["HLS Audio Media (a128)", "HLS Audio Media (a2)"]);
	});
});
