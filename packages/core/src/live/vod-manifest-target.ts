import type { StepLogEntry } from "../plan/steplog";

/**
 * WHERE a live-to-VOD DEFAULT manifest may be written, and under what name.
 *
 * **The provider rule (C35).** A Bitmovin DEFAULT manifest
 * (`POST /encoding/manifests/{hls,dash}/default`) enumerates the encoding's
 * muxings and writes RELATIVE segment URIs from its own location, so its
 * `outputPath` must be a PARENT of every muxing's `outputPath`. A path that is
 * a sibling — or deeper than the muxings — is refused with
 * `400 … Muxing output path is not a sub path of the default manifest output
 * path! (code 2701)`. The manifest FILE name is not part of that path: the SDK
 * documents `HlsManifest.manifestName` as "The filename of your manifest",
 * i.e. the object lands at `<outputPath>/<manifestName>`
 * (`@bitmovin/api-sdk@1.278.0` → `dist/models/HlsManifest.d.ts`,
 * `DashManifest.d.ts`; the vendor documentation assistant confirmed the
 * parent-path reading and the "set the filename via manifestName, not by
 * nesting the path" recommendation, 2026-08-29). See
 * `docs/BITMOVIN-API-COVERAGE.md` §0 C35.
 *
 * **The defect this module exists for .** live-to-VOD defaulted the
 * destination to `<run outputPrefix>/vod`  — a SIBLING of the
 * muxings, which write under `<run outputPrefix>/<rendition…>`. Every roll
 * therefore died on 2701 at the first manifest, measured against the real
 * provider on 2026-08-29. `<name>/vod` (the pre-#155 default) had the same
 * shape and the same fate.
 *
 * **Why the STEP LOG is the source.** The muxing paths are read back from the
 * channel's own step log — the `outputPath` in each `CREATE_MUXING_*` entry's
 * payload. That is not a parallel derivation of what was sent: the executor's
 * `destinationOf` (`apps/worker/src/orchestrator/ops/exec-shared.ts`) reads
 * `op.payload.outputPath` VERBATIM into the muxing's `EncodingOutput`, so this
 * field IS the wire value the provider stored. The alternatives all drift:
 * `LiveChannelRun.outputPrefix` is a second computation of the same fact
 * (`rebaseLivePlanForRun`) and answers a different question (a subtree, not
 * the muxings' parent), and `LiveChannel.plan` is the UNREBASED channel plan,
 * which for any run at seq ≥ 2 is not what was sent at all.
 *
 * **A retry never overwrites a previous roll's manifest.** A FINISHED or
 * ERRORed roll does not block another one, and the second roll derives the
 * SAME path from the SAME step log, so the filename is the only thing that
 * can separate them — `vodManifestFileName` folds the earlier rolls' files
 * (`priorRollManifestFiles`) into the taken set and counts monotonically
 * upward from the highest index it can see.
 *
 * That one source also collapses the two cases the caller would otherwise
 * branch on: for a run-scoped plan every recorded muxing path already starts
 * with the run's `outputPrefix`, so the derived parent is inside the run's own
 * subtree and #155's re-air isolation is preserved by construction; for a
 * pre-#155 run (seq 1, prefix "") the same derivation yields the plan's own
 * output base.
 */

/** Path segments, with leading/trailing/double slashes dropped. */
function segmentsOf(path: string): string[] {
	return path.split("/").filter((segment) => segment !== "");
}

/** `a/b` — the normalized form both sides of every comparison here use. */
function normalizePath(path: string): string {
	return segmentsOf(path).join("/");
}

/**
 * Is `parent` an ancestor of (or equal to) `child`, by PATH SEGMENT?
 *
 * Segment-wise on purpose: `startsWith` would call `out/vid` a parent of
 * `out/video/1080p`, which is exactly the class of near-miss the provider
 * refuses. Equality counts as a parent — a manifest beside its own muxing is
 * what "sub path" allows.
 */
export function isPathParentOf(parent: string, child: string): boolean {
	const base = segmentsOf(parent);
	const target = segmentsOf(child);
	if (base.length > target.length) {
		return false;
	}
	return base.every((segment, at) => segment === target[at]);
}

/**
 * The deepest directory that is a parent of every path (`""` for none, which
 * is the storage root and a legal `outputPath`).
 */
export function commonPathParent(paths: readonly string[]): string {
	if (paths.length === 0) {
		return "";
	}
	let base = segmentsOf(paths[0] as string);
	for (const path of paths.slice(1)) {
		const segments = segmentsOf(path);
		let shared = 0;
		while (
			shared < base.length &&
			shared < segments.length &&
			base[shared] === segments[shared]
		) {
			shared += 1;
		}
		base = base.slice(0, shared);
		if (base.length === 0) {
			break;
		}
	}
	return base.join("/");
}

/** `<path>/<file>`, with `path` empty meaning the storage root. */
export function joinManifestPath(path: string, file: string): string {
	const base = path.replace(/\/+$/, "");
	return base === "" ? file : `${base}/${file}`;
}

/**
 * What a provisioned live channel's step log says it WROTE: the muxing
 * destination paths (the 2701 population) and the manifest files the LIVE
 * plan itself publishes (the overwrite population).
 *
 * Every muxing is included regardless of which output it targets: the
 * provider evaluates the muxings of the ENCODING, so a path that is a parent
 * of only some of them is still refused.
 */
export function recordedLiveOutputs(entries: readonly StepLogEntry[]): {
	/** Segmented muxings — what a default VOD manifest enumerates. */
	muxingPaths: string[];
	manifestFiles: string[];
	/** Progressive archives : recorded, never listed. */
	archivePaths: string[];
} {
	const muxingPaths: string[] = [];
	const manifestFiles: string[] = [];
	const archivePaths: string[] = [];
	for (const entry of entries) {
		const path = entry.payload.outputPath;
		if (typeof path !== "string") {
			continue;
		}
		if (entry.kind.startsWith("CREATE_MUXING_")) {
			// : the progressive archive is not a playlist source, so it
			// must not pull the manifest's directory up to a parent it merely
			// shares with the segments (or to "" when it lives elsewhere).
			if (ARCHIVE_MUXING_KINDS.includes(entry.kind)) {
				archivePaths.push(path);
			} else {
				muxingPaths.push(path);
			}
			continue;
		}
		if (entry.kind.startsWith("CREATE_MANIFEST_")) {
			// `manifestName` is the filename; the SDK falls back to `name` when
			// it is absent, so the fallback is part of the collision set too.
			const file =
				typeof entry.payload.manifestName === "string"
					? entry.payload.manifestName
					: typeof entry.payload.name === "string"
						? entry.payload.name
						: undefined;
			if (file !== undefined) {
				manifestFiles.push(normalizePath(joinManifestPath(path, file)));
			}
		}
	}
	return { muxingPaths, manifestFiles, archivePaths };
}

/**
 * Every manifest file a PREVIOUS live-to-VOD roll of this channel wrote:
 * `manifests[].url` (the FINISHED projection) AND `families[].url` (ledger
 * #283 — a family whose manifest was CREATED and then failed or was cleaned
 * up still claimed its filename at the provider, possibly writing a partial
 * file; a fresh manifest for that family must count past it, never reuse it).
 * The worker composes both as `<path>/<manifestName>`.
 *
 * Deliberately structural over `unknown`. These come from Json columns whose
 * real population is wider than `LiveToVodRecord` — the web boundary
 * normalizer records a production row that was a bare `{}` — and a roll must
 * not fail because an old record is shaped oddly; an unreadable record simply
 * contributes no taken names.
 */
export function priorRollManifestFiles(records: readonly unknown[]): string[] {
	const files: string[] = [];
	for (const record of records) {
		const row = record as {
			manifests?: unknown;
			families?: unknown;
			priorManifests?: unknown;
		} | null;
		for (const list of [row?.manifests, row?.families, row?.priorManifests]) {
			if (!Array.isArray(list)) {
				continue;
			}
			for (const manifest of list) {
				const url = (manifest as { url?: unknown } | null)?.url;
				if (typeof url === "string" && url !== "") {
					files.push(normalizePath(url));
				}
			}
		}
	}
	return files;
}

/**
 * Live muxing kinds a default manifest never lists : the
 * progressive MP4 archive  is written beside the segments as a
 * file of its own, so it neither supports nor rules out a manifest family.
 * The provider's HLS default manifest is documented to skip progressive
 * muxings; that a LEGACY-generator manifest over a TS + MP4 recording
 * succeeds is a customer-run observation, not a measured fixture here.
 */
export const ARCHIVE_MUXING_KINDS: readonly string[] = ["CREATE_MUXING_MP4"];

/** Which live muxing kinds each DEFAULT manifest family can enumerate. */
const FAMILY_COMPATIBLE_MUXING_KINDS = {
	/** An HLS default manifest lists segmented MPEG-TS and fMP4 muxings alike. */
	HLS: ["CREATE_MUXING_TS", "CREATE_MUXING_FMP4"],
	/** A DASH default manifest enumerates fMP4 muxings ONLY. */
	DASH: ["CREATE_MUXING_FMP4"],
} as const;

export type LiveToVodFamilySupport = {
	/** Families every recorded muxing can be listed by, in HLS→DASH order. */
	supported: ("HLS" | "DASH")[];
	/** The rest, each with the muxing that rules it out. */
	unsupported: { family: "HLS" | "DASH"; reason: string }[];
};

/**
 * Which manifest families a live-to-VOD DEFAULT manifest can be generated
 * for over THIS recording — / §14.6 LF-02.
 *
 * The provider rule: a default manifest enumerates the encoding's muxings
 * itself, and a DASH default manifest enumerates fMP4 muxings only — over a
 * segmented MPEG-TS recording the create is refused (`400`, code 2700, measured
 * on the paid run of 2026-08-30). The old default asked for "both" regardless,
 * so every TS-only roll (the Akamai/MSL4 Production HLS/TS topology) made its
 * HLS manifest and then died on DASH.
 *
 * Read from the step log's `CREATE_MUXING_*` kinds for the same reason the
 * destination is (`recordedLiveOutputs`): they are what the executor SENT. A
 * family is supported only when EVERY recorded muxing is compatible with it —
 * the generator evaluates the encoding's muxings as a set, and a mixed
 * fMP4+TS recording is therefore HLS-only here rather than gambled on. No
 * muxings at all ⇒ nothing is supported (and `resolveLiveToVodTarget` refuses
 * the roll with the same reason).
 *
 * Only SEGMENTED muxings are judged: a TS recording that also
 * wrote a progressive MP4 archive used to be refused for BOTH families —
 * the archive matched neither allowlist — which turned every archived
 * channel's live-to-VOD into a 422 (customer install, 2026-09-11).
 */
export function liveToVodFamilySupport(
	entries: readonly StepLogEntry[],
): LiveToVodFamilySupport {
	const muxings = entries.filter((entry) =>
		entry.kind.startsWith("CREATE_MUXING_"),
	);
	const segmented = muxings.filter(
		(m) => !ARCHIVE_MUXING_KINDS.includes(m.kind),
	);
	const support: LiveToVodFamilySupport = { supported: [], unsupported: [] };
	for (const family of ["HLS", "DASH"] as const) {
		if (segmented.length === 0) {
			support.unsupported.push({
				family,
				reason: noSegmentedMuxingReason(muxings[0]),
			});
			continue;
		}
		const compatible: readonly string[] =
			FAMILY_COMPATIBLE_MUXING_KINDS[family];
		const offending = segmented.find((m) => !compatible.includes(m.kind));
		if (offending === undefined) {
			support.supported.push(family);
			continue;
		}
		support.unsupported.push({
			family,
			reason:
				family === "DASH"
					? `DASH cannot be generated over this recording: "${offending.step}" is ${describeMuxingKind(offending.kind)} and a DASH default manifest enumerates fMP4 muxings only (Bitmovin refuses it with code 2700) — this recording supports HLS only`
					: `HLS cannot be generated over this recording: "${offending.step}" is ${describeMuxingKind(offending.kind)}, which an HLS default manifest cannot enumerate`,
		});
	}
	return support;
}

/** `liveToVodFamilySupport(entries).supported` — the DEFAULT family set. */
export function supportedLiveToVodFamilies(
	entries: readonly StepLogEntry[],
): ("HLS" | "DASH")[] {
	return liveToVodFamilySupport(entries).supported;
}

/**
 * Why NO family can be generated when the recording has no segmented muxing:
 * the same sentence `resolveLiveToVodTarget` refuses the roll with, so the
 * route's 400 and the family check's 422 never disagree.
 */
function noSegmentedMuxingReason(archive: StepLogEntry | undefined): string {
	return archive === undefined
		? "Step log records no muxing output path — a default VOD manifest has nothing to enumerate; provision the channel first"
		: `Step log records no segmented muxing — "${archive.step}" is ${describeMuxingKind(archive.kind)}, which a default VOD manifest never lists; only the live HLS/DASH segments can be published as VOD`;
}

function describeMuxingKind(kind: string): string {
	switch (kind) {
		case "CREATE_MUXING_TS":
			return "segmented MPEG-TS (CREATE_MUXING_TS)";
		case "CREATE_MUXING_FMP4":
			return "segmented fMP4 (CREATE_MUXING_FMP4)";
		case "CREATE_MUXING_MP4":
			return "a progressive MP4 archive (CREATE_MUXING_MP4)";
		default:
			return `an unsupported live muxing kind (${kind})`;
	}
}

/** Family → the VOD manifest's base filename. */
const VOD_MANIFEST_BASE = { HLS: "vod.m3u8", DASH: "vod.mpd" } as const;

/**
 * A VOD manifest filename that overwrites NOTHING — not a live manifest, and
 * not an earlier roll's.
 *
 * The VOD manifest lands in the SAME directory as the channel's live
 * manifests (both are the muxings' parent), so the name is the only thing
 * keeping them apart: the live plan's own manifests are `stream.m3u8` /
 * `stream.mpd` in every fixture, hence `vod.*`. Nothing STOPS an operator
 * naming a live manifest `vod.m3u8`, so the name is checked against what the
 * step log says the live plan writes rather than assumed distinct.
 *
 * **A retry is a second writer at the same address** (review-357): a FINISHED
 * or ERRORed roll does not block another one — the route's 409 is
 * RUNNING-only — and the second roll derives the same path, so a fixed name
 * would point a second Bitmovin manifest resource at the first one's file.
 *
 * Hence MONOTONIC rather than first-free, which is the part that is not
 * obvious. What can be read back is only the LATEST roll per run: the route
 * overwrites `liveChannel.liveToVod` with its RUNNING claim before the worker
 * starts, and the run mirror keeps one record per run. First-free would
 * therefore hand roll 3 the name roll 1 used — roll 2 having taken `vod-2`
 * and being the only one still recorded. Taking one above the HIGHEST index
 * ever seen cannot do that, because the newest roll's index is the maximum by
 * construction.
 *
 * Indices are per FAMILY: `.m3u8` and `.mpd` cannot collide with each other,
 * so an HLS-only roll does not push the DASH counter.
 */
export function vodManifestFileName(
	family: "HLS" | "DASH",
	path: string,
	takenFiles: readonly string[],
): string {
	const base = VOD_MANIFEST_BASE[family];
	const dot = base.lastIndexOf(".");
	const stem = base.slice(0, dot);
	const ext = base.slice(dot);
	const directory = normalizePath(path);
	// `ext` always begins with the only character needing escaping here.
	const pattern = new RegExp(`^${stem}(?:-(\\d+))?\\${ext}$`);
	let highest = 0;
	for (const file of takenFiles) {
		const normalized = normalizePath(file);
		const at = normalized.lastIndexOf("/");
		if ((at === -1 ? "" : normalized.slice(0, at)) !== directory) {
			continue;
		}
		const match = pattern.exec(normalized.slice(at + 1));
		if (match) {
			highest = Math.max(
				highest,
				match[1] === undefined ? 1 : Number(match[1]),
			);
		}
	}
	return highest === 0 ? base : `${stem}-${highest + 1}${ext}`;
}

export type LiveToVodTarget = {
	/** The default manifest `destination.outputPath`. */
	path: string;
	/** Filename per family — free of every live manifest file at `path`. */
	nameFor: (family: "HLS" | "DASH") => string;
};

export type LiveToVodTargetResult =
	| { ok: true; target: LiveToVodTarget }
	| { ok: false; reason: string };

/**
 * Resolve (or validate) the destination of a live-to-VOD default manifest.
 *
 * `explicitPath` is the operator's `params.path`. It is held to the SAME rule
 * as the derived default — the provider is not our validator: an unusable path
 * must be refused with the reason and the usable parent, not sent so that the
 * roll dies mid-flight with a vendor error code.
 *
 * `priorFiles` are the manifest files EARLIER rolls of this channel wrote
 * (`priorRollManifestFiles` over the persisted records). The step log knows
 * nothing about them — it describes provisioning, and a roll is not a step —
 * so without them a retry silently reuses the first roll's filename. Callers
 * that only validate a path (the route's pre-check) may omit them.
 */
export function resolveLiveToVodTarget(
	entries: readonly StepLogEntry[],
	explicitPath?: string,
	priorFiles: readonly string[] = [],
): LiveToVodTargetResult {
	const { muxingPaths, manifestFiles, archivePaths } =
		recordedLiveOutputs(entries);
	const taken = [...manifestFiles, ...priorFiles];
	if (muxingPaths.length === 0) {
		return {
			ok: false,
			reason: noSegmentedMuxingReason(
				archivePaths.length > 0
					? entries.find((entry) => ARCHIVE_MUXING_KINDS.includes(entry.kind))
					: undefined,
			),
		};
	}
	const parent = commonPathParent(muxingPaths);
	if (explicitPath === undefined) {
		return {
			ok: true,
			target: {
				path: parent,
				nameFor: (family) => vodManifestFileName(family, parent, taken),
			},
		};
	}
	const offending = muxingPaths.find(
		(path) => !isPathParentOf(explicitPath, path),
	);
	if (offending !== undefined) {
		return {
			ok: false,
			reason: `Manifest path "${explicitPath}" is not a parent of the recording's muxing output paths (e.g. "${offending}") — Bitmovin refuses a default manifest whose output path is not a parent of every muxing (code 2701). Use "${parent}" or one of its parents.`,
		};
	}
	return {
		ok: true,
		target: {
			path: explicitPath,
			nameFor: (family) => vodManifestFileName(family, explicitPath, taken),
		},
	};
}
