import type { AisaMediaFragment } from "./playback";

export interface AisaRecordingTimeline {
	fragments: AisaMediaFragment[];
	endList: boolean;
}

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_FRAGMENTS = 4096;
const MAX_VARIANT_DEPTH = 3;
const READ_TIMEOUT_MS = 20_000;
const UNAVAILABLE = "Recording timeline unavailable";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE_KEYS = [
	"bitmovinAccountId",
	"encodingId",
	"expectedOrganizationId",
] as const;
type ScopeKey = (typeof SCOPE_KEYS)[number];
type RecordingScope = Record<ScopeKey, string> & {
	origin: string;
	path: string;
};

function unavailable(): Error {
	return new Error(UNAVAILABLE);
}

function playlistLines(text: string): string[] {
	if (
		text.length > MAX_MANIFEST_BYTES ||
		new TextEncoder().encode(text).byteLength > MAX_MANIFEST_BYTES
	) {
		throw unavailable();
	}
	const lines = text.split(/\r?\n/);
	if (lines.shift() !== "#EXTM3U") throw unavailable();
	return lines.map((line) => line.trim()).filter(Boolean);
}

function isMasterTag(line: string): boolean {
	return /^#EXT-X-(?:STREAM-INF|I-FRAME-STREAM-INF|MEDIA|SESSION-DATA|SESSION-KEY)(?:$|:)/.test(
		line,
	);
}

function isTimelineTag(line: string): boolean {
	return /^#(?:EXTINF|EXT-X-(?:PROGRAM-DATE-TIME|GAP|DISCONTINUITY|ENDLIST))(?:$|:)/.test(
		line,
	);
}

function parseProgramDateTime(value: string): number {
	// Date.parse also accepts local times and normalizes invalid calendar dates.
	const match =
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
			value,
		);
	if (!match) throw unavailable();
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > (days[month - 1] ?? 0) ||
		Number(match[4]) > 23 ||
		Number(match[5]) > 59 ||
		Number(match[6]) > 59
	)
		throw unavailable();
	const pdt = Date.parse(value);
	if (!Number.isFinite(pdt)) throw unavailable();
	return pdt;
}

/** Reads declared timeline values only; segment, key and map URIs are discarded. */
export function parseAisaRecordingMediaPlaylist(
	text: string,
): AisaRecordingTimeline {
	const fragments: AisaMediaFragment[] = [];
	let start = 0;
	let nextPdt: number | null = null;
	let explicitPdt = false;
	let durationText: string | null = null;
	let gap = false;
	let endList = false;
	let needsPdt = false;
	for (const line of playlistLines(text)) {
		if (isMasterTag(line) || line === "#EXTM3U") throw unavailable();
		if (line === "#EXT-X-ENDLIST") {
			if (endList || durationText !== null || gap || explicitPdt || needsPdt) {
				throw unavailable();
			}
			endList = true;
		} else if (line.startsWith("#EXTINF:")) {
			if (endList || durationText !== null) throw unavailable();
			const value = /^#EXTINF:([0-9]+(?:\.[0-9]+)?),/.exec(line)?.[1];
			if (!value || !Number.isFinite(Number(value)) || Number(value) <= 0) {
				throw unavailable();
			}
			durationText = value;
		} else if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
			if (endList || explicitPdt) throw unavailable();
			nextPdt = parseProgramDateTime(
				line.slice("#EXT-X-PROGRAM-DATE-TIME:".length),
			);
			explicitPdt = true;
			needsPdt = false;
		} else if (line === "#EXT-X-DISCONTINUITY") {
			if (endList || durationText !== null || gap || explicitPdt) {
				throw unavailable();
			}
			nextPdt = null;
			needsPdt = true;
		} else if (line === "#EXT-X-GAP") {
			if (endList || gap) throw unavailable();
			gap = true;
		} else if (isTimelineTag(line)) {
			throw unavailable();
		} else if (!line.startsWith("#")) {
			if (endList || durationText === null || nextPdt === null) {
				throw unavailable();
			}
			if (fragments.length >= MAX_FRAGMENTS) throw unavailable();
			const duration = Number(durationText);
			const end = start + duration;
			const endPdt: number = nextPdt + duration * 1000;
			if (
				!Number.isFinite(end) ||
				!Number.isFinite(new Date(endPdt).getTime())
			) {
				throw unavailable();
			}
			fragments.push({
				start,
				duration,
				programDateTime: nextPdt,
				tagList: [["INF", durationText]],
				gap,
			});
			start = end;
			nextPdt = endPdt;
			explicitPdt = false;
			durationText = null;
			gap = false;
		}
	}
	if (
		fragments.length === 0 ||
		durationText !== null ||
		gap ||
		explicitPdt ||
		needsPdt
	) {
		throw unavailable();
	}
	return { fragments, endList };
}

function firstMasterVariant(text: string): string | null {
	const lines = playlistLines(text);
	if (!lines.some((line) => line.startsWith("#EXT-X-STREAM-INF:"))) {
		return null;
	}
	let pending = false;
	let first: string | null = null;
	for (const line of lines) {
		if (line === "#EXTM3U" || isTimelineTag(line)) {
			throw unavailable();
		}
		if (line.startsWith("#EXT-X-STREAM-INF:")) {
			if (pending) throw unavailable();
			pending = true;
		} else if (!line.startsWith("#")) {
			if (!pending) throw unavailable();
			if (first === null) first = line;
			pending = false;
		}
	}
	if (pending || first === null) throw unavailable();
	return first;
}

function hasExactQueries(url: URL, keys: readonly string[]): boolean {
	return (
		Array.from(url.searchParams.keys()).length === keys.length &&
		keys.every((key) => url.searchParams.getAll(key).length === 1)
	);
}

function sourceScope(value: string): { url: URL; scope: RecordingScope } {
	if (
		!value.startsWith("/") ||
		value.startsWith("//") ||
		/[\\#\s]/.test(value)
	) {
		throw unavailable();
	}
	const url = new URL(value, location.origin);
	const match = /^\/api\/live\/analyses\/([^/]+)\/recording$/.exec(
		url.pathname,
	);
	if (
		!match?.[1] ||
		!UUID.test(match[1]) ||
		value.split("?")[0] !== url.pathname ||
		!hasExactQueries(url, SCOPE_KEYS)
	) {
		throw unavailable();
	}
	const scope: RecordingScope = {
		origin: url.origin,
		path: url.pathname,
		bitmovinAccountId: url.searchParams.get("bitmovinAccountId") ?? "",
		encodingId: url.searchParams.get("encodingId") ?? "",
		expectedOrganizationId:
			url.searchParams.get("expectedOrganizationId") ?? "",
	};
	if (!SCOPE_KEYS.every((key) => UUID.test(scope[key]))) throw unavailable();
	return { url, scope };
}

function scopedVariant(value: string, base: URL, scope: RecordingScope): URL {
	if (/[\\#\s]/.test(value)) throw unavailable();
	const url = new URL(value, base);
	const token = url.searchParams.get("token") ?? "";
	if (
		url.origin !== scope.origin ||
		url.username ||
		url.password ||
		url.pathname !== `${scope.path}/media` ||
		!hasExactQueries(url, [...SCOPE_KEYS, "token"]) ||
		!SCOPE_KEYS.every((key) => url.searchParams.get(key) === scope[key]) ||
		!/^[A-Za-z0-9_-]+$/.test(token) ||
		token.length > 12_000
	) {
		throw unavailable();
	}
	return url;
}

async function readBoundedText(
	response: Response,
	signal: AbortSignal,
): Promise<string> {
	if (!response.body) throw unavailable();
	const reader = response.body.getReader();
	let cancelled = false;
	const cancel = () => {
		if (cancelled) return;
		cancelled = true;
		// A hostile stream may never finish cancellation; never await it.
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", cancel, { once: true });
	try {
		if (signal.aborted) cancel();
		signal.throwIfAborted();
		const declaredLength = response.headers.get("content-length");
		if (
			declaredLength !== null &&
			/^\d+$/.test(declaredLength) &&
			Number(declaredLength) > MAX_MANIFEST_BYTES
		) {
			cancel();
			throw unavailable();
		}
		const bytes = new Uint8Array(MAX_MANIFEST_BYTES);
		let length = 0;
		while (true) {
			signal.throwIfAborted();
			const chunk = await reader.read();
			signal.throwIfAborted();
			if (chunk.done) break;
			if (chunk.value.byteLength > MAX_MANIFEST_BYTES - length) {
				cancel();
				throw unavailable();
			}
			bytes.set(chunk.value, length);
			length += chunk.value.byteLength;
		}
		return new TextDecoder("utf-8", { fatal: true }).decode(
			bytes.subarray(0, length),
		);
	} finally {
		signal.removeEventListener("abort", cancel);
		reader.releaseLock();
	}
}

/** GETs only the scoped app recording proxy, following at most three variants. */
export async function readAisaRecordingTimeline(
	url: string,
	signal: AbortSignal,
): Promise<AisaRecordingTimeline> {
	signal.throwIfAborted();
	const controller = new AbortController();
	const abort = () => controller.abort(signal.reason);
	signal.addEventListener("abort", abort, { once: true });
	const timeout = setTimeout(
		() => controller.abort(new DOMException(UNAVAILABLE, "TimeoutError")),
		READ_TIMEOUT_MS,
	);
	try {
		const source = sourceScope(url);
		let current = source.url;
		const visited = new Set<string>();
		for (let depth = 0; depth <= MAX_VARIANT_DEPTH; depth++) {
			controller.signal.throwIfAborted();
			if (visited.has(current.href)) throw unavailable();
			visited.add(current.href);
			const response = await fetch(`${current.pathname}${current.search}`, {
				method: "GET",
				credentials: "same-origin",
				cache: "no-store",
				redirect: "error",
				signal: controller.signal,
			});
			if (!response.ok || response.redirected) {
				void response.body?.cancel().catch(() => {});
				throw unavailable();
			}
			const text = await readBoundedText(response, controller.signal);
			const variant = firstMasterVariant(text);
			if (variant === null) return parseAisaRecordingMediaPlaylist(text);
			current = scopedVariant(variant, current, source.scope);
		}
		throw unavailable();
	} catch {
		if (controller.signal.aborted) throw controller.signal.reason;
		// Network exceptions can include signed URLs; callers receive no raw details.
		throw unavailable();
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", abort);
	}
}
