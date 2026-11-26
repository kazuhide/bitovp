import { expect, it } from "vitest";
import { inspectSinglePassPackets } from "./packet-coverage";

function inspectAudio(
	skipSamples: number,
	discardPadding = 0,
	discarded = true,
) {
	return inspectSinglePassPackets(
		{
			async run(_bin, _argv, options) {
				for (const line of [
					"stream_index=0|duration=512|flags=K__",
					`stream_index=1|duration=1024|flags=K${discarded ? "D" : "_"}_|side_data_type=Skip Samples|skip_samples=${skipSamples}|discard_padding=${discardPadding}`,
					"stream_index=1|duration=1024|flags=K__",
				]) {
					options?.onStdoutLine?.(line);
				}
				return { code: 0, stdout: "", stderr: "" };
			},
		},
		"ffprobe",
		"known-source.mp4",
		{ video: 0, audio: { index: 1, timeBase: "1/48000", sampleRate: "48000" } },
		new AbortController().signal,
	);
}

it("accepts a complete first AAC preroll packet", async () => {
	await expect(inspectAudio(1024)).resolves.toEqual({ video: 1, audio: 2 });
});

it.each([
	[1536, 0, true],
	[512, 0, true],
	[0, 64, false],
	[512, 0, false],
] as const)("rejects an unrepresentable AAC edit (%s, %s, %s)", async (skip, padding, discard) => {
	await expect(inspectAudio(skip, padding, discard)).resolves.toMatchObject({
		error: expect.stringContaining("cannot preserve this source's edit list"),
	});
});
