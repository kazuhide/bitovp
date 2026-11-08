/** Synthetic-only gate; real-content admission is tested through BitOVP UI. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeEditingMedia } from "./normalization";
import { runMediaProcess } from "./process";

const digest = (value: Buffer) =>
	createHash("sha256").update(value).digest("hex");

test("untagged CFR30 H264 is normalized with honest color evidence", {
	timeout: 60000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "bitovp-untagged-native-"));
	try {
		const original = join(directory, "source.mp4");
		const destination = join(directory, "prepared.mp4");
		await runMediaProcess("ffmpeg", [
			"-hide_banner",
			"-v",
			"error",
			"-nostdin",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=s=160x90:r=30",
			"-an",
			"-c:v",
			"libx264",
			"-threads",
			"2",
			"-pix_fmt",
			"yuv420p",
			"-frames:v",
			"30",
			"-movflags",
			"+faststart",
			original,
		]);
		const before = await readFile(original);
		const result = await normalizeEditingMedia({
			sourcePath: original,
			destinationPath: destination,
			expectedSourceSha256: digest(before),
		});
		assert.equal(result.path, destination);
		assert.equal(result.normalization.mode, "NORMALIZE");
		assert.equal(
			result.normalization.source.colorProfile,
			"BT709_8BIT_LIMITED_ASSUMED",
		);
		assert.equal(result.facts.frameCount, 30);
		assert.equal(result.facts.durationUs, 1_000_000);
		assert.equal(result.facts.width, 160);
		assert.equal(result.facts.height, 90);
		assert.deepEqual(
			result.normalization.sourceFrameIndex,
			Array.from({ length: 30 }, (_, frame) => frame),
		);
		assert.notEqual(result.preparedSha256, result.originalSha256);
		const streams = result.facts.probe.streams as Record<string, unknown>[];
		assert.equal(streams[0]?.color_primaries, "bt709");
		assert.equal(streams[0]?.color_transfer, "bt709");
		assert.equal(streams[0]?.color_space, "bt709");
		assert.deepEqual(await readFile(original), before);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
