import {
	type VodInputTimelineSource,
	type VodInputTimelineSourceFacts,
	vodInputTimelineSourceFactsSchema,
} from "@bitovp/core/vod-input-timeline";
import type { ObjectIdentity } from "@bitovp/storage";
import {
	MediaOperationError,
	runMediaProcess,
} from "../library-editing/process";
import {
	VOD_INPUT_PREVIEW_MAX_SOURCE_PIXELS,
	type VodInputMediaDependencies,
	vodInputPreviewReadArgs,
} from "./media-profile";
import {
	abortableVodOperation,
	assertVodSourceIdentity,
	createVodRangeBridge,
} from "./range-bridge";

export {
	VOD_INPUT_PREVIEW_MAX_OUTPUT_BYTES,
	VOD_INPUT_PREVIEW_MAX_SOURCE_PIXELS,
	vodInputPreviewCanvas,
	vodInputPreviewReadArgs,
} from "./media-profile";
export { renderVodInputPreview } from "./render";

const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const invalid = (): never => {
	throw new MediaOperationError("SOURCE_UNSUPPORTED");
};

function displayAspectRatio(
	video: Record<string, unknown>,
	width: number,
	height: number,
) {
	const sar = /^(\d+):(\d+)$/.exec(
		String(
			video.sample_aspect_ratio === undefined
				? "1:1"
				: video.sample_aspect_ratio,
		),
	);
	if (!sar) return invalid();
	const sarNum = Number(sar[1]),
		sarDen = Number(sar[2]);
	if (
		![sarNum, sarDen].every(
			(value) =>
				Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647,
		)
	)
		return invalid();
	const angle = (value: unknown) => {
		if (
			(typeof value !== "number" && typeof value !== "string") ||
			!/^[+-]?\d+(?:\.\d+)?$/.test(String(value))
		)
			return invalid();
		const degrees = Number(value),
			snapped = Math.round(degrees / 90) * 90;
		if (!Number.isFinite(degrees) || Math.abs(degrees - snapped) > 0.001)
			return invalid();
		return ((snapped % 360) + 360) % 360;
	};
	const matrices = (
		Array.isArray(video.side_data_list) ? video.side_data_list.map(record) : []
	).filter((side) => side.side_data_type === "Display Matrix");
	const rotations = matrices.map((side) => {
		const rotation = angle(side.rotation);
		if (side.displaymatrix !== undefined) {
			const rows = String(side.displaymatrix)
				.trim()
				.split(/\r?\n/)
				.map((line) =>
					/^\s*[\da-f]{8}:\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*$/i.exec(line),
				);
			if (rows.length !== 3 || rows.some((row) => !row)) return invalid();
			const values = rows.flatMap((row) =>
				row ? row.slice(1).map(Number) : [],
			);
			const [a = NaN, b = NaN, u, c = NaN, d = NaN, v, x, y, w] = values;
			// Only ordinary quarter-turn rotation matrices; no shear, mirroring, scaling or translation.
			if (
				![a, b, c, d].every((value) => [0, -65536, 65536].includes(value)) ||
				u !== 0 ||
				v !== 0 ||
				x !== 0 ||
				y !== 0 ||
				w !== 1073741824 ||
				a * d - b * c !== 4294967296 ||
				a * a + b * b !== 4294967296 ||
				c * c + d * d !== 4294967296 ||
				(a === 0) !== (rotation % 180 !== 0)
			)
				return invalid();
		}
		return rotation;
	});
	const rotation = rotations[0] ?? 0;
	if (rotations.some((value) => value !== rotation)) return invalid();
	const tag = record(video.tags).rotate;
	if (
		tag !== undefined &&
		(angle(tag) !== rotation || (!matrices.length && angle(tag) !== 0))
	)
		return invalid();
	let num = width * sarNum,
		den = height * sarDen;
	if (rotation === 90 || rotation === 270) [num, den] = [den, num];
	if (
		![num, den].every(Number.isSafeInteger) ||
		num / den > 320 ||
		num / den < 1 / 180
	)
		return invalid();
	const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
	const divisor = gcd(num, den);
	return { num: num / divisor, den: den / divisor };
}

/** Narrow returned facts, never return ffprobe's arbitrary tags, paths or diagnostics. */
export function inspectVodInputProbe(
	key: string,
	raw: unknown,
	identity: ObjectIdentity,
): VodInputTimelineSourceFacts {
	assertVodSourceIdentity(identity);
	const probe = record(raw);
	const streams = Array.isArray(probe.streams) ? probe.streams.map(record) : [];
	const video = streams.find(
		(stream) =>
			stream.codec_type === "video" &&
			record(stream.disposition).attached_pic !== 1,
	);
	const audio = streams.find((stream) => stream.codec_type === "audio");
	if (!video && !audio) return invalid();
	if (audio && ["enca", "encv"].includes(String(audio.codec_tag_string)))
		return invalid();
	const width = Number(video?.width),
		height = Number(video?.height);
	if (
		video &&
		(![width, height].every(
			(value) => Number.isSafeInteger(value) && value > 0,
		) ||
			width * height > VOD_INPUT_PREVIEW_MAX_SOURCE_PIXELS ||
			width > 8192 ||
			height > 8192 ||
			["encv", "enca"].includes(String(video.codec_tag_string)))
	)
		return invalid();
	function measuredDuration(stream: Record<string, unknown> | undefined) {
		if (stream?.duration === undefined || stream.duration === "N/A")
			return undefined;
		const seconds = Number(stream.duration);
		if (!Number.isFinite(seconds) || seconds <= 0) return invalid();
		return Math.floor(seconds * 1000);
	}
	const videoDurationMs = measuredDuration(video),
		audioDurationMs = measuredDuration(audio);
	const durationMs =
		videoDurationMs ??
		audioDurationMs ??
		Math.floor(Number(record(probe.format).duration) * 1000);
	if (!Number.isFinite(durationMs) || durationMs <= 0) return invalid();
	const ratio = /^(\d+)\/(\d+)$/.exec(String(video?.avg_frame_rate));
	const frameRate =
		ratio && Number(ratio[1]) > 0 && Number(ratio[2]) > 0
			? { num: Number(ratio[1]), den: Number(ratio[2]) }
			: undefined;
	const parsed = vodInputTimelineSourceFactsSchema.safeParse({
		key,
		durationMs,
		video: video
			? {
					streamIndex: Number(video.index),
					width,
					height,
					displayAspectRatio: displayAspectRatio(video, width, height),
					...(frameRate ? { frameRate } : {}),
					...(videoDurationMs !== undefined
						? { durationMs: videoDurationMs }
						: {}),
				}
			: null,
		audio: audio
			? {
					streamIndex: Number(audio.index),
					sampleRate: Number(audio.sample_rate),
					channels: Number(audio.channels),
					...(audioDurationMs !== undefined
						? { durationMs: audioDurationMs }
						: {}),
				}
			: null,
		identity: {
			size: identity.size,
			...(identity.etag ? { etag: identity.etag } : {}),
			...(identity.versionId ? { versionId: identity.versionId } : {}),
			...(identity.generation ? { generation: identity.generation } : {}),
		},
	});
	return parsed.success ? parsed.data : invalid();
}

export async function probeVodInputSources(
	input: VodInputMediaDependencies & {
		sources: readonly VodInputTimelineSource[];
	},
): Promise<VodInputTimelineSourceFacts[]> {
	const facts: VodInputTimelineSourceFacts[] = [];
	const execute = input.execute ?? runMediaProcess;
	for (const source of input.sources) {
		input.signal.throwIfAborted();
		const browser = await abortableVodOperation(
			input.browserFor(source.credentialId),
			input.signal,
			(late) => late.dispose?.(),
		);
		let identity: ObjectIdentity;
		try {
			if (!browser.headObject)
				throw new MediaOperationError("SOURCE_UNSUPPORTED");
			identity = await abortableVodOperation(
				browser.headObject({ bucket: source.bucket, key: source.objectKey }),
				AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]),
			);
			assertVodSourceIdentity(identity);
		} finally {
			browser.dispose?.();
		}
		const bridge = await createVodRangeBridge({
			sources: [{ source, identity }],
			browserFor: input.browserFor,
			signal: input.signal,
			maxBytes: 32 * 1024 ** 2,
		});
		try {
			const result = await execute(
				input.ffprobePath ?? "ffprobe",
				[
					"-v",
					"error",
					"-max_alloc",
					"67108864",
					...vodInputPreviewReadArgs(bridge.urlFor(source.key)),
					"-show_streams",
					"-show_format",
					"-of",
					"json",
				],
				{
					signal: input.signal,
					timeoutMs: input.timeoutMs ?? 30_000,
					maxOutputBytes: 1024 ** 2,
				},
			);
			bridge.throwIfFailed();
			facts.push(
				inspectVodInputProbe(source.key, JSON.parse(result.stdout), identity),
			);
		} catch (error) {
			bridge.throwIfFailed();
			throw error;
		} finally {
			await bridge.close();
		}
	}
	return facts;
}
