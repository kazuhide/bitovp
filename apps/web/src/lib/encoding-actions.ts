import { z } from "zod";

/**
 * Wire contracts for the three ENCODING RUNTIME actions on a VOD job
 * (transfer-retry / reprioritize / reschedule). Shared by the routes and the job
 * detail's "Encoding actions (advanced)" group so the form bounds and the
 * server's 400 boundary are one definition.
 *
 * Client-safe (no `server-only`, no SDK import): the SDK is server-side only, so
 * the few enum/bounds facts it carries are mirrored here with the SDK version
 * they came from — the same convention as `lib/infrastructure/schemas.ts`.
 */

/**
 * `Encoding.priority` — 0..100, SDK/API default 50 (higher runs first among an
 * organisation's queued encodings). @bitmovin/api-sdk 1.269.0.
 */
export const ENCODING_PRIORITY_MIN = 0;
export const ENCODING_PRIORITY_MAX = 100;
export const ENCODING_PRIORITY_DEFAULT = 50;

export const reprioritizeSchema = z.strictObject({
	priority: z
		.number()
		.int("priority must be a whole number")
		.min(ENCODING_PRIORITY_MIN, "priority must be at least 0")
		.max(ENCODING_PRIORITY_MAX, "priority must be at most 100"),
});

/**
 * `RescheduleEncodingRequest` carries **only** `infrastructureId` (verified in
 * dist/models/RescheduleEncodingRequest.d.ts, @bitmovin/api-sdk 1.269.0): there
 * is no date/time field anywhere on it. "Reschedule" therefore means **MOVE the
 * encoding to a different Cloud Connect (BYOC) infrastructure**, NOT "run it
 * later" — the UI must never present it as a time-based reschedule.
 */
export const rescheduleSchema = z.strictObject({
	infrastructureId: z.uuid("infrastructureId must be a Bitmovin resource UUID"),
});
