/**
 * `publicBaseUrls` — the operator's declaration of where a bucket is served
 * from publicly, stored on the non-secret `Credential.config` JSON:
 *
 *   { "region": "ap-northeast-1",
 *     "publicBaseUrls": { "my-output-bucket": "https://cdn.example.com/vod" } }
 *
 * Keys are bucket names (for `AZURE_BLOB`, container names — matching the plan
 * output schema's own field). Declaring publicness beats inferring it: it is
 * the only way to express a public Azure container (there is no per-blob ACL),
 * it covers a CDN or custom domain in front of the bucket, and it makes the
 * intent explicit instead of implied by an ACL enum.
 *
 * Deliberately dependency-free: both the credential zod schemas and the
 * playback URL builder consume it, and a cycle between those two would be the
 * only other way to share it.
 */

/** The map as stored. Values are bases, without a trailing slash. */
export type PublicBaseUrls = Record<string, string>;

/**
 * A usable base: absolute, http(s), free of query/fragment — both of which
 * would land *before* the appended object path and silently break every URL
 * built from it — and free of URL userinfo (see below). Trailing slashes are
 * tolerated and stripped.
 */
export function normalizeBaseUrl(raw: unknown): string | null {
	if (typeof raw !== "string" || raw.trim().length === 0) {
		return null;
	}
	const trimmed = raw.trim();
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		return null;
	}
	/**
	 * Guard the RAW string, not the parsed components. WHATWG `URL` reports
	 * `search === ""` for a bare trailing `?` and `hash === ""` for a bare `#`,
	 * so the parsed check passed them — and `https://cdn.x/vod#` turns the whole
	 * appended object path into a fragment: the browser fetches `/vod`.
	 */
	if (/[?#]/.test(trimmed)) {
		return null;
	}
	/**
	 * No URL userinfo, for the same reason `secretEgressUrlSchema` refuses it
	 * (`plan/schema.ts:53`): a credential entering by THIS door would sit in
	 * plaintext in `Credential.config`, which is stored raw *because* it is
	 * non-secret by construction. And this value now has more sinks than that
	 * one — it becomes a `<video src>` mounted automatically on the job and
	 * channel pages, and the text a Copy button puts on the clipboard.
	 */
	if (parsed.username !== "" || parsed.password !== "") {
		return null;
	}
	/**
	 * Return a value derived from `parsed`, never the raw input.
	 *
	 * Every check above ran against `parsed` while the old code returned
	 * `trimmed` — validate one form, use another. The string an operator reads,
	 * copies and hands to a player could therefore name a different host than
	 * the one fetched, and since HLS/DASH resolve every segment URI relative to
	 * the manifest, one deceptive base redirects the whole segment chain. All
	 * three of these were accepted and flagged fully playable:
	 *
	 *   https://cdn.example.com%2f@evil.tld/vod   → resolves to evil.tld
	 *   https://evil.tld\@cdn.example.com/vod     → resolves to evil.tld
	 *   https://аpple.com/vod  (Cyrillic а)       → xn--pple-43d.com, shown as apple
	 *
	 * `parsed.origin` collapses the backslash-authority forms, drops userinfo and
	 * emits punycode, so what is displayed is what will be fetched.
	 */
	return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
}

export const BASE_URL_HINT =
	"Must be an absolute http(s) URL with no query, fragment or user:password (e.g. https://cdn.example.com/vod)";

/**
 * Reads the map off a credential config, dropping anything unusable. Rows can
 * be edited straight in Postgres — the design says as much, since the form
 * field is the *convenience* — so this never trusts the shape it finds.
 */
export function readPublicBaseUrls(
	config: Record<string, unknown> | undefined,
): PublicBaseUrls {
	// `Object.hasOwn`, not a bare read: the map this builds is null-prototype, but the
	// LOOKUP producing it was not, so an *inherited* `publicBaseUrls` would have been
	// honoured. Unreachable today — Prisma Json arrives through `JSON.parse`, which
	// yields own properties only — so this is defence in depth at the one place the
	// rest of this file already guards (review suggestion).
	const raw =
		config && Object.hasOwn(config, "publicBaseUrls")
			? config.publicBaseUrls
			: undefined;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return {};
	}
	/**
	 * NULL-PROTOTYPE, because bucket names are attacker-adjacent keys. `constructor`
	 * is a valid S3 bucket name, and on a `{}` literal `map["constructor"]` returns
	 * `Function.prototype.constructor` — a function, which then fails
	 * `normalizeBaseUrl` and reports `MISSING_BASE_URL` for a bucket that simply has
	 * no declared base. Every prototype key has the same problem.
	 */
	const out: PublicBaseUrls = Object.create(null) as PublicBaseUrls;
	for (const [bucket, base] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof base === "string") {
			out[bucket] = base;
		}
	}
	return out;
}

/** One `bucket = base` per line — the credential form's text representation. */
export function formatPublicBaseUrls(
	map: PublicBaseUrls | undefined | null,
): string {
	if (!map) {
		return "";
	}
	return Object.entries(map)
		.map(([bucket, base]) => `${bucket} = ${base}`)
		.join("\n");
}

export type ParsedPublicBaseUrls =
	| { ok: true; value: PublicBaseUrls | undefined }
	| { ok: false; error: string };

/**
 * Parses the textarea back into the map. Bucket names cannot contain `=` or
 * whitespace, so either separator splits a line unambiguously; blank text
 * yields `undefined` so the field is omitted from the payload entirely rather
 * than stored as an empty object.
 */
export function parsePublicBaseUrls(text: string): ParsedPublicBaseUrls {
	const value: PublicBaseUrls = {};
	let count = 0;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i]?.trim() ?? "";
		if (line.length === 0) {
			continue;
		}
		const at = `line ${i + 1}`;
		// `=` with any spacing around it, else the first whitespace run. The
		// `\s*=\s*` alternative must come first: on "a = url" the regex engine
		// tries it at the space and consumes " = ", where a bare `\s+` would
		// stop at the space and leave "= url" as the value.
		const split = /\s*=\s*|\s+/.exec(line);
		if (!split || split.index === 0) {
			return {
				ok: false,
				error: `${at}: expected "bucket = https://host/base", got "${line}"`,
			};
		}
		const bucket = line.slice(0, split.index).trim();
		const base = normalizeBaseUrl(line.slice(split.index + split[0].length));
		if (!base) {
			return { ok: false, error: `${at} (${bucket}): ${BASE_URL_HINT}` };
		}
		if (value[bucket] !== undefined) {
			return { ok: false, error: `${at}: "${bucket}" is listed twice` };
		}
		value[bucket] = base;
		count += 1;
	}
	return { ok: true, value: count > 0 ? value : undefined };
}
