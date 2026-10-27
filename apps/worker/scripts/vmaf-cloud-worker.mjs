import { spawn } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import {
	buildVmafCommand,
	frameIndexDisplayGeometry,
	sampleAspectRatioFromProbe,
	VMAF_FRAME_INDEX_CROP_POLICY,
	VMAF_FRAME_INDEX_SCORING_VERSION,
} from "../../../packages/core/src/vmaf/command.ts";

const fail = (code, httpStatus) => {
	const error = new Error(code);
	if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599)
		error.httpStatus = httpStatus;
	throw error;
};
const diagnosticPhases = new Set([
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
]);
const diagnosticCodes = new Set([
	"INVALID_MANIFEST",
	"INVALID_TRANSFER_URL",
	"INVALID_DEADLINE",
	"TRANSFER_FAILED",
	"JSON_TOO_LARGE",
	"INVALID_JSON",
	"DOWNLOAD_FAILED",
	"INPUT_SIZE_MISMATCH",
	"INPUT_IDENTITY_MISMATCH",
	"PROCESS_START_FAILED",
	"DEADLINE_EXCEEDED",
	"PROCESS_OUTPUT_TOO_LARGE",
	"FFMPEG_FAILED",
	"EMPTY_RESULT",
	"INCOMPLETE_FRAME_COVERAGE",
	"INVALID_FRAME_COVERAGE",
	"INVALID_PSNR",
	"INVALID_FRAME_RATE",
	"INVALID_FRAME_PROBE",
	"INVALID_FRAME_CADENCE",
	"NON_CFR_INPUT",
	"INPUT_FRAME_RATE_MISMATCH",
	"INPUT_FRAME_COUNT_MISMATCH",
	"INPUT_GEOMETRY_CLAIM_MISMATCH",
	"INVALID_SAMPLE_ASPECT_RATIO",
	"INVALID_REFERENCE_DISPLAY_GEOMETRY",
	"ALIGNMENT_INCOMPLETE",
	"NONZERO_CONTENT_OFFSET",
	"INSUFFICIENT_ALIGNMENT_EVIDENCE",
	"ALIGNMENT_NEEDS_400_FRAMES",
	"UPLOAD_FAILED",
	"BUNDLED_MODEL_UNAVAILABLE",
	"INVALID_FRAME_INDEX_MEASUREMENT_OPTIONS",
]);
const diagnosticSystemCodes = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ETIMEDOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_SOCKET",
	"ENOSPC",
	"ENOENT",
	"EACCES",
	"EMFILE",
	"EROFS",
]);
/** Never serialize raw errors, arbitrary codes, URLs, file paths or causes. */
export function safeFailureDiagnostic(error, phase) {
	const code = diagnosticCodes.has(error?.message)
		? error.message
		: "VMAF_CLOUD_TASK_FAILED";
	const systemCode = [error?.code, error?.cause?.code].find((value) =>
		diagnosticSystemCodes.has(value),
	);
	const httpStatus = error?.httpStatus;
	return {
		status: "FAILED",
		phase: diagnosticPhases.has(phase) ? phase : "MANIFEST",
		code,
		...(systemCode ? { systemCode } : {}),
		...(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599
			? { httpStatus }
			: {}),
	};
}
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const digest = /^[a-f0-9]{64}$/;
function object(value, required, optional = []) {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		required.some((k) => !(k in value)) ||
		Object.keys(value).some((k) => ![...required, ...optional].includes(k))
	)
		fail("INVALID_MANIFEST");
}
function url(value) {
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		fail("INVALID_TRANSFER_URL");
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		parsed.hash
	)
		fail("INVALID_TRANSFER_URL");
}
function integer(value, min, max) {
	if (!Number.isSafeInteger(value) || value < min || value > max)
		fail("INVALID_MANIFEST");
}
function transfer(value, input) {
	object(
		value,
		input ? ["url", "sha256", "bytes"] : ["url"],
		input ? [] : ["headers"],
	);
	url(value.url);
	if (input) {
		if (!digest.test(value.sha256)) fail("INVALID_MANIFEST");
		integer(value.bytes, 1, 8 * 1024 ** 4);
	} else if (value.headers !== undefined) {
		if (
			!value.headers ||
			typeof value.headers !== "object" ||
			Array.isArray(value.headers)
		)
			fail("INVALID_MANIFEST");
		for (const [key, value] of Object.entries(value.headers)) {
			if (
				!/^[a-zA-Z0-9-]+$/.test(key) ||
				typeof value !== "string" ||
				/[\r\n]/.test(value) ||
				/^(host|connection|content-length|transfer-encoding)$/i.test(key)
			)
				fail("INVALID_MANIFEST");
		}
	}
}
export function validateManifest(value, now = Date.now()) {
	object(
		value,
		[
			"version",
			"taskId",
			"deadline",
			"image",
			"reference",
			"distorted",
			"scoring",
			"output",
			"receipt",
		],
		["modelFile", "progress", "checkpoint"],
	);
	if (
		value.version !== 1 ||
		!identifier.test(value.taskId) ||
		typeof value.image !== "string" ||
		!/^[^\s]+@sha256:[a-f0-9]{64}$/.test(value.image)
	)
		fail("INVALID_MANIFEST");
	const deadline = Date.parse(value.deadline);
	if (
		!Number.isFinite(deadline) ||
		deadline <= now ||
		deadline - now > (86400 + 7200) * 1000
	)
		fail("INVALID_DEADLINE");
	transfer(value.reference, true);
	transfer(value.distorted, true);
	if (value.modelFile !== undefined) {
		transfer(value.modelFile, true);
		integer(value.modelFile.bytes, 1, 100 * 1024 ** 2);
	}
	transfer(value.output, false);
	transfer(value.receipt, false);
	if (value.progress !== undefined) transfer(value.progress, false);
	if (value.checkpoint !== undefined) {
		object(
			value.checkpoint,
			["write", "authenticationKey"],
			["readUrl", "sha256"],
		);
		if (
			typeof value.checkpoint.authenticationKey !== "string" ||
			!digest.test(value.checkpoint.authenticationKey)
		)
			fail("INVALID_MANIFEST");
		transfer(value.checkpoint.write, false);
		if (
			value.checkpoint.readUrl !== undefined ||
			value.checkpoint.sha256 !== undefined
		) {
			url(value.checkpoint.readUrl);
			if (!digest.test(value.checkpoint.sha256)) fail("INVALID_MANIFEST");
		}
	}
	const s = value.scoring;
	object(
		s,
		["model"],
		[
			"scaleToReference",
			"fpsConform",
			"threads",
			"subsample",
			"psnr",
			"features",
			"alignFrames",
			"measurementMethod",
			"referenceFrameRate",
			"distortedOriginal",
			"referenceGeometry",
		],
	);
	if (typeof s.model !== "string" || !identifier.test(s.model))
		fail("INVALID_MANIFEST");
	if (s.scaleToReference !== undefined) {
		object(s.scaleToReference, ["width", "height"]);
		integer(s.scaleToReference.width, 1, 16384);
		integer(s.scaleToReference.height, 1, 16384);
	}
	if (
		s.fpsConform !== undefined &&
		(!Number.isFinite(s.fpsConform) || s.fpsConform <= 0 || s.fpsConform > 1000)
	)
		fail("INVALID_MANIFEST");
	if (s.threads !== undefined) integer(s.threads, 1, 96);
	if (s.subsample !== undefined) integer(s.subsample, 1, 1);
	if (s.alignFrames !== undefined) integer(s.alignFrames, -1000000, 1000000);
	if (s.psnr !== undefined && typeof s.psnr !== "boolean")
		fail("INVALID_MANIFEST");
	if (
		s.features !== undefined &&
		(!Array.isArray(s.features) ||
			s.features.length > 20 ||
			s.features.some((f) => typeof f !== "string" || !identifier.test(f)))
	)
		fail("INVALID_MANIFEST");
	if (s.measurementMethod !== undefined) {
		if (s.measurementMethod !== "FRAME_INDEX_BT709_10BIT")
			fail("INVALID_MANIFEST");
		if (
			!s.scaleToReference ||
			s.fpsConform !== undefined ||
			(s.alignFrames ?? 0) !== 0
		)
			fail("INVALID_MANIFEST");
		parseRate(s.referenceFrameRate);
		object(s.distortedOriginal, ["width", "height", "bitdepth"]);
		integer(s.distortedOriginal.width, 1, 16384);
		integer(s.distortedOriginal.height, 1, 16384);
		if (![8, 10, 12, 16].includes(s.distortedOriginal.bitdepth))
			fail("INVALID_MANIFEST");
		if (s.referenceGeometry !== undefined) {
			object(s.referenceGeometry, ["width", "height", "sampleAspectRatio"]);
			const display = frameIndexDisplayGeometry(s.referenceGeometry);
			if (
				display.width !== s.scaleToReference.width ||
				display.height !== s.scaleToReference.height
			)
				fail("INPUT_GEOMETRY_CLAIM_MISMATCH");
		}
	} else if (
		s.referenceFrameRate !== undefined ||
		s.distortedOriginal !== undefined ||
		s.referenceGeometry !== undefined
	)
		fail("INVALID_MANIFEST");
	return value;
}

async function boundedJson(response, limit, signal, expectedSha256) {
	if (!response.ok || !response.body) fail("TRANSFER_FAILED", response.status);
	const chunks = [];
	let bytes = 0;
	for await (const chunk of Readable.fromWeb(response.body)) {
		signal.throwIfAborted();
		bytes += chunk.length;
		if (bytes > limit) fail("JSON_TOO_LARGE");
		chunks.push(chunk);
	}
	const body = Buffer.concat(chunks);
	if (
		expectedSha256 &&
		createHash("sha256").update(body).digest("hex") !== expectedSha256
	)
		fail("INPUT_IDENTITY_MISMATCH");
	try {
		return JSON.parse(body.toString());
	} catch {
		fail("INVALID_JSON");
	}
}
async function fileHash(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}
async function download(input, path, fetcher, signal) {
	const response = await fetcher(input.url, { signal, redirect: "error" });
	if (!response.ok || !response.body) fail("DOWNLOAD_FAILED", response.status);
	const hash = createHash("sha256");
	let bytes = 0;
	const check = new Transform({
		transform(chunk, _encoding, done) {
			bytes += chunk.length;
			if (bytes > input.bytes) return done(new Error("INPUT_SIZE_MISMATCH"));
			hash.update(chunk);
			done(null, chunk);
		},
	});
	await pipeline(
		Readable.fromWeb(response.body),
		check,
		createWriteStream(path, { flags: "wx", mode: 0o600 }),
		{ signal },
	);
	if (bytes !== input.bytes || hash.digest("hex") !== input.sha256)
		fail("INPUT_IDENTITY_MISMATCH");
}
function execute(
	binary,
	args,
	signal,
	{ binaryOutput = false, maxBytes = 16384, onFrame } = {},
) {
	return new Promise((resolve, reject) => {
		signal.throwIfAborted();
		const child = spawn(binary, args, {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks = [];
		let bytes = 0,
			exceeded = false;
		let progressBuffer = "";
		child.stdout.on("data", (chunk) => {
			if (onFrame) {
				// ffmpeg progress is a bounded line protocol, never a retained full log.
				if (progressBuffer.length + chunk.length > 65536) {
					progressBuffer = "";
					return;
				}
				progressBuffer += chunk.toString();
				const lines = progressBuffer.split("\n");
				progressBuffer = lines.pop();
				for (const line of lines) {
					const match = /^frame=(\d{1,12})\r?$/.exec(line);
					if (match) onFrame(Number(match[1]));
				}
				return;
			}
			bytes += chunk.length;
			if (bytes > maxBytes) {
				exceeded = true;
				child.kill("SIGKILL");
			} else chunks.push(chunk);
		});
		child.stderr.resume(); // Never echo paths, signed URLs, or arbitrary codec diagnostics.
		const abort = () => child.kill("SIGKILL");
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		child.on("error", () => {
			signal.removeEventListener("abort", abort);
			reject(new Error("PROCESS_START_FAILED"));
		});
		child.on("close", (code) => {
			signal.removeEventListener("abort", abort);
			if (signal.aborted) reject(new Error("DEADLINE_EXCEEDED"));
			else if (exceeded) reject(new Error("PROCESS_OUTPUT_TOO_LARGE"));
			else if (code !== 0) reject(new Error("FFMPEG_FAILED"));
			else
				resolve(
					binaryOutput
						? Buffer.concat(chunks)
						: Buffer.concat(chunks).toString(),
				);
		});
	});
}
export function validateResult(result, scoring, expectedFrames) {
	if (!Array.isArray(result?.frames) || result.frames.length === 0)
		fail("EMPTY_RESULT");
	if (expectedFrames !== undefined && result.frames.length !== expectedFrames)
		fail("INCOMPLETE_FRAME_COVERAGE");
	const stride = scoring.subsample ?? 1;
	for (let i = 0; i < result.frames.length; i++) {
		const frame = result.frames[i];
		if (frame.frameNum !== i * stride || !Number.isFinite(frame.metrics?.vmaf))
			fail("INVALID_FRAME_COVERAGE");
		if (
			(scoring.psnr || scoring.features?.includes("psnr")) &&
			!Number.isFinite(frame.metrics.psnr_y)
		)
			fail("INVALID_PSNR");
	}
	return result.frames.length;
}
function parseRate(value) {
	if (typeof value !== "string" || !/^[1-9]\d{0,8}\/[1-9]\d{0,8}$/.test(value))
		fail("INVALID_FRAME_RATE");
	return value.split("/").map(Number);
}
export function validateFullFrameProbe(data, { reference = false } = {}) {
	const stream = data.streams?.[0],
		decoded = data.frames;
	if (
		!stream ||
		!Array.isArray(decoded) ||
		!decoded.length ||
		Number(stream.nb_read_frames) !== decoded.length
	)
		fail("INVALID_FRAME_PROBE");
	const frameRate =
		stream.r_frame_rate && stream.r_frame_rate !== "0/0"
			? stream.r_frame_rate
			: stream.avg_frame_rate;
	const [n, d] = parseRate(frameRate),
		fps = n / d;
	if (fps > 1000) fail("INVALID_FRAME_RATE");
	const first = decoded[0],
		firstTime = Number(first.best_effort_timestamp_time);
	const streamSar = sampleAspectRatioFromProbe(stream.sample_aspect_ratio);
	const firstSar = sampleAspectRatioFromProbe(first.sample_aspect_ratio);
	if (streamSar && firstSar && streamSar !== firstSar)
		fail("INVALID_SAMPLE_ASPECT_RATIO");
	const sampleAspectRatio = firstSar ?? streamSar;
	const endpointInterval =
		decoded.length > 1
			? (Number(decoded.at(-1).best_effort_timestamp_time) - firstTime) /
				(decoded.length - 1)
			: 1 / fps;
	let previous = -Infinity,
		maxAbsGridErrorFrames = 0,
		maxAbsIntervalErrorFrames = 0,
		endpointLinearFitMaxAbsResidualFrames = 0;
	const ptsHash = createHash("sha256");
	for (const [i, frame] of decoded.entries()) {
		const time = Number(frame.best_effort_timestamp_time);
		const frameSar = sampleAspectRatioFromProbe(frame.sample_aspect_ratio);
		if (frameSar && frameSar !== sampleAspectRatio)
			fail("INVALID_SAMPLE_ASPECT_RATIO");
		if (
			!Number.isFinite(time) ||
			time <= previous ||
			frame.interlaced_frame !== 0 ||
			frame.width !== first.width ||
			frame.height !== first.height ||
			frame.pix_fmt !== first.pix_fmt
		)
			fail("INVALID_FRAME_CADENCE");
		if (i > 0)
			maxAbsIntervalErrorFrames = Math.max(
				maxAbsIntervalErrorFrames,
				Math.abs((time - previous) * fps - 1),
			);
		endpointLinearFitMaxAbsResidualFrames = Math.max(
			endpointLinearFitMaxAbsResidualFrames,
			Math.abs((time - firstTime - i * endpointInterval) * fps),
		);
		previous = time;
		maxAbsGridErrorFrames = Math.max(
			maxAbsGridErrorFrames,
			Math.abs((time - firstTime) * fps - i),
		);
		ptsHash.update(`${frame.best_effort_timestamp_time}\n`);
	}
	let timestampPolicy = "nominal-cfr-grid-0.05frame";
	if (maxAbsGridErrorFrames > 0.05) {
		// A full 137-minute MPEG-2 source exhibited 0.889 ppm linear timestamp
		// drift (0.1753 frame total), with equal decoded counts and zero-offset
		// content correspondence in all ten windows for both encoded outputs.
		// This accepts only that narrowly bounded clock behavior on a reference;
		// the frame-index graph, pair counts and content checks remain unchanged.
		if (
			!reference ||
			stream.codec_name !== "mpeg2video" ||
			maxAbsGridErrorFrames >= 0.25 ||
			maxAbsIntervalErrorFrames >= 0.001 ||
			endpointLinearFitMaxAbsResidualFrames >= 0.001 ||
			decoded.some((frame) => frame.repeat_pict !== 0)
		)
			fail("NON_CFR_INPUT");
		timestampPolicy =
			"mpeg2-reference-linear-clock-drift-under-quarter-frame-v1";
	}
	const bitdepth =
		Number(stream.bits_per_raw_sample) ||
		Number(first.pix_fmt?.match(/(?:p|gray)(10|12|16)(?:le|be)$/)?.[1] ?? 8);
	integer(first.width, 1, 16384);
	integer(first.height, 1, 16384);
	return {
		frames: decoded.length,
		fps,
		frameRate,
		width: first.width,
		height: first.height,
		bitdepth,
		...(sampleAspectRatio ? { sampleAspectRatio } : {}),
		sampleAspectRatioPolicy: sampleAspectRatio
			? "reported"
			: "legacy-square-pixel",
		timestampPolicy,
		maxAbsGridErrorFrames,
		maxAbsIntervalErrorFrames,
		endpointLinearFitMaxAbsResidualFrames,
		inferredEndpointFps: 1 / endpointInterval,
		relativeCadenceOffsetPpm: (1 / endpointInterval / fps - 1) * 1e6,
		ptsSha256: ptsHash.digest("hex"),
	};
}
export function validateFrameIndexPair(reference, distorted, scoring) {
	const [rn, rd] = parseRate(reference.frameRate),
		[dn, dd] = parseRate(distorted.frameRate);
	const exact = BigInt(rn) * BigInt(dd) === BigInt(dn) * BigInt(rd);
	const drift = reference.frames * Math.abs(rn / rd / (dn / dd) - 1);
	const rates = new Set([reference.frameRate, distorted.frameRate]);
	if (
		!exact &&
		!(rates.has("2997/125") && rates.has("24000/1001") && drift < 0.5)
	)
		fail("INPUT_FRAME_RATE_MISMATCH");
	if (reference.frames !== distorted.frames) fail("INPUT_FRAME_COUNT_MISMATCH");
	let display = { width: reference.width, height: reference.height };
	if (scoring.referenceGeometry) {
		const claimed = scoring.referenceGeometry;
		if (
			claimed.width !== reference.width ||
			claimed.height !== reference.height ||
			!reference.sampleAspectRatio ||
			sampleAspectRatioFromProbe(claimed.sampleAspectRatio) !==
				reference.sampleAspectRatio
		)
			fail("INPUT_GEOMETRY_CLAIM_MISMATCH");
		display = frameIndexDisplayGeometry({
			...reference,
			sampleAspectRatio: reference.sampleAspectRatio,
		});
	}
	if (
		scoring.referenceFrameRate !== reference.frameRate ||
		scoring.scaleToReference.width !== display.width ||
		scoring.scaleToReference.height !== display.height ||
		["width", "height", "bitdepth"].some(
			(k) => scoring.distortedOriginal[k] !== distorted[k],
		)
	)
		fail("INPUT_GEOMETRY_CLAIM_MISMATCH");
	return {
		policy: exact
			? "exact-rational-cfr-match"
			: "2997-125-vs24000-1001-under-half-frame-drift-v2",
		referenceFps: reference.frameRate,
		distortedFps: distorted.frameRate,
		accumulatedDriftFrames: drift,
		displayGeometry: {
			...display,
			policy: scoring.referenceGeometry
				? "sample-aspect-ratio-display-v1"
				: "legacy-coded-canvas-v1",
		},
		reference,
		distorted,
	};
}
export function compareAlignmentWindows(x, y, starts, indices, totalFrames) {
	const span = 120,
		pixels = 160 * 90;
	if (x.length !== indices.length * pixels || y.length !== x.length)
		fail("ALIGNMENT_INCOMPLETE");
	const positions = new Map(indices.map((n, i) => [n, i]));
	const windows = starts.map((start) => {
		const offsets = [];
		for (let offset = -3; offset <= 3; offset++) {
			let sum = 0;
			for (let f = start; f < start + span; f++) {
				const xp = positions.get(f) * pixels,
					yp = positions.get(f + offset) * pixels;
				for (let p = 0; p < pixels; p++) {
					const difference = x[xp + p] - y[yp + p];
					sum += difference * difference;
				}
			}
			offsets.push({ offset, mse: sum / (span * pixels) });
		}
		const ranked = [...offsets].sort((a, b) => a.mse - b.mse);
		return {
			startFrame: start,
			fraction: start / totalFrames,
			frames: span,
			offsets,
			bestOffset: ranked[0].offset,
			confident: ranked[0].mse < ranked[1].mse * 0.9,
		};
	});
	if (windows.some((w) => w.confident && w.bestOffset !== 0))
		fail("NONZERO_CONTENT_OFFSET");
	const good = windows.filter((w) => w.confident && w.bestOffset === 0);
	if (
		good.length < 4 ||
		!good.some((w) => w.fraction < 0.25) ||
		!good.some((w) => w.fraction > 0.75)
	)
		fail("INSUFFICIENT_ALIGNMENT_EVIDENCE");
	return {
		policy: "ten-distributed-120frame-luma-windows-offset-minus3-to-plus3-v1",
		windows,
		confirmedWindows: good.length,
		referenceBufferSha256: createHash("sha256").update(x).digest("hex"),
		distortedBufferSha256: createHash("sha256").update(y).digest("hex"),
		limitation:
			"Content correspondence checked in distributed windows; every-frame timestamps/counts separately validated. No offset/drop/duplication correction applied.",
	};
}
async function validateContentAlignment(
	referencePath,
	distortedPath,
	frames,
	ffmpegPath,
	signal,
) {
	if (frames < 400) fail("ALIGNMENT_NEEDS_400_FRAMES");
	const span = 120,
		pad = 3;
	const starts = Array.from({ length: 10 }, (_, i) =>
		Math.min(
			frames - span - pad,
			Math.max(pad, Math.floor(frames * (0.05 + i * 0.1))),
		),
	);
	const indices = [
		...new Set(
			starts.flatMap((s) =>
				Array.from({ length: span + 2 * pad }, (_, i) => s - pad + i),
			),
		),
	].sort((a, b) => a - b);
	const select = starts
		.map((n) => `between(n\\,${n - pad}\\,${n + span + pad - 1})`)
		.join("+");
	const decode = (path) =>
		execute(
			ffmpegPath,
			[
				"-v",
				"error",
				"-nostdin",
				"-threads",
				"2",
				"-filter_threads",
				"1",
				"-protocol_whitelist",
				"file,pipe",
				"-apply_cropping",
				"codec",
				"-i",
				path,
				"-an",
				"-vf",
				`setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709,select=${select},extractplanes=y,scale=160:90:flags=area:in_range=full:out_range=full,format=gray`,
				"-frames:v",
				String(indices.length),
				"-fps_mode",
				"passthrough",
				"-f",
				"rawvideo",
				"pipe:1",
			],
			signal,
			{ binaryOutput: true, maxBytes: indices.length * 160 * 90 },
		);
	return compareAlignmentWindows(
		await decode(referencePath),
		await decode(distortedPath),
		starts,
		indices,
		frames,
	);
}
async function probeFrames(
	path,
	ffprobePath,
	signal,
	full = false,
	reference = false,
) {
	const data = JSON.parse(
		await execute(
			ffprobePath,
			[
				"-v",
				"error",
				"-protocol_whitelist",
				"file,pipe",
				"-select_streams",
				"v:0",
				"-count_frames",
				...(full ? ["-show_frames"] : []),
				"-show_entries",
				full
					? "frame=best_effort_timestamp_time,width,height,pix_fmt,sample_aspect_ratio,interlaced_frame,repeat_pict:stream=codec_name,nb_read_frames,avg_frame_rate,r_frame_rate,width,height,pix_fmt,bits_per_raw_sample,sample_aspect_ratio"
					: "stream=nb_read_frames,avg_frame_rate,r_frame_rate",
				"-of",
				"json",
				path,
			],
			signal,
			{ maxBytes: full ? 256 * 1024 ** 2 : 16384 },
		),
	);
	if (full) return validateFullFrameProbe(data, { reference });
	const stream = data.streams?.[0];
	const frames = Number(stream?.nb_read_frames);
	const rate = (stream?.avg_frame_rate || stream?.r_frame_rate || "")
		.split("/")
		.map(Number);
	const fps = rate[0] / (rate[1] ?? 1);
	if (
		!Number.isSafeInteger(frames) ||
		frames <= 0 ||
		!Number.isFinite(fps) ||
		fps <= 0
	)
		fail("INVALID_FRAME_PROBE");
	return { frames, fps };
}
async function upload(transfer, path, fetcher, signal) {
	const body = createReadStream(path);
	try {
		const response = await fetcher(transfer.url, {
			method: "PUT",
			headers: {
				...transfer.headers,
				"content-length": String((await stat(path)).size),
			},
			body,
			duplex: "half",
			redirect: "error",
			signal,
		});
		await response.body?.cancel();
		if (!response.ok) fail("UPLOAD_FAILED", response.status);
	} finally {
		body.destroy();
	}
}

const checkpointLimit = 256 * 1024;
function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonical(value[key])]),
		);
	return value;
}
function checkpointBinding(manifest, modelSha256) {
	return createHash("sha256")
		.update(
			JSON.stringify(
				canonical({
					algorithm: manifest.scoring.measurementMethod
						? "decoded-coverage-and-display-alignment-v2"
						: "decoded-coverage-and-content-alignment-v1",
					scoringVersion: VMAF_FRAME_INDEX_SCORING_VERSION,
					cropPolicy: VMAF_FRAME_INDEX_CROP_POLICY,
					image: manifest.image,
					reference: {
						sha256: manifest.reference.sha256,
						bytes: manifest.reference.bytes,
					},
					distorted: {
						sha256: manifest.distorted.sha256,
						bytes: manifest.distorted.bytes,
					},
					modelSha256,
					scoring: manifest.scoring,
				}),
			),
		)
		.digest("hex");
}
export function checkpointAuthentication(value, authenticationKey) {
	const { authentication: _authentication, ...unsigned } = value;
	return createHmac("sha256", Buffer.from(authenticationKey, "hex"))
		.update(JSON.stringify(canonical(unsigned)))
		.digest("hex");
}
/** Authenticate the producing worker before trusting any persisted coverage evidence. */
function validateCheckpoint(
	value,
	bindingSha256,
	full,
	scoring,
	authenticationKey,
) {
	if (
		!value ||
		typeof value !== "object" ||
		typeof value.authentication !== "string" ||
		!digest.test(value.authentication) ||
		!timingSafeEqual(
			Buffer.from(value.authentication, "hex"),
			Buffer.from(checkpointAuthentication(value, authenticationKey), "hex"),
		)
	)
		fail("INVALID_MANIFEST");
	object(
		value,
		[
			"version",
			"bindingSha256",
			"taskId",
			"completedAt",
			"referenceProbe",
			"distortedProbe",
			"authentication",
		],
		["cadence"],
	);
	if (
		value.version !== 1 ||
		value.bindingSha256 !== bindingSha256 ||
		!identifier.test(value.taskId) ||
		typeof value.completedAt !== "string" ||
		!Number.isFinite(Date.parse(value.completedAt)) ||
		Date.parse(value.completedAt) > Date.now()
	)
		fail("INVALID_MANIFEST");
	for (const probe of [value.referenceProbe, value.distortedProbe]) {
		object(
			probe,
			["frames", "fps"],
			full
				? [
						"frameRate",
						"width",
						"height",
						"bitdepth",
						"sampleAspectRatio",
						"sampleAspectRatioPolicy",
						"timestampPolicy",
						"maxAbsGridErrorFrames",
						"maxAbsIntervalErrorFrames",
						"endpointLinearFitMaxAbsResidualFrames",
						"inferredEndpointFps",
						"relativeCadenceOffsetPpm",
						"ptsSha256",
					]
				: [],
		);
		integer(probe.frames, 1, 1000000000);
		if (!Number.isFinite(probe.fps) || probe.fps <= 0 || probe.fps > 1000)
			fail("INVALID_FRAME_PROBE");
		if (full) {
			const [n, d] = parseRate(probe.frameRate);
			if (probe.fps !== n / d) fail("INVALID_FRAME_PROBE");
			integer(probe.width, 1, 16384);
			integer(probe.height, 1, 16384);
			const sar = sampleAspectRatioFromProbe(probe.sampleAspectRatio);
			if (
				probe.sampleAspectRatioPolicy !==
				(sar ? "reported" : "legacy-square-pixel")
			)
				fail("INVALID_FRAME_PROBE");
			if (
				![8, 10, 12, 16].includes(probe.bitdepth) ||
				!digest.test(probe.ptsSha256) ||
				![
					"nominal-cfr-grid-0.05frame",
					"mpeg2-reference-linear-clock-drift-under-quarter-frame-v1",
				].includes(probe.timestampPolicy)
			)
				fail("INVALID_FRAME_PROBE");
			for (const key of [
				"maxAbsGridErrorFrames",
				"maxAbsIntervalErrorFrames",
				"endpointLinearFitMaxAbsResidualFrames",
				"inferredEndpointFps",
				"relativeCadenceOffsetPpm",
			])
				if (!Number.isFinite(probe[key])) fail("INVALID_FRAME_PROBE");
			if (
				probe.inferredEndpointFps <= 0 ||
				[
					probe.maxAbsGridErrorFrames,
					probe.maxAbsIntervalErrorFrames,
					probe.endpointLinearFitMaxAbsResidualFrames,
				].some((n) => n < 0) ||
				probe.relativeCadenceOffsetPpm !==
					(probe.inferredEndpointFps / probe.fps - 1) * 1e6
			)
				fail("INVALID_FRAME_PROBE");
			if (probe.timestampPolicy === "nominal-cfr-grid-0.05frame") {
				if (probe.maxAbsGridErrorFrames > 0.05) fail("NON_CFR_INPUT");
			} else if (
				probe !== value.referenceProbe ||
				probe.maxAbsGridErrorFrames <= 0.05 ||
				probe.maxAbsGridErrorFrames >= 0.25 ||
				probe.maxAbsIntervalErrorFrames >= 0.001 ||
				probe.endpointLinearFitMaxAbsResidualFrames >= 0.001
			)
				fail("NON_CFR_INPUT");
		}
	}
	if (full) {
		const expected = validateFrameIndexPair(
			value.referenceProbe,
			value.distortedProbe,
			scoring,
		);
		object(value.cadence, [...Object.keys(expected), "alignment"]);
		for (const key of Object.keys(expected))
			if (
				JSON.stringify(canonical(value.cadence[key])) !==
				JSON.stringify(canonical(expected[key]))
			)
				fail("INVALID_FRAME_PROBE");
		const alignment = value.cadence.alignment;
		object(alignment, [
			"policy",
			"windows",
			"confirmedWindows",
			"referenceBufferSha256",
			"distortedBufferSha256",
			"limitation",
		]);
		if (
			alignment.policy !==
				"ten-distributed-120frame-luma-windows-offset-minus3-to-plus3-v1" ||
			!digest.test(alignment.referenceBufferSha256) ||
			!digest.test(alignment.distortedBufferSha256) ||
			typeof alignment.limitation !== "string" ||
			alignment.limitation.length > 512 ||
			!Array.isArray(alignment.windows) ||
			alignment.windows.length !== 10
		)
			fail("ALIGNMENT_INCOMPLETE");
		for (const [index, window] of alignment.windows.entries()) {
			object(window, [
				"startFrame",
				"fraction",
				"frames",
				"offsets",
				"bestOffset",
				"confident",
			]);
			integer(window.startFrame, 3, value.referenceProbe.frames - 123);
			const expectedStart = Math.min(
				value.referenceProbe.frames - 123,
				Math.max(
					3,
					Math.floor(value.referenceProbe.frames * (0.05 + index * 0.1)),
				),
			);
			if (
				window.startFrame !== expectedStart ||
				window.frames !== 120 ||
				window.fraction !== window.startFrame / value.referenceProbe.frames ||
				!Array.isArray(window.offsets) ||
				window.offsets.length !== 7
			)
				fail("ALIGNMENT_INCOMPLETE");
			window.offsets.forEach((entry, i) => {
				object(entry, ["offset", "mse"]);
				if (
					entry.offset !== i - 3 ||
					!Number.isFinite(entry.mse) ||
					entry.mse < 0
				)
					fail("ALIGNMENT_INCOMPLETE");
			});
			const ranked = [...window.offsets].sort((a, b) => a.mse - b.mse);
			if (
				window.bestOffset !== ranked[0].offset ||
				window.confident !== ranked[0].mse < ranked[1].mse * 0.9 ||
				(window.confident && window.bestOffset !== 0)
			)
				fail("ALIGNMENT_INCOMPLETE");
		}
		const good = alignment.windows.filter(
			(window) => window.confident && window.bestOffset === 0,
		);
		if (
			alignment.confirmedWindows !== good.length ||
			good.length < 4 ||
			!good.some((window) => window.fraction < 0.25) ||
			!good.some((window) => window.fraction > 0.75)
		)
			fail("ALIGNMENT_INCOMPLETE");
	} else if (value.cadence !== undefined) fail("INVALID_MANIFEST");
	return value;
}
function progressPublisher(manifest, fetcher, signal) {
	let state,
		pending,
		closed = false,
		revision = 0;
	const publish = () => {
		if (!manifest.progress || !state || pending || closed || signal.aborted)
			return;
		const body = Buffer.from(
			JSON.stringify({
				version: 1,
				taskId: manifest.taskId,
				image: manifest.image,
				...state,
				updatedAt: new Date().toISOString(),
			}),
		);
		const publishedRevision = revision;
		pending = (async () => {
			try {
				const response = await fetcher(manifest.progress.url, {
					method: "PUT",
					headers: {
						...manifest.progress.headers,
						"content-length": String(body.length),
					},
					body: Readable.from([body]),
					duplex: "half",
					redirect: "error",
					signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
				});
				await response.body?.cancel();
			} catch {
				/* Progress is best effort and cannot affect result validity. */
			}
		})().finally(() => {
			pending = undefined;
			if (publishedRevision !== revision) publish();
		});
	};
	const interval = setInterval(publish, 10000);
	interval.unref();
	return {
		update(phase, framesProcessed, totalFrames) {
			const changed = state?.phase !== phase;
			state = {
				phase,
				...(framesProcessed === undefined
					? {}
					: { framesProcessed, totalFrames }),
			};
			if (changed) {
				revision++;
				publish();
			}
		},
		async close() {
			clearInterval(interval);
			closed = true;
			await pending;
			closed = false;
			publish();
			await pending;
			closed = true;
		},
	};
}

/** Injectable transport/binary keep tests local; production has no HTTP bypass. */
export async function runCloudWorker(
	manifestUrl,
	{
		fetcher = fetch,
		ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg",
		ffprobePath = process.env.FFPROBE_PATH ?? "ffprobe",
		modelDir = process.env.VMAF_MODEL_DIR ?? "/opt/vmaf/model",
		onProgress,
	} = {},
) {
	let publisher;
	const progress = (phase, framesProcessed, totalFrames) => {
		publisher?.update(phase, framesProcessed, totalFrames);
		try {
			onProgress?.({
				status: "RUNNING",
				phase,
				...(framesProcessed === undefined
					? {}
					: { framesProcessed, totalFrames }),
			});
		} catch {
			/* Diagnostics cannot interrupt scoring. */
		}
	};
	progress("MANIFEST");
	url(manifestUrl);
	const startedAt = new Date().toISOString();
	const controller = new AbortController();
	const { signal } = controller;
	let timer = setTimeout(() => controller.abort(), 30000);
	const work = await mkdtemp(join(tmpdir(), "bitovp-vmaf-cloud-"));
	try {
		const manifest = validateManifest(
			await boundedJson(
				await fetcher(manifestUrl, { signal, redirect: "error" }),
				65536,
				signal,
			),
		);
		publisher = progressPublisher(manifest, fetcher, signal);
		clearTimeout(timer);
		timer = setTimeout(
			() => controller.abort(),
			Date.parse(manifest.deadline) - Date.now(),
		);
		const referencePath = join(work, "reference.media"),
			distortedPath = join(work, "distorted.media");
		const downloadStart = performance.now();
		progress("REFERENCE_DOWNLOAD");
		await download(manifest.reference, referencePath, fetcher, signal);
		progress("DISTORTED_DOWNLOAD");
		await download(manifest.distorted, distortedPath, fetcher, signal);
		progress("MODEL_DOWNLOAD");
		let modelPath, modelSha256;
		if (manifest.modelFile) {
			modelPath = join(work, "model.json");
			await download(manifest.modelFile, modelPath, fetcher, signal);
			modelSha256 = manifest.modelFile.sha256;
		} else {
			const bundled = join(modelDir, `${manifest.scoring.model}.json`);
			try {
				await stat(bundled);
				modelPath = bundled;
				modelSha256 = await fileHash(bundled);
			} catch {
				fail("BUNDLED_MODEL_UNAVAILABLE");
			}
		}
		const coverageStart = performance.now();
		// Full decoder passes establish coverage independently of container nb_frames.
		// This costs two extra decodes; it does not change the scoring filter graph.
		const full =
			manifest.scoring.measurementMethod === "FRAME_INDEX_BT709_10BIT";
		const bindingSha256 = checkpointBinding(manifest, modelSha256);
		let restored;
		if (manifest.checkpoint?.readUrl) {
			try {
				const checkpointSignal = AbortSignal.any([
					signal,
					AbortSignal.timeout(5000),
				]);
				restored = validateCheckpoint(
					await boundedJson(
						await fetcher(manifest.checkpoint.readUrl, {
							signal: checkpointSignal,
							redirect: "error",
						}),
						checkpointLimit,
						checkpointSignal,
						manifest.checkpoint.sha256,
					),
					bindingSha256,
					full,
					manifest.scoring,
					manifest.checkpoint.authenticationKey,
				);
			} catch {
				/* Invalid, expired or unavailable checkpoints require fresh validation. */
			}
		}
		progress("REFERENCE_PROBE");
		const referenceProbe =
			restored?.referenceProbe ??
			(await probeFrames(referencePath, ffprobePath, signal, full, true));
		progress("DISTORTED_PROBE");
		const distortedProbe =
			restored?.distortedProbe ??
			(await probeFrames(distortedPath, ffprobePath, signal, full));
		const expectedFrames =
			referenceProbe.frames - Math.max(manifest.scoring.alignFrames ?? 0, 0);
		let cadence;
		progress("ALIGNMENT");
		if (full) {
			cadence = validateFrameIndexPair(
				referenceProbe,
				distortedProbe,
				manifest.scoring,
			);
			cadence.alignment =
				restored?.cadence.alignment ??
				(await validateContentAlignment(
					referencePath,
					distortedPath,
					referenceProbe.frames,
					ffmpegPath,
					signal,
				));
		} else {
			const conformed = manifest.scoring.fpsConform;
			const distortedFrames =
				distortedProbe.frames *
					(conformed ? conformed / distortedProbe.fps : 1) -
				Math.max(-(manifest.scoring.alignFrames ?? 0), 0);
			if (
				expectedFrames <= 0 ||
				Math.abs(distortedFrames - expectedFrames) > (conformed ? 1 : 0)
			)
				fail("INPUT_FRAME_COUNT_MISMATCH");
		}
		let coverageValidation;
		if (manifest.checkpoint) {
			const checkpoint = restored ?? {
				version: 1,
				bindingSha256,
				taskId: manifest.taskId,
				completedAt: new Date().toISOString(),
				referenceProbe,
				distortedProbe,
				...(cadence ? { cadence } : {}),
			};
			if (!restored)
				checkpoint.authentication = checkpointAuthentication(
					checkpoint,
					manifest.checkpoint.authenticationKey,
				);
			const checkpointBytes = Buffer.from(JSON.stringify(checkpoint));
			const checkpointSha256 = createHash("sha256")
				.update(checkpointBytes)
				.digest("hex");
			coverageValidation = {
				reused: Boolean(restored),
				taskId: checkpoint.taskId,
				completedAt: checkpoint.completedAt,
				checkpointSha256,
			};
			try {
				if (checkpointBytes.length > checkpointLimit) fail("JSON_TOO_LARGE");
				const checkpointPath = join(work, "checkpoint.json");
				await writeFile(checkpointPath, checkpointBytes, { mode: 0o600 });
				await upload(
					manifest.checkpoint.write,
					checkpointPath,
					fetcher,
					AbortSignal.any([signal, AbortSignal.timeout(5000)]),
				);
			} catch {
				/* Checkpoint storage failure never invalidates a freshly verified result. */
			}
		}
		progress("SCORING", 0, expectedFrames);
		const ffmpegVersion = (
			await execute(ffmpegPath, ["-version"], signal)
		).split("\n")[0];
		const logPath = join(work, "result.json");
		const args = buildVmafCommand({
			...manifest.scoring,
			referencePath,
			distortedPath,
			logPath,
			modelPath,
		});
		const scoringStart = performance.now();
		await execute(
			ffmpegPath,
			[
				"-progress",
				"pipe:1",
				"-nostats",
				...args.flatMap((arg) =>
					arg === "-i" ? ["-protocol_whitelist", "file,pipe", arg] : [arg],
				),
			],
			signal,
			{
				onFrame: (frames) =>
					progress("SCORING", Math.min(frames, expectedFrames), expectedFrames),
			},
		);
		const scoringEnd = performance.now();
		signal.throwIfAborted();
		const result = JSON.parse(await readFile(logPath, "utf8"));
		const frames = validateResult(result, manifest.scoring, expectedFrames);
		const resultSha256 = await fileHash(logPath);
		const uploadStart = performance.now();
		progress("RESULT_UPLOAD");
		await upload(manifest.output, logPath, fetcher, signal);
		const receipt = {
			version: 1,
			taskId: manifest.taskId,
			image: manifest.image,
			resultSha256,
			...(coverageValidation ? { coverageValidation } : {}),
			referenceSha256: manifest.reference.sha256,
			distortedSha256: manifest.distorted.sha256,
			...(modelSha256 ? { modelSha256 } : {}),
			frames,
			...(cadence
				? {
						measurementMethod: manifest.scoring.measurementMethod,
						scoringVersion: VMAF_FRAME_INDEX_SCORING_VERSION,
						cropPolicy: VMAF_FRAME_INDEX_CROP_POLICY,
						cadence,
					}
				: {}),
			referenceFrames: referenceProbe.frames,
			ffmpegVersion,
			completedAt: new Date().toISOString(),
			startedAt,
			timingsMs: {
				download: coverageStart - downloadStart,
				coverage: scoringStart - coverageStart,
				scoring: scoringEnd - scoringStart,
				resultUpload: performance.now() - uploadStart,
			},
		};
		const receiptPath = join(work, "receipt.json");
		await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
		progress("RECEIPT_UPLOAD");
		await upload(manifest.receipt, receiptPath, fetcher, signal);
		await publisher.close();
		return receipt;
	} finally {
		clearTimeout(timer);
		controller.abort();
		await publisher?.close();
		await rm(work, { recursive: true, force: true });
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	let phase = "MANIFEST";
	runCloudWorker(process.env.VMAF_MANIFEST_URL, {
		onProgress: (event) => {
			phase = event.phase;
			console.log(JSON.stringify(event));
		},
	})
		.then((receipt) =>
			console.log(
				JSON.stringify({
					taskId: receipt.taskId,
					status: "SUCCEEDED",
					frames: receipt.frames,
				}),
			),
		)
		.catch((error) => {
			console.error(JSON.stringify(safeFailureDiagnostic(error, phase)));
			process.exitCode = 1;
		});
}
