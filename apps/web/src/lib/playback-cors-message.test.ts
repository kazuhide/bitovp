import { describe, expect, it } from "vitest";
import {
	type PlaybackCorsResult,
	playbackCorsMessage,
} from "./playback-cors-message";

const missingExposeHeaders: PlaybackCorsResult = {
	supported: true,
	origin: "https://app.example.com",
	bucket: "output",
	verdict: {
		code: "MISSING_EXPOSE_HEADERS",
		headers: ["content-range", "accept-ranges"],
	},
};

describe("playbackCorsMessage", () => {
	it("keeps missing exposed headers advisory for measured open-source HLS", () => {
		expect(
			playbackCorsMessage(missingExposeHeaders, {
				kind: "HLS",
				provider: "open-source",
			}),
		).toMatchObject({
			key: "playback.corsMissingExposeHeadersAdvisory",
			implicated: false,
		});
	});

	it.each([
		["open-source DASH", { kind: "DASH", provider: "open-source" }],
		["Bitmovin HLS", { kind: "HLS", provider: "bitmovin" }],
	] as const)("keeps missing exposed headers actionable for %s", (_label, context) => {
		expect(playbackCorsMessage(missingExposeHeaders, context)).toMatchObject({
			key: "playback.corsMissingExposeHeaders",
			implicated: true,
		});
	});
});
