import type { PlaybackCorsVerdict } from "@bitovp/core";
import type { MessageKey } from "@/lib/i18n";

/** Server answer shape of `/api/encoding-jobs/[id]/playback-cors`. */
export type PlaybackCorsResult =
	| {
			supported: true;
			origin: string;
			bucket: string;
			verdict: PlaybackCorsVerdict;
	  }
	| {
			supported: false;
			origin: string;
			reason:
				| "DRIVER"
				| "FORBIDDEN"
				| "NO_BUCKET"
				| "NOT_FOUND"
				| "DECLARED_BASE";
	  };

export type PlaybackCorsContext = {
	kind: "HLS" | "DASH" | null;
	provider: "open-source" | "bitmovin";
};

/**
 * Renders a CORS diagnosis through the message catalogue, the same discipline
 * `playback-reason.ts` applies: the server returns the verdict as data, so
 * every case is a key and a new case is a typecheck error here.
 *
 * Returns null for `NOT_FOUND` — a job or manifest that vanished between
 * rendering the link and asking about it is not a CORS finding, and saying
 * anything about CORS then would be a guess.
 */
export function playbackCorsMessage(
	result: PlaybackCorsResult,
	context: PlaybackCorsContext,
): {
	key: MessageKey;
	values?: Record<string, string>;
	/** False when the verdict rules CORS out rather than implicating it. */
	implicated: boolean;
} | null {
	if (!result.supported) {
		switch (result.reason) {
			case "DECLARED_BASE":
				return { key: "playback.corsDeclaredBase", implicated: false };
			case "DRIVER":
				return { key: "playback.corsUnknownDriver", implicated: false };
			case "FORBIDDEN":
				return { key: "playback.corsUnknownForbidden", implicated: false };
			case "NO_BUCKET":
				return { key: "playback.corsUnknownNoBucket", implicated: false };
			case "NOT_FOUND":
				return null;
			default: {
				const exhaustive: never = result.reason;
				throw new Error(`Unknown reason ${String(exhaustive)}`);
			}
		}
	}
	switch (result.verdict.code) {
		case "OK":
			return { key: "playback.corsOk", implicated: false };
		case "NO_RULES":
			return { key: "playback.corsNoRules", implicated: true };
		case "ORIGIN_NOT_ALLOWED":
			return {
				key: "playback.corsOriginNotAllowed",
				values: { origin: result.verdict.origin },
				implicated: true,
			};
		case "RANGE_HEADER_NOT_ALLOWED":
			return {
				key: "playback.corsRangeHeaderNotAllowed",
				implicated: true,
			};
		case "MISSING_EXPOSE_HEADERS":
			if (context.provider === "open-source" && context.kind === "HLS") {
				return {
					key: "playback.corsMissingExposeHeadersAdvisory",
					// The hls.js path was measured with both segmented and byte-range
					// HLS. Missing exposed response headers did not prevent playback.
					implicated: false,
					values: { headers: result.verdict.headers.join(", ") },
				};
			}
			return {
				key: "playback.corsMissingExposeHeaders",
				// Header names, not prose — safe to join outside the catalogue.
				values: { headers: result.verdict.headers.join(", ") },
				/** Shaka and Bitmovin remain unmeasured for this header gap. */
				implicated: true,
			};
		default: {
			const exhaustive: never = result.verdict;
			throw new Error(`Unknown verdict ${JSON.stringify(exhaustive)}`);
		}
	}
}
