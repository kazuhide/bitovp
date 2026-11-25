import { afterEach, expect, it, vi } from "vitest";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());
it("sends PCM, original audio and single-file WAV on their installed SDK routes", async () => {
	const calls: { path: string; method: string; body: unknown }[] = [];
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		calls.push({
			path: new URL(url).pathname,
			method: String(init.method),
			body: JSON.parse(String(init.body)),
		});
		return new Response(
			JSON.stringify({ data: { result: { id: "created" } } }),
			{ status: 201, headers: { "content-type": "application/json" } },
		);
	});
	const sdk = createBitmovinSdkOps({ apiKey: "test-only" }, async () => {});
	await sdk.createPcmConfig({
		name: "PCM",
		bitrate: 3072000,
		rate: 48000,
		channelLayout: "STEREO",
		sampleFormat: "S32LE",
	});
	await sdk.createPcmConfig({ name: "defaults", bitrate: 1152000 });
	await sdk.createPassthroughAudioConfig({ name: "copy" });
	await sdk.createProgressiveWavMuxing("enc", {
		streamId: "audio",
		filename: "master.wav",
		destination: { outputId: "out", outputPath: "files/" },
	});
	expect(calls).toEqual([
		{
			method: "POST",
			path: "/v1/encoding/configurations/audio/pcm",
			body: {
				type: "PCM",
				name: "PCM",
				bitrate: 3072000,
				rate: 48000,
				channelLayout: "STEREO",
				sampleFormat: "S32LE",
			},
		},
		{
			method: "POST",
			path: "/v1/encoding/configurations/audio/pcm",
			body: { type: "PCM", name: "defaults", bitrate: 1152000 },
		},
		{
			method: "POST",
			path: "/v1/encoding/configurations/audio/passthrough",
			body: { type: "AUDIO_PASSTHROUGH", name: "copy" },
		},
		{
			method: "POST",
			path: "/v1/encoding/encodings/enc/muxings/progressive-wav",
			body: {
				type: "PROGRESSIVE_WAV",
				filename: "master.wav",
				streams: [{ streamId: "audio" }],
				outputs: [{ outputId: "out", outputPath: "files/" }],
			},
		},
	]);
});
