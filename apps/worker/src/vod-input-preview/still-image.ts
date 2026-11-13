import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Readable } from "node:stream";
import {
	MAX_VOD_INPUT_IMAGE_BYTES,
	type VodInputImagePrepareRequest,
	type VodInputPreviewResult,
	vodInputImagePrepareRequestSchema,
	vodInputPreviewResultSchema,
	vodInputTimelineSourceSchema,
} from "@bitovp/core/vod-input-timeline";
import {
	type ObjectIdentity,
	type ObjectStorageBrowser,
	ObjectVersionMismatchError,
	VersionExpectationUnsupportedError,
} from "@bitovp/storage";
import {
	MediaOperationError,
	runMediaProcess,
} from "../library-editing/process";
import { probeVodInputSources } from "./media";
import {
	VOD_INPUT_PREVIEW_MAX_OUTPUT_BYTES,
	type VodInputMediaDependencies,
} from "./media-profile";
import { abortableVodOperation, assertVodSourceIdentity } from "./range-bridge";
import {
	inspectVodStillImage,
	vodStillImageDecodeBytes,
	vodStillImageOrientationFilters,
} from "./still-image-header";

const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const fail = (code: string): never => {
	throw new MediaOperationError(code);
};
const identity = (value: ObjectIdentity) => ({
	size: value.size,
	etag: value.etag,
	versionId: value.versionId === "null" ? undefined : value.versionId,
	generation: value.generation,
});
const sameIdentity = (a: ObjectIdentity, b: ObjectIdentity) =>
	JSON.stringify(identity(a)) === JSON.stringify(identity(b));

async function readObject(input: {
	browser: ObjectStorageBrowser;
	bucket: string;
	key: string;
	expect: ObjectIdentity;
	signal: AbortSignal;
	collect: boolean;
	output?: boolean;
}) {
	const bad = input.output ? "IMAGE_OUTPUT_UNVERIFIED" : "SOURCE_CHANGED";
	if (!input.browser.getObject)
		return fail(
			input.output ? "IMAGE_OUTPUT_UNSUPPORTED" : "SOURCE_UNSUPPORTED",
		);
	let stream: Readable | undefined;
	const canceled = () => stream?.destroy(new MediaOperationError("CANCELED"));
	try {
		stream = (await abortableVodOperation(
			input.browser.getObject({
				bucket: input.bucket,
				key: input.key,
				expect: input.expect,
				range: { start: 0, end: input.expect.size - 1 },
			}),
			input.signal,
			(late) => (late as Readable).destroy(),
		)) as Readable;
		input.signal.addEventListener("abort", canceled, { once: true });
		input.signal.throwIfAborted();
		const chunks: Buffer[] = [],
			hash = createHash("sha256");
		let size = 0;
		for await (const raw of stream) {
			input.signal.throwIfAborted();
			const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
			size += bytes.length;
			if (size > input.expect.size) return fail(bad);
			hash.update(bytes);
			if (input.collect) chunks.push(bytes);
		}
		if (size !== input.expect.size) return fail(bad);
		return { bytes: Buffer.concat(chunks), sha256: hash.digest("hex") };
	} catch (error) {
		if (error instanceof ObjectVersionMismatchError) return fail(bad);
		if (error instanceof VersionExpectationUnsupportedError)
			return fail(
				input.output ? "IMAGE_OUTPUT_UNVERIFIED" : "SOURCE_UNVERIFIED",
			);
		if (error instanceof MediaOperationError || input.signal.aborted)
			throw error;
		return fail(
			input.output ? "IMAGE_OUTPUT_UNVERIFIED" : "SOURCE_READ_FAILED",
		);
	} finally {
		input.signal.removeEventListener("abort", canceled);
		stream?.destroy();
	}
}

function validateGeneratedProbe(raw: unknown, durationMs: number) {
	const streams = Array.isArray(record(raw).streams)
		? (record(raw).streams as unknown[]).map(record)
		: [];
	const video = streams.find((stream) => stream.codec_type === "video"),
		audio = streams.find((stream) => stream.codec_type === "audio");
	const frames = Math.ceil((durationMs * 30) / 1000);
	if (
		streams.length !== 2 ||
		video?.codec_name !== "h264" ||
		audio?.codec_name !== "aac" ||
		video.width !== 1920 ||
		video.height !== 1080 ||
		video.avg_frame_rate !== "30/1" ||
		Number(video.nb_frames) !== frames ||
		Number(audio.sample_rate) !== 48000 ||
		Number(audio.channels) !== 2 ||
		!Number.isFinite(Number(video.duration)) ||
		!Number.isFinite(Number(audio.duration)) ||
		Math.floor(Number(video.duration) * 1000) < durationMs ||
		Math.abs(Number(video.duration) * 1000 - (frames * 1000) / 30) > 1 ||
		Math.floor(Number(audio.duration) * 1000) < durationMs ||
		Number(audio.duration) * 1000 > (frames * 1000) / 30 + 25
	)
		return fail("IMAGE_OUTPUT_INVALID");
}

/** Prepare and publish a real input object; a local preview artifact is never returned as input. */
export async function prepareVodInputImage(
	input: VodInputMediaDependencies & {
		request: VodInputImagePrepareRequest;
		organizationId: string;
		taskId: string;
		attemptId: string;
		directory: string;
	},
): Promise<NonNullable<VodInputPreviewResult["prepared"]>> {
	const request = vodInputImagePrepareRequestSchema.parse(input.request);
	const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
	if (
		!isAbsolute(input.directory) ||
		input.directory.includes("\0") ||
		![input.organizationId, input.taskId, input.attemptId].every((value) =>
			uuid.test(value),
		)
	)
		return fail("INVALID_LOCAL_PATH");
	input.signal.throwIfAborted();
	const source = vodInputTimelineSourceSchema.parse({
		key: `img_${input.taskId.replaceAll("-", "")}`,
		credentialId: request.output.credentialId,
		bucket: request.output.bucket,
		objectKey:
			(request.output.prefix.replace(/\/+$/, "")
				? `${request.output.prefix.replace(/\/+$/, "")}/`
				: "") +
			"bitovp-generated-inputs/" +
			input.organizationId +
			"/" +
			input.taskId +
			"/" +
			input.attemptId +
			".mp4",
	});
	if (
		source.bucket === request.source.bucket &&
		source.objectKey === request.source.objectKey
	)
		return fail("IMAGE_OUTPUT_UNSUPPORTED");
	const browsers = new Set<ObjectStorageBrowser>();
	try {
		const sourceBrowser = await abortableVodOperation(
			input.browserFor(request.source.credentialId),
			input.signal,
			(late) => late.dispose?.(),
		);
		browsers.add(sourceBrowser);
		const outputBrowser = await abortableVodOperation(
			input.browserFor(source.credentialId),
			input.signal,
			(late) => late.dispose?.(),
		);
		browsers.add(outputBrowser);
		if (!sourceBrowser.getObject || !sourceBrowser.headObject)
			return fail("SOURCE_UNSUPPORTED");
		if (
			!outputBrowser.putObject ||
			!outputBrowser.getObject ||
			!outputBrowser.headObject
		)
			return fail("IMAGE_OUTPUT_UNSUPPORTED");
		const ioSignal = () =>
			AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]);
		const head = await abortableVodOperation(
			sourceBrowser.headObject({
				bucket: request.source.bucket,
				key: request.source.objectKey,
			}),
			ioSignal(),
		);
		assertVodSourceIdentity(head);
		if (head.size > MAX_VOD_INPUT_IMAGE_BYTES) return fail("SOURCE_READ_LIMIT");
		if (!sameIdentity(request.sourceIdentity, head))
			return fail("SOURCE_CHANGED");
		const original = await readObject({
			browser: sourceBrowser,
			bucket: request.source.bucket,
			key: request.source.objectKey,
			expect: request.sourceIdentity,
			signal: ioSignal(),
			collect: true,
		});
		const header = inspectVodStillImage(original.bytes);
		const imagePath = join(
			input.directory,
			header.format === "PNG" ? "source.png" : "source.jpg",
		);
		const path = join(input.directory, "prepared.mp4");
		await writeFile(
			imagePath,
			vodStillImageDecodeBytes(original.bytes, header),
			{ flag: "wx", mode: 0o600 },
		);
		const execute = input.execute ?? runMediaProcess;
		const deadline = Date.now() + (input.timeoutMs ?? 180_000);
		const options = () => ({
			signal: input.signal,
			timeoutMs: Math.max(1, deadline - Date.now()),
			maxOutputBytes: 1024 ** 2,
		});
		const foreground = [
			...vodStillImageOrientationFilters(header.orientation),
			"format=rgba",
			"scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2",
			"setsar=1",
			"loop=loop=-1:size=1:start=0",
			"setpts=N/(30*TB)",
		].join(",");
		await execute(
			input.ffmpegPath ?? "ffmpeg",
			[
				"-v",
				"error",
				"-nostdin",
				"-cpucount",
				"1",
				"-max_alloc",
				"134217728",
				"-filter_threads",
				"1",
				"-filter_complex_threads",
				"1",
				"-n",
				"-threads",
				"1",
				"-protocol_whitelist",
				"file,pipe",
				"-noautorotate",
				"-f",
				"image2",
				"-pattern_type",
				"none",
				"-framerate",
				"30",
				"-c:v",
				header.format === "PNG" ? "png" : "mjpeg",
				"-i",
				imagePath,
				"-f",
				"lavfi",
				"-i",
				"anullsrc=channel_layout=stereo:sample_rate=48000",
				"-filter_complex",
				"[0:v]" +
					foreground +
					"[image];color=c=black:s=1920x1080:r=30[black];[black][image]overlay=(W-w)/2:(H-h)/2:shortest=1,format=yuv420p[out]",
				"-map",
				"[out]",
				"-map",
				"1:a:0",
				"-map_metadata",
				"-1",
				"-map_chapters",
				"-1",
				"-sn",
				"-dn",
				"-frames:v",
				String(Math.ceil((request.durationMs * 30) / 1000)),
				"-t",
				String(Math.ceil((request.durationMs * 30) / 1000) / 30),
				"-c:v",
				"libx264",
				"-preset",
				"veryfast",
				"-tune",
				"stillimage",
				"-crf",
				"18",
				"-threads",
				"1",
				"-pix_fmt",
				"yuv420p",
				"-c:a",
				"aac",
				"-b:a",
				"128k",
				"-ar",
				"48000",
				"-ac",
				"2",
				"-movflags",
				"+faststart",
				"-fs",
				String(VOD_INPUT_PREVIEW_MAX_OUTPUT_BYTES),
				path,
			],
			options(),
		);
		const size = (await stat(path)).size;
		if (size <= 0 || size >= VOD_INPUT_PREVIEW_MAX_OUTPUT_BYTES)
			return fail("OUTPUT_LIMIT");
		const local = await readFile(path),
			sha256 = createHash("sha256").update(local).digest("hex");
		const localProbe = await execute(
			input.ffprobePath ?? "ffprobe",
			[
				"-v",
				"error",
				"-max_alloc",
				"67108864",
				"-protocol_whitelist",
				"file,pipe",
				"-format_whitelist",
				"mov",
				"-i",
				path,
				"-show_streams",
				"-show_format",
				"-of",
				"json",
			],
			options(),
		);
		validateGeneratedProbe(JSON.parse(localProbe.stdout), request.durationMs);
		input.signal.throwIfAborted();
		try {
			await abortableVodOperation(
				outputBrowser.putObject({
					bucket: source.bucket,
					key: source.objectKey,
					filePath: path,
					contentType: "video/mp4",
				}),
				ioSignal(),
			);
		} catch (error) {
			if (input.signal.aborted) throw error;
			return fail("IMAGE_OUTPUT_WRITE_FAILED");
		}
		const outputHead = await abortableVodOperation(
			outputBrowser.headObject({
				bucket: source.bucket,
				key: source.objectKey,
			}),
			ioSignal(),
		);
		try {
			assertVodSourceIdentity(outputHead);
		} catch {
			return fail("IMAGE_OUTPUT_UNVERIFIED");
		}
		if (outputHead.size !== size) return fail("IMAGE_OUTPUT_UNVERIFIED");
		const remote = await readObject({
			browser: outputBrowser,
			bucket: source.bucket,
			key: source.objectKey,
			expect: outputHead,
			signal: ioSignal(),
			collect: false,
			output: true,
		});
		if (remote.sha256 !== sha256) return fail("IMAGE_OUTPUT_UNVERIFIED");
		const [facts] = await probeVodInputSources({ ...input, sources: [source] });
		if (
			!facts ||
			!sameIdentity(facts.identity, outputHead) ||
			facts.durationMs < request.durationMs ||
			!facts.video ||
			!facts.audio ||
			(facts.video.durationMs ?? 0) < request.durationMs ||
			(facts.audio.durationMs ?? 0) < request.durationMs ||
			facts.video.width !== 1920 ||
			facts.video.height !== 1080 ||
			facts.video.frameRate?.num !== 30 ||
			facts.video.frameRate?.den !== 1
		)
			return fail("IMAGE_OUTPUT_INVALID");
		const finalHead = await abortableVodOperation(
			outputBrowser.headObject({
				bucket: source.bucket,
				key: source.objectKey,
			}),
			ioSignal(),
		);
		if (!sameIdentity(outputHead, finalHead))
			return fail("IMAGE_OUTPUT_UNVERIFIED");
		input.signal.throwIfAborted();
		const result = vodInputPreviewResultSchema.parse({
			prepared: {
				source,
				facts,
				requestedDurationMs: request.durationMs,
				sha256,
			},
		});
		if (!result.prepared) return fail("IMAGE_OUTPUT_INVALID");
		return result.prepared;
	} finally {
		for (const browser of browsers) browser.dispose?.();
	}
}
