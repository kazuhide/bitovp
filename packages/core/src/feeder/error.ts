import {
	describeMediaDifferences,
	MEDIA_ATTRIBUTE_NAMES,
} from "../live/media-attributes";
import {
	SLATE_CONTAINER_ATTRIBUTE,
	SLATE_KIND_ATTRIBUTE,
	SLATE_POSITION_ATTRIBUTE,
	type SlateDifference,
} from "../live/slate-compat";

/**
 * Structured refusal errors for the live INGEST gates .
 *
 * The feeder's source-compatibility gate (#239), the ingest-satisfaction check
 * (#46) and the slate insert-match check write operator-facing refusal text
 * into `FeederSession.error` / `LiveSchedule.error`, which the live panels
 * render verbatim right beside translated copy. Authored as RAW ENGLISH, that
 * text was the one safety-critical string the panels never localized — the
 * "panel is fully localized" bar the QC gate set, failed .
 *
 * So the writers store a stable CODE plus interpolation PARAMS as JSON, and the
 * panel translates at render. New per-attribute details remain structured so
 * attribute labels and planned normalization can localize without parsing
 * prose. Technical values stay unchanged. Unusable optional details fall back
 * to validated code/params; old prose is not parsed or migrated.
 *
 * A legacy row — anything written before this landed, and any writer that still
 * emits a plain sentence — is a non-JSON (or non-code) string: `parseFeederError`
 * returns `null`; customer panels use generic copy, ADMIN retains diagnostics.
 * The parse gates on the KNOWN code set, so a stored English sentence that
 * merely happens to be valid JSON (it never is — they are prose) could not be
 * mistaken for a structured payload.
 */

/**
 * Every refusal code a writer may emit. The render maps each to a
 * `feederError.<code>` catalogue key; the two must move together.
 *
 * - `ingestUnsatisfied` — #46, the source cannot serve the channel's declared
 *   ingest (a missing media type, or a second position the feeder cannot push).
 *   `detail` carries the problem clauses.
 * - `sourceMismatch` — #239, a live switch whose attributes differ from what
 *   the run is ingesting; the encoder would warn and drop the input.
 *   `originKind` names WHAT it is compared against; `differences` the diff.
 * - `slatePosition` — a slate clip without video at stream position 0.
 *   `found` names what sits there instead.
 * - `slateMismatch` — a slate clip whose attributes differ from the live
 *   stream; the insert would fail at air time. `differences` carries the diff.
 * - `slateImage` — a still-image slate (C36): app registration remains
 *   disabled despite provider JPG/PNG measurements. No params.
 */
export const FEEDER_ERROR_CODES = [
	"ingestUnsatisfied",
	"sourceMismatch",
	"slatePosition",
	"slateMismatch",
	"slateImage",
] as const;
export type FeederErrorCode = (typeof FEEDER_ERROR_CODES)[number];

/** Which reference a `sourceMismatch` compared the incoming push against. */
export const FEEDER_ERROR_ORIGIN_KINDS = ["runSource", "heartbeat"] as const;
export type FeederErrorOriginKind = (typeof FEEDER_ERROR_ORIGIN_KINDS)[number];

/** Flat interpolation values — everything the catalogue sentence needs. */
export type FeederErrorParams = Record<string, string | number>;

export type FeederErrorPayload = {
	code: FeederErrorCode;
	params: FeederErrorParams;
	/** Optional typed detail; old params.differences prose is still readable. */
	differences?: readonly SlateDifference[];
};

const KNOWN_CODES = new Set<string>(FEEDER_ERROR_CODES);

function differenceEnglish(
	code: FeederErrorCode,
	differences: readonly SlateDifference[],
): string {
	// Report-only slate attributes do not imply a transcoding operation.
	return describeMediaDifferences(
		code === "sourceMismatch"
			? differences
			: differences.map((d) => ({ ...d, blocking: true })),
	);
}

/**
 * Serialize a refusal for storage in the `error` column. The result is a JSON
 * string; `redactSecrets` runs over it downstream and is a no-op (the params
 * carry attribute diffs and reference kinds, never keys or passphrases).
 */
export function feederError(
	code: FeederErrorCode,
	params: FeederErrorParams = {},
	differences?: readonly SlateDifference[],
): string {
	// Keep old readers useful during a rolling deploy; current readers prefer
	// typed data. Never parse or rewrite a caller's legacy freeform string.
	return JSON.stringify({
		code,
		params: differences
			? { ...params, differences: differenceEnglish(code, differences) }
			: params,
		...(differences ? { differences } : {}),
	} satisfies FeederErrorPayload);
}

/**
 * Read a stored `error` back. Returns the structured payload for a JSON string
 * carrying a KNOWN code, and `null` for everything else — a legacy plain
 * sentence, an unparseable string, or JSON of the wrong shape — which the
 * caller renders verbatim (the documented fallback).
 */
export function parseFeederError(stored: string): FeederErrorPayload | null {
	// Cheap reject for the overwhelmingly common legacy case (a prose sentence
	// never starts with `{`) — avoids a throw-and-catch per render.
	if (stored.length === 0 || stored[0] !== "{") {
		return null;
	}
	let value: unknown;
	try {
		value = JSON.parse(stored);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const code = (value as { code?: unknown }).code;
	if (typeof code !== "string" || !KNOWN_CODES.has(code)) {
		return null;
	}
	const rawParams = (value as { params?: unknown }).params;
	const params: FeederErrorParams = {};
	if (
		typeof rawParams === "object" &&
		rawParams !== null &&
		!Array.isArray(rawParams)
	) {
		for (const [key, item] of Object.entries(rawParams)) {
			if (typeof item === "string" || typeof item === "number") {
				params[key] = item;
			}
		}
	}
	const rawDifferences = (value as { differences?: unknown }).differences;
	if (rawDifferences !== undefined) {
		const names = new Set<string>([
			...MEDIA_ATTRIBUTE_NAMES,
			SLATE_CONTAINER_ATTRIBUTE,
			SLATE_KIND_ATTRIBUTE,
			SLATE_POSITION_ATTRIBUTE,
		]);
		if (
			!Array.isArray(rawDifferences) ||
			!rawDifferences.every(
				(d) =>
					typeof d === "object" &&
					d !== null &&
					!Array.isArray(d) &&
					names.has(d.attribute) &&
					typeof d.reference === "string" &&
					typeof d.candidate === "string" &&
					typeof d.blocking === "boolean",
			)
		)
			// Optional detail can come from a newer writer. Preserve the known
			// envelope and legacy prose rather than leaking JSON to notifications.
			return { code: code as FeederErrorCode, params };
		return {
			code: code as FeederErrorCode,
			params,
			differences: rawDifferences.map(
				({ attribute, reference, candidate, blocking }) => ({
					attribute,
					reference,
					candidate,
					blocking,
				}),
			),
		};
	}
	return { code: code as FeederErrorCode, params };
}

/**
 * The DEFAULT-LOCALE (English) sentence for a stored refusal — for the
 * NOTIFICATION surfaces that have no locale at write time :
 * the Slack body, the SCHEDULE_MISSED event, the schedule-outcome note. These
 * were built for the old English sentence, so a `{code, params}` JSON stored in
 * `error` would surface as raw JSON there.
 *
 * The DB `error` column keeps the STRUCTURED value (the panels localize it) —
 * only the notification path renders English through here. A legacy plain
 * string returns unchanged; a recognized payload with unusable params falls
 * back to generic prose, like the panel's `feederErrorMessage`.
 *
 * These templates and origin phrases are the same English the web `en.ts`
 * `feederError.*` catalogue holds; a web test pins the two against each other
 * so the one English truth cannot drift across the two files.
 */
const EN_ORIGIN: Record<FeederErrorOriginKind, string> = {
	runSource: "the source this run started on",
	heartbeat: "the encoder's last heartbeat",
};

const EN_INTERNAL_FAILURE =
	"The file input could not continue. Ask an administrator to review Diagnostics.";

const EN_TEMPLATES: Record<FeederErrorCode, string> = {
	ingestUnsatisfied:
		"Source cannot satisfy the channel's ingest: {detail}. The encoder would accept the connection and publish nothing.",
	sourceMismatch:
		"Source does not match what this channel is ingesting ({origin}) — the encoder would warn on the attribute change and drop the input, leaving the playlist advancing on a frozen picture:\n{differences}",
	slatePosition:
		"Slate clip does not match the live stream: Bitmovin requires the video stream at stream position 0, and this file carries {found} there. The content would register as READY and then fail at insert time.",
	slateMismatch:
		"Slate clip does not match the live stream, so the insert would fail at air time even though the content registers as READY:\n{differences}",
	slateImage:
		"The still-image slate could not be registered. Use a JPG or PNG and set a display duration when inserting.",
};

/** `{name}` interpolation identical to the web catalogue's `translate`. */
function interpolate(template: string, params: FeederErrorParams): string {
	return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
		const value = params[name];
		if (value === undefined) {
			throw new Error(`[feederError] no value for {${name}}`);
		}
		return String(value);
	});
}

/**
 * Render `stored` as the default-locale English sentence. Mirrors the web
 * `feederErrorMessage` exactly — same origin resolution, same interpolation,
 * same generic-error fallback — so the two never disagree on what the
 * operator reads.
 */
export function feederErrorEnglish(stored: string): string {
	const parsed = parseFeederError(stored);
	if (!parsed) {
		return stored;
	}
	try {
		const params: FeederErrorParams = { ...parsed.params };
		if (parsed.differences)
			params.differences = differenceEnglish(parsed.code, parsed.differences);
		if (parsed.code === "sourceMismatch") {
			// The reference kind is a code, not prose — resolve it before
			// interpolating, mirroring the panel's origin lookup.
			const kind = params.originKind;
			if (typeof kind !== "string" || !Object.hasOwn(EN_ORIGIN, kind)) {
				return EN_INTERNAL_FAILURE;
			}
			params.origin = EN_ORIGIN[kind as FeederErrorOriginKind];
			delete params.originKind;
		}
		return interpolate(EN_TEMPLATES[parsed.code], params);
	} catch {
		return EN_INTERNAL_FAILURE;
	}
}
