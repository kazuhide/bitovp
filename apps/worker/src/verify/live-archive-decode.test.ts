import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", () => ({
	execFile: Object.assign(() => {}, {
		[Symbol.for("nodejs.util.promisify.custom")]: mocks.exec,
	}),
}));

import { inspectArchiveBytes } from "./live-archive";

const streams = [
	{
		codec_type: "video",
		codec_name: "h264",
		duration: "2",
		nb_read_frames: "60",
	},
	{
		codec_type: "audio",
		codec_name: "aac",
		duration: "2",
		nb_read_frames: "94",
	},
	{
		codec_type: "audio",
		codec_name: "aac",
		duration: "2",
		nb_read_frames: "94",
	},
];
const inspect = () =>
	inspectArchiveBytes(
		(async function* () {
			yield Buffer.from("abc");
		})(),
		3,
		["h264", "aac", "aac"],
		new AbortController().signal,
	);

beforeEach(() => {
	mocks.exec
		.mockReset()
		.mockResolvedValue({ stdout: JSON.stringify({ streams }), stderr: "" });
});

it("strictly decodes all planned tracks, including additional audio, then removes temporary bytes", async () => {
	await expect(inspect()).resolves.toMatchObject({
		bytes: 3,
		avSync: "UNVERIFIED",
	});
	const args = mocks.exec.mock.calls[1]?.[1] as string[];
	expect(args.slice(args.indexOf("-map"), args.indexOf("-map") + 2)).toEqual([
		"-map",
		"0",
	]);
	const file = args[args.indexOf("-i") + 1];
	assert.ok(file);
	await expect(access(file)).rejects.toThrow();
});

it("rejects ffprobe decode errors even when the tool exits successfully with positive frame counts", async () => {
	mocks.exec.mockResolvedValueOnce({
		stdout: JSON.stringify({ streams }),
		stderr: "audio decode error",
	});
	await expect(inspect()).rejects.toThrow();
	expect(mocks.exec).toHaveBeenCalledTimes(1);
	const args = mocks.exec.mock.calls[0]?.[1] as string[];
	const file = args[args.indexOf("-i") + 1];
	assert.ok(file);
	await expect(access(file)).rejects.toThrow();
});
