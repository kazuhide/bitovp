import { readFileSync } from "node:fs";
import { join } from "node:path";
import { liveChannelPlanSchema } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { bindLiveMslOutputs } from "./runner-live";

const FIXTURES = join(
	import.meta.dirname,
	"../../../../packages/core/src/live/__fixtures__",
);

const plan = (name: string) =>
	liveChannelPlanSchema.parse(
		JSON.parse(readFileSync(join(FIXTURES, `${name}.plan.json`), "utf8")),
	);

const credential = {
	credentialId: "00000000-0000-4000-8000-000000000003",
	streamId: 2_126_636,
	eventName: "release20260831",
};

describe("bindLiveMslOutputs — credential identity to the exact event root", () => {
	it("binds direct MSL4 HLS/TS to /hls/live/{streamId}/{eventName}/", () => {
		const bindings = bindLiveMslOutputs(plan("live-akamai-msl-ts"), {
			...credential,
			edgeBaseUrl:
				"https://delivery.akamaized.net/hls/live/2126636/release20260831/",
		});
		expect(bindings).toEqual([
			{
				outputKey: "origin",
				credentialId: credential.credentialId,
				streamId: 2_126_636,
				eventName: "release20260831",
				streamFormat: "HLS",
				mslVersion: "MSL4",
				eventRoot:
					"https://delivery.akamaized.net/hls/live/2126636/release20260831/",
			},
		]);
	});

	it("binds direct MSL4 CMAF/fMP4 to /cmaf/live/{streamId}/{eventName}/", () => {
		const bindings = bindLiveMslOutputs(plan("live-akamai-msl"), {
			...credential,
			edgeBaseUrl:
				"https://delivery.akamaized.net/cmaf/live/2126636/release20260831/",
		});
		expect(bindings[0]).toMatchObject({
			outputKey: "origin",
			streamFormat: "CMAF",
			mslVersion: "MSL4",
			eventRoot:
				"https://delivery.akamaized.net/cmaf/live/2126636/release20260831/",
		});
	});

	it.each([
		[
			"an old event",
			"https://delivery.akamaized.net/hls/live/2126636/old-event/",
		],
		[
			"another stream",
			"https://delivery.akamaized.net/hls/live/9999999/release20260831/",
		],
		[
			"the wrong format root",
			"https://delivery.akamaized.net/cmaf/live/2126636/release20260831/",
		],
	])("REFUSES %s before the channel is created", (_name, edgeBaseUrl) => {
		expect(() =>
			bindLiveMslOutputs(plan("live-akamai-msl-ts"), {
				...credential,
				edgeBaseUrl,
			}),
		).toThrow(/does not match.*streamId.*eventName.*streamFormat/i);
	});

	it("persists only the safe credential identity and never a publishing secret", () => {
		const serialized = JSON.stringify(
			bindLiveMslOutputs(plan("live-akamai-msl-ts"), {
				...credential,
				edgeBaseUrl:
					"https://delivery.akamaized.net/hls/live/2126636/release20260831/",
			}),
		);
		expect(serialized).toContain(credential.credentialId);
		expect(serialized).not.toMatch(/password|username|secret|token/i);
	});
});
