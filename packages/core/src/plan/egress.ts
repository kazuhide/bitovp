/**
 * Host allowlist for credential-EGRESS destinations (COVERAGE C22,  —
 * was #18 until the PR-7 merge made that row the auth gate).
 *
 * `secretEgressUrlSchema` already forces https and forbids URL userinfo, but
 * neither rail answers the question that actually matters: *is this host
 * allowed to receive our vault material at all*. The Bitmovin encoder POSTs the
 * decrypted Kantar login/password (and ESAM POIS credentials) to whatever host
 * the plan names, so "can author a plan" implies "can exfiltrate that vault
 * entry to a host of my choosing" — over https, which is exactly how an
 * attacker would want it.
 *
 * The allowlist is OPERATOR configuration, not a constant: the real Kantar and
 * POIS hostnames are per-contract and we refuse to guess them (a wrong built-in
 * list would either block legitimate deployments or, worse, look like
 * protection while permitting hosts nobody vetted). Hence the tri-state below —
 * the *caller* declares whether it is the enforcement point.
 */

import type { PlanIssue } from "./validate";

/**
 * How a caller opts into egress-host checking:
 *
 * - `undefined` — not the enforcement point (e.g. the client-side wizard
 *   preview, which cannot read server env). Nothing is emitted; staying silent
 *   beats showing a warning whose answer the caller does not have.
 * - `[]` — enforcement point, operator configured NO allowlist. Emits a
 *   WARNING per egress host: unrestricted, and the operator should know.
 * - non-empty — enforcement point with a list. Emits an ERROR for any host not
 *   on it.
 *
 * The empty array is deliberately not folded into `undefined`: "nobody asked"
 * and "the operator declined to restrict" are different facts and only one of
 * them deserves a warning.
 */
export type SecretEgressAllowlist = readonly string[] | undefined;

/**
 * One credential-egress destination found in a plan.
 * `field` is the dotted plan path, so an issue can point at the exact input.
 */
export type EgressSite = {
	field: string;
	url: string;
	/** What leaves the encoder for this host, named in operator terms. */
	carries: string;
};

/**
 * Allowlist entry syntax:
 * - `kantar.example.com` — that hostname exactly.
 * - `.example.com` — any SUBdomain of example.com, but NOT example.com itself.
 *   The apex is a separate entry on purpose: `.example.com` is usually written
 *   to cover per-tenant hosts, and silently including the apex would widen the
 *   grant beyond what the operator typed.
 *
 * Ports are not matched: the rail is about *who* receives the secret, and a
 * different port on an allowlisted host is the same operator's endpoint.
 */
/** Malformed allowlist configuration — distinct from "no allowlist". */
export class SecretEgressConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SecretEgressConfigError";
	}
}

/**
 * Strips ONE trailing dot. `kantar.example.com.` is a valid FQDN that
 * `secretEgressUrlSchema` accepts and `new URL.hostname` preserves, so
 * without this an allowlist entry differs from the operator's URL by one
 * near-invisible character and rejects it. It fails closed, but a FALSE
 * rejection is what makes an operator turn a rail off entirely (review catch).
 */
function stripRootDot(host: string): string {
	return host.endsWith(".") ? host.slice(0, -1) : host;
}

/**
 * Normalizes an allowlist entry the way `new URL.hostname` normalizes a URL's
 * host — which means punycode. An operator writing `exämple.com` would
 * otherwise never match anything, and the rejection message (naming
 * `xn--exmple-cua.com`) gives no hint why (review catch). A leading dot is
 * preserved: it is our suffix syntax, not part of the hostname.
 */
function normalizeEntry(entry: string): string {
	const trimmed = entry.trim().toLowerCase();
	if (trimmed === "" || trimmed === ".") {
		return "";
	}
	const suffix = trimmed.startsWith(".");
	const bare = suffix ? trimmed.slice(1) : trimmed;
	// Routing entries through `new URL` fixed IDN but made the entry side
	// inherit URL parsing: `example.com/evil` silently drops the path, and
	// `example.com@evil.net` silently GRANTS evil.net. Before normalization a
	// malformed entry matched nothing; now it would resolve to a host the
	// operator never typed. Same defect class as a value that lists no
	// hostnames, so it gets the same treatment — refuse, loudly (review catch).
	// A colon is allowed only inside a bracketed IPv6 literal, which is the one
	// legitimate reason an entry contains one (a port is never matched).
	const bracketedIpv6 = bare.startsWith("[") && bare.endsWith("]");
	const forbidden = bracketedIpv6 ? /[/@\s]/ : /[/@:\s]/;
	if (forbidden.test(bare)) {
		throw new SecretEgressConfigError(
			`SECRET_EGRESS_ALLOWED_HOSTS entry ${JSON.stringify(entry)} is not a ` +
				"hostname. Entries are bare hostnames (kantar.example.com), " +
				'".example.com" for subdomains, or a bracketed IPv6 literal ' +
				"([2001:db8::1]) — no scheme, path, userinfo or port.",
		);
	}
	let host: string;
	try {
		host = new URL(`https://${bare}`).hostname.toLowerCase();
	} catch {
		// Not a parsable host (a stray path, a space). Kept verbatim so it simply
		// never matches, rather than degrading into something broader.
		host = bare;
	}
	host = stripRootDot(host);
	return suffix ? `.${host}` : host;
}

/**
 * Exact-or-suffix host match (`.example.com` matches subdomains, never the
 * apex). Public API since the notify worker adopted it .
 * @throws SecretEgressConfigError on a malformed allowlist ENTRY (a path or
 * space inside it) — callers doing delivery must catch and refuse rather
 * than retry (review-183 N4/P2).
 */
export function hostMatches(hostname: string, entry: string): boolean {
	const host = stripRootDot(hostname.toLowerCase());
	const pattern = normalizeEntry(entry);
	if (pattern === "") {
		return false;
	}
	if (pattern.startsWith(".")) {
		return host.endsWith(pattern) && host.length > pattern.length;
	}
	return host === pattern;
}

/** Parses the hostname out of an egress URL, or null if it will not parse. */
function egressHostname(url: string): string | null {
	try {
		return stripRootDot(new URL(url).hostname.toLowerCase());
	} catch {
		return null;
	}
}

/**
 * Normalizes an operator-supplied allowlist (comma-separated env, UI list,
 * anything) into entries. Blank entries are dropped rather than treated as
 * match-nothing noise, so a trailing comma in env is not a silent hazard.
 */
export function parseSecretEgressAllowlist(raw: string | undefined): string[] {
	if (!raw || raw.trim() === "") {
		return [];
	}
	const entries = raw
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry !== "");
	if (entries.length === 0) {
		// Configured, yet yields nothing — e.g. `","`. Returning [] would look
		// exactly like "operator declined to restrict" and silently downgrade
		// enforcement from error to warning, so a typo would disable the rail
		// while the operator believed it was on (review catch). Fail loudly.
		throw new SecretEgressConfigError(
			"SECRET_EGRESS_ALLOWED_HOSTS is set but lists no hostnames " +
				`(got ${JSON.stringify(raw)}). Remove the variable to run ` +
				"unrestricted, or list the vendor hostnames you have vetted.",
		);
	}
	return entries;
}

/**
 * Appends the egress issues for `sites` to `issues`.
 *
 * Callers pass every egress site they can find in the plan; a site whose URL
 * does not parse is skipped here because the schema already rejected it (and
 * reporting it twice would make the real problem harder to see).
 */
export function checkSecretEgressHosts(
	sites: readonly EgressSite[],
	allowlist: SecretEgressAllowlist,
	issues: PlanIssue[],
): void {
	if (allowlist === undefined || sites.length === 0) {
		return;
	}
	for (const site of sites) {
		const hostname = egressHostname(site.url);
		if (hostname === null) {
			continue;
		}
		if (allowlist.length === 0) {
			issues.push({
				code: "PLAN_SECRET_EGRESS_HOST_UNRESTRICTED",
				level: "warning",
				path: site.field,
				message:
					`No egress allowlist is configured, so the encoder will send ${site.carries} to ` +
					`${hostname} on the strength of this plan alone. Set SECRET_EGRESS_ALLOWED_HOSTS ` +
					`to the vendor hostnames you have vetted; until then any plan author can choose ` +
					`where these credentials go.`,
			});
			continue;
		}
		const allowed = allowlist.some((entry) => hostMatches(hostname, entry));
		if (!allowed) {
			issues.push({
				code: "PLAN_SECRET_EGRESS_HOST_NOT_ALLOWED",
				level: "error",
				path: site.field,
				message:
					`${hostname} is not in SECRET_EGRESS_ALLOWED_HOSTS, and this field decides where ` +
					`the encoder sends ${site.carries}. Add the hostname to the allowlist if it is a ` +
					`vendor endpoint you have vetted (entries are exact hostnames, or ".example.com" ` +
					`for subdomains).`,
			});
		}
	}
}

/**
 * Thrown when a step would POST vault material to a host the operator has not
 * allowlisted. A failed encoding is the correct outcome here: the alternative
 * is sending the credentials.
 */
export class SecretEgressBlockedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SecretEgressBlockedError";
	}
}

/**
 * ENFORCEMENT AT THE POINT OF EGRESS — for the worker, the process that
 * actually POSTs the pair.
 *
 * Validating at plan submission is not enough, and it took a review to see why:
 * several routes replay an ALREADY-PERSISTED plan into the queue (job retry,
 * live-channel start/restart, capture-vmaf, live-to-vod) without revalidating
 * it. A plan authored while the allowlist was unset therefore reached the
 * encoder unchecked after the operator configured one — the rail was in force
 * and simply never consulted. Checking here covers every replay path that
 * exists or will exist, because they all converge on this code.
 *
 * `onWarning` receives the unrestricted-egress notice; the caller decides where
 * it goes (the worker logs it — it is the process doing the POST).
 */
export function assertSecretEgressAllowed(
	sites: readonly EgressSite[],
	allowlist: readonly string[],
	onWarning: (message: string) => void,
): void {
	const issues: PlanIssue[] = [];
	checkSecretEgressHosts(sites, allowlist, issues);
	const blocked = issues.filter((issue) => issue.level === "error");
	if (blocked.length > 0) {
		throw new SecretEgressBlockedError(
			blocked.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
		);
	}
	for (const issue of issues) {
		onWarning(`${issue.path}: ${issue.message}`);
	}
}

/**
 *  — the SAME trust decision as SECRET_EGRESS_ALLOWED_HOSTS,
 * applied to STORAGE endpoints: a GENERIC_S3 credential's `host` decides
 * where THIS SERVER connects with vault material (browse, inspect, watch
 * sweeps, verify). AWS/Akamai/OCI/GCS hosts are derived or anchored by
 * their schemas; GENERIC_S3 is the one free-endpoint provider, which is
 * exactly the SSRF reach C22 names for serverUrl/poisEndpoint.
 *
 * Same grammar as the secret-egress rail: variable unset = unrestricted
 * with a WARNING at the point of use (existing deployments keep working);
 * set = an unlisted host is refused; set-but-empty = loud config error.
 */
export function parseStorageEndpointAllowlist(
	raw: string | undefined,
): string[] {
	if (!raw || raw.trim() === "") {
		return [];
	}
	const entries = raw
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry !== "");
	if (entries.length === 0) {
		throw new SecretEgressConfigError(
			"STORAGE_ENDPOINT_ALLOWED_HOSTS is set but lists no hostnames " +
				`(got ${JSON.stringify(raw)}). Remove the variable to run ` +
				"unrestricted, or list the storage endpoints you have vetted.",
		);
	}
	return entries;
}

export class StorageEndpointBlockedError extends Error {
	constructor(host: string) {
		super(
			`${host} is not in STORAGE_ENDPOINT_ALLOWED_HOSTS, and this GENERIC_S3 ` +
				"credential decides where this server connects with vault material. " +
				"Add the hostname if it is an endpoint you have vetted (entries are " +
				'exact hostnames, or ".example.com" for subdomains).',
		);
		this.name = "StorageEndpointBlockedError";
	}
}

/**
 * Point-of-use check for a GENERIC_S3 host. `allowlist` semantics:
 * `undefined` = the deployment never configured the variable (unrestricted
 * — `onWarning` fires once per call site's discretion); `[]` cannot reach
 * here (the parser throws); otherwise membership via `hostMatches`.
 */
export function assertStorageEndpointAllowed(
	host: string,
	allowlist: readonly string[] | undefined,
	onWarning: (message: string) => void,
): void {
	if (allowlist === undefined || allowlist.length === 0) {
		onWarning(
			`No STORAGE_ENDPOINT_ALLOWED_HOSTS is configured, so this server will ` +
				`connect to ${host} on the strength of a stored credential alone. ` +
				"Set it to the storage endpoints you have vetted.",
		);
		return;
	}
	const hostname = host.toLowerCase();
	if (!allowlist.some((entry) => hostMatches(hostname, entry))) {
		throw new StorageEndpointBlockedError(host);
	}
}
