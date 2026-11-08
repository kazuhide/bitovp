import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { type EditingObject, editingObjectSchema } from "@bitovp/core";
import type {
	ObjectIdentity,
	ObjectStorageBrowser,
	ObjectVersion,
} from "@bitovp/storage";
import { assertLocalMediaPath, downloadPinnedEditingMedia } from "./media";
import { MediaOperationError, runMediaProcess } from "./process";

export const HLS_PREPARATION_LIMITS = Object.freeze({
	playlists: 3,
	playlistBytes: 1024 * 1024,
	objects: 4096,
	totalBytes: 4 * 1024 ** 3,
	durationSeconds: 3600,
	timeoutMs: 20 * 60 * 1000,
	witnessBytes: 4 * 1024 * 1024,
});
const hasControl = (s: string, playlist = false) =>
	Array.from(s).some((c) => {
		const code = c.charCodeAt(0);
		return (
			(code < 32 && !(playlist && [9, 10, 13].includes(code))) || code === 127
		);
	});
function unsupported(): never {
	throw new MediaOperationError("HLS_UNSUPPORTED");
}
function limited(): never {
	throw new MediaOperationError("HLS_LIMIT");
}
export type EditingHlsVariant = {
	uri: string;
	width: number;
	height: number;
	bandwidth: number;
	audioGroup?: string;
	codecs?: string;
	frameRate?: string;
	videoRange?: string;
};
export type EditingHlsAudio = {
	uri?: string;
	groupId: string;
	default: boolean;
	name: string;
};
export type EditingHlsPlaylist =
	| { kind: "MASTER"; variants: EditingHlsVariant[]; audio: EditingHlsAudio[] }
	| {
			kind: "MEDIA";
			initUri?: string;
			segments: { uri: string; duration: number }[];
			durationSeconds: number;
			targetDuration: number;
	  };
function attributes(value: string): Record<string, string> {
	const result: Record<string, string> = {};
	let offset = 0;
	while (offset < value.length) {
		const match = /^([A-Z0-9-]+)=("[^"\r\n]*"|[^,\r\n]+)(?:,|$)/.exec(
			value.slice(offset),
		);
		if (!match) unsupported();
		const name = match[1],
			raw = match[2];
		if (!name || raw === undefined || Object.hasOwn(result, name))
			unsupported();
		result[name] = raw.startsWith('"') ? raw.slice(1, -1) : raw;
		offset += match[0].length;
	}
	return result;
}
export function resolveEditingHlsKey(
	playlistKey: string,
	uri: string,
	rootPrefix: string,
): string {
	if (
		!uri ||
		uri.length > 4096 ||
		hasControl(uri) ||
		/[\s\\?#]/u.test(uri) ||
		uri.startsWith("/") ||
		/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri) ||
		/%(?:2f|5c)/i.test(uri)
	)
		unsupported();
	let decoded: string;
	try {
		decoded = decodeURIComponent(uri);
	} catch {
		unsupported();
	}
	if (
		hasControl(decoded) ||
		/[\\?#]/u.test(decoded) ||
		decoded.startsWith("/") ||
		/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(decoded)
	)
		unsupported();
	const root = rootPrefix.replace(/\/+$/, ""),
		key = posix.normalize(posix.join(posix.dirname(playlistKey), decoded));
	if (
		key.startsWith("../") ||
		key === ".." ||
		key.startsWith("/") ||
		(root !== "" && !key.startsWith(`${root}/`)) ||
		key.length > 4096
	)
		unsupported();
	return key;
}
/** Deliberately accepts the bounded VOD subset; unsupported tags are never passed through to ffmpeg. */
export function parseEditingHlsPlaylist(text: string): EditingHlsPlaylist {
	if (Buffer.byteLength(text) > HLS_PREPARATION_LIMITS.playlistBytes) limited();
	if (text.startsWith("\ufeff") || hasControl(text, true)) unsupported();
	const lines = text.split(/\r?\n/).map((line) => line.trim());
	if (lines[0] !== "#EXTM3U") unsupported();
	const variants: EditingHlsVariant[] = [],
		audio: EditingHlsAudio[] = [],
		segments: { uri: string; duration: number }[] = [];
	let pendingVariant: Record<string, string> | undefined,
		pendingDuration: number | undefined,
		initUri: string | undefined,
		targetDuration = 0,
		ended = false,
		kind: "MASTER" | "MEDIA" | undefined,
		durationSeconds = 0;
	for (const line of lines.slice(1)) {
		if (!line) continue;
		if (ended) unsupported();
		if (line.startsWith("#EXT-X-STREAM-INF:")) {
			if (kind === "MEDIA" || pendingVariant || pendingDuration !== undefined)
				unsupported();
			kind = "MASTER";
			pendingVariant = attributes(line.slice(18));
			continue;
		}
		if (line.startsWith("#EXT-X-MEDIA:")) {
			if (kind === "MEDIA") unsupported();
			kind = "MASTER";
			const a = attributes(line.slice(13));
			if (
				a.TYPE !== "AUDIO" ||
				!a["GROUP-ID"] ||
				!a.NAME ||
				![undefined, "YES", "NO"].includes(a.DEFAULT)
			)
				unsupported();
			audio.push({
				groupId: a["GROUP-ID"],
				name: a.NAME,
				default: a.DEFAULT === "YES",
				...(a.URI ? { uri: a.URI } : {}),
			});
			continue;
		}
		if (line.startsWith("#EXTINF:")) {
			if (kind === "MASTER" || pendingDuration !== undefined) unsupported();
			kind = "MEDIA";
			const value = line.slice(8).split(",")[0];
			if (!value || !/^\d+(?:\.\d+)?$/.test(value)) unsupported();
			pendingDuration = Number(value);
			if (!(pendingDuration > 0) || !Number.isFinite(pendingDuration))
				unsupported();
			continue;
		}
		if (line.startsWith("#EXT-X-MAP:")) {
			if (kind === "MASTER" || initUri || segments.length) unsupported();
			kind = "MEDIA";
			const a = attributes(line.slice(11));
			if (!a.URI || Object.keys(a).some((key) => key !== "URI")) unsupported();
			initUri = a.URI;
			continue;
		}
		if (line === "#EXT-X-ENDLIST") {
			if (kind === "MASTER" || pendingDuration !== undefined) unsupported();
			ended = true;
			continue;
		}
		if (line.startsWith("#EXT-X-TARGETDURATION:")) {
			const n = Number(line.slice(22));
			if (targetDuration || !Number.isSafeInteger(n) || n < 1 || n > 3600)
				unsupported();
			targetDuration = n;
			continue;
		}
		if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
			if (!/^\d+$/.test(line.slice(22))) unsupported();
			continue;
		}
		if (line.startsWith("#EXT-X-PLAYLIST-TYPE:")) {
			if (line !== "#EXT-X-PLAYLIST-TYPE:VOD") unsupported();
			continue;
		}
		if (line.startsWith("#EXT-X-VERSION:")) {
			if (!/^\d+$/.test(line.slice(15))) unsupported();
			continue;
		}
		if (line === "#EXT-X-INDEPENDENT-SEGMENTS") continue;
		if (line.startsWith("#EXT")) unsupported();
		if (line.startsWith("#")) continue;
		if (pendingVariant) {
			const resolution = /^(\d+)x(\d+)$/.exec(pendingVariant.RESOLUTION ?? ""),
				bandwidth = Number(pendingVariant.BANDWIDTH);
			if (!resolution || !Number.isSafeInteger(bandwidth) || bandwidth < 1)
				unsupported();
			const width = Number(resolution[1]),
				height = Number(resolution[2]);
			if (
				!Number.isSafeInteger(width) ||
				!Number.isSafeInteger(height) ||
				width < 2 ||
				height < 2 ||
				width > 8192 ||
				height > 8192
			)
				unsupported();
			variants.push({
				uri: line,
				width,
				height,
				bandwidth,
				...(pendingVariant.AUDIO ? { audioGroup: pendingVariant.AUDIO } : {}),
				...(pendingVariant.CODECS !== undefined
					? { codecs: pendingVariant.CODECS }
					: {}),
				...(pendingVariant["FRAME-RATE"] !== undefined
					? { frameRate: pendingVariant["FRAME-RATE"] }
					: {}),
				...(pendingVariant["VIDEO-RANGE"] !== undefined
					? { videoRange: pendingVariant["VIDEO-RANGE"] }
					: {}),
			});
			pendingVariant = undefined;
		} else if (pendingDuration !== undefined) {
			segments.push({ uri: line, duration: pendingDuration });
			durationSeconds += pendingDuration;
			if (segments.length > 4096 || durationSeconds > 3600) limited();
			pendingDuration = undefined;
		} else unsupported();
	}
	if (pendingVariant || pendingDuration !== undefined) unsupported();
	if (kind === "MASTER") {
		if (!variants.length || variants.length > 128 || audio.length > 128)
			unsupported();
		return { kind, variants, audio };
	}
	if (
		kind !== "MEDIA" ||
		!ended ||
		!segments.length ||
		!targetDuration ||
		segments.some((s) => Math.round(s.duration) > targetDuration)
	)
		unsupported();
	return {
		kind,
		segments,
		durationSeconds,
		targetDuration,
		...(initUri ? { initUri } : {}),
	};
}
/** Declarations can reject a known unsupported sibling, never replace native CFR/8-bit/SDR validation. */
function supportsDeclaredEditingProfile(variant: EditingHlsVariant): boolean {
	if (variant.codecs !== undefined) {
		const codecs = variant.codecs.split(",").map((codec) => codec.trim());
		const video = (codec: string) =>
			/^(?:avc1|avc3|hvc1|hev1)(?:\.|$)/i.test(codec);
		if (
			!codecs.some(video) ||
			!codecs.every((codec) => video(codec) || /^mp4a\.40\.\d+$/i.test(codec))
		)
			return false;
	}
	if (
		variant.frameRate !== undefined &&
		(!/^\d+(?:\.\d+)?$/.test(variant.frameRate) ||
			![24, 25, 29.97, 30].includes(Number(variant.frameRate)))
	)
		return false;
	return variant.videoRange === undefined || variant.videoRange === "SDR";
}
export function selectEditingHlsVariant(playlist: EditingHlsPlaylist): {
	video: EditingHlsVariant;
	audio?: EditingHlsAudio;
} {
	if (playlist.kind !== "MASTER") unsupported();
	const variants = playlist.variants
		.filter(supportsDeclaredEditingProfile)
		.sort(
			(a, b) =>
				b.width * b.height - a.width * a.height ||
				b.bandwidth - a.bandwidth ||
				a.uri.localeCompare(b.uri),
		);
	const video = variants[0];
	if (!video) unsupported();
	if (!video.audioGroup) return { video };
	const group = playlist.audio.filter((a) => a.groupId === video.audioGroup),
		defaults = group.filter((a) => a.default);
	const audio =
		defaults.length === 1
			? defaults[0]
			: defaults.length === 0 && group.length === 1
				? group[0]
				: undefined;
	if (!audio) unsupported();
	return { video, audio };
}

export type HlsObjectCapture = {
	key: string;
	size: number;
	expect: ObjectVersion;
	sha256: string;
};
export type HlsSourceMaterialization = {
	version: "hls-vod-capture-v1";
	credentialId: string;
	bucket: string;
	rootManifestKey: string;
	videoPlaylistKey: string;
	audioPlaylistKey: string | null;
	objects: HlsObjectCapture[];
	downloadedBytes: number;
	remuxSha256: string;
	remuxBytes: number;
	timestampOrigin: {
		videoStartPts: number;
		timeBase: { num: number; den: number };
		offsetSeconds: string;
	};
};
/** All storage reads are conditional, all ffmpeg inputs are rewritten owned files. This witness is not an AISA input proof. */
export async function prepareHlsEditingSource(input: {
	browser: ObjectStorageBrowser;
	source: EditingObject;
	rootPrefix: string;
	directory: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	ffmpegPath?: string;
	ffprobePath?: string;
}): Promise<{
	path: string;
	sha256: string;
	bytes: number;
	witness: HlsSourceMaterialization;
}> {
	const timeoutMs = input.timeoutMs ?? HLS_PREPARATION_LIMITS.timeoutMs;
	if (
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > HLS_PREPARATION_LIMITS.timeoutMs
	)
		throw new RangeError("Invalid HLS preparation deadline");
	if (input.signal?.aborted) throw new MediaOperationError("CANCELED");
	const source = editingObjectSchema.parse(input.source);
	if (!source.size || !source.expect)
		throw new MediaOperationError("SOURCE_UNVERIFIED");
	assertLocalMediaPath(input.directory);
	if (
		input.rootPrefix.startsWith("/") ||
		input.rootPrefix.includes("\\") ||
		hasControl(input.rootPrefix) ||
		input.rootPrefix.split("/").some((s) => s === ".." || s === ".")
	)
		unsupported();
	if (
		resolveEditingHlsKey(
			source.key,
			posix.basename(source.key),
			input.rootPrefix,
		) !== source.key ||
		!source.key.endsWith(".m3u8")
	)
		unsupported();
	const signal = AbortSignal.any([
			AbortSignal.timeout(timeoutMs),
			...(input.signal ? [input.signal] : []),
		]),
		deadline = Date.now() + timeoutMs;
	const check = () => {
		if (signal.aborted || Date.now() >= deadline)
			throw new MediaOperationError(
				input.signal?.aborted ? "CANCELED" : "TIMED_OUT",
			);
	};
	const remaining = () => {
		check();
		return Math.max(1, deadline - Date.now());
	};
	const scratch = join(input.directory, "hls-source"),
		output = join(input.directory, "source.mp4");
	let ownedScratch = false,
		ownedOutput = false,
		complete = false,
		downloadedBytes = 0,
		playlistCount = 0,
		witnessBytes = 2;
	const cache = new Map<string, { path: string; receipt: HlsObjectCapture }>();
	try {
		check();
		await mkdir(scratch, { mode: 0o700 });
		ownedScratch = true;
		const capture = async (
			key: string,
			playlist = false,
			expectedIdentity?: ObjectIdentity,
		) => {
			const existing = cache.get(key);
			if (existing) return existing;
			if (cache.size >= HLS_PREPARATION_LIMITS.objects) limited();
			const ext = posix.extname(key).toLowerCase();
			if (
				!(playlist
					? ext === ".m3u8"
					: [".mp4", ".m4s", ".ts", ".aac"].includes(ext))
			)
				unsupported();
			if (playlist && ++playlistCount > HLS_PREPARATION_LIMITS.playlists)
				limited();
			const available = HLS_PREPARATION_LIMITS.totalBytes - downloadedBytes;
			if (available < 1) throw new MediaOperationError("SOURCE_TOO_LARGE");
			const path = join(scratch, `object-${cache.size}${ext}`),
				downloaded = await downloadPinnedEditingMedia({
					browser: input.browser,
					bucket: source.bucket,
					key,
					destinationPath: path,
					maxBytes: Math.min(
						available,
						playlist ? HLS_PREPARATION_LIMITS.playlistBytes : available,
					),
					...(expectedIdentity ? { expectedIdentity } : {}),
					signal,
					timeoutMs: remaining(),
				});
			check();
			downloadedBytes += downloaded.bytes;
			const identity = downloaded.identity,
				receipt: HlsObjectCapture = {
					key,
					size: downloaded.bytes,
					expect: {
						...(identity.etag ? { etag: identity.etag } : {}),
						...(identity.versionId ? { versionId: identity.versionId } : {}),
						...(identity.generation ? { generation: identity.generation } : {}),
					},
					sha256: downloaded.sha256,
				};
			const entry = { path, receipt };
			witnessBytes += Buffer.byteLength(JSON.stringify(receipt)) + 1;
			if (witnessBytes > HLS_PREPARATION_LIMITS.witnessBytes) limited();
			cache.set(key, entry);
			return entry;
		};
		const readPlaylist = async (
			key: string,
			expectedIdentity?: ObjectIdentity,
		) => {
			const object = await capture(key, true, expectedIdentity);
			let text: string;
			try {
				text = new TextDecoder("utf-8", {
					fatal: true,
					ignoreBOM: true,
				}).decode(await readFile(object.path));
			} catch {
				unsupported();
			}
			return parseEditingHlsPlaylist(text);
		};
		const root = await readPlaylist(source.key, {
			...source.expect,
			size: source.size,
		});
		let videoKey = source.key,
			audioKey: string | null = null;
		if (root.kind === "MASTER") {
			for (const candidate of root.variants)
				resolveEditingHlsKey(source.key, candidate.uri, input.rootPrefix);
			for (const candidate of root.audio)
				if (candidate.uri)
					resolveEditingHlsKey(source.key, candidate.uri, input.rootPrefix);
			const chosen = selectEditingHlsVariant(root);
			videoKey = resolveEditingHlsKey(
				source.key,
				chosen.video.uri,
				input.rootPrefix,
			);
			if (chosen.audio?.uri)
				audioKey = resolveEditingHlsKey(
					source.key,
					chosen.audio.uri,
					input.rootPrefix,
				);
		}
		const makeLocal = async (
			key: string,
			name: string,
			known?: EditingHlsPlaylist,
		) => {
			const playlist = known ?? (await readPlaylist(key));
			if (playlist.kind !== "MEDIA") unsupported();
			const lines = [
				"#EXTM3U",
				"#EXT-X-VERSION:7",
				`#EXT-X-TARGETDURATION:${playlist.targetDuration}`,
				"#EXT-X-PLAYLIST-TYPE:VOD",
			];
			if (playlist.initUri) {
				const init = await capture(
					resolveEditingHlsKey(key, playlist.initUri, input.rootPrefix),
				);
				lines.push(`#EXT-X-MAP:URI="${posix.basename(init.path)}"`);
			}
			for (const segment of playlist.segments) {
				check();
				const object = await capture(
					resolveEditingHlsKey(key, segment.uri, input.rootPrefix),
				);
				lines.push(`#EXTINF:${segment.duration},`, posix.basename(object.path));
			}
			lines.push("#EXT-X-ENDLIST", "");
			const path = join(scratch, name);
			await writeFile(path, lines.join("\n"), { flag: "wx", mode: 0o600 });
			return path;
		};
		const video = await makeLocal(
				videoKey,
				"selected-video.m3u8",
				root.kind === "MEDIA" ? root : undefined,
			),
			audio = audioKey
				? await makeLocal(audioKey, "selected-audio.m3u8")
				: null;
		const file = await open(output, "wx", 0o600);
		ownedOutput = true;
		await file.close();
		const hlsInput = (path: string) => [
			"-protocol_whitelist",
			"file,pipe",
			"-format_whitelist",
			"hls,mov,mpegts,aac",
			"-allowed_extensions",
			"mp4,m4s,ts,aac",
			"-i",
			path,
		];
		const inspectStreams = async (path: string) => {
			const inspected = await runMediaProcess(
				input.ffprobePath ?? "ffprobe",
				[
					"-v",
					"error",
					...hlsInput(path),
					"-show_entries",
					"stream=codec_type,start_pts,time_base",
					"-of",
					"json",
				],
				{ signal, timeoutMs: remaining() },
			);
			if (inspected.stderr.trim())
				throw new MediaOperationError("SOURCE_INCOMPLETE");
			const parsed = JSON.parse(inspected.stdout) as {
				streams?: {
					codec_type?: unknown;
					start_pts?: unknown;
					time_base?: unknown;
				}[];
			} | null;
			const streams = parsed?.streams;
			if (
				!Array.isArray(streams) ||
				streams.some((s) => !s || typeof s !== "object")
			)
				unsupported();
			return streams;
		};
		const streams = await inspectStreams(video),
			stream = streams.filter((s) => s.codec_type === "video"),
			muxedAudio = streams.filter((s) => s.codec_type === "audio");
		// Remux must not hide a source layout that normal preparation would reject.
		if (
			stream.length !== 1 ||
			muxedAudio.length > 1 ||
			streams.length !== stream.length + muxedAudio.length
		)
			unsupported();
		if (audio) {
			const audioStreams = await inspectStreams(audio);
			if (audioStreams.length !== 1 || audioStreams[0]?.codec_type !== "audio")
				unsupported();
		}
		const videoStartPts = stream[0]?.start_pts,
			base = /^(\d+)\/(\d+)$/.exec(String(stream[0]?.time_base));
		if (
			typeof videoStartPts !== "number" ||
			!Number.isSafeInteger(videoStartPts) ||
			!base
		)
			unsupported();
		const num = Number(base[1]),
			den = Number(base[2]);
		if (
			!Number.isSafeInteger(num) ||
			!Number.isSafeInteger(den) ||
			num < 1 ||
			den < 1
		)
			unsupported();
		const numerator = BigInt(videoStartPts) * BigInt(num),
			absolute = numerator < 0n ? -numerator : numerator,
			units = (absolute * 1000000000n + BigInt(den) / 2n) / BigInt(den),
			offsetSeconds =
				(numerator > 0n ? "-" : "") +
				String(units / 1000000000n) +
				"." +
				String(units % 1000000000n).padStart(9, "0"),
			timestampOrigin = {
				videoStartPts,
				timeBase: { num, den },
				offsetSeconds,
			};
		const result = await runMediaProcess(
			input.ffmpegPath ?? "ffmpeg",
			[
				"-hide_banner",
				"-v",
				"error",
				"-nostdin",
				"-y",
				"-copyts",
				"-itsoffset",
				offsetSeconds,
				...hlsInput(video),
				...(audio ? ["-itsoffset", offsetSeconds, ...hlsInput(audio)] : []),
				"-map",
				"0:v:0",
				"-map",
				audio ? "1:a:0" : "0:a:0?",
				"-c",
				"copy",
				"-movflags",
				"+faststart",
				"-f",
				"mp4",
				output,
			],
			{ signal, timeoutMs: remaining() },
		);
		check();
		if (result.stderr.trim())
			throw new MediaOperationError("SOURCE_INCOMPLETE");
		const facts = await stat(output);
		if (
			!facts.isFile() ||
			facts.size < 1 ||
			facts.size > HLS_PREPARATION_LIMITS.totalBytes
		)
			throw new MediaOperationError("SOURCE_TOO_LARGE");
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(output)) {
			check();
			hash.update(chunk);
		}
		const sha256 = hash.digest("hex"),
			witness: HlsSourceMaterialization = {
				version: "hls-vod-capture-v1",
				credentialId: source.credentialId,
				bucket: source.bucket,
				rootManifestKey: source.key,
				videoPlaylistKey: videoKey,
				audioPlaylistKey: audioKey,
				objects: [...cache.values()].map((v) => v.receipt),
				downloadedBytes,
				remuxSha256: sha256,
				remuxBytes: facts.size,
				timestampOrigin,
			};
		if (
			Buffer.byteLength(JSON.stringify(witness)) >
			HLS_PREPARATION_LIMITS.witnessBytes
		)
			limited();
		check();
		complete = true;
		return { path: output, sha256, bytes: facts.size, witness };
	} catch (error) {
		if (signal.aborted)
			throw new MediaOperationError(
				input.signal?.aborted ? "CANCELED" : "TIMED_OUT",
			);
		throw error;
	} finally {
		if (ownedScratch) await rm(scratch, { recursive: true, force: true });
		if (ownedOutput && !complete) await rm(output, { force: true });
	}
}
