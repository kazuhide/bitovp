import { masterKeyFromEnv } from "@bitovp/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
	INSPECTION_SELECT,
	type StorageInspectionRow,
	toInspectionDto,
} from "@/app/storage/inspect-shared";
import { getServerContext } from "@/lib/server/context";
import {
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import { getStorageInspectQueue } from "@/lib/server/queue";
import { clientKey, createFixedWindowLimiter } from "@/lib/server/rate-limit";

/**
 * POST only. Each accepted request costs a bounded read of up to
 * INSPECT_HEAD_BYTES + INSPECT_TAIL_BYTES (12 MB) billed to the CUSTOMER's
 * bucket, plus an ffprobe process on the worker — and nothing dedupes
 * `(credentialId, bucket, objectKey)`, so the same object can be re-inspected
 * indefinitely.
 *
 * 20/min is far past the UI's rate (one POST per dialog open, and the dialog
 * adopts an existing row instead of re-inspecting) while capping a loop at
 * ~240 MB/min of customer egress. The polling `GET /[id]` the dialog runs is
 * deliberately NOT limited — it is a cheap local row read, and throttling it
 * would break the dialog. Per-process, per-client-IP: a speed bump, not a quota.
 */
const limiter = createFixedWindowLimiter({ limit: 20, windowMs: 60_000 });

/**
 * Storage object inspection (P5 PR-5) — "what actually is this file?" for the
 * storage browser, before an object becomes an encoding input.
 *
 * THIS ROUTE DOES NOT TOUCH STORAGE and never reveals the credential secret.
 * It writes a PENDING row and enqueues; the worker (which owns the ffprobe
 * binary) decrypts the credential, reads a BOUNDED slice — a capped 8 MB head
 * plus one capped retry slice for a non-faststart MP4 — probes it, and writes
 * back `probe` + `bytesRead` or an operator-readable `error`.
 *
 * Mirrors the capture-vmaf precedent: fail fast on a broken MASTER_KEY (the
 * worker must decrypt, so a bad key would only wedge the job), create the row,
 * enqueue with jobId = row id so a redelivery dedupes, and on enqueue failure
 * mark the row ERROR with a re-try hint instead of leaving it PENDING forever.
 */

/**
 * Provider-side caps: S3 bucket names top out at 63 chars but GCS allows 222
 * for dotted names, and both cap object keys at 1024 bytes — a longer value
 * could not name a real object, so reject it before writing a row.
 */
const bucketSchema = z.string().min(1).max(255);
const objectKeySchema = z
	.string()
	.min(1)
	.max(1024)
	// A trailing slash is a prefix, not an object — there is nothing to probe.
	.refine((key) => !key.endsWith("/"), {
		message: "objectKey must name an object, not a prefix (no trailing '/')",
	});

const bodySchema = z.strictObject({
	credentialId: z.uuid(),
	bucket: bucketSchema,
	objectKey: objectKeySchema,
	/**
	 * The size the LISTING reported for this object . Lets the
	 * worker aim a TRUE tail read for the moov-at-the-end retry instead of the
	 * next-slice approximation. Advisory: the worker still bounds on arrival
	 * and requires Content-Range, so a wrong size cannot unbound the read.
	 * JSON numbers are exact to 2^53-1, far past any real object.
	 */
	objectSize: z.number().int().nonnegative().optional(),
});

const querySchema = z.strictObject({
	credentialId: z.uuid(),
	bucket: bucketSchema,
	objectKey: objectKeySchema,
});

/**
 * The most recent inspection of one object, so re-opening the dialog shows the
 * previous probe instead of paying for another bounded read. Deliberately a
 * single row rather than a page — there is no list surface here, hence no
 * limit/cursor to clamp (C6 applies to Bitmovin list endpoints we proxy).
 */
export async function GET(req: Request) {
	const url = new URL(req.url);
	const parsed = querySchema.safeParse({
		credentialId: url.searchParams.get("credentialId") ?? undefined,
		bucket: url.searchParams.get("bucket") ?? undefined,
		objectKey: url.searchParams.get("objectKey") ?? undefined,
	});
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	//  (the latest-only gap): `history=1` returns the object's
	// prior inspections too — a bounded, lean list (20 rows, identity
	// fields only), newest first. The retention prune (#27) bounds what
	// can accumulate behind it.
	const wantHistory = url.searchParams.get("history") === "1";
	try {
		const ctx = await getServerContext();
		const row = await ctx.prisma.storageInspection.findFirst({
			where: parsed.data,
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			select: INSPECTION_SELECT,
		});
		const history = wantHistory
			? await ctx.prisma.storageInspection.findMany({
					where: parsed.data,
					orderBy: [{ createdAt: "desc" }, { id: "desc" }],
					take: 20,
					select: {
						id: true,
						status: true,
						createdAt: true,
						bytesRead: true,
					},
				})
			: undefined;
		return NextResponse.json({
			latest: row ? toInspectionDto(row as StorageInspectionRow) : null,
			...(history
				? {
						history: history.map((h) => ({
							id: h.id,
							status: h.status,
							createdAt: h.createdAt.toISOString(),
							bytesRead: h.bytesRead === null ? null : Number(h.bytesRead),
						})),
					}
				: {}),
		});
	} catch (err) {
		return routeError(err);
	}
}

export async function POST(req: Request) {
	if (!limiter.check(clientKey(req))) {
		return jsonError(429, "Too many requests");
	}
	const parsed = bodySchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	const { credentialId, bucket, objectKey, objectSize } = parsed.data;
	try {
		// Fail fast: the worker must decrypt this credential to read the object —
		// a broken MASTER_KEY would leave the row RUNNING with no useful error.
		masterKeyFromEnv();
		const ctx = await getServerContext();
		// Existence check only. `credentials.get` returns the ciphertext-free
		// summary, so no secret is decrypted (let alone returned) here.
		const credential = await ctx.credentials.get(credentialId);
		if (!credential) {
			return jsonError(404, "Storage credential not found");
		}

		const row = await ctx.prisma.storageInspection.create({
			data: {
				credentialId,
				bucket,
				objectKey,
				status: "PENDING",
				objectSize: objectSize === undefined ? null : BigInt(objectSize),
			},
			select: INSPECTION_SELECT,
		});
		try {
			// jobId = the row id dedupes any retry/redelivery at the queue; the
			// payload is `storageInspectJobSchema` ({ storageInspectionId }).
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
		return NextResponse.json(toInspectionDto(row as StorageInspectionRow), {
			status: 201,
		});
	} catch (err) {
		return routeError(err);
	}
}
