import "server-only";
import type BitmovinApi from "@bitmovin/api-sdk";
import {
	compareSlateCompatibility,
	decideSlatePreparation,
	describeMediaDifferences,
	heartbeatIngestMedia,
	isSlateSupportedProvider,
	type MediaAttributes,
	masterKeyFromEnv,
	normalizeSlateInputPath,
	type ProbeResult,
	parseMediaAttributes,
	type SlateInputPath,
	type SlateSource,
	slateConversionDestination,
	slateImageDifference,
} from "@bitovp/core";
import { INSPECTION_SELECT } from "@/app/storage/inspect-shared";
import type {
	SlatePreflightDto,
	SlatePreflightStandDown,
} from "@/lib/live-runtime/schemas";
import type { ServerContext } from "./context";
import { getStorageInspectQueue } from "./queue";
import { browserForCredentialId } from "./storage";

/**
 * Slate compatibility PREFLIGHT for the direct registration path (C36 / WP-A2).
 *
 * `POST /api/live-channels/[id]/insertable-content` used to hand any
 * `{inputId, inputPath}` straight to Bitmovin. Measured 2026-09-02 (channel
 * 0645c2f1): a 23.976 fps / 44.1 kHz clip registered against a 30 fps /
 * 48 kHz ingest reached READY in one second and both scheduled insertions
 * went to provider ERROR 21 s after scheduling — READY validates nothing.
 * The scheduled-source path (`apps/worker/src/orchestrator/slate-register.ts`,
 * ) had run this check since 2026-08-29; the direct path did not.
 *
 * The web tier owns no ffprobe. The probe is the STORAGE INSPECTION the
 * worker already performs for the storage browser (a bounded read + ffprobe,
 * written to `StorageInspection.probe`), so this module adopts the object's
 * latest FINISHED inspection, or starts one and reports PENDING — the picker
 * polls until it lands. The verdict itself is `compareSlateCompatibility`
 * from `@bitovp/core`, the same table the worker uses, against the same
 * ingest reference the worker reads (`loadChannelIngestMedia`'s two
 * instruments, in the same order: the run's recorded reference, then the
 * encoder's heartbeat).
 *
 * Conservative like its worker sibling: a candidate that cannot be resolved
 * to a readable object (a legacy `inputId` whose bucket no vaulted credential
 * can open, an unsupported input type, an inspection that errored) is
 * UNVERIFIED with a stated reason — never silently accepted as "compatible".
 * For the raw `inputs` shape that still registers (stood down, and says so);
 * for the picker's shape the same verdict carries a REFUSE preparation (row
 * #330): what cannot be probed cannot be converted, so it is not registered.
 */

export type SlatePreflightRequest =
	| { kind: "source"; source: SlateSource }
	| { kind: "input"; inputId: string; inputPath: string };

export type SlatePreflightOutcome =
	| { status: "PENDING"; dto: SlatePreflightDto }
	| { status: "OK"; dto: SlatePreflightDto; candidate: SlateSource | null }
	| {
			status: "INCOMPATIBLE";
			dto: SlatePreflightDto;
			candidate: SlateSource;
			/** True when the refusal is the still-image kind, not an attribute. */
			image: boolean;
	  }
	| {
			status: "UNVERIFIED";
			dto: SlatePreflightDto;
			candidate: SlateSource | null;
	  };

/** The plain sentence a stood-down verdict carries — one spelling everywhere. */
export function unverifiedSummary(
	standDown: SlatePreflightStandDown,
	note: string,
): string {
	return `preflight UNVERIFIED (${standDown}): ${note}`;
}

/**
 * How many vaulted credentials the legacy-shape resolver will try against a
 * bucket before giving up — the same cap as the storage browser's
 * "which credential opens this bucket?" search (`find-credential-for-bucket`).
 */
export const LEGACY_CREDENTIAL_SEARCH_CAP = 8;

/**
 * What the channel's CURRENT run is ingesting — the web mirror of the worker's
 * `loadChannelIngestMedia`, same two instruments in the same order. Never
 * throws: no reference is "no opinion".
 */
export async function loadSlateIngestReference(
	ctx: ServerContext,
	channelId: string,
): Promise<MediaAttributes | null> {
	const run = await ctx.prisma.liveChannelRun
		.findFirst({
			where: { liveChannelId: channelId },
			orderBy: { seq: "desc" },
			select: { ingestMedia: true, lastHeartbeat: true },
		})
		.catch(() => null);
	if (run) {
		return (
			parseMediaAttributes(run.ingestMedia) ??
			heartbeatIngestMedia(run.lastHeartbeat)
		);
	}
	const channel = await ctx.prisma.liveChannel
		.findUnique({
			where: { id: channelId },
			select: { lastHeartbeat: true },
		})
		.catch(() => null);
	return heartbeatIngestMedia(channel?.lastHeartbeat ?? null);
}

/**
 * The bucket a Bitmovin file-storage input reads from, by input type. Only the
 * types a slate credential can be vaulted for are resolved; an ingest input
 * (RTMP/SRT/ZIXI), an HTTPS input or an unknown type has no bucket to probe.
 */
export async function resolveInputBucket(
	api: BitmovinApi,
	inputId: string,
): Promise<{ bucket: string } | { bucket: null; reason: string }> {
	const typed = await api.encoding.inputs.type.get(inputId);
	const type = String(typed.type ?? "");
	switch (type) {
		case "S3": {
			const input = await api.encoding.inputs.s3.get(inputId);
			return input.bucketName
				? { bucket: input.bucketName }
				: { bucket: null, reason: "S3 input carries no bucketName" };
		}
		case "GENERIC_S3": {
			const input = await api.encoding.inputs.genericS3.get(inputId);
			return input.bucketName
				? { bucket: input.bucketName }
				: { bucket: null, reason: "Generic S3 input carries no bucketName" };
		}
		case "GCS": {
			const input = await api.encoding.inputs.gcs.get(inputId);
			return input.bucketName
				? { bucket: input.bucketName }
				: { bucket: null, reason: "GCS input carries no bucketName" };
		}
		case "AZURE": {
			const input = await api.encoding.inputs.azure.get(inputId);
			return input.container
				? { bucket: input.container }
				: { bucket: null, reason: "Azure input carries no container" };
		}
		default:
			return {
				bucket: null,
				reason: `input type ${type || "unknown"} is not a browsable file storage`,
			};
	}
}

/**
 * Which vaulted credential can read this object? Bounded, sequential, and
 * asks for exactly the key (`prefix = key, limit 1`) — "may I read this", not
 * "what is in here". A credential-level refusal says nothing about the bucket
 * and is skipped like a bucket-level one.
 */
export async function findCredentialForObject(
	ctx: ServerContext,
	bucket: string,
	key: string,
): Promise<string | null> {
	const candidates = (await ctx.credentials.list())
		.filter((c) => isSlateSupportedProvider(c.provider))
		.slice(0, LEGACY_CREDENTIAL_SEARCH_CAP);
	for (const candidate of candidates) {
		let browser: Awaited<ReturnType<typeof browserForCredentialId>> = null;
		try {
			browser = await browserForCredentialId(ctx, candidate.id);
			if (!browser) {
				continue;
			}
			const page = await browser.listObjects({ bucket, prefix: key, limit: 1 });
			if (page.objects.some((object) => object.key === key)) {
				return candidate.id;
			}
		} catch {
			// Not this one — or not readable at all; either way no evidence.
		} finally {
			browser?.dispose?.();
		}
	}
	return null;
}

async function latestInspection(ctx: ServerContext, source: SlateSource) {
	return ctx.prisma.storageInspection.findFirst({
		where: {
			credentialId: source.credentialId,
			bucket: source.bucket,
			objectKey: source.key,
		},
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		select: INSPECTION_SELECT,
	});
}

/**
 * Start a storage inspection for the object — the same row + enqueue the
 * storage browser's `POST /api/storage-inspections` performs (jobId = row id
 * dedupes a redelivery; an enqueue failure marks the row ERROR and rethrows).
 */
export async function startSlateInspection(
	ctx: ServerContext,
	source: SlateSource,
): Promise<string> {
	// The worker must decrypt the credential to read the object; fail here
	// rather than leave a row PENDING forever behind a broken MASTER_KEY.
	masterKeyFromEnv();
	const row = await ctx.prisma.storageInspection.create({
		data: {
			credentialId: source.credentialId,
			bucket: source.bucket,
			objectKey: source.key,
			status: "PENDING",
		},
		select: { id: true },
	});
	try {
		await getStorageInspectQueue().add(
			"storage-inspect",
			{ storageInspectionId: row.id },
			{ jobId: row.id, removeOnComplete: 1000, removeOnFail: 1000 },
		);
	} catch (enqueueErr) {
		await ctx.prisma.storageInspection.update({
			where: { id: row.id },
			data: { status: "ERROR", error: "Enqueue failed — inspect again" },
		});
		throw enqueueErr;
	}
	return row.id;
}

function unverified(
	standDown: SlatePreflightStandDown,
	note: string,
	inputPath: SlateInputPath,
	candidate: SlateSource | null,
): SlatePreflightOutcome {
	return {
		status: "UNVERIFIED",
		candidate,
		dto: {
			status: "DONE",
			verdict: "UNVERIFIED",
			standDown,
			note,
			summary: unverifiedSummary(standDown, note),
			inputPath,
			...(candidate ? { candidate } : {}),
			// : a picked file nobody could probe is REFUSED, not
			// registered as it is — an unprobed MP4 would air with half-speed
			// audio, an unprobed MKV never. The raw `inputs` shape ignores
			// `preparation` (no credential to write with) and stands down as
			// before.
			preparation: { action: "REFUSE", reason: note },
		},
	};
}

/**
 * Resolve the request to an object, adopt or start its inspection, and judge
 * it against the channel's ingest. See the module docblock for the
 * stand-down rules.
 */
export async function runSlatePreflight(options: {
	ctx: ServerContext;
	api: BitmovinApi;
	channelId: string;
	request: SlatePreflightRequest;
}): Promise<SlatePreflightOutcome> {
	const { ctx, api, channelId, request } = options;
	const inputPath = normalizeSlateInputPath(
		request.kind === "source" ? request.source.key : request.inputPath,
	);

	// 1. Which object?
	let candidate: SlateSource;
	if (request.kind === "source") {
		candidate = { ...request.source, key: inputPath.path };
	} else {
		let resolved: Awaited<ReturnType<typeof resolveInputBucket>>;
		try {
			resolved = await resolveInputBucket(api, request.inputId);
		} catch (err) {
			return unverified(
				"INPUT_UNRESOLVED",
				`the Bitmovin input ${request.inputId} could not be read: ${err instanceof Error ? err.message : String(err)}`,
				inputPath,
				null,
			);
		}
		if (resolved.bucket === null) {
			return unverified(
				"INPUT_UNRESOLVED",
				`the Bitmovin input ${request.inputId} names no bucket to probe (${resolved.reason})`,
				inputPath,
				null,
			);
		}
		const credentialId = await findCredentialForObject(
			ctx,
			resolved.bucket,
			inputPath.path,
		);
		if (credentialId === null) {
			return unverified(
				"NO_CREDENTIAL",
				`no vaulted storage credential can read ${resolved.bucket}/${inputPath.path}, so the clip was not probed`,
				inputPath,
				null,
			);
		}
		candidate = { credentialId, bucket: resolved.bucket, key: inputPath.path };
	}

	// 2. Its probe — adopt the latest inspection or start one.
	const latest = await latestInspection(ctx, candidate);
	if (latest === null || latest.status === "ERROR") {
		if (latest?.status === "ERROR") {
			return unverified(
				"INSPECTION_FAILED",
				`the object's inspection failed (${latest.error ?? "no reason recorded"}), so its attributes could not be compared`,
				inputPath,
				candidate,
			);
		}
		const inspectionId = await startSlateInspection(ctx, candidate);
		return {
			status: "PENDING",
			dto: {
				status: "PENDING",
				inspectionId,
				summary: `PENDING: inspection ${inspectionId} started`,
				candidate,
				inputPath,
			},
		};
	}
	if (latest.status !== "FINISHED") {
		return {
			status: "PENDING",
			dto: {
				status: "PENDING",
				inspectionId: latest.id,
				summary: `PENDING: inspection ${latest.id} is ${latest.status}`,
				candidate,
				inputPath,
			},
		};
	}

	// 3. The verdict.
	const probe = (latest.probe ?? null) as ProbeResult | null;
	const ingest = await loadSlateIngestReference(ctx, channelId);
	const verdict = compareSlateCompatibility(ingest, probe);
	const preparation = decideSlatePreparation(probe, ingest);
	//  follow-up: where a conversion would land — the channel's own
	// S3-family output (its credential writes there already), else next to
	// the source. Named without its credential id.
	let conversionDestination: SlatePreflightDto["conversionDestination"];
	if (preparation.action === "NORMALIZE") {
		// Not caught: a failed plan read must not turn into a confident
		// "next to the source" — the worker derives the truth from the plan.
		const channel = await ctx.prisma.liveChannel.findUnique({
			where: { id: channelId },
			select: { plan: true },
		});
		const destination = slateConversionDestination(channel?.plan ?? null);
		conversionDestination = destination
			? {
					bucket: destination.bucket,
					keyPrefix: destination.keyPrefix,
					sameAsSource: false,
				}
			: {
					bucket: candidate.bucket,
					keyPrefix: candidate.key.includes("/")
						? candidate.key.slice(0, candidate.key.lastIndexOf("/"))
						: "",
					sameAsSource: true,
				};
	}
	const base = {
		status: "DONE" as const,
		inspectionId: latest.id,
		candidate,
		inputPath,
		kind: verdict.kind,
		container: verdict.container,
		differences: verdict.differences,
		compared: verdict.compared,
		notComparable: verdict.notComparable,
		probe: latest.probe ?? null,
		// : what registration will do about the verdict. The picker's
		// shape acts on it (convert / wait / register as is); the raw shape has
		// no credential to write with, so it still refuses on the verdict.
		preparation,
		...(conversionDestination ? { conversionDestination } : {}),
	};
	if (!verdict.ok) {
		const image = slateImageDifference(verdict) !== undefined;
		const note = image
			? "The still-image slate could not be registered. Use a JPG or PNG and set a display duration when inserting."
			: describeMediaDifferences(verdict.differences.filter((d) => d.blocking));
		return {
			status: "INCOMPATIBLE",
			candidate,
			image,
			dto: {
				...base,
				verdict: "INCOMPATIBLE",
				note,
				summary: `INCOMPATIBLE: ${note.replace(/\n/g, "; ")}`,
			},
		};
	}
	if (verdict.standDown !== null) {
		const note =
			verdict.standDown === "NO_PROBE"
				? "the inspection recorded no ffprobe result, so the clip's attributes could not be compared"
				: verdict.standDown === "NO_COMPARABLE_ATTRIBUTE"
					? "the ingest reference carries no attribute the clip can be compared on, so nothing was verified"
					: "the channel has no ingest reference yet (no heartbeat and no recorded source), so the clip's attributes could not be compared";
		return {
			status: "UNVERIFIED",
			candidate,
			dto: {
				...base,
				verdict: "UNVERIFIED",
				standDown: verdict.standDown,
				note,
				summary: unverifiedSummary(verdict.standDown, note),
			},
		};
	}
	// An OK names its scope (rev406 R1): on a heartbeat reference the clip was
	// compared on geometry, rates and codecs, and NOT on profile, level, pixel
	// format or channels — "matches the live ingest" alone read as all of it.
	return {
		status: "OK",
		candidate,
		dto: {
			...base,
			verdict: "OK",
			summary: `OK: matches the live ingest on ${verdict.compared.join(", ")}${
				verdict.notComparable.length > 0
					? `; not comparable: ${verdict.notComparable.join(", ")}`
					: ""
			}`,
		},
	};
}
