import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { vodInputPreviewJobSchema } from "@bitovp/core";
import {
	vodInputPreviewRequestSchema,
	vodInputPreviewResultSchema,
} from "@bitovp/core/vod-input-timeline";
import { type AppPrismaClient, DB_NULL, type Prisma } from "@bitovp/db";
import { MediaOperationError } from "../library-editing/process";
import { probeVodInputSources, renderVodInputPreview } from "./media";
import type { VodInputBrowserFactory } from "./range-bridge";

export const VOD_INPUT_PREVIEW_LEASE_MS = 30_000;
export const VOD_INPUT_PREVIEW_TASK_TIMEOUT_MS = 180_000;
export const VOD_INPUT_PREVIEW_UUID =
	/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
type Reservation = <T>(
	pixels: number,
	signal: AbortSignal,
	work: (signal: AbortSignal) => Promise<T>,
) => Promise<T>;

export function vodInputPreviewAttemptDirectory(
	root: string,
	organizationId: string,
	taskId: string,
	token: string,
): string {
	if (
		!isAbsolute(root) ||
		root.includes("\0") ||
		![organizationId, taskId, token].every((value) =>
			VOD_INPUT_PREVIEW_UUID.test(value),
		)
	)
		throw new MediaOperationError("INVALID_LOCAL_PATH");
	return join(resolve(root), organizationId, taskId, token);
}

const errorMessages: Record<string, string> = {
	SOURCE_CHANGED: "The source changed. Inspect the source again.",
	SOURCE_UNVERIFIED: "The storage provider cannot verify this source version.",
	SOURCE_UNSUPPORTED:
		"The source format or dimensions are not supported for CPU preview.",
	SOURCE_READ_LIMIT:
		"The preview reached its source read limit. Use a shorter preview range.",
	SOURCE_READ_TIMED_OUT: "The source storage did not respond in time.",
	SOURCE_AUDIO_MISSING:
		"Every clip needs an audio stream when sequence audio is enabled.",
	SOURCE_RANGE_INVALID:
		"A clip or preview range is outside the measured source duration.",
	PROBE_UNAVAILABLE:
		"The source inspection is unavailable. Inspect the source again.",
	CREDENTIAL_UNAVAILABLE: "A source storage credential is unavailable.",
	RESOURCE_UNAVAILABLE:
		"CPU preview is waiting for worker resources. Try again later.",
	TIMED_OUT:
		"The CPU preview exceeded its time limit. Use a shorter preview range.",
	TASK_EXPIRED: "The preview expired. Create a new preview.",
};

/** Durable intent and artifact adoption share the same expiring owner fence. */
export function createVodInputPreviewProcessor(deps: {
	prisma: AppPrismaClient;
	browserFor: VodInputBrowserFactory;
	workDir: string;
	ffmpegPath?: string;
	ffprobePath?: string;
	now?: () => Date;
	signal?: AbortSignal;
	reserve?: Reservation;
	probe?: typeof probeVodInputSources;
	render?: typeof renderVodInputPreview;
	heartbeatMs?: number;
}) {
	const now = deps.now ?? (() => new Date());
	return async (raw: unknown) => {
		const { taskId } = vodInputPreviewJobSchema.parse(raw);
		const row = await deps.prisma.vodInputPreviewTask.findUnique({
			where: { id: taskId },
		});
		if (!row) return { status: "MISSING" };
		if (["SUCCEEDED", "FAILED", "CANCELED"].includes(row.status))
			return { status: row.status };
		if (row.expiresAt <= now() || row.cancelRequestedAt) {
			await deps.prisma.vodInputPreviewTask.updateMany({
				where: { id: taskId, status: "PENDING" },
				data: { status: "CANCELED", stage: "CANCELED", finishedAt: now() },
			});
			return { status: "CANCELED" };
		}
		const token = randomUUID();
		const claimed = await deps.prisma.vodInputPreviewTask.updateMany({
			where: {
				id: taskId,
				cancelRequestedAt: null,
				expiresAt: { gt: now() },
				OR: [
					{ status: "PENDING" },
					{
						status: "RUNNING",
						OR: [{ leaseUntil: { lt: now() } }, { leaseUntil: null }],
					},
				],
			},
			data: {
				status: "RUNNING",
				stage: "PREPARING",
				leaseToken: token,
				leaseUntil: new Date(now().getTime() + VOD_INPUT_PREVIEW_LEASE_MS),
				attempts: { increment: 1 },
				startedAt: now(),
				error: DB_NULL,
			},
		});
		if (!claimed.count) return { status: "LEASE_HELD" };
		const directory = vodInputPreviewAttemptDirectory(
			deps.workDir,
			row.organizationId,
			taskId,
			token,
		);
		const controller = new AbortController();
		const deadline = AbortSignal.timeout(VOD_INPUT_PREVIEW_TASK_TIMEOUT_MS);
		const signal = AbortSignal.any([
			controller.signal,
			deadline,
			...(deps.signal ? [deps.signal] : []),
		]);
		const fence = () => ({
			id: taskId,
			status: "RUNNING",
			leaseToken: token,
			leaseUntil: { gt: now() },
			expiresAt: { gt: now() },
			cancelRequestedAt: null,
		});
		const renew = async (stage?: string) => {
			signal.throwIfAborted();
			const changed = await deps.prisma.vodInputPreviewTask.updateMany({
				where: fence(),
				data: {
					leaseUntil: new Date(now().getTime() + VOD_INPUT_PREVIEW_LEASE_MS),
					...(stage ? { stage } : {}),
				},
			});
			if (!changed.count) throw new MediaOperationError("LEASE_LOST");
		};
		let renewing: Promise<void> | undefined;
		const heartbeat = setInterval(() => {
			if (renewing) return;
			renewing = renew()
				.catch(() => controller.abort(new MediaOperationError("LEASE_LOST")))
				.finally(() => {
					renewing = undefined;
				});
		}, deps.heartbeatMs ?? 1000);
		heartbeat.unref();
		let adopted = false;
		try {
			const request = vodInputPreviewRequestSchema.parse(row.request);
			if (
				request.kind !== row.kind ||
				createHash("sha256").update(JSON.stringify(request)).digest("hex") !==
					row.requestHash
			)
				throw new MediaOperationError("INVALID_INTENT");
			let sources: Extract<typeof request, { kind: "PROBE" }>["sources"];
			let result: Prisma.InputJsonObject;
			let artifact: { path: string; size: number; sha256: string } | undefined;
			const reserve: Reservation =
				deps.reserve ??
				(async (_pixels, permitSignal, work) => work(permitSignal));
			const media = {
				browserFor: deps.browserFor,
				ffmpegPath: deps.ffmpegPath,
				ffprobePath: deps.ffprobePath,
				signal,
			};
			if (request.kind === "PROBE") {
				sources = request.sources;
				await renew("PROBING");
				result = {
					sources: await reserve(0, signal, (permitSignal) =>
						(deps.probe ?? probeVodInputSources)({
							...media,
							signal: permitSignal,
							sources,
						}),
					),
				};
			} else {
				const probe = await deps.prisma.vodInputPreviewTask.findUnique({
					where: { id: request.probeId },
				});
				if (
					!probe ||
					probe.organizationId !== row.organizationId ||
					probe.id !== row.probeId ||
					probe.kind !== "PROBE" ||
					probe.status !== "SUCCEEDED" ||
					probe.cancelRequestedAt ||
					probe.expiresAt <= now()
				)
					throw new MediaOperationError("PROBE_UNAVAILABLE");
				const probeRequest = vodInputPreviewRequestSchema.parse(probe.request);
				const facts = vodInputPreviewResultSchema.parse(probe.result).sources;
				if (
					probeRequest.kind !== "PROBE" ||
					!facts ||
					facts.length !== probeRequest.sources.length ||
					facts.some(
						(fact) =>
							!probeRequest.sources.some((source) => source.key === fact.key),
					) ||
					new Set(facts.map((fact) => fact.key)).size !== facts.length
				)
					throw new MediaOperationError("PROBE_UNAVAILABLE");
				sources = probeRequest.sources;
				await mkdir(directory, { recursive: true, mode: 0o700 });
				await renew("RENDERING");
				const pixels = Math.max(
					...facts.map((facts) => facts.video.width * facts.video.height),
				);
				const rendered = await reserve(pixels, signal, (permitSignal) =>
					(deps.render ?? renderVodInputPreview)({
						...media,
						signal: permitSignal,
						sources,
						facts,
						request,
						directory,
					}),
				);
				if (rendered.path !== join(directory, "preview.mp4"))
					throw new MediaOperationError("OUTPUT_INVALID");
				artifact = rendered;
				result = {
					preview: {
						startMs: request.range.startMs,
						durationMs: rendered.durationMs,
						size: rendered.size,
						sha256: rendered.sha256,
					},
				};
			}
			const credentialIds = [
				...new Set(sources.map((source) => source.credentialId)),
			];
			if (
				(await deps.prisma.credential.count({
					where: { id: { in: credentialIds } },
				})) !== credentialIds.length
			)
				throw new MediaOperationError("CREDENTIAL_UNAVAILABLE");
			await renew("FINALIZING");
			signal.throwIfAborted();
			const completed = await deps.prisma.vodInputPreviewTask.updateMany({
				where: fence(),
				data: {
					status: "SUCCEEDED",
					stage: "READY",
					result: vodInputPreviewResultSchema.parse(result),
					finishedAt: now(),
					leaseToken: null,
					leaseUntil: null,
					...(artifact
						? {
								artifactPath: artifact.path,
								artifactToken: token,
								artifactSize: BigInt(artifact.size),
								artifactSha256: artifact.sha256,
							}
						: {}),
				},
			});
			adopted = completed.count > 0;
			return { status: adopted ? "SUCCEEDED" : "LEASE_LOST" };
		} catch (error) {
			const latest = await deps.prisma.vodInputPreviewTask.findUnique({
				where: { id: taskId },
			});
			const canceled =
				!!latest?.cancelRequestedAt ||
				latest?.status === "CANCELED" ||
				deps.signal?.aborted;
			const code =
				latest && latest.expiresAt <= now()
					? "TASK_EXPIRED"
					: deadline.aborted
						? "TIMED_OUT"
						: error instanceof Error &&
								["ResourceUnavailableError", "VmafResourceLeaseError"].includes(
									error.name,
								)
							? "RESOURCE_UNAVAILABLE"
							: error instanceof MediaOperationError
								? error.code
								: "PREVIEW_FAILED";
			if (
				latest?.leaseToken === token &&
				latest.leaseUntil &&
				latest.leaseUntil > now()
			) {
				await deps.prisma.vodInputPreviewTask.updateMany({
					where: {
						id: taskId,
						leaseToken: token,
						status: { in: ["RUNNING", "CANCELED"] },
					},
					data: {
						status: canceled ? "CANCELED" : "FAILED",
						stage: canceled ? "CANCELED" : "FAILED",
						error: {
							code,
							message:
								errorMessages[code] ?? "CPU preview could not be completed.",
						},
						leaseToken: null,
						leaseUntil: null,
						finishedAt: now(),
					},
				});
			}
			return { status: canceled ? "CANCELED" : "FAILED" };
		} finally {
			clearInterval(heartbeat);
			controller.abort();
			await renewing;
			if (!adopted) await rm(directory, { recursive: true, force: true });
		}
	};
}
