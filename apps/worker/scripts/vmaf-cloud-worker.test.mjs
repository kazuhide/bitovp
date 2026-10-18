import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { buildVmafCommand } from "../../../packages/core/src/vmaf/command.ts";
import { createContainerCropFixture } from "../../../packages/core/src/vmaf/crop-fixture.test-helper.ts";
import {
	checkpointAuthentication,
	compareAlignmentWindows,
	runCloudWorker,
	safeFailureDiagnostic,
	validateFrameIndexPair,
	validateFullFrameProbe,
	validateManifest,
	validateResult,
} from "./vmaf-cloud-worker.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
function fixture() {
	const content = Buffer.from("immutable media fixture");
	const input = (name) => ({
		url: `https://fixture.invalid/${name}?secret=NEVER_LOG_ME`,
		sha256: sha(content),
		bytes: content.length,
	});
	const manifest = {
		version: 1,
		taskId: "fixture-1",
		deadline: new Date(Date.now() + 60000).toISOString(),
		image: `registry/worker@sha256:${"a".repeat(64)}`,
		reference: input("reference"),
		distorted: input("distorted"),
		modelFile: input("model"),
		scoring: { model: "vmaf_v0.6.1", subsample: 1, psnr: true },
		output: { url: "https://fixture.invalid/output" },
		receipt: { url: "https://fixture.invalid/receipt" },
	};
	const uploads = new Map();
	const requests = [];
	const fetcher = async (url, options) => {
		requests.push({ url, options });
		if (options.method === "PUT") {
			const parts = [];
			for await (const chunk of options.body) parts.push(chunk);
			uploads.set(url, Buffer.concat(parts));
			return new Response(null, { status: 200 });
		}
		return new Response(
			url.endsWith("/manifest") ? JSON.stringify(manifest) : content,
		);
	};
	return { manifest, content, uploads, requests, fetcher };
}
async function fakePrograms(
	dir,
	{ hang = false, truncated = false, missing = false, frames = 3 } = {},
) {
	const ffmpegPath = join(dir, "ffmpeg"),
		ffprobePath = join(dir, "ffprobe");
	await writeFile(
		ffprobePath,
		`#!/usr/bin/env node\nconsole.log(JSON.stringify({streams:[{nb_read_frames:process.argv.at(-1).includes('distorted')?${truncated ? 2 : 3}:3,avg_frame_rate:'24/1'}]}));\n`,
		{ mode: 0o700 },
	);
	await writeFile(
		ffmpegPath,
		`#!/usr/bin/env node\nconst fs=require('node:fs');if(process.argv.includes('-version'))console.log('ffmpeg fixture');else{${hang ? "setInterval(()=>{},1000);" : missing ? "" : `const graph=process.argv[process.argv.indexOf('-filter_complex')+1];if(!graph.includes('settb=AVTB,setpts=N/FRAME_RATE/TB'))process.exit(2);const path=graph.match(/log_path=([^:]+)/)[1];fs.writeFileSync(path,JSON.stringify({frames:Array.from({length:${frames}},(_,frameNum)=>({frameNum,metrics:{vmaf:99,psnr_y:60}}))}));`}}\n`,
		{ mode: 0o700 },
	);
	return { ffmpegPath, ffprobePath };
}
test("strict manifest rejects unsafe URLs, filters, deadlines and sampled cloud metrics", () => {
	for (const mutate of [
		(m) => {
			m.reference.url = "http://localhost/secret";
		},
		(m) => {
			m.scoring.model = "vmaf:log_path=bad";
		},
		(m) => {
			m.scoring.features = ["psnr|name=bad"];
		},
		(m) => {
			m.scoring.subsample = 2;
		},
		(m) => {
			m.deadline = "2000-01-01";
		},
		(m) => {
			m.output.headers = { Host: "bad" };
		},
		(m) => {
			m.scoring.unexpected = true;
		},
	]) {
		const { manifest } = fixture();
		mutate(manifest);
		assert.throws(() => validateManifest(manifest));
	}
});
test("checkpoint and progress are optional signed transfers with a pinned read digest", () => {
	const { manifest } = fixture();
	manifest.progress = { url: "https://fixture.invalid/progress" };
	manifest.checkpoint = {
		write: { url: "https://fixture.invalid/checkpoint" },
		authenticationKey: "b".repeat(64),
	};
	assert.equal(validateManifest(manifest), manifest);
	delete manifest.checkpoint.authenticationKey;
	assert.throws(() => validateManifest(manifest));
	manifest.checkpoint.authenticationKey = "b".repeat(64);
	manifest.checkpoint.readUrl = "https://fixture.invalid/previous";
	assert.throws(() => validateManifest(manifest));
	manifest.checkpoint.sha256 = "a".repeat(64);
	assert.equal(validateManifest(manifest), manifest);
});
test("coverage rejects missing, repeated and nonfinite frames", () => {
	assert.throws(() => validateResult({ frames: [] }, {}), /EMPTY_RESULT/);
	assert.throws(
		() =>
			validateResult({ frames: [{ frameNum: 1, metrics: { vmaf: 99 } }] }, {}),
		/INVALID_FRAME_COVERAGE/,
	);
	assert.throws(
		() =>
			validateResult({ frames: [{ frameNum: 0, metrics: { vmaf: NaN } }] }, {}),
		/INVALID_FRAME_COVERAGE/,
	);
	assert.throws(
		() =>
			validateResult(
				{ frames: [{ frameNum: 0, metrics: { vmaf: 99 } }] },
				{},
				2,
			),
		/INCOMPLETE_FRAME_COVERAGE/,
	);
});
test("uses the mounted task scratch directory and removes it after scoring", async () => {
	const dir = await mkdtemp("/tmp/cloud-mounted-test-");
	const previous = process.env.TMPDIR;
	process.env.TMPDIR = dir;
	let usedMountedDisk = false;
	try {
		const f = fixture();
		const binaries = await fakePrograms(dir);
		await runCloudWorker("https://fixture.invalid/manifest", {
			...binaries,
			fetcher: async (...args) => {
				usedMountedDisk ||= (await readdir(dir)).some((entry) =>
					entry.startsWith("bitovp-vmaf-cloud-"),
				);
				return f.fetcher(...args);
			},
		});
		assert.equal(usedMountedDisk, true);
		assert.equal(
			(await readdir(dir)).some((entry) =>
				entry.startsWith("bitovp-vmaf-cloud-"),
			),
			false,
		);
	} finally {
		if (previous === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previous;
		await rm(dir, { recursive: true, force: true });
	}
});
test("verified input, full coverage and successful output precede receipt", async () => {
	const dir = await mkdtemp("/tmp/cloud-test-");
	try {
		const f = fixture();
		const binaries = await fakePrograms(dir);
		const receipt = await runCloudWorker("https://fixture.invalid/manifest", {
			...binaries,
			fetcher: f.fetcher,
		});
		assert.equal(receipt.frames, 3);
		assert.equal(receipt.referenceFrames, 3);
		assert.ok(Date.parse(receipt.startedAt) <= Date.parse(receipt.completedAt));
		assert.ok(
			Object.values(receipt.timingsMs).every(
				(n) => Number.isFinite(n) && n >= 0,
			),
		);
		assert.equal(
			receipt.resultSha256,
			sha(f.uploads.get(f.manifest.output.url)),
		);
		assert.equal(receipt.modelSha256, f.manifest.modelFile.sha256);
		assert.deepEqual(
			JSON.parse(f.uploads.get(f.manifest.receipt.url)),
			receipt,
		);
		assert.deepEqual(
			[...f.uploads.keys()],
			[f.manifest.output.url, f.manifest.receipt.url],
		);
		assert.ok(f.requests.every((r) => r.options.redirect === "error"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
for (const [name, configuration, mutate, expected] of [
	[
		"bad SHA",
		{},
		(m) => {
			m.reference.sha256 = "0".repeat(64);
		},
		/INPUT_IDENTITY_MISMATCH/,
	],
	[
		"truncated media",
		{ truncated: true },
		() => {},
		/INPUT_FRAME_COUNT_MISMATCH/,
	],
	["missing output", { missing: true }, () => {}, /ENOENT/],
	[
		"incomplete scored frames",
		{ frames: 2 },
		() => {},
		/INCOMPLETE_FRAME_COVERAGE/,
	],
	[
		"deadline kills stalled process",
		{ hang: true },
		(m) => {
			m.deadline = new Date(Date.now() + 1200).toISOString();
		},
		/DEADLINE_EXCEEDED/,
	],
])
	test(`${name} cannot publish a success receipt`, async () => {
		const dir = await mkdtemp("/tmp/cloud-test-");
		try {
			const f = fixture();
			mutate(f.manifest);
			const binaries = await fakePrograms(dir, configuration);
			await assert.rejects(
				runCloudWorker("https://fixture.invalid/manifest", {
					...binaries,
					fetcher: f.fetcher,
				}),
				expected,
			);
			assert.equal(f.uploads.size, 0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
test("failed output upload prevents receipt", async () => {
	const dir = await mkdtemp("/tmp/cloud-test-");
	try {
		const f = fixture();
		const binaries = await fakePrograms(dir);
		await assert.rejects(
			runCloudWorker("https://fixture.invalid/manifest", {
				...binaries,
				fetcher: (url, options) =>
					url === f.manifest.output.url
						? Promise.resolve(new Response(null, { status: 403 }))
						: f.fetcher(url, options),
			}),
			/UPLOAD_FAILED/,
		);
		assert.equal(f.uploads.size, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("real ffmpeg scores every decoded frame through download and receipt", async (t) => {
	const command = promisify(execFile);
	const ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg",
		ffprobePath = process.env.FFPROBE_PATH ?? "ffprobe";
	let model;
	for (const path of [
		process.env.VMAF_MODEL_DIR &&
			join(process.env.VMAF_MODEL_DIR, "vmaf_v0.6.1.json"),
		"/opt/vmaf/model/vmaf_v0.6.1.json",
		"/opt/homebrew/Cellar/libvmaf/3.2.1/share/libvmaf/model/vmaf_v0.6.1.json",
	].filter(Boolean)) {
		try {
			model = await readFile(path);
			break;
		} catch {
			/* Optional local integration prerequisites. */
		}
	}
	try {
		const { stdout } = await command(ffmpegPath, ["-hide_banner", "-filters"]);
		if (!stdout.includes("libvmaf")) throw Error();
	} catch {
		return t.skip("ffmpeg with libvmaf unavailable");
	}
	if (!model) return t.skip("VMAF model file unavailable");
	const dir = await mkdtemp("/tmp/cloud-real-test-");
	try {
		const path = join(dir, "source.mkv");
		await command(ffmpegPath, [
			"-hide_banner",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=size=64x64:rate=5:duration=0.6",
			"-c:v",
			"ffv1",
			path,
		]);
		const media = await readFile(path);
		const f = fixture();
		for (const key of ["reference", "distorted", "modelFile"]) {
			const bytes = key === "modelFile" ? model : media;
			f.manifest[key].bytes = bytes.length;
			f.manifest[key].sha256 = sha(bytes);
		}
		const fetcher = (url, options) =>
			options.method === "PUT" || url.endsWith("/manifest")
				? f.fetcher(url, options)
				: Promise.resolve(
						new Response(url.includes("/model?") ? model : media),
					);
		const receipt = await runCloudWorker("https://fixture.invalid/manifest", {
			fetcher,
			ffmpegPath,
			ffprobePath,
		});
		assert.equal(receipt.frames, 3);
		assert.equal(receipt.referenceFrames, 3);
		const scored = JSON.parse(f.uploads.get(f.manifest.output.url));
		const modelPath = join(dir, "model.json"),
			logPath = join(dir, "local-control.json");
		await writeFile(modelPath, model);
		await command(
			ffmpegPath,
			buildVmafCommand({
				...f.manifest.scoring,
				referencePath: path,
				distortedPath: path,
				modelPath,
				logPath,
			}),
		);
		const control = JSON.parse(await readFile(logPath, "utf8"));
		assert.deepEqual(scored.frames, control.frames);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("deadline allows the profile maximum run plus queue window", () => {
	const { manifest } = fixture();
	const now = Date.now();
	manifest.deadline = new Date(now + (86400 + 7200) * 1000).toISOString();
	assert.doesNotThrow(() => validateManifest(manifest, now));
	manifest.deadline = new Date(now + (86400 + 7201) * 1000).toISOString();
	assert.throws(() => validateManifest(manifest, now));
});

const gen5Scoring = {
	model: "vmaf_v0.6.1",
	measurementMethod: "FRAME_INDEX_BT709_10BIT",
	referenceFrameRate: "24000/1001",
	scaleToReference: { width: 1920, height: 1080 },
	distortedOriginal: { width: 640, height: 360, bitdepth: 8 },
};
test("frame-index manifest requires exact metadata and forbids frame resampling", () => {
	const { manifest } = fixture();
	manifest.scoring = { ...gen5Scoring };
	assert.doesNotThrow(() => validateManifest(manifest));
	for (const changes of [
		{ measurementMethod: "OTHER" },
		{ referenceFrameRate: "24:bad" },
		{ referenceFrameRate: "0/1" },
		{ fpsConform: 24 },
		{ alignFrames: 1 },
		{ distortedOriginal: { width: 640, height: 360, bitdepth: 7 } },
	]) {
		assert.throws(() =>
			validateManifest({
				...manifest,
				scoring: { ...manifest.scoring, ...changes },
			}),
		);
	}
});
test("full-frame probes reject non-CFR, interlacing and variable geometry", () => {
	const data = () => ({
		streams: [
			{ nb_read_frames: 4, r_frame_rate: "24/1", bits_per_raw_sample: "8" },
		],
		frames: Array.from({ length: 4 }, (_, i) => ({
			best_effort_timestamp_time: String(i / 24),
			width: 640,
			height: 360,
			pix_fmt: "yuv420p",
			interlaced_frame: 0,
		})),
	});
	assert.equal(validateFullFrameProbe(data()).frames, 4);
	for (const mutate of [
		(d) => (d.frames[2].best_effort_timestamp_time = "0.12"),
		(d) => (d.frames[2].interlaced_frame = 1),
		(d) => (d.frames[2].width = 320),
		(d) => d.frames.pop(),
	]) {
		const d = data();
		mutate(d);
		assert.throws(() => validateFullFrameProbe(d));
	}
});
test("gen5 cadence is rational, exact count, with only the bounded known rounded-rate exception", () => {
	const ref = {
		frames: 100000,
		frameRate: "24000/1001",
		width: 1920,
		height: 1080,
		bitdepth: 10,
	};
	const dist = { ...ref, width: 640, height: 360, bitdepth: 8 };
	assert.equal(
		validateFrameIndexPair(ref, dist, gen5Scoring).policy,
		"exact-rational-cfr-match",
	);
	assert.ok(
		validateFrameIndexPair(ref, { ...dist, frameRate: "2997/125" }, gen5Scoring)
			.accumulatedDriftFrames < 0.5,
	);
	assert.throws(
		() =>
			validateFrameIndexPair(ref, { ...dist, frameRate: "24/1" }, gen5Scoring),
		/INPUT_FRAME_RATE_MISMATCH/,
	);
	assert.throws(
		() =>
			validateFrameIndexPair(
				{ ...ref, frames: 600000 },
				{ ...dist, frames: 600000, frameRate: "2997/125" },
				gen5Scoring,
			),
		/INPUT_FRAME_RATE_MISMATCH/,
	);
	assert.throws(
		() => validateFrameIndexPair(ref, { ...dist, frames: 99999 }, gen5Scoring),
		/INPUT_FRAME_COUNT_MISMATCH/,
	);
	assert.throws(
		() => validateFrameIndexPair(ref, { ...dist, bitdepth: 10 }, gen5Scoring),
		/INPUT_GEOMETRY_CLAIM_MISMATCH/,
	);
});
test("distributed content evidence rejects actual shifted frames and ambiguous static images", () => {
	const frames = 1000,
		starts = [10, 200, 500, 800],
		indices = [
			...new Set(
				starts.flatMap((s) => Array.from({ length: 126 }, (_, i) => s - 3 + i)),
			),
		].sort((a, b) => a - b);
	const make = (offset) =>
		Buffer.concat(
			indices.map((n) => Buffer.alloc(14400, ((n + offset) * 53) % 251)),
		);
	const original = make(0);
	assert.equal(
		compareAlignmentWindows(original, original, starts, indices, frames)
			.confirmedWindows,
		4,
	);
	assert.throws(
		() => compareAlignmentWindows(original, make(1), starts, indices, frames),
		/NONZERO_CONTENT_OFFSET/,
	);
	assert.throws(
		() =>
			compareAlignmentWindows(
				Buffer.alloc(original.length),
				Buffer.alloc(original.length),
				starts,
				indices,
				frames,
			),
		/INSUFFICIENT_ALIGNMENT_EVIDENCE/,
	);
});

test("real gen6 cloud worker ignores container aperture in scoring and alignment for v06 and v1 CAMBI", async (t) => {
	const command = promisify(execFile),
		ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg",
		ffprobePath = process.env.FFPROBE_PATH ?? "ffprobe";
	const root = "/opt/homebrew/Cellar/libvmaf/3.2.1/share/libvmaf/model";
	const models = [
		{ name: "vmaf_v0.6.1", path: join(root, "vmaf_v0.6.1.json") },
		{
			name: "vmaf_v1.0.16_3d0h",
			path: join(root, "vmaf_v1.0.16/vmaf_v1.0.16_3d0h.json"),
		},
	];
	try {
		for (const m of models) m.bytes = await readFile(m.path);
		const { stdout } = await command(ffmpegPath, ["-hide_banner", "-filters"]);
		if (!stdout.includes("libvmaf")) throw Error();
	} catch {
		return t.skip("ffmpeg and v1/v06 models unavailable");
	}
	const dir = await mkdtemp("/tmp/cloud-gen5-real-");
	try {
		const { original: path, cropped } = createContainerCropFixture(
			dir,
			ffmpegPath,
			{ width: 640, height: 360, frames: 1000 },
		);
		const referenceMedia = await readFile(cropped);
		const media = await readFile(path);
		for (const model of models) {
			const f = fixture();
			f.manifest.checkpoint = {
				write: { url: "https://fixture.invalid/checkpoint" },
				authenticationKey: "b".repeat(64),
			};
			f.manifest.scoring = {
				...gen5Scoring,
				model: model.name,
				referenceFrameRate: "24/1",
				scaleToReference: { width: 640, height: 360 },
				distortedOriginal: { width: 640, height: 360, bitdepth: 8 },
				psnr: true,
				threads: 2,
			};
			f.manifest.deadline = new Date(Date.now() + 120000).toISOString();
			for (const key of ["reference", "distorted", "modelFile"]) {
				const bytes =
					key === "modelFile"
						? model.bytes
						: key === "reference"
							? referenceMedia
							: media;
				f.manifest[key].bytes = bytes.length;
				f.manifest[key].sha256 = sha(bytes);
			}
			const fetcher = (url, options) =>
				options.method === "PUT" || url.endsWith("/manifest")
					? f.fetcher(url, options)
					: Promise.resolve(
							new Response(
								url.includes("/model?")
									? model.bytes
									: url.includes("/reference?")
										? referenceMedia
										: media,
							),
						);
			const receipt = await runCloudWorker("https://fixture.invalid/manifest", {
				fetcher,
				ffmpegPath,
				ffprobePath,
			});
			assert.equal(receipt.frames, 1000);
			assert.equal(receipt.scoringVersion, 6);
			assert.equal(
				receipt.cropPolicy,
				"codec-only-ignore-container-aperture-v1",
			);
			assert.equal(
				receipt.cadence.alignment.referenceBufferSha256,
				receipt.cadence.alignment.distortedBufferSha256,
			);
			assert.ok(receipt.cadence.alignment.confirmedWindows >= 4);
			const result = JSON.parse(f.uploads.get(f.manifest.output.url));
			assert.equal(result.frames.length, 1000);
			assert.ok(
				result.frames.every(
					(f) => Number.isFinite(f.metrics.vmaf) && f.metrics.psnr_y >= 60,
				),
			);
			if (model.name === "vmaf_v0.6.1") {
				const saved = f.uploads.get(f.manifest.checkpoint.write.url);
				f.manifest.taskId = "real-restored-attempt";
				f.manifest.checkpoint.readUrl = "https://fixture.invalid/previous";
				f.manifest.checkpoint.sha256 = sha(saved);
				const wrapper = join(dir, "scoring-only.mjs");
				await writeFile(
					wrapper,
					`#!/usr/bin/env node\nimport {spawnSync} from 'node:child_process';\nconst args=process.argv.slice(2);if(args.includes('-vf'))process.exit(92);const r=spawnSync(${JSON.stringify(ffmpegPath)},args,{stdio:'inherit'});process.exit(r.status ?? 1);\n`,
					{ mode: 0o700 },
				);
				const events = [];
				const restored = await runCloudWorker(
					"https://fixture.invalid/manifest",
					{
						fetcher: (url, options) =>
							url.endsWith("/previous")
								? Promise.resolve(new Response(saved))
								: fetcher(url, options),
						ffmpegPath: wrapper,
						ffprobePath: "/nonexistent/probe-must-be-skipped",
						onProgress: (event) => events.push(event),
					},
				);
				assert.equal(restored.coverageValidation.reused, true);
				assert.equal(restored.coverageValidation.taskId, receipt.taskId);
				assert.deepEqual(restored.cadence, receipt.cadence);
				assert.deepEqual(
					JSON.parse(f.uploads.get(f.manifest.output.url)).frames,
					result.frames,
				);
				assert.ok(
					events.some(
						(event) =>
							event.phase === "SCORING" &&
							event.framesProcessed > 0 &&
							event.totalFrames === 1000,
					),
				);
				for (const mutate of [
					(value) => {
						value.referenceProbe.maxAbsGridErrorFrames = 0.2;
					},
					(value) => {
						const window = value.cadence.alignment.windows[1];
						window.startFrame = value.cadence.alignment.windows[0].startFrame;
						window.fraction = window.startFrame / value.referenceProbe.frames;
					},
				]) {
					const invalid = JSON.parse(saved);
					mutate(invalid);
					invalid.authentication = checkpointAuthentication(
						invalid,
						f.manifest.checkpoint.authenticationKey,
					);
					const bytes = Buffer.from(JSON.stringify(invalid));
					f.manifest.checkpoint.sha256 = sha(bytes);
					await assert.rejects(
						runCloudWorker("https://fixture.invalid/manifest", {
							fetcher: (url, options) =>
								url.endsWith("/previous")
									? Promise.resolve(new Response(bytes))
									: fetcher(url, options),
							ffmpegPath: wrapper,
							ffprobePath: "/nonexistent/rejected-checkpoint-requires-probe",
						}),
						/PROCESS_START_FAILED/,
					);
				}
			}
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("only reference MPEG-2 can accept bounded linear timestamp clock drift", () => {
	const data = (drift = 0.175) => ({
		streams: [
			{
				codec_name: "mpeg2video",
				nb_read_frames: 1000,
				r_frame_rate: "24000/1001",
				bits_per_raw_sample: "8",
			},
		],
		frames: Array.from({ length: 1000 }, (_, i) => ({
			best_effort_timestamp_time: String(
				(i * (1 - drift / 999)) / (24000 / 1001),
			),
			width: 640,
			height: 360,
			pix_fmt: "yuv420p",
			interlaced_frame: 0,
			repeat_pict: 0,
		})),
	});
	const probe = validateFullFrameProbe(data(), { reference: true });
	assert.equal(
		probe.timestampPolicy,
		"mpeg2-reference-linear-clock-drift-under-quarter-frame-v1",
	);
	assert.ok(Math.abs(probe.maxAbsGridErrorFrames - 0.175) < 1e-9);
	assert.ok(probe.maxAbsIntervalErrorFrames < 0.001);
	assert.ok(probe.endpointLinearFitMaxAbsResidualFrames < 0.001);
	assert.throws(() => validateFullFrameProbe(data()), /NON_CFR_INPUT/);
	assert.equal(
		validateFullFrameProbe(data(0.01)).timestampPolicy,
		"nominal-cfr-grid-0.05frame",
	);
	for (const mutate of [
		(d) => (d.streams[0].codec_name = "h264"),
		(d) => (d.frames[500].repeat_pict = 1),
		(d) => {
			for (let i = 500; i < 1000; i++)
				d.frames[i].best_effort_timestamp_time = String(
					Number(d.frames[i].best_effort_timestamp_time) + 0.01,
				);
		},
		(d) => {
			for (let i = 0; i < 1000; i++)
				d.frames[i].best_effort_timestamp_time = String(
					Number(d.frames[i].best_effort_timestamp_time) +
						0.0002 * Math.sin((Math.PI * i) / 999),
				);
		},
	]) {
		const d = data();
		mutate(d);
		assert.throws(
			() => validateFullFrameProbe(d, { reference: true }),
			/NON_CFR_INPUT/,
		);
	}
	assert.throws(
		() => validateFullFrameProbe(data(0.251), { reference: true }),
		/NON_CFR_INPUT/,
	);
	const scoring = {
		...gen5Scoring,
		scaleToReference: { width: 640, height: 360 },
	};
	assert.throws(
		() => validateFrameIndexPair(probe, { ...probe, frames: 999 }, scoring),
		/INPUT_FRAME_COUNT_MISMATCH/,
	);
});

test("diagnostics allow only exact known codes and never echo secrets", () => {
	const secret = "https://secret.invalid/file?token=TOP_SECRET";
	for (const error of [
		new Error(secret),
		{
			message: `FFMPEG_FAILED ${secret}`,
			code: secret,
			cause: { code: secret },
			httpStatus: secret,
		},
		{ message: secret, stack: secret, path: secret, url: secret },
	]) {
		const result = safeFailureDiagnostic(error, secret);
		assert.deepEqual(result, {
			status: "FAILED",
			phase: "MANIFEST",
			code: "VMAF_CLOUD_TASK_FAILED",
		});
		assert.ok(!JSON.stringify(result).includes("TOP_SECRET"));
	}
	assert.deepEqual(
		safeFailureDiagnostic(
			{
				message: "DOWNLOAD_FAILED",
				httpStatus: 403,
				cause: { code: "ECONNRESET", message: secret },
			},
			"REFERENCE_DOWNLOAD",
		),
		{
			status: "FAILED",
			phase: "REFERENCE_DOWNLOAD",
			code: "DOWNLOAD_FAILED",
			systemCode: "ECONNRESET",
			httpStatus: 403,
		},
	);
	assert.equal(
		safeFailureDiagnostic({ message: "NON_CFR_INPUT" }, "REFERENCE_PROBE").code,
		"NON_CFR_INPUT",
	);
	assert.ok(
		!("httpStatus" in safeFailureDiagnostic({ httpStatus: 999 }, "SCORING")),
	);
});
test("optional progress emits only phase transitions and preserves scoring when callback throws", async () => {
	const dir = await mkdtemp("/tmp/cloud-progress-test-");
	try {
		const f = fixture(),
			binaries = await fakePrograms(dir),
			events = [];
		const receipt = await runCloudWorker("https://fixture.invalid/manifest", {
			...binaries,
			fetcher: f.fetcher,
			onProgress: (event) => {
				events.push(event);
				throw Error("IGNORED_SECRET");
			},
		});
		assert.equal(receipt.frames, 3);
		assert.deepEqual(
			events.map((e) => e.phase),
			[
				"MANIFEST",
				"REFERENCE_DOWNLOAD",
				"DISTORTED_DOWNLOAD",
				"MODEL_DOWNLOAD",
				"REFERENCE_PROBE",
				"DISTORTED_PROBE",
				"ALIGNMENT",
				"SCORING",
				"RESULT_UPLOAD",
				"RECEIPT_UPLOAD",
			],
		);
		assert.ok(
			events.every(
				(e) =>
					e.status === "RUNNING" &&
					Object.keys(e).every((key) =>
						["status", "phase", "framesProcessed", "totalFrames"].includes(key),
					),
			),
		);
		assert.ok(!JSON.stringify(events).includes("NEVER_LOG_ME"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a fresh attempt reuses pinned coverage after interruption and preserves score output", async () => {
	const dir = await mkdtemp("/tmp/cloud-checkpoint-test-");
	try {
		const f = fixture();
		f.manifest.checkpoint = {
			write: { url: "https://fixture.invalid/checkpoint" },
			authenticationKey: "b".repeat(64),
		};
		const binaries = await fakePrograms(dir, { missing: true });
		await assert.rejects(
			runCloudWorker("https://fixture.invalid/manifest", {
				...binaries,
				fetcher: f.fetcher,
			}),
			/ENOENT/,
		);
		const saved = f.uploads.get(f.manifest.checkpoint.write.url);
		assert.ok(saved);
		const original = JSON.parse(saved);
		await fakePrograms(dir);
		// A restored attempt must not invoke either full decoder probe again.
		await writeFile(
			binaries.ffprobePath,
			"#!/usr/bin/env node\nprocess.exit(91);\n",
			{ mode: 0o700 },
		);
		f.manifest.taskId = "fresh-attempt";
		f.manifest.checkpoint.readUrl = "https://fixture.invalid/previous";
		f.manifest.checkpoint.sha256 = sha(saved);
		const fetcher = (url, options) =>
			url.endsWith("/previous")
				? Promise.resolve(new Response(saved))
				: f.fetcher(url, options);
		const receipt = await runCloudWorker("https://fixture.invalid/manifest", {
			...binaries,
			fetcher,
		});
		assert.deepEqual(receipt.coverageValidation, {
			reused: true,
			taskId: original.taskId,
			completedAt: original.completedAt,
			checkpointSha256: sha(saved),
		});
		assert.equal(receipt.taskId, "fresh-attempt");
		const recoveredOutput = f.uploads.get(f.manifest.output.url);
		await fakePrograms(dir);
		delete f.manifest.checkpoint;
		const fresh = await runCloudWorker("https://fixture.invalid/manifest", {
			...binaries,
			fetcher: f.fetcher,
		});
		assert.equal(receipt.resultSha256, fresh.resultSha256);
		assert.deepEqual(recoveredOutput, f.uploads.get(f.manifest.output.url));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("tampered, oversized and mismatched checkpoints recompute, and input hashes remain mandatory", async () => {
	const dir = await mkdtemp("/tmp/cloud-checkpoint-invalid-");
	try {
		const f = fixture(),
			binaries = await fakePrograms(dir);
		f.manifest.checkpoint = {
			write: { url: "https://fixture.invalid/checkpoint" },
			authenticationKey: "b".repeat(64),
		};
		await runCloudWorker("https://fixture.invalid/manifest", {
			...binaries,
			fetcher: f.fetcher,
		});
		const saved = f.uploads.get(f.manifest.checkpoint.write.url);
		const changed = (mutate) => {
			const v = JSON.parse(saved);
			mutate(v);
			v.authentication = checkpointAuthentication(
				v,
				f.manifest.checkpoint.authenticationKey,
			);
			return Buffer.from(JSON.stringify(v));
		};
		for (const [body, pinned] of [
			[Buffer.from("{}"), sha(saved)],
			[
				Buffer.from(
					JSON.stringify({
						...JSON.parse(saved),
						authentication: "0".repeat(64),
					}),
				),
				undefined,
			],
			[Buffer.alloc(256 * 1024 + 1, " "), undefined],
			[
				changed((v) => {
					v.bindingSha256 = "0".repeat(64);
				}),
				undefined,
			],
			[
				changed((v) => {
					v.referenceProbe.unexpected = true;
				}),
				undefined,
			],
			[
				changed((v) => {
					v.distortedProbe.frames = -1;
				}),
				undefined,
			],
		]) {
			f.manifest.checkpoint.readUrl = "https://fixture.invalid/previous";
			f.manifest.checkpoint.sha256 = pinned ?? sha(body);
			const receipt = await runCloudWorker("https://fixture.invalid/manifest", {
				...binaries,
				fetcher: (url, options) =>
					url.endsWith("/previous")
						? Promise.resolve(new Response(body))
						: f.fetcher(url, options),
			});
			assert.equal(receipt.coverageValidation.reused, false);
		}
		f.manifest.reference.sha256 = "0".repeat(64);
		await assert.rejects(
			runCloudWorker("https://fixture.invalid/manifest", {
				...binaries,
				fetcher: f.fetcher,
			}),
			/INPUT_IDENTITY_MISMATCH/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("progress and checkpoint transfer failures do not interrupt continuous scoring", async () => {
	const dir = await mkdtemp("/tmp/cloud-progress-failure-");
	try {
		const f = fixture(),
			binaries = await fakePrograms(dir);
		f.manifest.progress = { url: "https://fixture.invalid/progress" };
		f.manifest.checkpoint = {
			write: { url: "https://fixture.invalid/checkpoint" },
			authenticationKey: "b".repeat(64),
		};
		const events = [];
		const receipt = await runCloudWorker("https://fixture.invalid/manifest", {
			...binaries,
			fetcher: async (url, options) => {
				if (url.endsWith("/progress")) {
					const chunks = [];
					for await (const chunk of options.body) chunks.push(chunk);
					events.push(JSON.parse(Buffer.concat(chunks)));
					throw new Error("unavailable");
				}
				if (url.endsWith("/checkpoint"))
					return new Response(null, { status: 503 });
				return f.fetcher(url, options);
			},
		});
		assert.equal(receipt.frames, 3);
		assert.ok(
			events.some(
				(event) => event.phase === "SCORING" && event.totalFrames === 3,
			),
		);
		assert.ok(
			events.every(
				(event) =>
					event.taskId === f.manifest.taskId &&
					event.image === f.manifest.image,
			),
		);
		assert.ok(!JSON.stringify(events).includes("NEVER_LOG_ME"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("download errors retain safe HTTP status and the last entered phase", async () => {
	let phase;
	const f = fixture();
	await assert.rejects(
		runCloudWorker("https://fixture.invalid/manifest", {
			fetcher: (url, options) =>
				url.endsWith("/manifest")
					? f.fetcher(url, options)
					: Promise.resolve(
							new Response("TOKEN_SHOULD_NOT_BE_LOGGED", { status: 403 }),
						),
			onProgress: (e) => {
				phase = e.phase;
			},
		}),
		(error) => {
			assert.deepEqual(safeFailureDiagnostic(error, phase), {
				status: "FAILED",
				phase: "REFERENCE_DOWNLOAD",
				code: "DOWNLOAD_FAILED",
				httpStatus: 403,
			});
			return true;
		},
	);
});
