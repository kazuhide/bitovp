import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	compileLiveChannel,
	liveHlsEntryUri,
	liveHlsEntryUris,
} from "./compiler";
import { liveChannelPlanSchema } from "./schema";
import { validateLiveChannel } from "./validate";

function fixture(uri = "live-main.m3u8") {
	const input = JSON.parse(
		readFileSync(
			join(__dirname, "__fixtures__/live-rtmp-simple.plan.json"),
			"utf8",
		),
	);
	Object.assign(input.renditions[0], { hlsVariantUri: uri });
	return liveChannelPlanSchema.parse(input);
}

describe("Live video playlist URI", () => {
	it("passes the literal override to the shared StreamInfo operation", () => {
		const plan = fixture();
		expect(
			validateLiveChannel(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		expect(
			compileLiveChannel(plan).find((op) => op.step === "hls-variant:hls:v1080")
				?.payload.uri,
		).toBe("live-main.m3u8");
	});
	it("reserves explicit names before assigning automatic names", () => {
		const plan = fixture();
		const first = plan.renditions[0];
		const second = plan.renditions[1];
		if (first?.codec !== "H264" || second?.codec !== "H264")
			throw new Error("Missing video fixtures");
		first.hlsVariantUri = liveHlsEntryUri(second);
		const uris = liveHlsEntryUris(plan);
		expect(uris.get(first.key)).toBe(first.hlsVariantUri);
		expect(uris.get(second.key)).not.toBe(first.hlsVariantUri);
	});
	it("refuses an audio-group pattern instead of sending unresolved tokens", () => {
		expect(
			validateLiveChannel(fixture("live-{group}.m3u8")).map(
				(issue) => issue.code,
			),
		).toContain("LIVE_HLS_VIDEO_URI_PATTERN");
	});
	it("does not rename two conflicting explicit overrides", () => {
		const plan = fixture();
		const second = plan.renditions[1];
		if (!second) throw new Error("Missing video fixture");
		second.hlsVariantUri = "live-main.m3u8";
		expect(liveHlsEntryUris(plan).get(second.key)).toBe("live-main.m3u8");
		expect(validateLiveChannel(plan).map((issue) => issue.code)).toContain(
			"LIVE_HLS_URI_COLLISION",
		);
	});
	it("refuses an explicit name that overwrites the master playlist", () => {
		expect(
			validateLiveChannel(fixture("stream.m3u8")).map((issue) => issue.code),
		).toContain("LIVE_HLS_URI_COLLISION");
	});
	it("refuses a name that overwrites audio without silently renaming the audio", () => {
		const plan = fixture("audio_128000.m3u8");
		expect(liveHlsEntryUris(plan).get("a128")).toBe("audio_128000.m3u8");
		expect(validateLiveChannel(plan).map((issue) => issue.code)).toContain(
			"LIVE_HLS_URI_COLLISION",
		);
	});
});
