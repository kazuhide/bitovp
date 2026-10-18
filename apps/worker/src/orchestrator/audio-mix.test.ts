import {
	AudioMixChannelType,
	AudioMixInputChannelLayout,
	AudioMixSourceChannelType,
} from "@bitmovin/api-sdk";
import { AUDIO_MIX_CHANNEL_TYPES, AUDIO_MIX_LAYOUTS } from "@bitovp/core";
import { afterEach, expect, it, vi } from "vitest";
import { executeStep } from "./executor";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());
it("uses every actual SDK enum wire value", () => {
	expect([...AUDIO_MIX_LAYOUTS].sort()).toEqual(
		Object.values(AudioMixInputChannelLayout).sort(),
	);
	expect([...AUDIO_MIX_CHANNEL_TYPES].sort()).toEqual(
		Object.values(AudioMixChannelType).sort(),
	);
	expect([...AUDIO_MIX_CHANNEL_TYPES].sort()).toEqual(
		Object.values(AudioMixSourceChannelType).sort(),
	);
});
it("executes two source refs through actual SDK serialization and audit", async () => {
	const bodies: unknown[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			expect(new URL(url).pathname).toBe(
				"/v1/encoding/encodings/enc-id/input-streams/audio-mix",
			);
			bodies.push(JSON.parse(init.body as string));
			return new Response(
				JSON.stringify({ data: { result: { id: "mix-id" } } }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}),
	);
	const sdk = createBitmovinSdkOps(
		{ apiKey: "test-only", tenantOrgId: null, bitmovinAccountId: "account" },
		async () => {},
	);
	const result = await executeStep(
		{
			step: "audioMix:mix",
			kind: "CREATE_AUDIO_MIX_INPUT_STREAM",
			refs: {
				encodingId: "encoding",
				source0: "ingest:first",
				source1: "ingest:second",
			},
			payload: {
				channelLayout: "STEREO",
				audioMixChannels: [
					{
						sourceRef: "source0",
						outputChannelType: "FRONT_LEFT",
						sourceChannels: [
							{ type: "CHANNEL_NUMBER", channelNumber: 0, gain: 0 },
						],
					},
					{
						sourceRef: "source1",
						outputChannelType: "FRONT_RIGHT",
						sourceChannels: [{ type: "CENTER" }],
					},
				],
			},
		},
		{
			sdk,
			ids: new Map([
				["encoding", "enc-id"],
				["ingest:first", "first-id"],
				["ingest:second", "second-id"],
			]),
			resolveCredential: vi.fn(),
			poll: { intervalMs: 1, timeoutMs: 50, sleep: () => Promise.resolve() },
		},
	);
	expect(result.resourceId).toBe("mix-id");
	expect(bodies).toEqual([
		{
			type: "AUDIO_MIX",
			channelLayout: "STEREO",
			audioMixChannels: [
				{
					inputStreamId: "first-id",
					outputChannelType: "FRONT_LEFT",
					sourceChannels: [
						{ type: "CHANNEL_NUMBER", channelNumber: 0, gain: 0 },
					],
				},
				{
					inputStreamId: "second-id",
					outputChannelType: "FRONT_RIGHT",
					sourceChannels: [{ type: "CENTER" }],
				},
			],
		},
	]);
});
