/** Native gate: pnpm --filter @bitovp/worker exec tsx --test src/library-editing/normalization.media.ts */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	cfrTimeMapSchema,
	editingNormalizationEvidenceSchema,
} from "@bitovp/core";
import { probeEditingMedia } from "./media";
import {
	normalizeEditingMedia,
	probeEditingNormalizationSource,
} from "./normalization";
import { runMediaProcess } from "./process";

const digest = (value: Buffer) =>
	createHash("sha256").update(value).digest("hex");
async function source(path: string, fps = "24/1", frames = 48, vfr = false) {
	const [num, den] = fps.split("/").map(Number);
	await runMediaProcess("ffmpeg", [
		"-hide_banner",
		"-v",
		"error",
		"-nostdin",
		"-cpucount",
		"2",
		"-filter_threads",
		"1",
		"-filter_complex_threads",
		"1",
		"-f",
		"lavfi",
		"-threads",
		"1",
		"-i",
		`nullsrc=s=160x90:r=${fps},geq=lum='32+mod(N,8)*24':cb=128:cr=128`,
		"-f",
		"lavfi",
		"-threads",
		"1",
		"-i",
		"sine=frequency=440:sample_rate=48000:duration=3",
		"-vf",
		vfr ? "settb=1/120000,setpts=PTS+if(eq(N\\,5)\\,1200\\,0)" : "null",
		"-af",
		"volume=enable='lt(t,0.5)':volume=0",
		"-c:v",
		"libx264",
		"-threads",
		"2",
		"-pix_fmt",
		"yuv420p",
		"-color_primaries",
		"bt709",
		"-color_trc",
		"bt709",
		"-colorspace",
		"bt709",
		"-x264-params",
		"colorprim=bt709:transfer=bt709:colormatrix=bt709",
		"-color_range",
		"tv",
		"-c:a",
		"aac",
		"-ar",
		"48000",
		"-ac",
		"1",
		"-frames:v",
		String(frames),
		"-t",
		String((frames * (den ?? 1)) / (num ?? 24)),
		"-fps_mode",
		"passthrough",
		...(vfr ? ["-enc_time_base", "1/120000"] : []),
		path,
	]);
}
async function grayFrames(path: string, output: string) {
	await runMediaProcess("ffmpeg", [
		"-v",
		"error",
		"-nostdin",
		"-cpucount",
		"2",
		"-filter_threads",
		"1",
		"-filter_complex_threads",
		"1",
		"-threads",
		"1",
		"-i",
		path,
		"-map",
		"0:v:0",
		"-an",
		"-vf",
		"scale=16:16",
		"-pix_fmt",
		"gray",
		"-fps_mode",
		"passthrough",
		"-f",
		"rawvideo",
		"-threads",
		"1",
		output,
	]);
	const bytes = await readFile(output);
	assert.equal(bytes.length % 256, 0);
	return Array.from(
		{ length: bytes.length / 256 },
		(_, frame) =>
			bytes
				.subarray(frame * 256, frame * 256 + 256)
				.reduce((sum, n) => sum + n, 0) / 256,
	);
}
async function audioOnset(path: string, output: string) {
	await runMediaProcess("ffmpeg", [
		"-v",
		"error",
		"-nostdin",
		"-cpucount",
		"2",
		"-filter_threads",
		"1",
		"-filter_complex_threads",
		"1",
		"-threads",
		"1",
		"-i",
		path,
		"-map",
		"0:a:0",
		"-vn",
		"-ac",
		"1",
		"-ar",
		"48000",
		"-c:a",
		"pcm_f32le",
		"-f",
		"f32le",
		output,
	]);
	const bytes = await readFile(output);
	for (let start = 0; start + 480 * 4 <= bytes.length; start += 480 * 4) {
		let sum = 0;
		for (let i = 0; i < 480; i++) sum += bytes.readFloatLE(start + i * 4) ** 2;
		if (Math.sqrt(sum / 480) > 0.03) return start / 4 / 48000;
	}
	throw new Error("Expected the original audio cue");
}

for (const [fps, frames] of [
	["24/1", 48],
	["25/1", 50],
	["30000/1001", 60],
	["30/1", 60],
] as const) {
	test(`native ${fps} SDR normalization preserves source indexing and audio clock`, {
		timeout: 60000,
	}, async () => {
		const dir = await mkdtemp(join(tmpdir(), "bitovp-normalize-native-"));
		try {
			const original = join(dir, "source.mp4"),
				destination = join(dir, "prepared.mp4");
			await source(original, fps, frames);
			const bytes = await readFile(original);
			const result = await normalizeEditingMedia({
				sourcePath: original,
				destinationPath: destination,
				expectedSourceSha256: digest(bytes),
			});
			assert.equal(result.originalSha256, digest(bytes));
			assert.equal(result.preparedSha256, digest(await readFile(result.path)));
			assert.equal(result.facts.width, 160);
			assert.equal(result.facts.height, 90);
			assert.deepEqual(result.facts.fps, { num: 30, den: 1 });
			assert.equal(result.facts.frameCount, 60);
			assert.equal(result.facts.durationUs, 2_000_000);
			assert.equal(result.facts.hasAudio, true);
			assert.equal(result.normalization.schemaVersion, 1);
			assert.equal(result.normalization.profile, "SDR_CFR30_INDEXED_V1");
			editingNormalizationEvidenceSchema.parse(result.normalization);
			const before = await grayFrames(original, join(dir, "original.gray"));
			const after = await grayFrames(result.path, join(dir, "prepared.gray"));
			assert.equal(before.length, frames);
			assert.equal(after.length, 60);
			for (let j = 0; j < after.length; j++) {
				const index = result.normalization.sourceFrameIndex[j];
				assert.notEqual(index, undefined);
				assert.ok(
					Math.abs((after[j] ?? -100) - (before[index ?? 0] ?? 100)) <= 4,
					`Output frame ${j} must sample original frame ${index}`,
				);
			}
			assert.ok(
				Math.abs(
					(await audioOnset(original, join(dir, "original.f32"))) -
						(await audioOnset(result.path, join(dir, "prepared.f32"))),
				) <= 0.025,
			);
			assert.deepEqual(await readFile(original), bytes);
			if (fps === "30/1") {
				assert.equal(result.path, original);
				assert.equal(result.normalization.mode, "IDENTITY_COPY");
				assert.equal(result.preparedSha256, result.originalSha256);
				await assert.rejects(access(destination));
			} else {
				assert.equal(result.path, destination);
				assert.equal(result.normalization.mode, "NORMALIZE");
				assert.notEqual(result.preparedSha256, result.originalSha256);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
}
for (const [fps, frames, expectedFrames] of [
	["24/1", 49, 61],
	["30/1", 31, 31],
] as const) {
	test(`native ${fps} ${frames} frames retain a complete CFR30 map at a fractional microsecond end`, {
		timeout: 60000,
	}, async () => {
		const dir = await mkdtemp(join(tmpdir(), "bitovp-normalize-end-"));
		try {
			const original = join(dir, "source.mp4");
			await source(original, fps, frames);
			const bytes = await readFile(original);
			const result = await normalizeEditingMedia({
				sourcePath: original,
				destinationPath: join(dir, "prepared.mp4"),
				expectedSourceSha256: digest(bytes),
			});
			assert.equal(result.facts.frameCount, expectedFrames);
			assert.equal(
				result.facts.durationUs,
				Math.ceil((expectedFrames * 1_000_000) / 30),
			);
			const id = "00000000-0000-4000-8000-000000000001";
			cfrTimeMapSchema.parse({
				id,
				mediaVersionId: id,
				kind: "CFR",
				fps: { num: 30, den: 1 },
				sourceStartUs: 0,
				sourceEndUs: result.facts.durationUs,
				editingStartFrame: 0,
				editingEndFrame: expectedFrames,
			});
			assert.deepEqual(await readFile(original), bytes);
			if (fps === "30/1") {
				assert.equal(result.path, original);
				assert.equal(result.preparedSha256, result.originalSha256);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
}
test("native identity normalization checks both clocks with one video decode", {
	timeout: 60000,
}, async () => {
	const dir = await mkdtemp(join(tmpdir(), "bitovp-normalize-single-decode-"));
	try {
		const original = join(dir, "source.mp4");
		const destination = join(dir, "prepared.mp4");
		const trace = join(dir, "probe.jsonl");
		const malformedTime = join(dir, "malformed-time");
		const shim = join(dir, "ffprobe");
		await source(original, "30/1", 60);
		await writeFile(
			shim,
			`#!/usr/bin/env node
const { appendFileSync, existsSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + "\\n");
const result = spawnSync("ffprobe", args, { encoding: "utf8" });
let stdout = result.stdout ?? "";
if (existsSync(${JSON.stringify(malformedTime)}) && args.includes("compact=p=1:nk=0")) {
	stdout = stdout.replace("best_effort_timestamp_time=0.000000", "best_effort_timestamp_time=0.100000");
}
process.stdout.write(stdout);
process.stderr.write(result.stderr ?? "");
process.exitCode = result.status ?? 1;
`,
			{ mode: 0o700 },
		);
		const input = {
			sourcePath: original,
			destinationPath: destination,
			expectedSourceSha256: digest(await readFile(original)),
			ffprobePath: shim,
		};
		const result = await normalizeEditingMedia(input);
		assert.equal(result.normalization.mode, "IDENTITY_COPY");
		assert.deepEqual(
			result.facts,
			await probeEditingMedia({ sourcePath: original }),
		);
		assert.deepEqual(
			result.normalization.source,
			(await probeEditingNormalizationSource({ sourcePath: original })).source,
		);
		const calls: string[][] = (await readFile(trace, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(
			calls.filter((args) => args.includes("-show_streams")).length,
			1,
		);
		assert.equal(
			calls.filter(
				(args) => args.includes("v:0") && args.includes("-show_frames"),
			).length,
			1,
		);
		assert.equal(
			calls.filter(
				(args) => args.includes("a:0") && args.includes("-show_frames"),
			).length,
			1,
		);
		await writeFile(malformedTime, "");
		await assert.rejects(normalizeEditingMedia(input), {
			code: "UNSUPPORTED_MEDIA",
		});
		await assert.rejects(access(destination));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("native VFR is rejected before a normalized artifact is published", {
	timeout: 60000,
}, async () => {
	const dir = await mkdtemp(join(tmpdir(), "bitovp-normalize-vfr-"));
	try {
		const original = join(dir, "vfr.mp4"),
			destination = join(dir, "prepared.mp4");
		await source(original, "24/1", 24, true);
		const timeline = await runMediaProcess("ffprobe", [
			"-v",
			"error",
			"-threads",
			"1",
			"-i",
			original,
			"-select_streams",
			"v:0",
			"-show_frames",
			"-show_entries",
			"frame=best_effort_timestamp_time",
			"-of",
			"csv=p=0",
		]);
		const pts = timeline.stdout
			.split(/\r?\n/)
			.filter((row) => row.trim())
			.map((row) => Number(row.split(",")[0]));
		assert.ok(
			Math.abs((pts[5] ?? 0) - 5 / 24) > 0.005,
			"The negative fixture must contain an actual variable PTS",
		);
		await assert.rejects(
			normalizeEditingMedia({
				sourcePath: original,
				destinationPath: destination,
				expectedSourceSha256: digest(await readFile(original)),
			}),
		);
		await assert.rejects(access(destination));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("native changed source or existing destination is never repaired or overwritten", {
	timeout: 60000,
}, async () => {
	const dir = await mkdtemp(join(tmpdir(), "bitovp-normalize-fence-"));
	try {
		const original = join(dir, "source.mp4"),
			destination = join(dir, "existing.mp4");
		await source(original);
		const originalBytes = await readFile(original);
		await writeFile(destination, "preserved");
		await assert.rejects(
			normalizeEditingMedia({
				sourcePath: original,
				destinationPath: destination,
				expectedSourceSha256: "0".repeat(64),
			}),
			{ code: "SOURCE_CHANGED" },
		);
		await assert.rejects(
			normalizeEditingMedia({
				sourcePath: original,
				destinationPath: destination,
				expectedSourceSha256: digest(originalBytes),
			}),
			{ code: "EEXIST" },
		);
		assert.equal(await readFile(destination, "utf8"), "preserved");
		assert.deepEqual(await readFile(original), originalBytes);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
