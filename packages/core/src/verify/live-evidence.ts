/**
 * The Live / MSL evidence TUPLE (audit 5c3d97ca BLOCKER-4, §14.4 EV-02).
 *
 * The paid re-audit found that a live run's PASS rested on facts that were
 * never joined: `LiveRunResult` carried a channel id, a report, a first-publish
 * latency and a cleanup seal, but no plan digest, no source identity, no
 * provider resource ids, no output prefix, no edge URL and no media bytes — and
 * the HLS edge closure dropped absolute child URIs, so a master whose children
 * were all absolute walked ZERO children and still closed on zero segments.
 * "Delivered" was therefore a claim about a master playlist that returned 200.
 *
 * This module is the canonical, VERSIONED shape of what a live PASS is a pass
 * OF, one leg per (manifest, output) delivery target:
 *
 *   build        exact commit / image / plan SHA
 *   source       the fed object's location and version identity
 *   channel      channel id, the airing (LiveChannelRun), the provider encoding
 *   output       the run prefix, and for an edge leg the credential-free edge URL
 *   master       identity, bytes, hash
 *   children     each child playlist / representation, with the media it served
 *   probes       at least two timestamps, each with what was listed and served
 *   progression  whether media ADVANCED between the first and last probe
 *   providerTerminal, cleanup
 *
 * `liveEvidenceCompleteness` is the single rule for whether a leg is COMPLETE,
 * and it is pure: the worker's runner assembles the leg and asks; the run
 * recorder refuses to seal a green live outcome whose legs are not complete;
 * the Dashboard renders the same `missing` list. One rule, three readers, so
 * they cannot disagree about what "sealed" means.
 *
 * Every URL persisted here is CREDENTIAL-FREE (`redactUrl`): userinfo is
 * dropped, query VALUES are dropped (a signed edge URL's token lives there),
 * only the query key names and the SHA-256 of the full resolved URL are kept —
 * enough to prove which exact URL was read without storing the secret.
 */

export const LIVE_EVIDENCE_VERSION = 2 as const;

/** A URL as persisted: origin + path, query KEY NAMES, and a digest of the whole. */
export type RedactedUrl = {
	origin: string;
	path: string;
	queryKeys: string[];
	/** SHA-256 of the full resolved URL (with its query values) — never the URL itself. */
	urlSha256: string;
};

/**
 * Strip a URL to what evidence may carry. `sha256` is injected so this module
 * stays free of `node:crypto` (the Dashboard imports these types); the worker
 * passes its own digest.
 */
export function redactUrl(
	url: string | URL,
	sha256: (value: string) => string,
): RedactedUrl {
	const parsed = typeof url === "string" ? new URL(url) : url;
	const clean = new URL(parsed.href);
	clean.username = "";
	clean.password = "";
	return {
		origin: clean.origin,
		path: clean.pathname,
		queryKeys: [...new Set([...clean.searchParams.keys()])].sort(),
		urlSha256: sha256(clean.href),
	};
}

/** `origin + path` — the human-readable half of a redacted URL. */
export function displayRedactedUrl(url: RedactedUrl): string {
	return `${url.origin}${url.path}`;
}

/** Why a reference was refused by `resolveEdgeReference`. */
export type EdgeRejectionReason =
	| "invalid"
	| "scheme"
	| "userinfo"
	| "query"
	| "origin"
	| "root-escape";

/**
 * Where a playlist / MPD reference may resolve to. The base is the edge root
 * the run was pointed at; same-origin references must stay UNDER it (a `../`
 * or an absolute path that climbs out of the event root is a root escape), and
 * any other origin must be named in `allowedRoots` as an absolute URL prefix.
 */
export type EdgeUrlPolicy = {
	base: URL;
	allowedRoots: readonly string[];
};

export type ResolvedEdgeReference =
	| { ok: true; url: URL }
	| { ok: false; reason: EdgeRejectionReason; detail: string };

/** A diagnostic form that can be persisted: URL credentials and query values omitted. */
function safeReferenceDisplay(reference: string, parent: URL): string {
	try {
		const url = new URL(reference, parent);
		return `"${url.origin}${url.pathname}"`;
	} catch {
		return "the invalid manifest reference";
	}
}

/** The directory of a URL (everything up to and including the last slash). */
function rootOf(url: URL): string {
	const path = url.pathname;
	const i = path.lastIndexOf("/");
	return `${url.origin}${i < 0 ? "/" : path.slice(0, i + 1)}`;
}

/**
 * Build the policy for an edge base: the base's own directory is the root, and
 * any extra roots are normalised to `origin + directory`.
 */
export function edgeUrlPolicy(
	base: string | URL,
	allowedRoots: readonly string[] = [],
): EdgeUrlPolicy {
	const parsed = typeof base === "string" ? new URL(base) : base;
	// A base without a trailing slash names a FILE for `new URL(rel, base)`;
	// the run's root is a directory, so make the directory explicit.
	const dir = parsed.pathname.endsWith("/")
		? parsed
		: new URL(`${parsed.pathname}/`, parsed);
	return {
		base: dir,
		allowedRoots: allowedRoots.map((root) => {
			const u = new URL(root);
			return u.pathname.endsWith("/") ? `${u.origin}${u.pathname}` : rootOf(u);
		}),
	};
}

/**
 * `new URL(reference, parent)` semantics, then the policy. Absolute AND
 * relative references resolve the same way a player resolves them; what
 * changes is that a resolved URL outside the allowed roots is REFUSED rather
 * than silently dropped (the HLS resolver used to filter absolute URIs out —
 * which walked zero children and closed the leg on zero segments) or fetched
 * (which would hand a signed request to any origin a manifest named).
 */
export function resolveEdgeReference(
	reference: string,
	parent: URL,
	policy: EdgeUrlPolicy,
): ResolvedEdgeReference {
	let url: URL;
	try {
		url = new URL(reference, parent);
	} catch {
		return {
			ok: false,
			reason: "invalid",
			detail: `the invalid manifest reference does not resolve against ${parent.origin}${parent.pathname}`,
		};
	}
	const display = safeReferenceDisplay(reference, parent);
	if (url.protocol !== "https:") {
		return {
			ok: false,
			reason: "scheme",
			detail: `${display} resolves to scheme ${url.protocol} — only https: is read on the edge`,
		};
	}
	if (url.username !== "" || url.password !== "") {
		return {
			ok: false,
			reason: "userinfo",
			detail: `${display} carries userinfo — a credential in a manifest reference is never followed`,
		};
	}
	if (url.search !== "" || url.hash !== "") {
		return {
			ok: false,
			reason: "query",
			detail: `${display} carries a query or fragment — current-run attribution requires an exact unsigned edge path`,
		};
	}
	const target = `${url.origin}${url.pathname}`;
	const baseRoot = `${policy.base.origin}${policy.base.pathname}`;
	if (target.startsWith(baseRoot)) {
		return { ok: true, url };
	}
	if (policy.allowedRoots.some((root) => target.startsWith(root))) {
		return { ok: true, url };
	}
	if (url.origin === policy.base.origin) {
		return {
			ok: false,
			reason: "root-escape",
			detail: `${display} resolves to ${target}, outside the edge root ${baseRoot}`,
		};
	}
	return {
		ok: false,
		reason: "origin",
		detail: `${display} resolves to origin ${url.origin}, which is neither the edge origin nor an allowed root`,
	};
}

/** Akamai's media-delivery hostnames — the default allowlist for an MSL edge. */
export const DEFAULT_MSL_EDGE_HOST_SUFFIXES = [
	".akamaized.net",
	".akamaihd.net",
	".akamaized-staging.net",
	".akamaihd-staging.net",
] as const;

/**
 * The shape rules an edge base URL must satisfy wherever it is accepted — the
 * verifier flag and the `AKAMAI_MSL` credential's `edgeBaseUrl` share THIS
 * classifier so the two doors cannot disagree about what a usable edge root
 * is. `null` means the URL's shape is fine; the two callers add their own
 * rules on top (the verifier a host allowlist, the credential a public host,
 * no trailing slash and a length cap).
 */
export type EdgeBaseUrlShapeDefect = "scheme" | "userinfo" | "query";

export function edgeBaseUrlShapeDefect(
	url: URL,
): EdgeBaseUrlShapeDefect | null {
	if (url.protocol !== "https:") {
		return "scheme";
	}
	if (url.username !== "" || url.password !== "") {
		return "userinfo";
	}
	if (url.search !== "" || url.hash !== "") {
		return "query";
	}
	return null;
}

/**
 * Validate the operator-supplied edge base (`--live-msl-edge-base-url` /
 * `VERIFY_LIVE_MSL_EDGE_BASE_URL`): HTTPS, no userinfo, no query or fragment,
 * and a host on the allowlist (a suffix like `.akamaized.net`, or an exact
 * host). Returns the base normalised to a directory (trailing slash) so every
 * later `new URL(key, base)` resolves under it rather than beside it.
 */
export function parseEdgeBaseUrl(
	raw: string,
	options: { allowedHosts?: readonly string[] } = {},
): { ok: true; url: string } | { ok: false; reason: string } {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, reason: `edge base URL "${raw}" is not a URL` };
	}
	switch (edgeBaseUrlShapeDefect(url)) {
		case "scheme":
			return {
				ok: false,
				reason: `edge base URL "${raw}" is not https: — the delivery edge is read over TLS only`,
			};
		case "userinfo":
			return {
				ok: false,
				reason:
					"edge base URL carries userinfo — a credential never rides in the edge base",
			};
		case "query":
			return {
				ok: false,
				reason: `edge base URL "${raw}" carries a query or fragment — a signed or parameterised base cannot be persisted as evidence; supply the event root only`,
			};
		case null:
			break;
	}
	const host = url.hostname.toLowerCase();
	const allowed = options.allowedHosts ?? DEFAULT_MSL_EDGE_HOST_SUFFIXES;
	const permitted = allowed.some((entry) => {
		const e = entry.trim().toLowerCase();
		if (e === "") {
			return false;
		}
		return e.startsWith(".") ? host.endsWith(e) : host === e;
	});
	if (!permitted) {
		return {
			ok: false,
			reason: `edge base URL host "${host}" is not an allowed delivery host (${allowed.join(", ")}) — name it in VERIFY_LIVE_MSL_EDGE_ALLOWED_HOSTS to read it on purpose`,
		};
	}
	const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
	return { ok: true, url: `${url.origin}${path}` };
}

/** The longest `edgeBaseUrl` an `AKAMAI_MSL` credential may carry. */
export const MAX_CREDENTIAL_EDGE_BASE_URL_LENGTH = 512;

/**
 * Why an `AKAMAI_MSL` credential's `edgeBaseUrl` was refused. The first three
 * are the shape rules shared with the verifier (`edgeBaseUrlShapeDefect`); the
 * rest are the credential's own: the app appends `/<manifestName>` itself, so
 * a trailing slash would double it; a private or loopback host would turn a
 * playback link every viewer receives into a pointer at the operator's own
 * network; and a bounded length keeps the plain-JSON config column bounded.
 */
export type CredentialEdgeBaseUrlDefect =
	| "length"
	| "invalid"
	| EdgeBaseUrlShapeDefect
	| "trailing-slash"
	| "private-host";

const IPV4_LITERAL = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Is this LITERAL host one no viewer can reach — `localhost`, or an IP literal
 * in a loopback, private, link-local, CGNAT, multicast, reserved or
 * unspecified range? Names are not resolved (the schema runs in the browser
 * as well as the server); the rule refuses what can be read off the string.
 *
 * The string it reads is `URL.hostname`, and that matters for IPv4-mapped
 * IPv6 (review rev401 R2): WHATWG serialises `[::ffff:127.0.0.1]` as
 * `[::ffff:7f00:1]` — two hex groups, never the dotted quad — so the mapped
 * branch decodes the hex form (and still accepts the dotted form for callers
 * that hand over a raw literal) and recurses into the IPv4 rules.
 */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	if (host === "localhost" || host.endsWith(".localhost")) {
		return true;
	}
	const v4 = IPV4_LITERAL.exec(host);
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])];
		return (
			a === 0 || // 0.0.0.0/8 — unspecified
			a === 10 || // 10/8
			(a === 100 && b >= 64 && b <= 127) || // 100.64/10 — CGNAT
			a === 127 || // loopback
			(a === 169 && b === 254) || // link-local
			(a === 172 && b >= 16 && b <= 31) || // 172.16/12
			(a === 192 && b === 168) || // 192.168/16
			a >= 224 // 224/4 multicast, 240/4 reserved, 255.255.255.255
		);
	}
	if (host.startsWith("[") && host.endsWith("]")) {
		const v6 = host.slice(1, -1);
		if (v6 === "::" || v6 === "::1") {
			return true;
		}
		// Unique-local (fc00::/7) and link-local (fe80::/10).
		if (/^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6)) {
			return true;
		}
		// An IPv4-mapped address (::ffff:0:0/96) carries its IPv4 rules — in
		// the serialised hex form a URL hands over, or the dotted form.
		const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
		if (mappedHex) {
			const hi = Number.parseInt(mappedHex[1] as string, 16);
			const lo = Number.parseInt(mappedHex[2] as string, 16);
			return isPrivateOrLoopbackHost(
				`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`,
			);
		}
		const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(
			v6,
		);
		if (mappedDotted) {
			return isPrivateOrLoopbackHost(mappedDotted[1] as string);
		}
	}
	return false;
}

/**
 * Validate an `AKAMAI_MSL` credential's `edgeBaseUrl` — the Akamai delivery
 * root a viewer's player loads the stream from (`/hls/live/<streamId>/<event>`
 * on MSL4; the Control Center value on MSL5). Version-agnostic on purpose: the
 * app only ever appends `/<manifestName>`, so the rules are about the URL's
 * shape, never about the path's meaning. Returns the value to store: the
 * trimmed input, byte-for-byte, when it passes.
 */
export function parseCredentialEdgeBaseUrl(
	raw: string,
):
	| { ok: true; url: string }
	| { ok: false; defect: CredentialEdgeBaseUrlDefect } {
	const value = raw.trim();
	if (value.length > MAX_CREDENTIAL_EDGE_BASE_URL_LENGTH) {
		return { ok: false, defect: "length" };
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { ok: false, defect: "invalid" };
	}
	const shape = edgeBaseUrlShapeDefect(url);
	if (shape) {
		return { ok: false, defect: shape };
	}
	if (value.endsWith("/")) {
		return { ok: false, defect: "trailing-slash" };
	}
	if (url.hostname === "" || isPrivateOrLoopbackHost(url.hostname)) {
		return { ok: false, defect: "private-host" };
	}
	return { ok: true, url: value };
}

/** One object the leg read (edge: fetched with bytes and hash; origin: listed with bytes). */
export type LiveEvidenceObject = {
	key: string;
	url?: RedactedUrl;
	bytes: number;
	/** Present when the bytes were FETCHED (an edge leg); absent when only listed. */
	sha256?: string;
	/**
	 * The object's `Last-Modified` as the edge served it, ISO-8601 (WP-C6b).
	 * Present only when the reader exposed the header; its absence makes the
	 * freshness verdict UNVERIFIED, never a pass — see `mediaFreshness`.
	 */
	lastModified?: string;
	/**
	 * The RAW reference as the playlist / MPD wrote it, before URL resolution
	 * percent-encoded it (`seg-{rand_chars:8}-1.ts` → `…%7B…%7D…`). Kept so the
	 * evidence says what the manifest said, not only what was fetched.
	 */
	reference?: string;
};

/** Verdict of `mediaFreshness`. */
export type MediaFreshness = {
	verdict: "FRESH" | "STALE" | "UNVERIFIED";
	detail: string;
};

/** Objects older than the airing by more than this are a previous airing's. */
export const MEDIA_FRESHNESS_TOLERANCE_MS = 60_000;

/**
 * Are the witnessed media objects THIS airing's? (WP-C6b, measured
 * 2026-09-02, measurement doc Part 9.)
 *
 * A re-aired MSL4 channel's root playlists advanced normally while every
 * object they named carried the FIRST airing's `Last-Modified` (08:18Z at a
 * 13:25Z start) or 404'd. Playlist progression is therefore not evidence
 * that the media a viewer fetches belong to the run under test; the object's
 * own timestamp against the run's `runningSince` is.
 *
 * Rules, each fail-closed:
 *   - no `runningSince`            → UNVERIFIED (nothing to compare against)
 *   - no media witnessed           → UNVERIFIED
 *   - any STAMPED media older than
 *     `runningSince − tolerance`   → STALE, with both timestamps in the detail
 *                                    (judged first: a witnessed stale object
 *                                    is a defect even beside an unstamped one)
 *   - any media without the header → UNVERIFIED, naming it — a reader that
 *                                    drops the header must not turn into a pass
 *   - otherwise                    → FRESH
 * Unparsable timestamps count as absent.
 */
export function mediaFreshness(
	media: readonly Pick<LiveEvidenceObject, "key" | "lastModified">[],
	runningSince: string | number | undefined,
	toleranceMs = MEDIA_FRESHNESS_TOLERANCE_MS,
): MediaFreshness {
	const since =
		typeof runningSince === "number"
			? runningSince
			: Date.parse(runningSince ?? "");
	if (runningSince === undefined || Number.isNaN(since)) {
		return {
			verdict: "UNVERIFIED",
			detail:
				"the run's runningSince is unknown, so object age cannot be judged",
		};
	}
	if (media.length === 0) {
		return { verdict: "UNVERIFIED", detail: "no media object was witnessed" };
	}
	const unstamped = media.filter(
		(m) =>
			m.lastModified === undefined || Number.isNaN(Date.parse(m.lastModified)),
	);
	const floor = since - toleranceMs;
	// STALE is judged over the STAMPED objects before UNVERIFIED (rev411): one
	// header-less object beside a witnessed stale sibling must not soften a
	// FAIL into a WARN.
	const stale = media.filter(
		(m) =>
			m.lastModified !== undefined &&
			!Number.isNaN(Date.parse(m.lastModified)) &&
			Date.parse(m.lastModified) < floor,
	);
	if (stale.length === 0 && unstamped.length > 0) {
		return {
			verdict: "UNVERIFIED",
			detail: `${unstamped.length} of ${media.length} media object(s) carried no readable Last-Modified (first ${unstamped[0]?.key}) — age unverified, never a pass`,
		};
	}
	if (stale.length > 0) {
		const oldest = stale.reduce((a, b) =>
			Date.parse(a.lastModified as string) <=
			Date.parse(b.lastModified as string)
				? a
				: b,
		);
		return {
			verdict: "STALE",
			detail: `${stale.length} of ${media.length} media object(s) predate this airing: ${oldest.key} Last-Modified ${new Date(Date.parse(oldest.lastModified as string)).toISOString()} vs runningSince ${new Date(since).toISOString()} (tolerance ${toleranceMs / 1000}s) — the edge is serving a previous airing's objects`,
		};
	}
	return {
		verdict: "FRESH",
		detail: `${media.length} media object(s) all modified at or after runningSince ${new Date(since).toISOString()} (tolerance ${toleranceMs / 1000}s)`,
	};
}

/** One child playlist (HLS) or representation (DASH), with the media it served. */
export type LiveEvidenceChild = {
	id: string;
	url?: RedactedUrl;
	bytes?: number;
	sha256?: string;
	mediaSequence?: number;
	/** Media segments listed at the closure that produced this child. */
	listed: number;
	/** Media segments this leg actually witnessed with bytes (bounded sample). */
	media: LiveEvidenceObject[];
	/** Init bytes for fMP4 HLS and every DASH representation. */
	init?: LiveEvidenceObject;
	/** Derived from the submitted plan/protocol, never from what happened to appear. */
	requiresInit: boolean;
	/** Objects that were referenced but not served, or references the policy refused. */
	missing: string[];
};

/** One probe: what each child listed and served at one instant. */
export type LiveEvidenceProbe = {
	at: string;
	children: {
		id: string;
		mediaSequence?: number;
		/** Identities (paths / keys) of media witnessed with nonzero bytes at this probe. */
		served: string[];
	}[];
	error?: string;
};

/** Non-secret identity that joins an MSL edge observation to one output. */
export type LiveMslIdentity = {
	outputKey: string;
	/** Vault row id only; no Digest username/password is persisted. */
	credentialId: string;
	/** Provider output resource created for this exact airing. */
	providerOutputId?: string;
	streamId: number;
	eventName: string;
	streamFormat: "HLS" | "DASH" | "CMAF";
	mslVersion: string;
	eventRoot: RedactedUrl;
};

/** Akamai's documented playback event-root path for an MSL format. */
export function mslPlaybackEventPath(
	streamFormat: LiveMslIdentity["streamFormat"],
	streamId: number,
	eventName: string,
): string {
	return `/${streamFormat.toLowerCase()}/live/${streamId}/${encodeURIComponent(eventName)}/`;
}

export type LiveEvidenceLeg = {
	version: typeof LIVE_EVIDENCE_VERSION;
	scenario: string;
	/** `<manifestKey>@<outputKey>` — one delivery target of one manifest. */
	outputLeg: string;
	manifestKey: string;
	outputKey: string;
	kind: "HLS" | "DASH";
	/** ORIGIN: read through storage; EDGE: read over HTTPS on the delivery edge. */
	role: "ORIGIN" | "EDGE";
	build: { commit: string; image?: string; planSha256: string };
	source: {
		location: string;
		etag?: string;
		versionId?: string;
		generation?: string;
		size?: number;
		sha256?: string;
	};
	channel: {
		channelId: string;
		liveChannelRunId?: string;
		providerEncodingId?: string;
		/** Exact resource ids, keyed by the submitted plan's stream/output keys. */
		providerStreamIds: Record<string, string>;
		providerOutputIds: Record<string, string>;
		requiredProviderStreamKeys: string[];
		requiredProviderOutputKeys: string[];
	};
	/** Required only for EDGE legs, where it binds the URL to the exact MSL output. */
	msl?: LiveMslIdentity;
	output: { prefix: string; edge?: RedactedUrl };
	/** Plan-derived topology. Observations are never allowed to define their own bar. */
	topology: { expectedChildCount: number; expectedChildIds?: string[] };
	master?: LiveEvidenceObject & { entries?: number };
	children: LiveEvidenceChild[];
	probes: LiveEvidenceProbe[];
	progression: { observed: boolean; detail: string };
	providerTerminal: {
		confirmed: boolean;
		encodingId?: string;
		status?: string;
		observedAt?: string;
		detail: string;
	};
	cleanup: {
		clean: boolean;
		queueDrained: boolean;
		processGone: boolean;
		/** The run's output is deliberately RETAINED — it is the evidence. */
		storageRetained: boolean;
		/** Static ingest has a temporary provider stream key; other ingests do not. */
		tokenCleanup: { required: boolean; confirmed: boolean; detail: string };
	};
	complete: boolean;
	missing: string[];
};

/** Everything but the verdict fields, which `liveEvidenceCompleteness` derives. */
export type LiveEvidenceLegInput = Omit<
	LiveEvidenceLeg,
	"complete" | "missing"
>;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const IMMUTABLE_IMAGE_ID = /(?:^|@)sha256:[0-9a-f]{64}$/i;
const PROVIDER_TERMINAL_STATUSES = new Set([
	"FINISHED",
	"ERROR",
	"CANCELED",
	"TRANSFER_ERROR",
	"NOT_FOUND",
]);

/**
 * A live destination prefix is an object-key prefix, not a URL. Normalise it
 * once and reject path traversal / query syntax so a persisted tuple cannot
 * make an unrelated URL look current by choosing a permissive marker.
 */
function currentRunPrefix(prefix: string): string | undefined {
	const normalized = prefix.replace(/^\/+/, "").replace(/\/+$/, "");
	const parts = normalized.split("/");
	if (
		normalized === "" ||
		parts.some(
			(part) =>
				part === "" ||
				part === "." ||
				part === ".." ||
				part.includes("\\") ||
				part.includes("?") ||
				part.includes("#"),
		)
	) {
		return undefined;
	}
	return `${normalized}/`;
}

/**
 * MSL media must be below the exact event-root + run prefix. The master alone
 * may remain at the direct event root; no other origin or sibling event path
 * can establish current-run attribution in the durable tuple.
 */
function edgeUrlUsesCurrentRun(
	url: Pick<RedactedUrl, "origin" | "path" | "queryKeys">,
	eventRoot: RedactedUrl,
	prefix: string,
): boolean {
	return (
		url.origin === eventRoot.origin &&
		url.queryKeys.length === 0 &&
		url.path.startsWith(`${eventRoot.path}${prefix}`)
	);
}

function edgePlaylistIsDirectEventRootObject(
	url: Pick<RedactedUrl, "origin" | "path" | "queryKeys">,
	eventRoot: RedactedUrl,
): boolean {
	if (
		url.origin !== eventRoot.origin ||
		url.queryKeys.length > 0 ||
		!url.path.startsWith(eventRoot.path)
	) {
		return false;
	}
	const relative = url.path.slice(eventRoot.path.length);
	return relative !== "" && !relative.includes("/");
}

function servedUrlUsesCurrentRun(
	value: string,
	eventRoot: RedactedUrl,
	prefix: string,
): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.username === "" &&
			url.password === "" &&
			url.search === "" &&
			url.hash === "" &&
			edgeUrlUsesCurrentRun(
				{ origin: url.origin, path: url.pathname, queryKeys: [] },
				eventRoot,
				prefix,
			)
		);
	} catch {
		return false;
	}
}

/**
 * Did media ADVANCE between two probes? A later media sequence on any child,
 * or a media identity served at the later probe that the earlier one did not
 * serve. Two probes that served the same set are a stalled — or template-
 * computed — edge, and that is exactly the "two identical snapshots" that must
 * not close a leg. Identity is by SERVED media, never by what a template would
 * address: a DASH template's addressable set grows with the clock alone.
 */
export function liveEvidenceProgression(
	first: LiveEvidenceProbe | undefined,
	last: LiveEvidenceProbe | undefined,
): { observed: boolean; detail: string } {
	if (!first || !last) {
		return {
			observed: false,
			detail:
				"fewer than two probes — progression cannot be observed from one snapshot",
		};
	}
	if (first.error || last.error) {
		return {
			observed: false,
			detail: `a probe failed: ${first.error ?? last.error}`,
		};
	}
	const firstIds = new Set(first.children.map((child) => child.id));
	const lastIds = new Set(last.children.map((child) => child.id));
	const missing = [...firstIds].filter((id) => !lastIds.has(id));
	const unexpected = [...lastIds].filter((id) => !firstIds.has(id));
	if (firstIds.size === 0 || missing.length > 0 || unexpected.length > 0) {
		return {
			observed: false,
			detail: `probe child topology changed — ${missing.length > 0 ? `missing at last probe: ${missing.join(", ")}` : "no child at first probe"}${unexpected.length > 0 ? `${missing.length > 0 ? "; " : ""}unexpected at last probe: ${unexpected.join(", ")}` : ""}`,
		};
	}
	const advances: string[] = [];
	const stalled: string[] = [];
	for (const before of first.children) {
		const child = last.children.find((candidate) => candidate.id === before.id);
		if (!child) {
			stalled.push(`${before.id}: missing at last probe`);
			continue;
		}
		if (
			before.mediaSequence !== undefined &&
			child.mediaSequence !== undefined &&
			child.mediaSequence > before.mediaSequence
		) {
			advances.push(
				`${child.id}: media sequence ${before.mediaSequence} → ${child.mediaSequence}`,
			);
			continue;
		}
		const seen = new Set(before.served);
		const fresh = child.served.find((id) => !seen.has(id));
		if (fresh !== undefined) {
			advances.push(
				`${child.id}: served ${fresh} at ${last.at}, not served at ${first.at}`,
			);
			continue;
		}
		stalled.push(`${child.id}: identical media served`);
	}
	return stalled.length === 0
		? { observed: true, detail: advances.join("; ") }
		: {
				observed: false,
				detail: `${stalled.join("; ")} between ${first.at} and ${last.at}`,
			};
}

/**
 * The completeness rule. Every element the audit's tuple names must be
 * POSITIVELY present; a missing element is named, never defaulted.
 */
export function liveEvidenceCompleteness(leg: LiveEvidenceLegInput): {
	complete: boolean;
	missing: string[];
} {
	const missing: string[] = [];
	if (leg.version !== LIVE_EVIDENCE_VERSION) {
		missing.push(
			`version: ${String(leg.version)} is not ${LIVE_EVIDENCE_VERSION}`,
		);
	}
	if (!leg.build.commit || leg.build.commit === "unknown") {
		missing.push("build.commit: the exact commit is unknown");
	}
	if (!leg.build.image || !IMMUTABLE_IMAGE_ID.test(leg.build.image)) {
		missing.push("build.image: no immutable sha256 image digest was recorded");
	}
	if (!SHA256_HEX.test(leg.build.planSha256)) {
		missing.push("build.planSha256: not a SHA-256");
	}
	if (!leg.source.location) {
		missing.push("source.location: no fed source recorded");
	}
	if (!leg.source.etag && !leg.source.versionId && !leg.source.generation) {
		missing.push(
			"source.etag/versionId/generation: no stable source version identity was read",
		);
	}
	if (!(typeof leg.source.size === "number" && leg.source.size > 0)) {
		missing.push("source.size: no positive fed-source size was recorded");
	}
	if (!leg.source.sha256 || !SHA256_HEX.test(leg.source.sha256)) {
		missing.push(
			"source.sha256: the bytes actually fed were not SHA-256 sealed",
		);
	}
	if (!leg.channel.channelId) {
		missing.push("channel.channelId");
	}
	if (!leg.channel.liveChannelRunId) {
		missing.push("channel.liveChannelRunId: the airing was not identified");
	}
	if (!leg.channel.providerEncodingId) {
		missing.push("channel.providerEncodingId: no provider encoding recorded");
	}
	for (const key of leg.channel.requiredProviderStreamKeys) {
		if (!leg.channel.providerStreamIds[key]) {
			missing.push(
				`channel.providerStreamIds.${key}: no exact provider stream id`,
			);
		}
	}
	for (const key of leg.channel.requiredProviderOutputKeys) {
		if (!leg.channel.providerOutputIds[key]) {
			missing.push(
				`channel.providerOutputIds.${key}: no exact provider output id`,
			);
		}
	}
	if (!leg.output.prefix) {
		missing.push("output.prefix");
	}
	const runPrefix = currentRunPrefix(leg.output.prefix);
	if (leg.role === "EDGE" && !runPrefix) {
		missing.push(
			"output.prefix: no valid relative current run prefix was recorded",
		);
	}
	if (leg.role === "EDGE" && !leg.output.edge) {
		missing.push("output.edge: no edge URL recorded for an edge leg");
	}
	if (leg.role === "EDGE") {
		if (!leg.msl) {
			missing.push("msl: no credential-safe MSL output identity was recorded");
		} else {
			const currentOutputId = leg.channel.providerOutputIds[leg.outputKey];
			if (leg.msl.outputKey !== leg.outputKey) {
				missing.push(
					`msl.outputKey: ${leg.msl.outputKey} is not evidence output ${leg.outputKey}`,
				);
			}
			if (!leg.msl.credentialId) {
				missing.push("msl.credentialId: no exact vault credential id");
			}
			if (
				!leg.msl.providerOutputId ||
				leg.msl.providerOutputId !== currentOutputId
			) {
				missing.push(
					`msl.providerOutputId: ${leg.msl.providerOutputId ?? "missing"} is not the current provider output ${currentOutputId ?? "missing"}`,
				);
			}
			if (!(Number.isSafeInteger(leg.msl.streamId) && leg.msl.streamId > 0)) {
				missing.push("msl.streamId: no positive integer stream id");
			}
			if (!leg.msl.eventName) {
				missing.push("msl.eventName: no event name");
			}
			if (!leg.msl.mslVersion) {
				missing.push("msl.mslVersion: no protocol version");
			}
			const expectedRoot = mslPlaybackEventPath(
				leg.msl.streamFormat,
				leg.msl.streamId,
				leg.msl.eventName,
			);
			if (leg.msl.eventRoot.path !== expectedRoot) {
				missing.push(
					`msl.eventRoot: ${leg.msl.eventRoot.path} is not ${expectedRoot}`,
				);
			}
			if (leg.msl.eventRoot.queryKeys.length > 0) {
				missing.push("msl.eventRoot: query-bearing event roots are not exact");
			}
			if (
				leg.output.edge &&
				(leg.output.edge.origin !== leg.msl.eventRoot.origin ||
					!leg.output.edge.path.startsWith(leg.msl.eventRoot.path))
			) {
				missing.push(
					"msl.eventRoot: the observed master is outside the bound event root",
				);
			}
			if (
				leg.output.edge &&
				runPrefix &&
				!edgePlaylistIsDirectEventRootObject(leg.output.edge, leg.msl.eventRoot)
			) {
				missing.push(
					"master.url: master must be an exact direct MSL event root object",
				);
			}
		}
	}
	if (!leg.master) {
		missing.push("master: the master playlist / MPD was not read");
	} else {
		if (!(leg.master.bytes > 0)) {
			missing.push("master.bytes: zero-length master");
		}
		if (leg.role === "EDGE" && !leg.master.sha256) {
			missing.push("master.sha256: edge master bytes were not hashed");
		}
		if (
			leg.role === "EDGE" &&
			leg.msl &&
			runPrefix &&
			leg.master.url &&
			!edgePlaylistIsDirectEventRootObject(leg.master.url, leg.msl.eventRoot)
		) {
			const reason =
				"master.url: master must be an exact direct MSL event root object";
			if (!missing.includes(reason)) missing.push(reason);
		}
	}
	if (leg.children.length === 0) {
		missing.push("children: no child playlist / representation was walked");
	}
	if (leg.children.length !== leg.topology.expectedChildCount) {
		missing.push(
			`topology: expected ${leg.topology.expectedChildCount} child playlist / representation(s), observed ${leg.children.length}`,
		);
	}
	for (const id of leg.topology.expectedChildIds ?? []) {
		if (!leg.children.some((child) => child.id === id)) {
			missing.push(`topology: required child ${id} was not observed`);
		}
	}
	for (const child of leg.children) {
		if (leg.role === "EDGE" && leg.msl && runPrefix) {
			if (!child.url) {
				missing.push(
					`children.${child.id}.url: no exact child URL was recorded`,
				);
			} else if (leg.kind === "HLS") {
				if (
					!edgePlaylistIsDirectEventRootObject(child.url, leg.msl.eventRoot)
				) {
					missing.push(
						`children.${child.id}.url: child playlist is not an exact direct MSL event root object`,
					);
				}
			} else if (
				!edgeUrlUsesCurrentRun(child.url, leg.msl.eventRoot, runPrefix)
			) {
				missing.push(
					`children.${child.id}.url: DASH representation evidence is outside the current run prefix ${runPrefix}`,
				);
			}
			for (const media of child.media) {
				if (!media.url) {
					missing.push(
						`children.${child.id}.media.${media.key}.url: no media URL was bound to the current run prefix`,
					);
				} else if (
					!edgeUrlUsesCurrentRun(media.url, leg.msl.eventRoot, runPrefix)
				) {
					missing.push(
						`children.${child.id}.media.${media.key}.url: media URL is outside the current run prefix ${runPrefix}`,
					);
				}
			}
			if (
				child.init &&
				(!child.init.url ||
					!edgeUrlUsesCurrentRun(child.init.url, leg.msl.eventRoot, runPrefix))
			) {
				missing.push(
					`children.${child.id}.init.url: init URL is outside the current run prefix ${runPrefix}`,
				);
			}
		}
		if (child.missing.length > 0) {
			missing.push(
				`children.${child.id}.missing: ${child.missing.length} referenced object(s) not served (first ${child.missing[0]})`,
			);
		}
		const witnessed = child.media.filter((m) => m.bytes > 0);
		if (witnessed.length === 0) {
			missing.push(
				`children.${child.id}.media: no nonzero media segment witnessed`,
			);
		}
		if (leg.role === "EDGE") {
			for (const m of witnessed) {
				if (!m.sha256) {
					missing.push(`children.${child.id}.media.${m.key}: bytes not hashed`);
					break;
				}
			}
		}
		if (child.requiresInit) {
			if (!child.init || !(child.init.bytes > 0)) {
				missing.push(
					`children.${child.id}.init: required init bytes not witnessed`,
				);
			} else if (
				leg.role === "EDGE" &&
				!SHA256_HEX.test(child.init.sha256 ?? "")
			) {
				missing.push(`children.${child.id}.init: bytes not hashed`);
			}
		}
	}
	if (leg.probes.length < 2) {
		missing.push(`probes: ${leg.probes.length} probe(s), two are required`);
	}
	if (leg.role === "EDGE" && leg.msl && runPrefix) {
		const eventRoot = leg.msl.eventRoot;
		for (const [probeIndex, probe] of leg.probes.entries()) {
			for (const child of probe.children) {
				if (child.served.length === 0) {
					missing.push(
						`probes.${probeIndex}.${child.id}.served: no media URL was bound to the current run prefix`,
					);
					continue;
				}
				if (
					child.served.some(
						(url) => !servedUrlUsesCurrentRun(url, eventRoot, runPrefix),
					)
				) {
					missing.push(
						`probes.${probeIndex}.${child.id}.served: media URL is outside the current run prefix ${runPrefix}`,
					);
				}
			}
		}
	}
	const derivedProgression = liveEvidenceProgression(
		leg.probes[0],
		leg.probes[leg.probes.length - 1],
	);
	if (!derivedProgression.observed) {
		missing.push(`progression: ${derivedProgression.detail}`);
	} else if (!leg.progression.observed) {
		missing.push(`progression: ${leg.progression.detail}`);
	}
	if (!leg.providerTerminal.confirmed) {
		missing.push(`providerTerminal: ${leg.providerTerminal.detail}`);
	}
	if (
		leg.providerTerminal.encodingId !== leg.channel.providerEncodingId ||
		!PROVIDER_TERMINAL_STATUSES.has(leg.providerTerminal.status ?? "") ||
		!leg.providerTerminal.observedAt ||
		Number.isNaN(Date.parse(leg.providerTerminal.observedAt))
	) {
		missing.push(
			"providerTerminal: exact encoding id, provider-terminal status and observation time were not joined",
		);
	}
	if (!leg.cleanup.clean) {
		missing.push("cleanup: the teardown seal is not clean");
	}
	if (!leg.cleanup.queueDrained) {
		missing.push("cleanup.queueDrained: not positively confirmed");
	}
	if (!leg.cleanup.processGone) {
		missing.push("cleanup.processGone: not positively confirmed");
	}
	if (!leg.cleanup.storageRetained) {
		missing.push(
			"cleanup.storageRetained: evidence objects were not confirmed retained",
		);
	}
	if (
		leg.cleanup.tokenCleanup.required &&
		!leg.cleanup.tokenCleanup.confirmed
	) {
		missing.push(`cleanup.tokenCleanup: ${leg.cleanup.tokenCleanup.detail}`);
	}
	return { complete: missing.length === 0, missing };
}

/** Attach the verdict to a leg input. */
export function sealLiveEvidenceLeg(
	leg: LiveEvidenceLegInput,
): LiveEvidenceLeg {
	return { ...leg, ...liveEvidenceCompleteness(leg) };
}

/**
 * The versioned SUMMARY that rides on a scenario outcome, the report and the
 * Dashboard row — the per-leg verdicts without the object lists.
 */
export type LiveEvidenceSummary = {
	version: typeof LIVE_EVIDENCE_VERSION;
	complete: boolean;
	legs: {
		outputLeg: string;
		role: "ORIGIN" | "EDGE";
		kind: "HLS" | "DASH";
		complete: boolean;
		missing: string[];
		children: number;
		mediaWitnessed: number;
		mediaBytes: number;
		probes: number;
		progression: string;
	}[];
};

export function summarizeLiveEvidence(
	legs: readonly LiveEvidenceLeg[],
): LiveEvidenceSummary {
	return {
		version: LIVE_EVIDENCE_VERSION,
		// A scenario with NO legs has no evidence — that is not "complete".
		complete: legs.length > 0 && legs.every((leg) => leg.complete),
		legs: legs.map((leg) => ({
			outputLeg: leg.outputLeg,
			role: leg.role,
			kind: leg.kind,
			complete: leg.complete,
			missing: leg.missing,
			children: leg.children.length,
			mediaWitnessed: leg.children.reduce(
				(n, c) => n + c.media.filter((m) => m.bytes > 0).length,
				0,
			),
			mediaBytes: leg.children.reduce(
				(n, c) => n + c.media.reduce((b, m) => b + m.bytes, 0),
				0,
			),
			probes: leg.probes.length,
			progression: leg.progression.detail,
		})),
	};
}

/**
 * Is a summary one a GREEN live outcome may carry? The seal gate and the
 * outcome gate both ask this — one rule.
 */
export function liveEvidenceSupportsPass(
	summary: LiveEvidenceSummary | undefined,
): { ok: true } | { ok: false; reason: string } {
	if (!summary) {
		return {
			ok: false,
			reason: "no live evidence tuple was recorded for this scenario",
		};
	}
	if (summary.version !== LIVE_EVIDENCE_VERSION) {
		return {
			ok: false,
			reason: `live evidence version ${String(summary.version)} is not ${LIVE_EVIDENCE_VERSION}`,
		};
	}
	if (summary.legs.length === 0) {
		return { ok: false, reason: "the live evidence tuple has no output leg" };
	}
	const incomplete = summary.legs.filter((leg) => !leg.complete);
	if (incomplete.length > 0) {
		const first = incomplete[0] as LiveEvidenceSummary["legs"][number];
		return {
			ok: false,
			reason: `${incomplete.length} of ${summary.legs.length} live evidence leg(s) incomplete — ${first.outputLeg}: ${first.missing[0] ?? "unspecified"}`,
		};
	}
	if (!summary.complete) {
		return {
			ok: false,
			reason:
				"the live evidence tuple parent is marked incomplete despite complete legs",
		};
	}
	return { ok: true };
}
