import {
	type LiveToVodRecord as CoreLiveToVodRecord,
	type LiveToVodErrorCode,
	type LiveToVodFamilyRecord,
	type LiveToVodManifest,
	type LiveToVodStatus,
	liveToVodErrorCodeSchema,
	liveToVodFamilySchema,
	liveToVodReasonCodeSchema,
	normalizeLiveToVodRecord,
} from "@bitovp/core";
import { z } from "zod";

/**
 * The server adds this marker only after it has normalized an internal DB
 * record and removed provider identities. It lets the browser validate the
 * deliberately narrower public DTO without mistaking missing private fields
 * for a corrupt provider record.
 *
 * A value stored in the JSON column cannot forge this boundary:
 * `liveToVodForRole` first reconstructs the record with core's allow-listing
 * normalizer, which drops unknown properties, and only then adds this marker.
 */
export const LIVE_TO_VOD_PUBLIC_PROJECTION = "PUBLIC_V1" as const;

const publicCleanupBaseSchema = z.object({
	requestedAt: z.string().min(1),
	errorCode: liveToVodErrorCodeSchema.optional(),
});

const publicCleanupSchema = z.discriminatedUnion("status", [
	publicCleanupBaseSchema
		.extend({ status: z.literal("DELETE_PENDING") })
		.strict(),
	publicCleanupBaseSchema
		.extend({
			status: z.literal("DELETE_CONFIRMED"),
			confirmedAt: z.string().min(1),
		})
		.strict(),
]);

const publicFamilyBaseSchema = z.object({ type: liveToVodFamilySchema });

/**
 * Public counterpart of core's status-discriminated family schema. Provider
 * identity, create intent, cleanup provider id and technical prose are not
 * optional here: they are forbidden by `.strict`. The remaining customer
 * fields still prove the lifecycle claim (FINISHED always has id + URL,
 * SKIPPED always has a stable reason, and ERROR always has a stable code).
 */
export const publicLiveToVodFamilySchema = z.discriminatedUnion("status", [
	publicFamilyBaseSchema.extend({ status: z.literal("PENDING") }).strict(),
	publicFamilyBaseSchema
		.extend({
			status: z.literal("CREATED"),
			manifestId: z.string().min(1),
		})
		.strict(),
	publicFamilyBaseSchema
		.extend({
			status: z.literal("RUNNING"),
			manifestId: z.string().min(1),
		})
		.strict(),
	publicFamilyBaseSchema
		.extend({
			status: z.literal("FINISHED"),
			manifestId: z.string().min(1),
			url: z.string().min(1),
		})
		.strict(),
	publicFamilyBaseSchema
		.extend({
			status: z.literal("ERROR"),
			errorCode: liveToVodErrorCodeSchema,
			manifestId: z.string().min(1).optional(),
			url: z.string().min(1).optional(),
			cleanup: publicCleanupSchema.optional(),
		})
		.strict(),
	publicFamilyBaseSchema
		.extend({
			status: z.literal("SKIPPED_UNSUPPORTED"),
			reasonCode: liveToVodReasonCodeSchema,
		})
		.strict(),
]);

export type PublicLiveToVodFamily = z.infer<typeof publicLiveToVodFamilySchema>;

/** The panel consumes only this common, provider-safe family surface. */
export type LiveToVodFamilyView = LiveToVodFamilyRecord | PublicLiveToVodFamily;

export type LiveToVodViewRecord = Omit<CoreLiveToVodRecord, "families"> & {
	families?: LiveToVodFamilyView[];
	projection?: typeof LIVE_TO_VOD_PUBLIC_PROJECTION;
};

function derivePublicStatus(
	families: readonly PublicLiveToVodFamily[],
): LiveToVodStatus {
	const outcomes = families.filter(
		(family) => family.status !== "SKIPPED_UNSUPPORTED",
	);
	if (
		outcomes.some(
			(family) =>
				family.status === "PENDING" ||
				family.status === "CREATED" ||
				family.status === "RUNNING",
		)
	) {
		return "RUNNING";
	}
	const finished = outcomes.filter(
		(family) => family.status === "FINISHED",
	).length;
	const failed = outcomes.filter((family) => family.status === "ERROR").length;
	if (finished > 0 && failed === 0) {
		return "FINISHED";
	}
	if (finished > 0) {
		return "PARTIAL";
	}
	return "ERROR";
}

function publicManifests(
	families: readonly PublicLiveToVodFamily[],
): LiveToVodManifest[] {
	return families.flatMap((family) =>
		family.status === "FINISHED"
			? [
					{
						type: family.type,
						manifestId: family.manifestId,
						url: family.url,
					},
				]
			: [],
	);
}

function text(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	return typeof record[key] === "string" ? (record[key] as string) : undefined;
}

/**
 * Browser boundary for the role-projected API record.
 *
 * Legacy records (families absent) keep core's historical compatibility. A
 * new public record is accepted only with the server marker and a wholly
 * valid, duplicate-free family array. Any invalid/null/unknown/duplicate
 * entry invalidates the overall verdict; raw `manifests` are never trusted
 * and are always reconstructed from valid FINISHED families.
 */
export function normalizeLiveToVodView(
	raw: unknown,
): LiveToVodViewRecord | null {
	if (raw === null || typeof raw !== "object") {
		return null;
	}
	const record = raw as Record<string, unknown>;
	if (record.projection !== LIVE_TO_VOD_PUBLIC_PROJECTION) {
		return normalizeLiveToVodRecord(raw);
	}

	// The server deliberately keeps old families-absent records old. Core's
	// legacy parser is safe here and ignores the projection marker.
	if (!Object.hasOwn(record, "families")) {
		return normalizeLiveToVodRecord(record);
	}

	const status = record.status;
	if (
		status !== "RUNNING" &&
		status !== "FINISHED" &&
		status !== "PARTIAL" &&
		status !== "ERROR"
	) {
		return null;
	}

	let invalid = !Array.isArray(record.families);
	const families: PublicLiveToVodFamily[] = [];
	if (Array.isArray(record.families)) {
		const seen = new Set<string>();
		for (const entry of record.families) {
			const parsed = publicLiveToVodFamilySchema.safeParse(entry);
			if (!parsed.success || seen.has(parsed.data?.type ?? "")) {
				invalid = true;
				continue;
			}
			seen.add(parsed.data.type);
			families.push(parsed.data);
		}
	}
	if (families.length === 0) {
		invalid = true;
	}

	const derivedStatus = derivePublicStatus(families);
	// Public DTOs intentionally omit queue/revision internals. The remaining
	// attempt + exact run coordinates distinguish a server-projected active
	// claim from a stale terminal record; a finishedAt on RUNNING is impossible.
	const exactActiveClaim =
		status === "RUNNING" &&
		(text(record, "attemptId")?.length ?? 0) > 0 &&
		(text(record, "liveChannelRunId")?.length ?? 0) > 0 &&
		!Object.hasOwn(record, "finishedAt");
	if (
		(status === "RUNNING" && !exactActiveClaim) ||
		(status !== "RUNNING" && status !== derivedStatus)
	) {
		invalid = true;
	}

	const parsedErrorCode = liveToVodErrorCodeSchema.safeParse(record.errorCode);
	const normalizedStatus: LiveToVodStatus = invalid
		? "ERROR"
		: exactActiveClaim
			? "RUNNING"
			: derivedStatus;
	return {
		status: normalizedStatus,
		projection: LIVE_TO_VOD_PUBLIC_PROJECTION,
		...(text(record, "attemptId")
			? { attemptId: text(record, "attemptId") }
			: {}),
		...(text(record, "liveChannelRunId")
			? { liveChannelRunId: text(record, "liveChannelRunId") }
			: {}),
		...(text(record, "requestedAt")
			? { requestedAt: text(record, "requestedAt") }
			: {}),
		...(text(record, "finishedAt")
			? { finishedAt: text(record, "finishedAt") }
			: {}),
		...(text(record, "outputKey")
			? { outputKey: text(record, "outputKey") }
			: {}),
		...(text(record, "path") ? { path: text(record, "path") } : {}),
		...(invalid
			? { errorCode: "L2V_RECORD_INVALID" as const }
			: parsedErrorCode.success
				? { errorCode: parsedErrorCode.data as LiveToVodErrorCode }
				: {}),
		families,
		manifests: publicManifests(families),
	};
}
