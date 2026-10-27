/**
 * The delivery-EDGE resolver: master → every child → init + media, with bytes
 * and hashes, under a URL policy.
 *
 * What the previous closure got wrong, and why each rule below
 * exists:
 *
 * absolute URIs were DROPPED `filter(relative)` threw away every absolute
 * child and segment URI, so a master whose
 * children were absolute walked ZERO children —
 * and still closed. Now every reference is
 * resolved with `new URL(reference, parent)`
 * semantics and either FOLLOWED (inside the
 * policy) or REFUSED and counted as missing.
 * zero segments closed a child listing no media, or a child whose
 * media were never fetched, was "closed". Now a
 * leg closes only when ≥1 child was walked and
 * EVERY child served ≥1 nonzero media segment.
 * DASH closed on Representation count
 * the MPD was parsed and counted. Now BaseURL +
 * SegmentTemplate / Timeline / List are resolved
 * (mpd-parser, with the MPD's own URL and the
 * harness clock), and every representation's
 * init AND ≥1 nonzero media segment is fetched.
 * nothing was hashed the audit hashed every representative segment;
 * the product hashed nothing. Every fetched
 * object carries its SHA-256, and every persisted
 * URL is credential-free (core's `redactUrl`).
 *
 * Progression — media ADVANCING between two probes — is not decided here: this
 * observes ONE instant. The runner takes one observation per sample and the
 * engine / evidence tuple compare them (core's `liveEvidenceProgression`).
 */

import { createHash } from "node:crypto";
import {
	displayRedactedUrl,
	type EdgeUrlPolicy,
	type ExpectedLiveArtefacts,
	type LiveEvidenceProbe,
	type LiveMslIdentity,
	type RedactedUrl,
	redactUrl,
	resolveEdgeReference,
} from "@bitovp/core";
import {
	bindHlsVideoReferences,
	type HlsVideoReferences,
} from "./hls-video-reference-binding";
import {
	dashExternalSubtitleChecks,
	externalVttReferenceChecks,
	hlsAudioGroupChecks,
	hlsMediaReferenceChecks,
} from "./manifest-reference-checks";

/** One object the closure fetched on the edge, with its bytes and digest. */
export type LiveEdgeServed = {
	key: string;
	url: RedactedUrl;
	bytes: number;
	sha256: string;
	/** True for an init segment (EXT-X-MAP / DASH initialization) — witnessed,
	 *  but not media: a child needs a NON-init segment to count as delivering. */
	init: boolean;
	/** The exact playlist range proven to fit this complete fetched object. */
	byteRange?: { offset: number; length: number };
	/**
	 * The RAW reference as the playlist / MPD wrote it (WP-C6b). `new URL`
	 * percent-encodes `{`, `}` and spaces in a path before the GET — the form
	 * Akamai answers (a raw `{` is a 404 there) — so `url`/`key` carry the
	 * encoded object while this carries what the manifest said. Optional only
	 * because closures persisted before WP-C6b have none.
	 */
	reference?: string;
	/**
	 * `Last-Modified` as served, ISO-8601, when the reader exposed it. Its
	 * absence is UNVERIFIED downstream (`mediaFreshness`), never a pass.
	 */
	lastModified?: string;
};

/** One child playlist (HLS) or representation (DASH) the closure walked. */
export type LiveEdgeClosureChild = {
	id: string;
	/** Only explicitly configured remote WebVTT may omit a local media-byte witness. */
	externalContent?: "UNVERIFIED";
	requiresInit: boolean;
	url: RedactedUrl;
	bytes?: number;
	sha256?: string;
	mediaSequence?: number;
	/** Media segments the child LISTED / the template addressed at this instant. */
	listed: number;
	/** What was actually served with bytes (init + a bounded media spread). */
	served: LiveEdgeServed[];
	/** Referenced objects not served, references the policy refused, or a
	 *  child that lists no media at all. Empty for a child that delivered. */
	missing: string[];
};

/**
 * One (manifest, output) leg observed on the delivery EDGE at one instant
 * . Built by the resolver,
 * judged by the engine: `closed` means master → every child → init + ≥1
 * nonzero media segment per child, every reference inside the policy. A
 * non-empty `missing` / `rejected` / `error` is a leg that did NOT close, and
 * no entry at all is UNOBSERVED (a SKIP that does not pass the run).
 */
export type LiveEdgeClosure = {
	/** The manifest this leg observes. */
	manifestKey: string;
	/** The output (MSL mirror) the leg was read back from. */
	outputKey: string;
	/** Exact non-secret MSL identity and current provider output resource. */
	msl?: LiveMslIdentity;
	/** The credential-free master URL (origin + path) — for the report line. */
	masterUrl: string;
	/** Master → children → init + media, all served with bytes, all in policy. */
	closed: boolean;
	/** Harness clock (ms) when this observation was taken. */
	at?: number;
	master?: {
		url: RedactedUrl;
		bytes: number;
		sha256: string;
		entries?: number;
	};
	/** Children the master referenced and the closure walked. */
	childCount?: number;
	/** Submitted-plan topology, kept beside the observation. */
	expectedChildCount?: number;
	expectedChildIds?: string[];
	/** Media segments (init excluded) served with bytes, across children. */
	segmentCount?: number;
	children?: LiveEdgeClosureChild[];
	/** References the URL policy refused (scheme / origin / root escape). */
	rejected?: string[];
	/** Objects the edge did not serve, the first few, when not closed. */
	missing?: string[];
	/** A read/parse fault that stopped the closure, distinct from a plain miss. */
	error?: string;
	/**
	 * When THIS airing started (ISO-8601), carried beside the observation so
	 * the engine can judge each served object's `Last-Modified` against it
	 * (WP-C6b). Absent when the runner could not learn it — freshness is then
	 * UNVERIFIED.
	 */
	runningSince?: string;
};

/**
 * One closure as a PROBE for the progression rule: each child's media
 * sequence and the identities of the NON-init media it served. Shared by the
 * engine's mirror verdict and the evidence tuple, so both compare the same
 * thing.
 */
export function closureProbe(closure: LiveEdgeClosure): LiveEvidenceProbe {
	return {
		at: new Date(closure.at ?? 0).toISOString(),
		children: (closure.children ?? [])
			.filter((child) => child.externalContent === undefined)
			.map((child) => ({
				id: child.id,
				...(child.mediaSequence !== undefined
					? { mediaSequence: child.mediaSequence }
					: {}),
				served: child.served
					.filter((s) => !s.init)
					.map((s) => displayRedactedUrl(s.url)),
			})),
		...(closure.error !== undefined ? { error: closure.error } : {}),
	};
}

/** One GET on the edge. `body` carries the raw bytes when the reader has them;
 *  `text` is the decoded form the manifest parsers read. */
export type EdgeRead = {
	status: number;
	bytes: number;
	text: string;
	body?: Uint8Array;
	/** True only after the entire response body was read, never a capped prefix. */
	bodyComplete?: boolean;
	/** Readers must use manual redirect mode; this is a second fail-closed rail. */
	redirected?: boolean;
	/** Final response URL, when the HTTP client exposes it. */
	finalUrl?: string;
	/** The response's `Last-Modified` header verbatim, when present (WP-C6b). */
	lastModified?: string;
};
export type EdgeReader = (url: string) => Promise<EdgeRead>;

export type LiveEdgeRequirements = {
	/** When this airing started (ISO-8601) — the freshness reference (WP-C6b). */
	runningSince?: string;
	expectedChildCount: number;
	/** Run-unique destination prefix. MSL master and HLS child playlists must be
	 * direct event-root objects; only init/media objects live under this prefix. */
	currentRunPrefix?: string;
	/** HLS has stable playlist names; DASH is count-checked because MPD ids are provider-authored. */
	expectedChildIds?: readonly string[];
	/** Children whose submitted muxing is fMP4 and therefore must expose init bytes. */
	requireInitChildIds?: readonly string[];
};

/**
 * At most this many media segments are fetched per child (init excluded).
 * A live media playlist can list a full DVR window and each read is a round
 * trip; init + a spread (first, middle, last) proves the child's media are
 * served without downloading the window. The closure says when it sampled.
 */
export const MAX_EDGE_MEDIA_PER_CHILD = 11;

export const sha256Hex = (value: string | Uint8Array): string =>
	createHash("sha256").update(value).digest("hex");

const redact = (url: URL): RedactedUrl => redactUrl(url, sha256Hex);

/** A persisted reference label: filename/path only, never userinfo or query values. */
function safeReferenceLabel(reference: string, parent: URL): string {
	try {
		const url = new URL(reference, parent);
		return (
			url.pathname.slice(url.pathname.lastIndexOf("/") + 1) || url.pathname
		);
	} catch {
		return "[invalid-reference]";
	}
}

/** first, middle, last, then fill from the front — bounded and deterministic. */
export function spread<T>(items: readonly T[], max: number): T[] {
	if (items.length <= max) {
		return [...items];
	}
	const last = items.length - 1;
	const picks = new Set<number>([0, Math.floor(last / 2), last]);
	for (let i = 1; picks.size < max && i <= last; i++) {
		picks.add(i);
	}
	return [...picks].sort((a, b) => a - b).map((i) => items[i] as T);
}

/**
 * An HTTP-date `Last-Modified` → ISO-8601, or undefined when absent or
 * unparsable. Unparsable is treated as absent on purpose: a header the rule
 * cannot read must make the verdict UNVERIFIED, not throw or pass.
 */
export function isoLastModified(
	header: string | undefined,
): string | undefined {
	if (header === undefined) {
		return undefined;
	}
	const ms = Date.parse(header);
	return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** `#EXT-X-MEDIA-SEQUENCE` of a media playlist, or undefined when absent. */
function mediaSequenceOf(text: string): number | undefined {
	const m = /#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text);
	return m?.[1] !== undefined ? Number(m[1]) : undefined;
}

type Fetched =
	| { ok: true; read: EdgeRead; sha256: string }
	| { ok: false; detail: string };

async function fetchObject(readEdge: EdgeReader, url: URL): Promise<Fetched> {
	let read: EdgeRead;
	try {
		read = await readEdge(url.href);
	} catch (err) {
		return {
			ok: false,
			detail: `read threw: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	if (read.status >= 300 || read.bytes === 0) {
		return { ok: false, detail: `HTTP ${read.status}, ${read.bytes} bytes` };
	}
	let exactFinalUrl = true;
	if (read.finalUrl !== undefined) {
		try {
			exactFinalUrl = new URL(read.finalUrl).href === url.href;
		} catch {
			exactFinalUrl = false;
		}
	}
	if (read.redirected === true || !exactFinalUrl) {
		return {
			ok: false,
			detail:
				"edge reader followed a redirect instead of reading the exact URL",
		};
	}
	return {
		ok: true,
		read,
		sha256: sha256Hex(read.body ?? Buffer.from(read.text, "utf8")),
	};
}

/**
 * Walk one child's references: resolve each under the policy, fetch the init
 * and a bounded spread of media, and say what was served and what was not.
 */
async function walkChild(
	readEdge: EdgeReader,
	policy: EdgeUrlPolicy,
	child: {
		id: string;
		url: URL;
		/** DASH has no separately fetched child playlist; bind its durable
		 * representation URL to the first init/media object instead of the MPD. */
		evidenceUrl?: URL;
		bytes?: number;
		sha256?: string;
		mediaSequence?: number;
		initRef?: string;
		requiresInit: boolean;
		mediaRefs: readonly string[];
		resources?: HlsVideoReferences["objects"];
	},
	rejected: string[],
): Promise<LiveEdgeClosureChild> {
	const missing: string[] = [];
	const served: LiveEdgeClosureChild["served"] = [];
	// The raw reference rides beside its resolved URL: `new URL` has already
	// percent-encoded `{`/`}`/spaces in the path (RFC 3986 — the form the edge
	// answers), and the evidence keeps what the manifest actually said.
	type Reference = Pick<
		HlsVideoReferences["objects"][number],
		"reference" | "init" | "range"
	>;
	const resolveAll = (
		refs: readonly Reference[],
	): (Reference & { url: URL })[] => {
		const out: (Reference & { url: URL })[] = [];
		for (const ref of refs) {
			const resolved = resolveEdgeReference(ref.reference, child.url, policy);
			if (resolved.ok) out.push({ ...ref, url: resolved.url });
			else {
				rejected.push(`${child.id}: ${resolved.detail}`);
				missing.push(
					`${safeReferenceLabel(ref.reference, child.url)} (${resolved.reason})`,
				);
			}
		}
		return out;
	};
	const references: Reference[] = child.resources ?? [
		...(child.initRef !== undefined
			? [{ reference: child.initRef, init: true }]
			: []),
		...child.mediaRefs.map((reference) => ({ reference, init: false })),
	];
	const initReferences = [
		...new Map(
			references
				.filter((ref) => ref.init)
				.map((ref) => [
					JSON.stringify([ref.reference, ref.range?.offset, ref.range?.length]),
					ref,
				]),
		).values(),
	];
	if (child.requiresInit && initReferences.length === 0)
		missing.push(`${child.id} (required init reference is absent)`);
	const initTargets = resolveAll(initReferences);
	const mediaTargets = resolveAll(references.filter((ref) => !ref.init));
	if (mediaTargets.length === 0)
		missing.push(`${child.id} (lists no media segment)`);
	const initObjects = [
		...new Map(initTargets.map((target) => [target.url.href, target])).values(),
	];
	if (initObjects.length > MAX_EDGE_MEDIA_PER_CHILD)
		missing.push(
			`${child.id} (initialization objects exceed the bounded delivery check)`,
		);
	const toFetch = [
		...initObjects.slice(0, MAX_EDGE_MEDIA_PER_CHILD),
		...spread(mediaTargets, MAX_EDGE_MEDIA_PER_CHILD),
	];
	const fetchedObjects = new Map<string, Fetched>();
	const checkedRanges = new Set<Reference>();
	const rangeIssue = (
		ref: Reference,
		fetched: Fetched | undefined,
	): string | undefined => {
		if (!ref.range) return undefined;
		const { offset, length } = ref.range;
		if (
			!fetched?.ok ||
			fetched.read.status !== 200 ||
			fetched.read.bodyComplete !== true ||
			!Number.isSafeInteger(fetched.read.bytes) ||
			fetched.read.bytes <= 0 ||
			(fetched.read.body !== undefined &&
				fetched.read.body.byteLength !== fetched.read.bytes)
		)
			return "byte range is UNVERIFIED without complete, consistent response bytes";
		if (
			offset === undefined ||
			length === undefined ||
			!Number.isSafeInteger(offset) ||
			offset < 0 ||
			!Number.isSafeInteger(length) ||
			length <= 0 ||
			!Number.isSafeInteger(offset + length) ||
			offset + length > fetched.read.bytes
		)
			return "byte range exceeds the complete response bytes";
		return undefined;
	};
	let mediaServed = 0;
	for (const target of toFetch) {
		const { url, reference, init } = target;
		const key = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
		let fetched = fetchedObjects.get(url.href);
		if (!fetched) {
			fetched = await fetchObject(readEdge, url);
			fetchedObjects.set(url.href, fetched);
		}
		checkedRanges.add(target);
		if (!fetched.ok) {
			missing.push(`${key} (${fetched.detail})`);
			continue;
		}
		const issue = rangeIssue(target, fetched);
		if (issue) {
			missing.push(`${key} (${issue})`);
			continue;
		}
		const lastModified = isoLastModified(fetched.read.lastModified);
		served.push({
			key,
			url: redact(url),
			bytes: fetched.read.bytes,
			sha256: fetched.sha256,
			init,
			reference,
			...(target.range?.offset !== undefined &&
			target.range.length !== undefined
				? {
						byteRange: {
							offset: target.range.offset,
							length: target.range.length,
						},
					}
				: {}),
			...(lastModified !== undefined ? { lastModified } : {}),
		});
		if (!init) {
			mediaServed += 1;
		}
	}
	// Ranges outside the sampled references still need actual byte bounds. A
	// shared fetched object can prove them; an unread object remains unverified.
	for (const target of [...initTargets, ...mediaTargets]) {
		if (!target.range || checkedRanges.has(target)) continue;
		const issue = rangeIssue(target, fetchedObjects.get(target.url.href));
		if (issue)
			missing.push(
				`${safeReferenceLabel(target.reference, child.url)} (${issue})`,
			);
	}
	if (mediaTargets.length > 0 && mediaServed === 0) {
		missing.push(`${child.id} (no media segment served with bytes)`);
	}
	return {
		id: child.id,
		requiresInit: child.requiresInit,
		url: redact(child.evidenceUrl ?? child.url),
		...(child.bytes !== undefined ? { bytes: child.bytes } : {}),
		...(child.sha256 !== undefined ? { sha256: child.sha256 } : {}),
		...(child.mediaSequence !== undefined
			? { mediaSequence: child.mediaSequence }
			: {}),
		listed: child.mediaRefs.length,
		served,
		missing,
	};
}

/**
 * Observe ONE (manifest, output) leg on the edge at one instant.
 *
 * `closed` is true only when: the master was served with bytes, it referenced
 * at least one child, every reference resolved INSIDE the policy, every child
 * was served, and every child served at least one nonzero media segment (and
 * its init, when it declares one). Anything less is named in `missing` /
 * `rejected` / `error`, never silently rounded up.
 */
export async function observeEdgeLeg(
	readEdge: EdgeReader,
	basePolicy: EdgeUrlPolicy,
	manifest: ExpectedLiveArtefacts["manifests"][number],
	outputKey: string,
	at: number,
	requirements?: LiveEdgeRequirements,
): Promise<LiveEdgeClosure> {
	const required = requirements ?? { expectedChildCount: -1 };
	const policy = basePolicy;
	const normalizedRunPrefix = required.currentRunPrefix
		?.replace(/^\/+/, "")
		.replace(/\/+$/, "");
	if (
		required.currentRunPrefix !== undefined &&
		(normalizedRunPrefix === undefined ||
			normalizedRunPrefix === "" ||
			normalizedRunPrefix
				.split("/")
				.some(
					(part) =>
						part === "" ||
						part === "." ||
						part === ".." ||
						part.includes("\\") ||
						part.includes("?") ||
						part.includes("#"),
				))
	) {
		return {
			manifestKey: manifest.manifestKey,
			outputKey,
			at,
			masterUrl: `${policy.base.origin}${policy.base.pathname}`,
			closed: false,
			error:
				"current run prefix is empty or is not a safe relative object-key prefix",
		};
	}
	const masterKey = `${manifest.dir.prefix}${manifest.files[0] ?? ""}`;
	const manifestPrefix = manifest.dir.prefix
		.replace(/^\/+/, "")
		.replace(/\/+$/, "");
	if (normalizedRunPrefix !== undefined && manifestPrefix !== "") {
		return {
			manifestKey: manifest.manifestKey,
			outputKey,
			at,
			masterUrl: `${policy.base.origin}${policy.base.pathname}${masterKey.replace(/^\/+/, "")}`,
			closed: false,
			error: "master must be directly at the MSL event root",
		};
	}
	const masterRef = resolveEdgeReference(
		masterKey.replace(/^\/+/, ""),
		policy.base,
		policy,
	);
	const legBase = {
		manifestKey: manifest.manifestKey,
		outputKey,
		at,
		...(required.expectedChildCount >= 0
			? { expectedChildCount: required.expectedChildCount }
			: {}),
		...(required.expectedChildIds
			? { expectedChildIds: [...required.expectedChildIds] }
			: {}),
		// The airing's start rides on every closure this leg produces — the
		// engine judges each served object's Last-Modified against it (WP-C6b).
		...(required.runningSince !== undefined
			? { runningSince: required.runningSince }
			: {}),
	};
	if (!masterRef.ok) {
		return {
			...legBase,
			masterUrl: `${policy.base.origin}${policy.base.pathname}${masterKey}`,
			closed: false,
			rejected: [masterRef.detail],
			error: `master key refused by the edge policy: ${masterRef.detail}`,
		};
	}
	const masterUrl = masterRef.url;
	if (normalizedRunPrefix !== undefined) {
		const relative = masterUrl.pathname.slice(policy.base.pathname.length);
		if (
			masterUrl.origin !== policy.base.origin ||
			!masterUrl.pathname.startsWith(policy.base.pathname) ||
			relative === "" ||
			relative.includes("/")
		) {
			return {
				...legBase,
				masterUrl: displayRedactedUrl(redact(masterUrl)),
				closed: false,
				error: "master must be an exact direct MSL event root object",
			};
		}
	}
	const masterDisplay = displayRedactedUrl(redact(masterUrl));
	const leg = { ...legBase, masterUrl: masterDisplay };
	/**
	 * MSL has two distinct roots: master/HLS children are direct event-root
	 * objects, while init/media bytes are under the exact current-run prefix.
	 * Generic edge walks retain the manifest-directory policy and explicit
	 * allowlist used before MSL current-run attribution is requested.
	 */
	const mediaPrefix = `${normalizedRunPrefix ?? manifest.dir.prefix.replace(/^\/+/, "").replace(/\/+$/, "")}/`;
	const mediaPolicy: EdgeUrlPolicy = {
		base: new URL(mediaPrefix, policy.base),
		allowedRoots: normalizedRunPrefix === undefined ? policy.allowedRoots : [],
	};
	const playlistPolicy: EdgeUrlPolicy =
		normalizedRunPrefix === undefined
			? mediaPolicy
			: { ...policy, allowedRoots: [] };

	const master = await fetchObject(readEdge, masterUrl);
	if (!master.ok) {
		return {
			...leg,
			closed: false,
			missing: [masterKey],
			error: `master not served on the edge (${master.detail})`,
		};
	}
	const masterRecord = {
		url: redact(masterUrl),
		bytes: master.read.bytes,
		sha256: master.sha256,
	};
	const rejected: string[] = [];
	const children: LiveEdgeClosureChild[] = [];
	const referenceMissing: string[] = [];

	if (manifest.kind === "DASH") {
		if (manifest.dashExternalSubtitles?.length) {
			const { parseDashText } = await import("./adapters");
			const observed = await parseDashText(master.read.text).catch(
				() => undefined,
			);
			const checks = observed
				? dashExternalSubtitleChecks(
						"external",
						manifest.dashExternalSubtitles,
						observed,
					)
				: [];
			for (const [index] of manifest.dashExternalSubtitles.entries()) {
				const valid = checks.some(
					(check) =>
						check.id === `external:external-subtitle:${index}:reference` &&
						check.verdict === "PASS",
				);
				children.push({
					id: `external-subtitle-${index}`,
					url: redact(masterUrl),
					requiresInit: false,
					externalContent: "UNVERIFIED",
					listed: valid ? 1 : 0,
					served: [],
					missing: valid
						? []
						: ["configured external subtitle URL or language was absent"],
				});
			}
			if (
				observed?.representations.filter((row) => row.kind === "text")
					.length !== manifest.dashExternalSubtitles.length
			)
				referenceMissing.push(
					"DASH external subtitle count differs from the configured tracks",
				);
		}
		let parsed: import("mpd-parser").MpdManifest;
		try {
			const mod = await import("mpd-parser");
			parsed = mod.parse(master.read.text, {
				manifestUri: masterUrl.href,
				NOW: at,
			});
		} catch (err) {
			return {
				...leg,
				closed: false,
				master: masterRecord,
				error: `MPD parse failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
		const playlists: { id: string; p: import("mpd-parser").MpdPlaylist }[] = [
			...(parsed.playlists ?? []).map((p, i) => ({
				id: p.attributes?.NAME ?? `video-${i}`,
				p,
			})),
			...Object.entries(parsed.mediaGroups?.AUDIO ?? {}).flatMap(
				([group, entries]) =>
					Object.entries(entries).flatMap(([name, entry]) =>
						(entry.playlists ?? []).map((p, i) => ({
							id: p.attributes?.NAME ?? `audio-${group}-${name}-${i}`,
							p,
						})),
					),
			),
		];
		if (playlists.length === 0) {
			return {
				...leg,
				closed: false,
				master: { ...masterRecord, entries: 0 },
				childCount: 0,
				segmentCount: 0,
				error:
					"MPD served on the edge but resolved no representation — a Representation count is not a closure",
			};
		}
		for (const { id, p } of playlists) {
			const segments = p.segments ?? [];
			const initRef = segments[0]?.map?.resolvedUri;
			const mediaRefs = segments.flatMap((s) =>
				s.resolvedUri ? [s.resolvedUri] : [],
			);
			const evidenceRef = initRef ?? mediaRefs[0];
			const evidenceUrl = evidenceRef
				? resolveEdgeReference(evidenceRef, masterUrl, mediaPolicy)
				: undefined;
			children.push(
				await walkChild(
					readEdge,
					mediaPolicy,
					{
						id,
						url: masterUrl,
						...(evidenceUrl?.ok ? { evidenceUrl: evidenceUrl.url } : {}),
						...(initRef ? { initRef } : {}),
						requiresInit: true,
						mediaRefs,
					},
					rejected,
				),
			);
		}
	} else {
		const { parseHlsText } = await import("./adapters");
		let parsedMaster: Awaited<ReturnType<typeof parseHlsText>>;
		try {
			parsedMaster = await parseHlsText(master.read.text);
		} catch (err) {
			return {
				...leg,
				closed: false,
				master: masterRecord,
				error: `master parse failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
		const childRefs = [
			...parsedMaster.variants.map((v) => v.uri),
			...parsedMaster.media.flatMap((m) => (m.uri ? [m.uri] : [])),
		].filter((u) => u !== "");
		referenceMissing.push(
			...hlsMediaReferenceChecks(
				"master",
				manifest.hlsAdditionalMedia ?? [],
				parsedMaster,
			)
				.filter((check) => check.verdict === "FAIL")
				.map((check) => check.detail),
		);
		if (manifest.hlsAudioGroups)
			referenceMissing.push(
				...hlsAudioGroupChecks("master", manifest.hlsAudioGroups, parsedMaster)
					.filter((check) => check.verdict === "FAIL")
					.map((check) => check.detail),
			);
		if (
			manifest.entryCount !== undefined &&
			parsedMaster.variants.length + parsedMaster.media.length !==
				manifest.entryCount
		)
			referenceMissing.push(
				"HLS master entry count differs from the configured tracks",
			);
		if (childRefs.length === 0) {
			return {
				...leg,
				closed: false,
				master: { ...masterRecord, entries: 0 },
				childCount: 0,
				segmentCount: 0,
				error:
					"master served on the edge but references no child playlist — a master-only leg is not a closure",
			};
		}
		for (const ref of childRefs) {
			const resolved = resolveEdgeReference(ref, masterUrl, playlistPolicy);
			if (!resolved.ok) {
				const id = safeReferenceLabel(ref, masterUrl);
				rejected.push(`master: ${resolved.detail}`);
				children.push({
					id,
					requiresInit: required.requireInitChildIds?.includes(id) ?? false,
					url: redact(masterUrl),
					listed: 0,
					served: [],
					missing: [`${id} (${resolved.reason})`],
				});
				continue;
			}
			const childUrl = resolved.url;
			if (normalizedRunPrefix !== undefined) {
				const relative = childUrl.pathname.slice(policy.base.pathname.length);
				if (
					childUrl.origin !== policy.base.origin ||
					!childUrl.pathname.startsWith(policy.base.pathname) ||
					relative === "" ||
					relative.includes("/")
				) {
					const id = safeReferenceLabel(ref, masterUrl);
					rejected.push(
						`master: ${id} is not an exact direct MSL event root child playlist`,
					);
					children.push({
						id,
						requiresInit: required.requireInitChildIds?.includes(id) ?? false,
						url: redact(masterUrl),
						listed: 0,
						served: [],
						missing: [`${id} (not a direct MSL event root object)`],
					});
					continue;
				}
			}
			const id = childUrl.pathname.slice(
				childUrl.pathname.lastIndexOf("/") + 1,
			);
			const child = await fetchObject(readEdge, childUrl);
			if (!child.ok) {
				children.push({
					id,
					requiresInit: required.requireInitChildIds?.includes(id) ?? false,
					url: redact(childUrl),
					listed: 0,
					served: [],
					missing: [`${id} (${child.detail})`],
				});
				continue;
			}
			let parsedChild: Awaited<ReturnType<typeof parseHlsText>>;
			try {
				parsedChild = await parseHlsText(child.read.text);
			} catch (err) {
				children.push({
					id,
					requiresInit: required.requireInitChildIds?.includes(id) ?? false,
					url: redact(childUrl),
					bytes: child.read.bytes,
					sha256: child.sha256,
					listed: 0,
					served: [],
					missing: [
						`${id} (parse: ${err instanceof Error ? err.message : String(err)})`,
					],
				});
				continue;
			}
			const mediaSequence = mediaSequenceOf(child.read.text);
			let videoResources: HlsVideoReferences["objects"] | undefined;
			const video = manifest.hlsAdditionalMedia?.find(
				(media) => media.type === "VIDEO" && media.uri === id,
			);
			if (video) {
				const binding = bindHlsVideoReferences(
					"video-binding",
					video,
					parsedChild,
					{ outputKey, playlist: childUrl, storageRoot: policy.base },
				);
				videoResources = binding.objects;
				if (binding.check.verdict !== "PASS") {
					children.push({
						id,
						url: redact(childUrl),
						requiresInit: video.requiresInit ?? false,
						bytes: child.read.bytes,
						sha256: child.sha256,
						listed: parsedChild.segmentUris?.length ?? 0,
						served: [],
						missing: [binding.check.detail],
					});
					continue;
				}
			}
			const external = manifest.hlsAdditionalMedia?.find(
				(media) => media.uri === id && media.vttUrl !== undefined,
			);
			if (external?.vttUrl) {
				const checks = externalVttReferenceChecks(
					"subtitle",
					external.vttUrl,
					parsedChild,
				);
				children.push({
					id,
					url: redact(childUrl),
					requiresInit: false,
					bytes: child.read.bytes,
					sha256: child.sha256,
					externalContent: "UNVERIFIED",
					listed: parsedChild.segmentUris?.length ?? 0,
					served: [],
					missing: checks
						.filter((check) => check.verdict === "FAIL")
						.map((check) => check.detail),
				});
				continue;
			}
			children.push(
				await walkChild(
					readEdge,
					mediaPolicy,
					{
						id,
						url: childUrl,
						bytes: child.read.bytes,
						sha256: child.sha256,
						...(mediaSequence !== undefined ? { mediaSequence } : {}),
						...(parsedChild.mapUri ? { initRef: parsedChild.mapUri } : {}),
						requiresInit: required.requireInitChildIds?.includes(id) ?? false,
						mediaRefs: parsedChild.segmentUris ?? [],
						...(videoResources ? { resources: videoResources } : {}),
					},
					rejected,
				),
			);
		}
	}

	const missing = [
		...referenceMissing,
		...children.flatMap((c) => c.missing.map((m) => `${c.id}: ${m}`)),
	];
	const segmentCount = children.reduce(
		(n, c) => n + c.served.filter((s) => !s.init).length,
		0,
	);
	const expectedIds = new Set(required.expectedChildIds ?? []);
	const observedIds = new Set(children.map((child) => child.id));
	const topologyMissing = [...expectedIds].filter((id) => !observedIds.has(id));
	for (const id of topologyMissing) {
		missing.push(`required child ${id} was omitted by the master`);
	}
	const closed =
		(required.expectedChildCount < 0 ||
			children.length === required.expectedChildCount) &&
		topologyMissing.length === 0 &&
		referenceMissing.length === 0 &&
		rejected.length === 0 &&
		children.every(
			(c) =>
				c.missing.length === 0 &&
				(c.externalContent === "UNVERIFIED"
					? c.listed > 0
					: c.served.some((s) => !s.init)),
		);
	return {
		...leg,
		closed,
		master: { ...masterRecord, entries: children.length },
		childCount: children.length,
		segmentCount,
		children,
		...(rejected.length > 0 ? { rejected } : {}),
		...(missing.length > 0 ? { missing: missing.slice(0, 8) } : {}),
	};
}
