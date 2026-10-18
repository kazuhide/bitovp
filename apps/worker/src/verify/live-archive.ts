import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const ARCHIVE_MAX_BYTES = 250_000_000;

/** Exact conditional GET accounting; neither truncation nor extra bytes is evidence. */
export async function writeArchiveBytes(
	chunks: AsyncIterable<Buffer>,
	expected: number,
	write: (chunk: Buffer) => Promise<void>,
) {
	assert.ok(
		Number.isSafeInteger(expected) &&
			expected > 0 &&
			expected <= ARCHIVE_MAX_BYTES,
	);
	let bytes = 0;
	const hash = createHash("sha256");
	for await (const chunk of chunks) {
		assert.ok(Buffer.isBuffer(chunk));
		bytes += chunk.length;
		assert.ok(bytes <= expected);
		hash.update(chunk);
		await write(chunk);
	}
	assert.equal(bytes, expected);
	return { bytes, sha256: hash.digest("hex") };
}

export function archiveMediaFacts(probe: unknown, expectedCodecs: string[]) {
	const streams = (probe as { streams?: Record<string, unknown>[] }).streams;
	assert.ok(Array.isArray(streams));
	assert.ok(expectedCodecs.length > 0);
	assert.ok(
		expectedCodecs.every((codec) => codec === "h264" || codec === "aac"),
	);
	assert.deepEqual(
		streams.map((s) => s.codec_name).sort(),
		[...expectedCodecs].sort(),
	);
	const video = streams.filter((s) => s.codec_type === "video");
	const audio = streams.filter((s) => s.codec_type === "audio");
	assert.ok(
		streams.every(
			(s) => s.codec_type === (s.codec_name === "h264" ? "video" : "audio"),
		),
	);
	assert.ok(
		streams.every(
			(s) =>
				Number.isFinite(Number(s.duration)) &&
				Number(s.duration) > 0 &&
				Number(s.nb_read_frames) > 0,
		),
	);
	const videoDurationSeconds = video.length
		? Math.max(...video.map((s) => Number(s.duration)))
		: null;
	const audioDurationSeconds = audio.length
		? Math.max(...audio.map((s) => Number(s.duration)))
		: null;
	return {
		videoDurationSeconds,
		audioDurationSeconds,
		durationDifferenceSeconds:
			videoDurationSeconds === null || audioDurationSeconds === null
				? null
				: Math.abs(videoDurationSeconds - audioDurationSeconds),
		avSync: "UNVERIFIED" as const,
	};
}

/** Local-only decode: no MP4-contained network reference may leave the process. */
export async function inspectArchiveBytes(
	chunks: AsyncIterable<Buffer>,
	expectedSize: number,
	codecs: string[],
	signal: AbortSignal,
) {
	const dir = await mkdtemp(join(tmpdir(), "bitovp-archive-"));
	const file = join(dir, "archive.mp4");
	try {
		const handle = await open(file, "wx", 0o600);
		let identity: { bytes: number; sha256: string };
		try {
			identity = await writeArchiveBytes(
				chunks,
				expectedSize,
				async (chunk) => {
					signal.throwIfAborted();
					await handle.writeFile(chunk);
				},
			);
		} finally {
			await handle.close();
		}
		signal.throwIfAborted();
		const input = [
			"-threads",
			"1",
			"-protocol_whitelist",
			"file,pipe",
			"-f",
			"mov",
			"-i",
			file,
		];
		const probe = await exec(
			process.env.FFPROBE_PATH ?? "ffprobe",
			[
				"-v",
				"error",
				...input,
				"-count_frames",
				"-show_entries",
				"stream=codec_type,codec_name,duration,nb_read_frames",
				"-of",
				"json",
			],
			{ signal, timeout: 120_000, maxBuffer: 1_000_000 },
		);
		// ffprobe can report a recoverable decode error and still exit zero.
		assert.equal(probe.stderr.trim(), "");
		const facts = archiveMediaFacts(JSON.parse(probe.stdout), codecs);
		await exec(
			process.env.FFMPEG_PATH ?? "ffmpeg",
			[
				"-v",
				"error",
				"-xerror",
				...input,
				"-map",
				"0",
				"-filter_threads",
				"1",
				"-f",
				"null",
				"-",
			],
			{ signal, timeout: 120_000, maxBuffer: 1_000_000 },
		);
		return { ...identity, ...facts };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
