import { CREDENTIAL_PROVIDER_SHAPES } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { parseMoqPlaybackDescriptor } from "./types";

const runId = "00000000-0000-4000-8000-000000000003";
const descriptor = (url: string) => ({
	runId,
	encodingId: "00000000-0000-4000-8000-000000000004",
	playerLicenseKey: "test-key",
	resource: {
		type: "moq",
		url,
		metadata: {
			namespace: "test-namespace",
			catalogTrackName: "catalog",
			draftVersion: 18,
			mediaTypes: ["audio", "video"],
		},
	},
});

describe("MoQ descriptor URL contract", () => {
	it.each([
		8192, 8193,
	])("agrees with credential admission at subscriber URL length %i", (length) => {
		const prefix = "https://subscriber.example/moq?token=";
		const url = prefix + "s".repeat(length - prefix.length);
		const admitted = CREDENTIAL_PROVIDER_SHAPES.MOQ.secret.safeParse({
			relayUrl: "moqt://publisher.example/moq",
			playbackUrl: url,
		});
		expect(admitted.success).toBe(length <= 8192);
		if (admitted.success)
			expect(
				parseMoqPlaybackDescriptor(descriptor(url), runId).resource.url,
			).toBe(url);
		else
			expect(() =>
				parseMoqPlaybackDescriptor(descriptor(url), runId),
			).toThrow();
	});
	it("accepts only the Analytics video identity derived from this exact encoding and run", () => {
		const value = descriptor("https://subscriber.example/moq");
		const analytics = {
			licenseKey: "analytics-test-key",
			licenseKeySha256: "a".repeat(64),
			videoId: `bitovp-moq:${value.encodingId}:${runId}`,
			collectorVersion: "2.62.0",
			latencyField: "customData1",
		};
		expect(
			parseMoqPlaybackDescriptor({ ...value, analytics }, runId).analytics,
		).toEqual(analytics);
		expect(() =>
			parseMoqPlaybackDescriptor(
				{
					...value,
					analytics: { ...analytics, videoId: "bitovp-moq:other-run" },
				},
				runId,
			),
		).toThrow();
	});
	it("accepts the explicit query-token subscriber URL accepted by the server", () => {
		const url = "https://subscriber.example/moq?auth=subscribe-token";
		expect(
			parseMoqPlaybackDescriptor(descriptor(url), runId).resource.url,
		).toBe(url);
	});
	it.each([
		"http://subscriber.example/moq",
		"https://user:secret@subscriber.example/moq",
		"https://subscriber.example/moq#secret",
		" https://subscriber.example/moq",
		"https://subscriber.example/moq\n",
	])("rejects unsafe or ambiguous URLs: %s", (url) => {
		expect(() => parseMoqPlaybackDescriptor(descriptor(url), runId)).toThrow();
	});
});
