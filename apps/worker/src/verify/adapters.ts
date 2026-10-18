/**
 * The real-world implementations behind `EngineDeps`.
 *
 * The engine is deliberately ignorant of storage drivers, ffprobe and manifest
 * parsers — that seam is what lets the self-test drive it against a synthetic world.
 * This file is the other side: the adapters that talk to the actual bucket and the
 * actual binaries. It has no assertions in it, on purpose. Everything here either
 * returns a fact or throws.
 */

import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ObjectStorageBrowser } from "@bitovp/storage";
import type {
	BoxFacts,
	EngineDeps,
	MediaProbe,
	ObjectEntry,
	ParsedDash,
	ParsedHls,
} from "./engine";

/**
 * `listObjects` is delimiter-based: one call returns one level. The first version of
 * the artefact verifier listed a base prefix, got 7 objects, and concluded the
 * per-rendition folders did not exist — its very first finding was its own blind
 * spot. Recursion is therefore not an optimisation here, it is correctness.
 *
 * Bounded by `maxPages` per level and a total object cap, and the give-up is REPORTED
 * (the caller turns it into a check) rather than being a silent truncation.
 */
export async function listRecursive(
	browser: ObjectStorageBrowser,
	bucket: string,
	prefix: string,
	limits: { maxObjects?: number; maxPages?: number } = {},
): Promise<{ objects: ObjectEntry[]; truncated: boolean }> {
	const maxObjects = limits.maxObjects ?? 5_000;
	const maxPages = limits.maxPages ?? 50;
	const objects: ObjectEntry[] = [];
	const queue = [prefix];
	let pages = 0;
	let truncated = false;

	while (queue.length > 0) {
		const current = queue.shift() as string;
		let cursor: string | undefined;
		do {
			if (pages >= maxPages || objects.length >= maxObjects) {
				truncated = true;
				return { objects, truncated };
			}
			pages += 1;
			const page = await browser.listObjects({
				bucket,
				prefix: current,
				limit: 100,
				...(cursor ? { cursor } : {}),
			});
			for (const o of page.objects) {
				objects.push({
					key: o.key,
					...(o.size !== undefined ? { size: o.size } : {}),
					// `StorageObject.lastModified` was already on the driver's result and was
					// being dropped here, which is why `--strict-prefix` could not do the
					// timestamp comparison its own doc comment described.
					...(o.lastModified !== undefined
						? { lastModified: o.lastModified }
						: {}),
				});
			}
			for (const dir of (page as { prefixes?: string[] }).prefixes ?? []) {
				queue.push(dir);
			}
			cursor = (page as { nextCursor?: string }).nextCursor;
		} while (cursor);
	}
	return { objects, truncated };
}

function run(
	cmd: string,
	args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => {
			stdout += String(d);
		});
		child.stderr.on("data", (d) => {
			stderr += String(d);
		});
		child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
	});
}

const rate = (raw: string | undefined): number | undefined => {
	if (!raw || raw === "0/0") {
		return undefined;
	}
	const [n, d] = raw.includes("/") ? raw.split("/") : [raw, "1"];
	const num = Number(n);
	const den = Number(d);
	return Number.isFinite(num) && Number.isFinite(den) && den !== 0 && num !== 0
		? num / den
		: undefined;
};

/**
 * ffprobe one local file.
 *
 * `avg_frame_rate` is preferred over `r_frame_rate`. `r_frame_rate` is ffprobe's BASE
 * rate and disagrees with the real rate on VFR and oddly-muxed sources; the VOD VMAF
 * runner prefers it the other way round, which is a latent hazard recorded separately.
 * A verifier that inherits that preference would report a wrong fps as correct.
 */
export async function probeFile(
	ffprobePath: string,
	path: string,
): Promise<MediaProbe> {
	const r = await run(ffprobePath, [
		"-v",
		"error",
		"-print_format",
		"json",
		"-show_streams",
		"-show_format",
		path,
	]);
	if (r.code !== 0) {
		throw new Error(
			`ffprobe failed (${r.code}) on ${path}: ${r.stderr.trim().slice(-200)}`,
		);
	}
	const parsed = JSON.parse(r.stdout) as {
		streams?: Record<string, unknown>[];
		format?: Record<string, unknown>;
	};
	const streams = parsed.streams ?? [];
	const v = streams.find((s) => s.codec_type === "video");
	const a = streams.find((s) => s.codec_type === "audio");
	const fps =
		rate(v?.avg_frame_rate as string | undefined) ??
		rate(v?.r_frame_rate as string | undefined);
	const num = (x: unknown): number | undefined => {
		const n = Number(x);
		return Number.isFinite(n) ? n : undefined;
	};
	/**
	 * The video stream's duration, from whichever field the container actually carries it in.
	 *
	 * MP4 puts it on the stream as `duration`. Matroska usually carries neither `duration` NOR
	 * `nb_frames` on the stream — `input/AWOLNATION_muxed_30s.mkv` has neither, which is why two
	 * successive attempts at this both fell back to the container and changed nothing — and
	 * instead writes `tags.DURATION` as `HH:MM:SS.nnnnnnnnn`.
	 */
	const videoDuration = (
		stream: Record<string, unknown> | undefined,
		toNum: (x: unknown) => number | undefined,
	): number | undefined => {
		const direct = toNum(stream?.duration);
		if (direct !== undefined) {
			return direct;
		}
		const tags = stream?.tags as Record<string, unknown> | undefined;
		const tag = tags?.DURATION ?? tags?.duration;
		if (typeof tag !== "string") {
			return undefined;
		}
		const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(tag.trim());
		if (!m) {
			return undefined;
		}
		return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
	};
	return {
		...(v?.width !== undefined ? { width: v.width as number } : {}),
		...(v?.height !== undefined ? { height: v.height as number } : {}),
		...(v?.codec_name ? { videoCodec: v.codec_name as string } : {}),
		...(v?.profile ? { profile: String(v.profile) } : {}),
		...(fps !== undefined ? { fps } : {}),
		...(num(v?.nb_frames) !== undefined
			? { nbFrames: num(v?.nb_frames) as number }
			: {}),
		...(num(parsed.format?.duration) !== undefined
			? { durationSec: num(parsed.format?.duration) as number }
			: {}),
		/**
		 * The VIDEO STREAM's duration, separately from the container's.
		 *
		 * `format.duration` is the container, which is as long as its LONGEST track. A video
		 * muxing runs for as long as the video does, and the two differ whenever the audio is
		 * longer: `input/AWOLNATION_muxed_30s.mkv` reports a 30.03s container and wrote 6 audio
		 * segments and 5 video ones, so dividing the video by 30.03 failed a correct encode.
		 *
		 * `nbFrames ÷ fps` was the first route to this and it is not enough — Matroska usually
		 * omits `nb_frames` entirely, which is exactly the case here (`undefined frames`), so the
		 * derivation silently fell back to the container and the fix did nothing. Reading the
		 * stream's own `duration` works for both.
		 */
		...(videoDuration(v, num) !== undefined
			? { videoDurationSec: videoDuration(v, num) as number }
			: {}),
		...(num(parsed.format?.bit_rate) !== undefined
			? { bitrateBps: num(parsed.format?.bit_rate) as number }
			: {}),
		...(a?.codec_name ? { audioCodec: a.codec_name as string } : {}),
		...(a?.channels !== undefined
			? { audioChannels: a.channels as number }
			: {}),
		...(num(a?.sample_rate) !== undefined
			? { audioSampleRate: num(a?.sample_rate) as number }
			: {}),
		// The AUDIO stream's OWN bitrate (row 272), from the stream not the
		// container: in a muxed file `format.bit_rate` is video+audio, so the
		// per-stream field is the only one that binds the audio target. Absent for
		// some fMP4/TS audio, in which case the engine SKIPs rather than guessing.
		...(num(a?.bit_rate) !== undefined
			? { audioBitrateBps: num(a?.bit_rate) as number }
			: {}),
		...(v === undefined ? { videoAbsent: true } : {}),
	};
}

/**
 * Walk MP4 boxes and pull out the DRM facts.
 *
 * Hand-rolled rather than a dependency, because the need is small and precise: `pssh`
 * system ids, the `schm` scheme type, and `tenc`'s `default_IV_size` + `default_KID`.
 * Sizes are read as 32-bit big-endian with the `size === 1` 64-bit extension handled,
 * because an init segment with a large `moov` is legal and a naive walker would run
 * off the end of it.
 */
export async function scanMp4Boxes(path: string): Promise<BoxFacts> {
	const buf = await readFile(path);
	const psshSystemIds: string[] = [];
	let schemeType: string | undefined;
	let ivSizeBytes: number | undefined;
	let defaultKid: string | undefined;

	const CONTAINERS = new Set([
		"moov",
		"trak",
		"mdia",
		"minf",
		"stbl",
		"stsd",
		"encv",
		"enca",
		"sinf",
		"schi",
		"moof",
		"traf",
	]);

	const walk = (start: number, end: number, depth: number): void => {
		if (depth > 12) {
			return;
		}
		let at = start;
		while (at + 8 <= end) {
			let size = buf.readUInt32BE(at);
			const type = buf.toString("latin1", at + 4, at + 8);
			let headerLen = 8;
			if (size === 1) {
				// 64-bit extended size.
				if (at + 16 > end) {
					return;
				}
				size = Number(buf.readBigUInt64BE(at + 8));
				headerLen = 16;
			} else if (size === 0) {
				// "to end of file"
				size = end - at;
			}
			if (size < headerLen || at + size > end) {
				return;
			}
			const bodyStart = at + headerLen;
			const bodyEnd = at + size;

			if (type === "pssh" && bodyStart + 24 <= bodyEnd) {
				// version(1) flags(3) systemId(16)
				psshSystemIds.push(
					buf.toString("hex", bodyStart + 4, bodyStart + 20).toLowerCase(),
				);
			} else if (type === "schm" && bodyStart + 8 <= bodyEnd) {
				schemeType = buf.toString("latin1", bodyStart + 4, bodyStart + 8);
			} else if (type === "tenc" && bodyStart + 24 <= bodyEnd) {
				// version(1) flags(3) reserved(1) [crypt/skip byte] isProtected(1)
				// default_Per_Sample_IV_Size(1) default_KID(16)
				ivSizeBytes = buf.readUInt8(bodyStart + 7);
				defaultKid = buf
					.toString("hex", bodyStart + 8, bodyStart + 24)
					.toLowerCase();
			} else if (CONTAINERS.has(type)) {
				// `stsd` and the sample-entry boxes carry fixed preambles before their
				// children; skipping them wrongly is how a hand-rolled walker misses
				// `sinf`. These offsets are the ISO-BMFF ones.
				const skip =
					type === "stsd" ? 8 : type === "encv" ? 78 : type === "enca" ? 28 : 0;
				walk(bodyStart + skip, bodyEnd, depth + 1);
			}
			at = bodyEnd;
		}
	};

	walk(0, buf.length, 0);
	return {
		psshSystemIds,
		...(schemeType ? { schemeType } : {}),
		...(ivSizeBytes !== undefined ? { ivSizeBytes } : {}),
		...(defaultKid ? { defaultKid } : {}),
	};
}

/** HLS via `m3u8-parser` — a real player-family parser (owner decision D1). */
export async function parseHlsText(text: string): Promise<ParsedHls> {
	const { Parser } = await import("m3u8-parser");
	const parser = new Parser();
	parser.push(text);
	parser.end();
	const m = parser.manifest;
	const media: ParsedHls["media"] = [];
	for (const [type, groups] of Object.entries(m.mediaGroups ?? {})) {
		for (const [groupId, entries] of Object.entries(groups)) {
			// The NAME is the KEY m3u8-parser files each entry under — carried so
			// the topology binding can key on it (row 272). Collapse of a duplicate
			// NAME is caught separately from the raw text (`:media-names-unique`).
			for (const [name, entry] of Object.entries(entries)) {
				media.push({
					type,
					groupId,
					...(name ? { name } : {}),
					...(entry.uri ? { uri: entry.uri } : {}),
				});
			}
		}
	}
	return {
		variants: (m.playlists ?? []).map((p) => {
			// RESOLUTION and CODECS bind the variant to its plan rendition (row 272);
			// m3u8-parser hands RESOLUTION back as `{width, height}`.
			const res = p.attributes?.RESOLUTION as
				| { width?: number; height?: number }
				| undefined;
			const codecs = p.attributes?.CODECS;
			// AUDIO is the row's identity beside its URI (row 284): the group a
			// variant points at, absent on a self-contained one.
			const audio = (p.attributes as { AUDIO?: unknown } | undefined)?.AUDIO;
			return {
				uri: p.uri ?? "",
				...(p.attributes?.BANDWIDTH !== undefined
					? { bandwidth: p.attributes.BANDWIDTH }
					: {}),
				...(res?.width !== undefined && res?.height !== undefined
					? { resolution: `${res.width}x${res.height}` }
					: {}),
				...(typeof codecs === "string" ? { codecs } : {}),
				...(typeof audio === "string" ? { audio } : {}),
			};
		}),
		media,
		segments: (m.segments ?? []).length,
		...((m.segments ?? []).length > 0
			? {
					segmentUris: (m.segments ?? []).flatMap((seg) =>
						seg.uri ? [seg.uri] : [],
					),
					// First segment's map only: RFC 8216 lets EXT-X-MAP change after a
					// discontinuity, and no VOD playlist this app emits carries more
					// than one (review-343 L2) — a second init would go unchecked.
					...(m.segments?.[0]?.map?.uri
						? { mapUri: m.segments[0].map.uri }
						: {}),
				}
			: {}),
		...(m.version !== undefined ? { version: m.version } : {}),
	};
}

/**
 * DASH via `mpd-parser`, plus a raw-XML read for the addressing mode.
 *
 * `mpd-parser` normalises TEMPLATE and TIMELINE into the same playlist shape — that
 * is its job as a player parser, and it is exactly the distinction the
 * `dash-segment-timeline` fixture exists to protect. So acceptance comes from the
 * parser and the addressing mode comes from the document.
 */
export async function parseDashText(text: string): Promise<ParsedDash> {
	const mod = await import("mpd-parser");
	const parsed = mod.parse(text);

	const reps = [...text.matchAll(/<Representation\b[^>]*>/g)].map((m) => {
		const attrs = m[0];
		const at = (m.index as number) + attrs.length;
		// Look inside this Representation only: stop at its closing tag, or at the
		// next Representation if the element is self-closing.
		const rest = text.slice(at);
		const stop = Math.min(
			...[rest.indexOf("</Representation>"), rest.indexOf("<Representation")]
				.filter((i) => i >= 0)
				.concat([rest.length]),
		);
		const body = rest.slice(0, stop);
		// Inherited addressing: a SegmentTemplate on the AdaptationSet applies to its
		// Representations, so fall back to the enclosing element's text.
		const adaptationStart = Math.max(
			0,
			text.lastIndexOf("<AdaptationSet", m.index as number),
		);
		const enclosing = text.slice(
			adaptationStart,
			(m.index as number) + attrs.length,
		);
		const setOpenEnd = enclosing.indexOf(">");
		const setOpen =
			setOpenEnd >= 0 ? enclosing.slice(0, setOpenEnd + 1) : enclosing;
		const scope = body + enclosing;
		const addressing: ParsedDash["representations"][number]["addressing"] =
			/<SegmentTimeline/.test(scope)
				? "TIMELINE"
				: /<SegmentTemplate/.test(scope)
					? "TEMPLATE"
					: /<SegmentBase|<BaseURL/.test(scope)
						? "BASE"
						: /<SegmentList/.test(scope)
							? "LIST"
							: "UNKNOWN";
		const height = /height="(\d+)"/.exec(attrs);
		const bandwidth = /bandwidth="(\d+)"/.exec(attrs);
		const id = /id="([^"]+)"/.exec(attrs);
		// The codec string binds the representation to its plan rendition (row
		// 272): the Representation's own `codecs`, else the AdaptationSet's — the
		// two places DASH is allowed to declare it.
		const codecs =
			/codecs="([^"]+)"/.exec(attrs) ?? /codecs="([^"]+)"/.exec(setOpen);
		// The set's own declaration first (Bitmovin writes contentType on the
		// AdaptationSet), then the mime prefix, then the representation's own
		// geometry; a representation that declares none is "unknown", and the
		// engine counts unknowns separately rather than folding them into video.
		// Only the AdaptationSet OPENING TAG is an inheritance source. The text
		// before this representation can contain earlier Representation tags; using
		// the whole prefix made a codec-less row inherit its sibling's codec.
		const contentType =
			/contentType="(video|audio|text)"/.exec(setOpen) ??
			/contentType="(video|audio|text)"/.exec(attrs);
		const mime =
			/mimeType="(video|audio|text)\//.exec(setOpen) ??
			/mimeType="(video|audio|text)\//.exec(attrs);
		const kind: ParsedDash["representations"][number]["kind"] = contentType
			? (contentType[1] as "video" | "audio" | "text")
			: mime
				? (mime[1] as "video" | "audio" | "text")
				: height || /width="\d+"/.test(attrs) || /width="\d+"/.test(setOpen)
					? "video"
					: /audioSamplingRate="/.test(attrs) ||
							/audioSamplingRate="/.test(setOpen)
						? "audio"
						: "unknown";
		return {
			addressing,
			kind,
			...(id ? { id: id[1] as string } : {}),
			...(height ? { height: Number(height[1]) } : {}),
			...(bandwidth ? { bandwidth: Number(bandwidth[1]) } : {}),
			...(codecs ? { codecs: codecs[1] as string } : {}),
		};
	});

	if ((parsed.playlists ?? []).length === 0 && reps.length === 0) {
		throw new Error("mpd-parser found no playlists in this document");
	}
	// The resolved playlists : mpd-parser expands the template /
	// timeline / list into concrete segment URIs — relative to the MPD, the
	// same way a player addresses them — for the video playlists and for every
	// audio group. `uri` is the template-relative form; `resolvedUri` carries
	// a base URL when the document declares one, so the relative form is kept.
	const segmentsOf = (p: import("mpd-parser").MpdPlaylist) =>
		(p.segments ?? []).flatMap((seg) => (seg.uri ? [seg.uri] : []));
	const playlistOf = (
		p: import("mpd-parser").MpdPlaylist,
		kind: "video" | "audio",
	): NonNullable<ParsedDash["playlists"]>[number] => ({
		kind,
		...(p.attributes?.NAME ? { id: p.attributes.NAME } : {}),
		...(p.attributes?.CODECS ? { codecs: p.attributes.CODECS } : {}),
		// First segment's init only — same single-init assumption as the HLS map above.
		...(p.segments?.[0]?.map?.uri ? { mapUri: p.segments[0].map.uri } : {}),
		segmentUris: segmentsOf(p),
	});
	const playlists = [
		...(parsed.playlists ?? []).map((p) => playlistOf(p, "video")),
		...Object.values(parsed.mediaGroups?.AUDIO ?? {}).flatMap((group) =>
			Object.values(group).flatMap((entry) =>
				(entry.playlists ?? []).map((p) => playlistOf(p, "audio")),
			),
		),
	];
	// AdaptationSet structure : the codecs each set carries, from
	// the set's own attribute or its representations'. Paid case F put H264 and
	// H265 into ONE set; a representation count cannot see that.
	const adaptationSets = [
		...text.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/g),
	].map((m) => {
		const attrs = m[1] ?? "";
		const body = m[2] ?? "";
		const kindMatch =
			/contentType="(video|audio|text)"/.exec(attrs) ??
			/mimeType="(video|audio|text)\//.exec(attrs) ??
			/mimeType="(video|audio|text)\//.exec(body);
		const kind: NonNullable<ParsedDash["adaptationSets"]>[number]["kind"] =
			kindMatch
				? (kindMatch[1] as "video" | "audio" | "text")
				: /height="\d+"/.test(attrs + body)
					? "video"
					: /audioSamplingRate="/.test(attrs + body)
						? "audio"
						: "unknown";
		const codecs = new Set<string>();
		for (const c of [...(attrs + body).matchAll(/codecs="([^"]+)"/g)]) {
			codecs.add(c[1] as string);
		}
		return { kind, codecs: [...codecs].sort() };
	});
	return {
		representations: reps,
		periods: (text.match(/<Period\b/g) ?? []).length,
		...(parsed.duration !== undefined ? { durationSec: parsed.duration } : {}),
		...(playlists.length > 0 ? { playlists } : {}),
		...(adaptationSets.length > 0 ? { adaptationSets } : {}),
	};
}

export type AdapterConfig = {
	/** Resolve an output key to its bucket + browser. */
	outputFor(outputKey: string): {
		bucket: string;
		browser: ObjectStorageBrowser;
	};
	/** Directory downloads land in; the caller owns its lifetime. */
	scratchDir: string;
	ffprobePath: string;
	reference?: { durationSec?: number; fps?: number; nbFrames?: number };
	/**
	 * `EngineDeps`' signature exactly, INCLUDING the entry.
	 *
	 * It was declared `(key: string) => boolean` here and passed straight through
	 * to a dep the engine calls with two arguments, so the type was silently
	 * lossier than the value. That is a live footgun rather than untidiness: the
	 * whole "written before this job" arm reads `entry.lastModified`, and anyone
	 * making the adapter agree with its own declared type — by wrapping it as
	 * `(key) => filter(key)` — would delete that arm with no test and no
	 * typechecker able to object.
	 */
	foreignKeyFilter?: (key: string, entry?: ObjectEntry) => boolean;
	/** Called when a listing was truncated, so the report can say so. */
	onTruncated?: (outputKey: string, prefix: string) => void;
};

/** Wire the adapters into the shape the engine consumes. */
export function makeEngineDeps(config: AdapterConfig): EngineDeps {
	const downloads = new Map<string, string>();

	const fetchObject = async (
		outputKey: string,
		key: string,
		range?: { start: number; end: number },
	): Promise<string> => {
		const cacheKey = `${outputKey}\0${key}\0${range?.start ?? ""}-${range?.end ?? ""}`;
		const cached = downloads.get(cacheKey);
		if (cached) {
			return cached;
		}
		const { bucket, browser } = config.outputFor(outputKey);
		if (!browser.getObject) {
			throw new Error(
				`storage driver for output "${outputKey}" cannot stream objects`,
			);
		}
		const dest = join(
			config.scratchDir,
			`${key.replace(/[^A-Za-z0-9._-]/g, "_")}${range ? `.${range.start}-${range.end}` : ""}`,
		);
		const stream = await browser.getObject({
			bucket,
			key,
			...(range ? { range } : {}),
		});
		await pipeline(stream, createWriteStream(dest));
		downloads.set(cacheKey, dest);
		return dest;
	};

	/**
	 * Download several objects and glue them into one file, in the order given.
	 *
	 * The whole reason this exists is fMP4: `init.mp4` + `segment_0.m4s` is a parseable
	 * stream, and `segment_0.m4s` alone is not. Concatenating the bytes is exactly what a
	 * player does with `EXT-X-MAP`, so this is not a trick — it is the same assembly the
	 * format specifies.
	 *
	 * Cached on the joined key, so a ladder that probes the same pair twice downloads once.
	 */
	const fetchConcatenated = async (
		outputKey: string,
		keys: string[],
	): Promise<string> => {
		if (keys.length === 0) {
			throw new Error("fetchConcatenated needs at least one key");
		}
		if (keys.length === 1) {
			const only = keys[0];
			if (only === undefined) {
				throw new Error("fetchConcatenated needs at least one key");
			}
			return fetchObject(outputKey, only);
		}
		const cacheKey = `${outputKey}\0concat\0${keys.join("\0")}`;
		const cached = downloads.get(cacheKey);
		if (cached) {
			return cached;
		}
		const parts = await Promise.all(
			keys.map((key) => fetchObject(outputKey, key)),
		);
		const dest = join(
			config.scratchDir,
			`concat_${keys
				.map((k) => k.replace(/[^A-Za-z0-9._-]/g, "_"))
				.join("+")
				.slice(-180)}`,
		);
		const out = createWriteStream(dest);
		for (const part of parts) {
			await pipeline(createReadStream(part), out, { end: false });
		}
		out.end();
		await new Promise<void>((done, fail) => {
			out.on("finish", () => done());
			out.on("error", fail);
		});
		downloads.set(cacheKey, dest);
		return dest;
	};

	return {
		listAll: async (outputKey, prefix) => {
			const { bucket, browser } = config.outputFor(outputKey);
			const { objects, truncated } = await listRecursive(
				browser,
				bucket,
				prefix,
			);
			if (truncated) {
				config.onTruncated?.(outputKey, prefix);
			}
			return objects;
		},
		fetchObject,
		fetchConcatenated,
		probe: (path) => probeFile(config.ffprobePath, path),
		scanBoxes: (path) => scanMp4Boxes(path),
		readText: async (outputKey, key) => {
			const path = await fetchObject(outputKey, key);
			// A manifest is small; a multi-GB object here would mean the caller asked
			// for the wrong key, so fail loudly instead of reading it into memory.
			const info = await stat(path);
			if (info.size > 8 * 1024 * 1024) {
				throw new Error(
					`${key} is ${info.size}B — too large to be a manifest, refusing to read it as text`,
				);
			}
			return readFile(path, "utf8");
		},
		parseHls: parseHlsText,
		parseDash: parseDashText,
		...(config.reference ? { reference: config.reference } : {}),
		...(config.foreignKeyFilter
			? { foreignKeyFilter: config.foreignKeyFilter }
			: {}),
	};
}
