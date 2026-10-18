import {
	type BrowserCredential,
	createBrowserForCredential,
} from "@bitovp/storage";
import type { ResolvedCredential } from "../orchestrator/executor";

/**
 * Per-title QC-mirror key resolution (P4 fix; over-counting fix).
 *
 * STANDARD renditions need no resolution here: the compiler's `qc/<key>.mp4`
 * mirror  lands at a LITERAL path (no placeholders), so `buildKeyMatcher` returns
 * null and `resolveDistortedKeys` hands back that one key verbatim — no listing,
 * no wildcard, nothing to over-count. For PER-TITLE renditions the muxing output
 * path carries `{height}`/`{bitrate}`/`{uuid}` placeholders (constraint C4); the
 * mirror inherits them, so `enumerateQcTargets` produces a path with LITERAL
 * `{…}` segments while Bitmovin wrote the file at the RESOLVED path — and
 * per-title writes one mirror per rung. The runner can't predict those values,
 * so it lists the bucket under the placeholder-free prefix and matches the real
 * key(s) by turning each placeholder SEGMENT into `[^/]+`.
 *
 * SCOPE GUARANTEE (over-counting fix, per-title only): the placeholder regex
 * (`[^/]+`) matches EVERY run's rungs ever written under that prefix — a re-run,
 * or a different job pointed at the same output base, leaves stale mirrors there
 * that the regex would happily score too. Bitmovin exposes no resolved per-rung
 * path for a per-title muxing (the muxing list/get returns the TEMPLATE; the
 * muxing "information" endpoint returns codec/track metadata, no path), so there
 * is no definitive resolved-paths source to scope by id. We instead scope by
 * TIME: `resolveDistortedKeys` takes a `modifiedSince` lower bound (this
 * encoding's createdAt) and drops any matched object written BEFORE it — a prior
 * run's mirrors were written earlier, and a re-run-as-new gets a later createdAt,
 * so the old job's files fall outside the window. Honest about its limits: it is
 * a time window, not an identity match (documented at the call site), and objects
 * whose `lastModified` is unknown are KEPT rather than silently dropped (fail
 * toward scoring a legitimate rung over discarding it).
 */

/** A resolved distorted object: its real key + a per-title rung discriminator. */
export type ResolvedDistorted = { key: string; variant?: string };

type KeyMatcher = {
	/** List prefix: the leading path before the first placeholder segment. */
	prefix: string;
	/** True when an actual object key matches the template's shape. */
	matches: (key: string) => boolean;
	/** The resolved value(s) of the placeholder segment(s), for the result row. */
	variant: (key: string) => string | undefined;
};

const RE_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const escapeRe = (s: string): string => s.replace(RE_SPECIAL, "\\$&");

/**
 * Build a matcher for a (possibly templated) output key. Returns null when the
 * key has no `{placeholder}` — the caller then downloads it verbatim. A segment
 * is treated as a placeholder if it contains `{`; the WHOLE segment becomes
 * `[^/]+` (so `{height}_{bitrate}_{uuid}` matches one resolved path segment),
 * keeping every literal segment exact.
 */
export function buildKeyMatcher(template: string): KeyMatcher | null {
	if (!template.includes("{")) {
		return null;
	}
	const segments = template.split("/");
	const firstPlaceholder = segments.findIndex((s) => s.includes("{"));
	const prefix =
		firstPlaceholder > 0
			? `${segments.slice(0, firstPlaceholder).join("/")}/`
			: "";
	const pattern = new RegExp(
		`^${segments
			.map((s) => (s.includes("{") ? "[^/]+" : escapeRe(s)))
			.join("/")}$`,
	);
	const placeholderIdx = segments
		.map((s, i) => (s.includes("{") ? i : -1))
		.filter((i) => i >= 0);
	return {
		prefix,
		matches: (key) => pattern.test(key),
		variant: (key) => {
			const parts = key.split("/");
			const resolved = placeholderIdx
				.map((i) => parts[i])
				.filter((p): p is string => p !== undefined);
			return resolved.length > 0 ? resolved.join("/") : undefined;
		},
	};
}

/** One listed object: its key plus the write time the scope filter reads. */
export type ListedObject = { key: string; lastModified?: string };

/**
 * Lists objects (key + lastModified) under a prefix — injectable so tests run
 * without storage. Carries `lastModified` so `resolveDistortedKeys` can drop
 * mirrors a PRIOR run wrote (the over-counting scope filter); a previous
 * signature returned bare keys, which discarded the write time.
 */
export type KeyLister = (args: {
	credential: ResolvedCredential;
	bucket: string;
	prefix: string;
}) => Promise<ListedObject[]>;

/** Page cap; a per-title qc/ tree is tiny, so hitting it means something is off. */
const MAX_LIST_PAGES = 2000;

/**
 * Default lister: pages browser.listObjects RECURSIVELY (no `/` delimiter) under
 * the prefix, so the per-title `…/<rung>/qc/<key>.mp4` objects nested below the
 * placeholder-free prefix actually come back (a delimited list would only return
 * the rung folders as prefixes). Throws if the page cap is hit while more pages
 * remain — a silent truncation would score a SUBSET of rungs.
 */
export const defaultKeyLister: KeyLister = async (args) => {
	const browser = createBrowserForCredential({
		provider: args.credential.provider as BrowserCredential["provider"],
		config: args.credential.config,
		secret: args.credential.secret,
	});
	try {
		const objects: ListedObject[] = [];
		let cursor: string | undefined;
		let exhausted = false;
		for (let page = 0; page < MAX_LIST_PAGES; page++) {
			const res = await browser.listObjects({
				bucket: args.bucket,
				prefix: args.prefix,
				cursor,
				limit: 100,
				recursive: true,
			});
			for (const o of res.objects) {
				// Carry lastModified through (it was discarded before) so the scope
				// filter in resolveDistortedKeys can exclude a prior run's mirrors.
				objects.push({ key: o.key, lastModified: o.lastModified });
			}
			if (!res.nextCursor) {
				exhausted = true;
				break;
			}
			cursor = res.nextCursor;
		}
		if (!exhausted) {
			throw new Error(
				`qc-mirror listing under "${args.prefix}" exceeded ${MAX_LIST_PAGES} pages — too many objects to scan`,
			);
		}
		return objects;
	} finally {
		browser.dispose?.();
	}
};

/**
 * Resolve a distorted path template to the actual object key(s). A non-templated
 * path returns itself (one key, no variant). A templated path lists the bucket
 * and returns every matching key (one per per-title rung); throws if none match
 * (the encoding never wrote the mirror).
 *
 * `modifiedSince` (this encoding's createdAt, ISO-8601) scopes a templated match
 * to THIS run: an object whose `lastModified` is strictly EARLIER is a prior
 * run's leftover under the same output base and is dropped (the over-counting
 * fix). Objects with an unknown `lastModified` are KEPT (can't prove staleness
 * → don't silently drop a legitimate rung). Omitting the bound preserves the old
 * unscoped behavior (every match, e.g. tests that inject a fake lister).
 */
export async function resolveDistortedKeys(
	lister: KeyLister,
	credential: ResolvedCredential,
	bucket: string,
	template: string,
	modifiedSince?: string,
): Promise<ResolvedDistorted[]> {
	const matcher = buildKeyMatcher(template);
	if (!matcher) {
		return [{ key: template }];
	}
	const objects = await lister({ credential, bucket, prefix: matcher.prefix });
	const inScope = (o: ListedObject): boolean => {
		// No lower bound, or no write time to compare → keep (fail toward scoring).
		if (modifiedSince === undefined || o.lastModified === undefined) {
			return true;
		}
		// ISO-8601 timestamps compare correctly as strings; a numeric Date compare
		// is robust to differing precision/offset, so use that.
		return (
			new Date(o.lastModified).getTime() >= new Date(modifiedSince).getTime()
		);
	};
	const matched = objects
		.filter((o) => matcher.matches(o.key))
		.filter(inScope)
		.sort((a, b) => a.key.localeCompare(b.key))
		.map((o) => ({ key: o.key, variant: matcher.variant(o.key) }));
	if (matched.length === 0) {
		throw new Error(
			`per-title qc mirror: no object under "${matcher.prefix}" matched the template "${template}"${
				modifiedSince ? ` and was written at/after ${modifiedSince}` : ""
			} — the encoding did not write the mirror (or wrote it elsewhere)`,
		);
	}
	return matched;
}
