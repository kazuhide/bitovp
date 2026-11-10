/** pnpm --filter @bitovp/worker exec tsx --test src/vmaf/reference-preparation.media.ts */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { vmafReferencePreparationEvidenceSchema } from "@bitovp/core";
import { createNodeProcessRunner } from "../feeder/process-runner";
import { presentationTransformReason } from "./hardware-decode";
import { prepareDisplayScaleReference } from "./reference-preparation";

const digest = (bytes: Buffer) =>
	createHash("sha256").update(bytes).digest("hex");

async function verifyMediaReference(audioFirst: boolean) {
	const directory = await mkdtemp(
		join(tmpdir(), "bitovp-reference-preparation-media-"),
	);
	try {
		const runner = createNodeProcessRunner();
		const originalPath = join(directory, "source.mov"),
			preparedPath = join(directory, "prepared.mov");
		const generated = await runner.run("ffmpeg", [
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
			"testsrc2=s=192x108:r=24",
			...(audioFirst
				? [
						"-f",
						"lavfi",
						"-threads",
						"1",
						"-i",
						"sine=frequency=440:sample_rate=48000:duration=0.5",
						"-map",
						"1:a:0",
						"-map",
						"0:v:0",
						"-c:a",
						"aac",
					]
				: []),
			"-frames:v",
			"12",
			"-c:v",
			"libx264",
			"-bf",
			"2",
			"-threads",
			"1",
			"-pix_fmt",
			"yuv420p",
			"-video_track_timescale",
			"2400",
			originalPath,
		]);
		assert.equal(generated.code, 0, generated.stderr);
		const bytes = await readFile(originalPath);
		const firstHeader = bytes.indexOf(Buffer.from("tkhd"));
		const atom =
			(audioFirst
				? bytes.indexOf(Buffer.from("tkhd"), firstHeader + 4)
				: firstHeader) - 4;
		assert.ok(atom >= 0);
		assert.equal(bytes[atom + 8], 0, "fixture uses version-0 track header");
		const values = [34475, 0, 0, 0, 34467, 0, 0, 0, 1073741824];
		values.forEach((value, index) => {
			bytes.writeInt32BE(value, atom + 48 + index * 4);
		});
		await writeFile(originalPath, bytes);
		const probe = await runner.run("ffprobe", [
			"-v",
			"error",
			"-show_streams",
			"-of",
			"json",
			originalPath,
		]);
		assert.equal(probe.code, 0, probe.stderr);
		const originalVideo = JSON.parse(probe.stdout).streams.find(
			(stream: { codec_type: string }) => stream.codec_type === "video",
		);
		assert.equal(originalVideo.index, audioFirst ? 1 : 0);
		assert.equal(
			presentationTransformReason(originalVideo),
			"CUDA_DISPLAY_MATRIX_REQUIRES_CPU",
		);
		const result = await prepareDisplayScaleReference({
			runner,
			ffmpegPath: "ffmpeg",
			ffprobePath: "ffprobe",
			originalPath,
			preparedPath,
			originalProbe: probe.stdout,
			originalSha256: digest(bytes),
		});
		assert.equal(
			vmafReferencePreparationEvidenceSchema.safeParse(result.evidence).success,
			true,
		);
		assert.equal(result.evidence.packetCount, 12);
		assert.equal(result.evidence.frameCount, 12);
		assert.equal(result.evidence.timeBase, "1/2400");
		assert.deepEqual(result.evidence.sourceDisplayMatrix, values);
		assert.equal(
			result.evidence.preparedSha256,
			digest(await readFile(preparedPath)),
		);
		assert.equal(digest(await readFile(originalPath)), digest(bytes));
		assert.equal(
			presentationTransformReason(JSON.parse(result.probe).streams[0]),
			undefined,
		);
		assert.equal(JSON.parse(result.probe).streams[0].index, 0);
		assert.deepEqual((await readdir(directory)).sort(), [
			"prepared.mov",
			"source.mov",
		]);
		for (const failure of ["frame-receipt", "abort"] as const) {
			const controller = new AbortController();
			const failedPath = join(directory, `${failure}.mov`);
			const failingRunner = {
				...runner,
				async run(...args: Parameters<typeof runner.run>) {
					const result = await runner.run(...args);
					if (failure === "abort" && args[1].includes("copy"))
						controller.abort();
					const output = args[1].at(-1);
					if (
						failure === "frame-receipt" &&
						args[1].includes("framehash") &&
						output?.endsWith("prepared.framehash")
					) {
						const receipt = await readFile(output, "utf8");
						await writeFile(
							output,
							receipt.replace(/, [a-f0-9]{64}\n/, `, ${"0".repeat(64)}\n`),
						);
					}
					return result;
				},
			};
			await assert.rejects(
				prepareDisplayScaleReference({
					runner: failingRunner,
					ffmpegPath: "ffmpeg",
					ffprobePath: "ffprobe",
					originalPath,
					preparedPath: failedPath,
					originalProbe: probe.stdout,
					originalSha256: digest(bytes),
					signal: controller.signal,
				}),
			);
			await assert.rejects(readFile(failedPath));
			assert.equal(digest(await readFile(originalPath)), digest(bytes));
		}
		console.log(
			JSON.stringify({
				ffmpeg: (await runner.run("ffmpeg", ["-version"])).stdout.split(
					"\n",
				)[0],
				ffprobe: (await runner.run("ffprobe", ["-version"])).stdout.split(
					"\n",
				)[0],
				originalVideoIndex: originalVideo.index,
				preparedVideoIndex: 0,
				evidence: result.evidence,
			}),
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("real fractional MOV display scale: complete H264 packets, B-frame timing and decoded rasters survive", () =>
	verifyMediaReference(false));
test("real fractional MOV with audio first: video packets and frames survive stream renumbering one to zero", () =>
	verifyMediaReference(true));
