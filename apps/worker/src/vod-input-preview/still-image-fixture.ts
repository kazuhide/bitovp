import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VodInputImagePrepareRequest } from "@bitovp/core/vod-input-timeline";
import type { ObjectStorageBrowser } from "@bitovp/storage";
import { runMediaProcess } from "../library-editing/process";
import { renderVodInputPreview } from "./render";
import { prepareVodInputImage } from "./still-image";

const common = [
	"-v",
	"error",
	"-nostdin",
	"-cpucount",
	"1",
	"-filter_threads",
	"1",
	"-filter_complex_threads",
	"1",
];
const exif = (value: number) => {
	const bytes = Buffer.alloc(36);
	bytes[0] = 255;
	bytes[1] = 225;
	bytes.writeUInt16BE(34, 2);
	bytes.write("Exif\0\0II", 4);
	bytes.writeUInt16LE(42, 12);
	bytes.writeUInt32LE(8, 14);
	bytes.writeUInt16LE(1, 18);
	bytes.writeUInt16LE(0x112, 20);
	bytes.writeUInt16LE(3, 22);
	bytes.writeUInt32LE(1, 24);
	bytes.writeUInt16LE(value, 28);
	return bytes;
};

/** Real local media and range storage only; no provider calls. Added inside the existing media gate. */
export async function runStillImageFixture(signal: AbortSignal) {
	const directory = await mkdtemp(join(tmpdir(), "bitovp-vod-images-"));
	try {
		const png = join(directory, "alpha.png"),
			jpg = join(directory, "quadrants.jpg");
		await runMediaProcess(
			"ffmpeg",
			[
				...common,
				"-f",
				"lavfi",
				"-i",
				"color=black@0.0:s=200x100:r=1,format=rgba,drawbox=x=0:y=0:w=100:h=100:color=red@1:t=fill:replace=1",
				"-frames:v",
				"1",
				"-threads",
				"1",
				png,
			],
			{ signal },
		);
		await runMediaProcess(
			"ffmpeg",
			[
				...common,
				"-f",
				"lavfi",
				"-i",
				"color=black:s=200x100:r=1,drawbox=x=0:y=0:w=100:h=50:color=red:t=fill,drawbox=x=100:y=0:w=100:h=50:color=lime:t=fill,drawbox=x=0:y=50:w=100:h=50:color=blue:t=fill,drawbox=x=100:y=50:w=100:h=50:color=yellow:t=fill",
				"-frames:v",
				"1",
				"-c:v",
				"mjpeg",
				"-q:v",
				"2",
				"-threads",
				"1",
				jpg,
			],
			{ signal },
		);
		const objects = new Map<string, string>([["alpha.png", png]]);
		const originalJpeg = await readFile(jpg);
		for (let orientation = 1; orientation <= 8; orientation++) {
			const path = join(directory, `image-${orientation}.jpg`);
			await writeFile(
				path,
				Buffer.concat([
					originalJpeg.subarray(0, 2),
					exif(orientation),
					originalJpeg.subarray(2),
				]),
			);
			objects.set(`image-${orientation}.jpg`, path);
		}
		const objectHead = async (key: string) => {
			const path = objects.get(key);
			assert.ok(path);
			return {
				size: (await stat(path)).size,
				etag:
					'"' +
					createHash("sha256")
						.update(await readFile(path))
						.digest("hex") +
					'"',
			};
		};
		let uploads = 0;
		const browser: ObjectStorageBrowser = {
			listBuckets: async () => ["original", "prepared"],
			listObjects: async () => ({ objects: [], prefixes: [] }),
			headObject: async ({ key }) => objectHead(key),
			getObject: async ({ key, range, expect }) => {
				assert.deepEqual(expect, await objectHead(key));
				assert.ok(range?.end !== undefined);
				const path = objects.get(key);
				assert.ok(path);
				return createReadStream(path, { start: range.start, end: range.end });
			},
			putObject: async ({ bucket, key, filePath }) => {
				assert.equal(bucket, "prepared");
				assert.ok(key.includes("/bitovp-generated-inputs/"));
				const path = join(directory, `${randomUUID()}.mp4`);
				await copyFile(filePath, path);
				objects.set(key, path);
				uploads++;
			},
		};
		const browserFor = async () => browser;
		const credentialId = randomUUID(),
			organizationId = randomUUID();
		const evidenceDirectory = process.env.BITOVP_VOD_INPUT_IMAGE_EVIDENCE_DIR;
		if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true });
		for (let orientation = 0; orientation <= 8; orientation++) {
			const objectKey =
				orientation === 0 ? "alpha.png" : `image-${orientation}.jpg`;
			const request: VodInputImagePrepareRequest = {
				kind: "IMAGE_PREPARE",
				source: { key: "cover", credentialId, bucket: "original", objectKey },
				durationMs: orientation === 0 ? 5000 : orientation === 6 ? 1234 : 1000,
				output: {
					credentialId,
					bucket: "prepared",
					prefix: "generated-fixture",
				},
				sourceIdentity: await objectHead(objectKey),
			};
			const work = join(directory, `work-${orientation}`);
			await mkdir(work);
			const prepared = await prepareVodInputImage({
				request,
				organizationId,
				taskId: randomUUID(),
				attemptId: randomUUID(),
				directory: work,
				browserFor,
				signal,
				execute: async (binary, argv, options) => {
					const result = await runMediaProcess(binary, argv, options);
					if (binary === "ffprobe" && evidenceDirectory) {
						const probe = JSON.parse(result.stdout);
						await writeFile(
							join(evidenceDirectory, `probe-${orientation}.json`),
							JSON.stringify({ streams: probe.streams }, null, 2),
						);
					}
					return result;
				},
			});
			const path = objects.get(prepared.source.objectKey);
			assert.ok(path);
			if (evidenceDirectory) {
				await copyFile(
					path,
					join(evidenceDirectory, `still-image-${orientation}.mp4`),
				);
				await writeFile(
					join(evidenceDirectory, `still-image-${orientation}.json`),
					JSON.stringify(prepared, null, 2),
				);
				if (orientation === 0)
					await copyFile(png, join(evidenceDirectory, "alpha-source.png"));
			}
			assert.ok(prepared.facts.durationMs >= request.durationMs);
			assert.ok((prepared.facts.audio?.durationMs ?? 0) >= request.durationMs);
			const pixels = join(directory, `pixels-${orientation}.rgb`);
			const crop =
				orientation >= 5 ? "crop=540:1080:690:0" : "crop=1920:960:0:60";
			await runMediaProcess(
				"ffmpeg",
				[
					...common,
					"-i",
					path,
					"-frames:v",
					"1",
					"-vf",
					`${crop},format=rgb24,scale=2:2:flags=neighbor`,
					"-f",
					"rawvideo",
					"-pix_fmt",
					"rgb24",
					pixels,
				],
				{ signal },
			);
			const rgb = await readFile(pixels);
			if (orientation === 0) {
				assert.ok(
					rgb[0] !== undefined && rgb[0] > 200,
					`alpha PNG displayed pixels=${Array.from(rgb).join(",")}`,
				);
				assert.ok(
					[...rgb.subarray(3, 6)].every((c) => c < 10),
					"transparent PNG is black-matted",
				);
				const pcm = join(directory, "silent.pcm");
				await runMediaProcess(
					"ffmpeg",
					[
						...common,
						"-i",
						path,
						"-t",
						"0.2",
						"-vn",
						"-ac",
						"1",
						"-ar",
						"48000",
						"-f",
						"s16le",
						pcm,
					],
					{ signal },
				);
				const samples = await readFile(pcm);
				for (let i = 0; i < samples.length; i += 2)
					assert.ok(Math.abs(samples.readInt16LE(i)) < 3);
				const previewDir = join(directory, "preview");
				await mkdir(previewDir);
				const clip = {
					id: randomUUID(),
					sourceKey: prepared.source.key,
					startMs: 0,
					inMs: 0,
					outMs: request.durationMs,
				};
				const preview = await renderVodInputPreview({
					browserFor,
					signal,
					sources: [prepared.source],
					facts: [prepared.facts],
					directory: previewDir,
					request: {
						kind: "PREVIEW",
						probeId: randomUUID(),
						document: {
							schemaVersion: 2,
							id: randomUUID(),
							audioEnabled: true,
							durationMs: request.durationMs,
							videoClips: [clip],
							audioClips: [clip],
						},
						range: { startMs: 0, durationMs: request.durationMs },
					},
				});
				assert.ok(
					Math.abs(preview.durationMs - 5000) < 40,
					"prepared image is a normal preview source",
				);
				if (evidenceDirectory)
					await copyFile(
						preview.path,
						join(evidenceDirectory, "still-image-preview.mp4"),
					);
			} else {
				const expected = [
					[0, 1, 2, 3],
					[1, 0, 3, 2],
					[3, 2, 1, 0],
					[2, 3, 0, 1],
					[0, 2, 1, 3],
					[2, 0, 3, 1],
					[3, 1, 2, 0],
					[1, 3, 0, 2],
				][orientation - 1];
				assert.ok(expected);
				const colors = [
					[255, 0, 0],
					[0, 255, 0],
					[0, 0, 255],
					[255, 255, 0],
				];
				for (let pixel = 0; pixel < 4; pixel++) {
					const target = colors[expected[pixel] ?? -1];
					assert.ok(target);
					for (let channel = 0; channel < 3; channel++)
						assert.ok(
							Math.abs(
								(rgb[pixel * 3 + channel] ?? -999) - (target[channel] ?? 999),
							) < 25,
							"EXIF orientation " +
								orientation +
								" preserves quadrant " +
								pixel,
						);
				}
			}
		}
		assert.equal(uploads, 9);
		console.log(
			"still images: alpha PNG black matte, JPEG EXIF orientations 1..8, silent AAC, exact/1234ms clocks, immutable storage SHA and normal preview passed",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
