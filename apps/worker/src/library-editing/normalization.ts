import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import {
	type EditingNormalizationEvidence,
	type EditingNormalizationSource,
	editingNormalizationEvidenceSchema,
	editingNormalizationSourceSchema,
	hashEditingEvidence,
} from "@bitovp/core";
import {
	assertLocalMediaPath,
	type EditingMediaFacts,
	probeEditingMedia,
} from "./media";
import { MediaOperationError, runMediaProcess } from "./process";

const fail = (): never => {
	throw new MediaOperationError("UNSUPPORTED_MEDIA");
};
const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const numeric = (value: unknown) =>
	value !== "" && value !== null && value !== undefined ? Number(value) : NaN;
const positiveInteger = (value: unknown) =>
	Number.isSafeInteger(numeric(value)) && numeric(value) > 0;
function ratio(value: unknown) {
	if (typeof value !== "string" || !/^\d+\/\d+$/.test(value)) return fail();
	const [num, den] = value.split("/").map(Number);
	if (!num || !den || !Number.isSafeInteger(num) || !Number.isSafeInteger(den))
		return fail();
	const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
	const divisor = gcd(num, den);
	return { num: num / divisor, den: den / divisor };
}
type AudioMetadata = {
	sampleRate: 44100 | 48000;
	channels: 1 | 2;
	timeBase: { num: number; den: number };
};
export type NormalizationMetadata = Omit<
	EditingNormalizationSource,
	"videoPtsHash" | "audio"
> & { audio: AudioMetadata | null };

function sourceColorProfile(
	video: Record<string, unknown>,
): EditingNormalizationSource["colorProfile"] {
	const color = [
		video.color_primaries,
		video.color_transfer,
		video.color_space,
	];
	if (
		video.color_range !== undefined &&
		!["tv", "unknown", "unspecified"].includes(String(video.color_range))
	)
		return fail();
	if (color.every((value) => value === "bt709")) return "BT709_8BIT_LIMITED";
	if (
		color.every(
			(value) =>
				value === undefined || value === "unknown" || value === "unspecified",
		)
	)
		// Compatibility interpretation, not a claim about the untagged original.
		return "BT709_8BIT_LIMITED_ASSUMED";
	return fail();
}

/** Metadata is only admission; full decoded video/audio indices are also required. */
export function inspectNormalizationSourceMetadata(
	raw: unknown,
): NormalizationMetadata {
	const probe = object(raw);
	const streams = Array.isArray(probe.streams) ? probe.streams.map(object) : [];
	const video = streams.filter((s) => s.codec_type === "video");
	const audio = streams.filter((s) => s.codec_type === "audio");
	if (
		video.length !== 1 ||
		audio.length > 1 ||
		streams.length !== video.length + audio.length ||
		!String(object(probe.format).format_name).split(",").includes("mov")
	)
		return fail();
	const v = video[0] ?? {};
	const fps = ratio(v.r_frame_rate);
	const avg = ratio(v.avg_frame_rate);
	const frameCount = numeric(v.nb_frames);
	const width = numeric(v.width),
		height = numeric(v.height);
	const supported = [
		[24, 1],
		[25, 1],
		[30000, 1001],
		[30, 1],
	].some(([n, d]) => fps.num === n && fps.den === d);
	const sides = Array.isArray(v.side_data_list)
		? v.side_data_list.map(object)
		: [];
	const colorProfile = sourceColorProfile(v);
	if (
		!supported ||
		fps.num !== avg.num ||
		fps.den !== avg.den ||
		!["h264", "hevc"].includes(String(v.codec_name)) ||
		!(v.codec_name === "h264"
			? v.codec_tag_string === "avc1"
			: ["hvc1", "hev1"].includes(String(v.codec_tag_string))) ||
		v.pix_fmt !== "yuv420p" ||
		v.field_order !== "progressive" ||
		v.sample_aspect_ratio !== "1:1" ||
		numeric(v.start_time) !== 0 ||
		(object(v.tags).rotate !== undefined &&
			numeric(object(v.tags).rotate) !== 0) ||
		sides.some(
			(s) =>
				(s.rotation !== undefined && numeric(s.rotation) !== 0) ||
				/encrypt|drm|hdr|dolby|dovi|mastering display|content light/i.test(
					String(s.side_data_type),
				),
		) ||
		!positiveInteger(width) ||
		!positiveInteger(height) ||
		width < 2 ||
		height < 2 ||
		width > 8192 ||
		height > 8192 ||
		width % 2 ||
		height % 2 ||
		!positiveInteger(frameCount) ||
		frameCount > 108000 ||
		!Number.isFinite(numeric(v.duration)) ||
		Math.abs(numeric(v.duration) - (frameCount * fps.den) / fps.num) > 0.000002
	)
		return fail();
	const durationUs = Number(
		(BigInt(frameCount) * BigInt(fps.den) * 1_000_000n + BigInt(fps.num) - 1n) /
			BigInt(fps.num),
	);
	if (durationUs > 3_600_000_000) return fail();
	const a = audio[0];
	if (
		a &&
		(a.codec_name !== "aac" ||
			a.codec_tag_string === "enca" ||
			![44100, 48000].includes(numeric(a.sample_rate)) ||
			![1, 2].includes(numeric(a.channels)) ||
			numeric(a.start_time) !== 0)
	)
		return fail();
	return {
		width,
		height,
		codec: v.codec_name as "h264" | "hevc",
		fps,
		timeBase: ratio(v.time_base),
		frameCount,
		durationUs,
		colorProfile,
		audio: a
			? {
					sampleRate: numeric(a.sample_rate) as 44100 | 48000,
					channels: numeric(a.channels) as 1 | 2,
					timeBase: ratio(a.time_base),
				}
			: null,
	};
}

export function validateNormalizationVideoIndex(
	source: NormalizationMetadata,
	csv: string,
): string {
	const values = csv
		.split(/\r?\n/)
		.map((row) => row.split(",")[0]?.trim() ?? "")
		.filter(Boolean);
	if (values.length !== source.frameCount)
		throw new MediaOperationError("SOURCE_INCOMPLETE");
	for (const [index, value] of values.entries()) {
		if (
			!/^\d+$/.test(value) ||
			BigInt(value) * BigInt(source.timeBase.num) * BigInt(source.fps.num) !==
				BigInt(index) * BigInt(source.fps.den) * BigInt(source.timeBase.den)
		)
			return fail();
	}
	return hashEditingEvidence(values);
}

function audioIndex(audio: AudioMetadata, csv: string) {
	const rows = csv.split(/\r?\n/).filter((r) => r.trim());
	let count = 0;
	for (const row of rows) {
		const [pts, samples] = row.split(",");
		if (
			!pts ||
			!/^\d+$/.test(pts) ||
			!positiveInteger(samples) ||
			numeric(samples) > 8192 ||
			BigInt(pts) * BigInt(audio.timeBase.num) * BigInt(audio.sampleRate) !==
				BigInt(count) * BigInt(audio.timeBase.den)
		)
			return fail();
		count += numeric(samples);
	}
	if (!count || count > 180_000_000) return fail();
	return {
		sampleRate: audio.sampleRate,
		channels: audio.channels,
		sampleCount: count,
		ptsHash: hashEditingEvidence(rows),
	};
}

export function buildNormalizationRecipe(
	source: Pick<EditingNormalizationSource, "frameCount" | "fps"> & {
		audio: object | null;
	},
) {
	const outputFrameCount = Number(
		(BigInt(source.frameCount) * 30n * BigInt(source.fps.den)) /
			BigInt(source.fps.num),
	);
	if (!outputFrameCount || outputFrameCount > 108000) return fail();
	const sourceFrameIndex = Array.from({ length: outputFrameCount }, (_, j) =>
		Number(
			(BigInt(j) * BigInt(source.fps.num)) / (30n * BigInt(source.fps.den)),
		),
	);
	const sourceEndUs = Math.ceil((outputFrameCount * 1_000_000) / 30);
	return {
		outputFrameCount,
		sourceFrameIndex,
		sourceEndUs,
		videoFilter: `fps=fps=30:start_time=0:round=up:eof_action=pass,trim=end_frame=${outputFrameCount},setpts=N/(30*TB),setsar=1/1`,
		audioFilter: source.audio
			? `aresample=48000:async=0:first_pts=0,apad=whole_len=${outputFrameCount * 1600},atrim=end_sample=${outputFrameCount * 1600},asetpts=N/SR/TB`
			: null,
	};
}

const readInput = (path: string) => [
	"-protocol_whitelist",
	"file,pipe",
	"-format_whitelist",
	"mov",
	"-enable_drefs",
	"0",
	"-use_absolute_path",
	"0",
	"-i",
	path,
];
async function digestFile(path: string) {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size < 1 || stat.size > 4 * 1024 ** 3)
			throw new MediaOperationError("SOURCE_TOO_LARGE");
		const hash = createHash("sha256");
		let bytes = 0;
		for await (const chunk of file.createReadStream({ autoClose: false })) {
			hash.update(chunk);
			bytes += chunk.length;
		}
		if (bytes !== stat.size) throw new MediaOperationError("SOURCE_CHANGED");
		return { sha256: hash.digest("hex"), bytes };
	} finally {
		await file.close();
	}
}

export async function probeEditingNormalizationSource(input: {
	sourcePath: string;
	ffprobePath?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<{
	source: EditingNormalizationSource;
	metadata: NormalizationMetadata;
}> {
	assertLocalMediaPath(input.sourcePath);
	const options = { signal: input.signal, timeoutMs: input.timeoutMs };
	const read = async (args: string[]) => {
		const result = await runMediaProcess(
			input.ffprobePath ?? "ffprobe",
			["-v", "error", ...readInput(input.sourcePath), ...args],
			options,
		);
		if (result.stderr.trim())
			throw new MediaOperationError("SOURCE_INCOMPLETE");
		return result.stdout;
	};
	const metadata = inspectNormalizationSourceMetadata(
		JSON.parse(await read(["-show_streams", "-show_format", "-of", "json"])),
	);
	const videoPtsHash = validateNormalizationVideoIndex(
		metadata,
		await read([
			"-select_streams",
			"v:0",
			"-show_frames",
			"-show_entries",
			"frame=best_effort_timestamp",
			"-of",
			"csv=p=0",
		]),
	);
	const audio = metadata.audio
		? audioIndex(
				metadata.audio,
				await read([
					"-select_streams",
					"a:0",
					"-show_frames",
					"-show_entries",
					"frame=best_effort_timestamp,nb_samples",
					"-of",
					"csv=p=0",
				]),
			)
		: null;
	const source = editingNormalizationSourceSchema.parse({
		...metadata,
		audio,
		videoPtsHash,
	});
	return { source, metadata };
}

export async function normalizeEditingMedia(input: {
	sourcePath: string;
	destinationPath: string;
	expectedSourceSha256: string;
	ffmpegPath?: string;
	ffprobePath?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<{
	path: string;
	facts: EditingMediaFacts;
	originalSha256: string;
	preparedSha256: string;
	bytes: number;
	normalization: EditingNormalizationEvidence;
}> {
	assertLocalMediaPath(input.sourcePath);
	assertLocalMediaPath(input.destinationPath);
	if (input.signal?.aborted) throw new MediaOperationError("CANCELED");
	if (
		input.sourcePath === input.destinationPath ||
		!/^[a-f0-9]{64}$/.test(input.expectedSourceSha256)
	)
		throw new MediaOperationError("SOURCE_UNVERIFIED");
	const original = await digestFile(input.sourcePath);
	if (original.sha256 !== input.expectedSourceSha256)
		throw new MediaOperationError("SOURCE_CHANGED");
	const options = { signal: input.signal, timeoutMs: input.timeoutMs };
	const { source, metadata } = await probeEditingNormalizationSource(input);
	const audio = source.audio;
	const recipe = buildNormalizationRecipe(metadata);
	let facts: EditingMediaFacts | undefined;
	if (
		metadata.codec === "h264" &&
		metadata.fps.num === 30 &&
		metadata.fps.den === 1 &&
		metadata.colorProfile === "BT709_8BIT_LIMITED"
	)
		facts = await probeEditingMedia({
			sourcePath: input.sourcePath,
			ffprobePath: input.ffprobePath,
			...options,
		});
	let owned = false;
	try {
		if (!facts) {
			const output = await open(input.destinationPath, "wx", 0o600);
			owned = true;
			await output.close();
			await runMediaProcess(
				input.ffmpegPath ?? "ffmpeg",
				[
					"-hide_banner",
					"-v",
					"error",
					"-nostdin",
					"-y",
					"-noautorotate",
					...readInput(input.sourcePath),
					"-map",
					"0:v:0",
					...(audio ? ["-map", "0:a:0"] : ["-an"]),
					"-vf",
					recipe.videoFilter,
					...(recipe.audioFilter
						? [
								"-af",
								recipe.audioFilter,
								"-c:a",
								"aac",
								"-ar",
								"48000",
								"-ac",
								String(audio?.channels),
							]
						: []),
					"-c:v",
					"libx264",
					"-threads",
					"2",
					"-preset",
					"fast",
					"-crf",
					"18",
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
					"-fps_mode",
					"cfr",
					"-r",
					"30",
					"-frames:v",
					String(recipe.outputFrameCount),
					"-map_metadata",
					"-1",
					"-map_chapters",
					"-1",
					"-video_track_timescale",
					"90000",
					"-movflags",
					"+faststart",
					"-fs",
					String(4 * 1024 ** 3),
					"-f",
					"mp4",
					input.destinationPath,
				],
				options,
			);
			facts = await probeEditingMedia({
				sourcePath: input.destinationPath,
				ffprobePath: input.ffprobePath,
				...options,
			});
		}
		if (
			facts.frameCount !== recipe.outputFrameCount ||
			facts.width !== source.width ||
			facts.height !== source.height ||
			facts.hasAudio !== (audio !== null)
		)
			throw new MediaOperationError("SOURCE_INCOMPLETE");
		if ((await digestFile(input.sourcePath)).sha256 !== original.sha256)
			throw new MediaOperationError("SOURCE_CHANGED");
		const path = owned ? input.destinationPath : input.sourcePath;
		const prepared = owned ? await digestFile(path) : original;
		const normalization = editingNormalizationEvidenceSchema.parse({
			schemaVersion: 1,
			profile: "SDR_CFR30_INDEXED_V1",
			mode: owned ? "NORMALIZE" : "IDENTITY_COPY",
			originalSha256: original.sha256,
			preparedSha256: prepared.sha256,
			originalBytes: original.bytes,
			preparedBytes: prepared.bytes,
			source,
			output: {
				width: facts.width,
				height: facts.height,
				frameCount: facts.frameCount,
				durationUs: facts.durationUs,
				fps: facts.fps,
				hasAudio: facts.hasAudio,
			},
			sourceStartUs: 0,
			sourceEndUs: recipe.sourceEndUs,
			sourceFrameIndex: recipe.sourceFrameIndex,
			indexMapHash: hashEditingEvidence(recipe.sourceFrameIndex),
			recipeHash: hashEditingEvidence({
				profile: "SDR_CFR30_INDEXED_V1",
				mode: owned ? "NORMALIZE" : "IDENTITY_COPY",
				source,
				videoFilter: recipe.videoFilter,
				audioFilter: recipe.audioFilter,
			}),
		});
		return {
			path,
			facts,
			originalSha256: original.sha256,
			preparedSha256: prepared.sha256,
			bytes: prepared.bytes,
			normalization,
		};
	} catch (error) {
		if (owned) await rm(input.destinationPath, { force: true });
		throw error;
	}
}
