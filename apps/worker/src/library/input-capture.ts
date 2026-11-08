import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CompiledOperation,
	createInputCaptureCredentials,
	encodingPlanSchema,
	hashEditingEvidence,
	type PinnedInputCapture,
	pinnedInputCaptureSchema,
} from "@bitovp/core";
import type { AppPrismaClient, Prisma } from "@bitovp/db";
import type { ObjectStorageBrowser } from "@bitovp/storage";
import { downloadPinnedEditingMedia } from "../library-editing/media";
import { probeEditingNormalizationSource } from "../library-editing/normalization";
import { MediaOperationError } from "../library-editing/process";
import type { SdkOps } from "../orchestrator/sdk-ops";

export type CapturedIngestInput = {
	inputId: string;
	inputPath: string;
	inputReceiptId: string;
};
export type CaptureIngestRequest = {
	organizationId: string;
	jobId: string;
	operation: CompiledOperation;
	encodingId: string;
	sdk: SdkOps;
	checkpoint(): Promise<void>;
};
const json = (value: unknown) =>
	JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

/** Optional future-input producer. Historical/mutable inputs never acquire a receipt. */
export function createEncodingInputCapture(deps: {
	prisma: AppPrismaClient;
	browserFor(credentialId: string): Promise<ObjectStorageBrowser>;
	config: { baseUrl: string; secret: string } | null;
	now?: () => Date;
	uuid?: () => string;
}): (request: CaptureIngestRequest) => Promise<CapturedIngestInput | null> {
	let base: URL | undefined;
	if (deps.config) {
		base = new URL(deps.config.baseUrl);
		if (
			base.protocol !== "https:" ||
			base.username ||
			base.password ||
			base.search ||
			base.hash ||
			base.pathname !== "/" ||
			deps.config.secret.length < 32
		)
			throw new Error("INPUT_CAPTURE_CONFIGURATION_INVALID");
	}
	return async (input) => {
		if (
			!base ||
			!deps.config ||
			input.operation.kind !== "CREATE_INGEST_INPUT_STREAM"
		)
			return null;
		await input.checkpoint();
		const job = await deps.prisma.encodingJob.findUnique({
			where: { id: input.jobId },
		});
		if (
			!job ||
			job.organizationId !== input.organizationId ||
			job.bitmovinEncodingId !== input.encodingId
		)
			throw new Error("INPUT_CAPTURE_JOB_MISMATCH");
		const parsed = encodingPlanSchema.safeParse(job.plan);
		if (!parsed.success) return null;
		const plan = parsed.data;
		if (
			!plan.aiSceneAnalysis ||
			plan.ingest.length !== 1 ||
			(plan.encodings?.length ?? 1) !== 1 ||
			plan.trimmingStreams.length ||
			plan.concatenationStreams.length ||
			plan.audioMixStreams.length ||
			plan.dolbyStreams.length ||
			plan.fileStreams.length ||
			plan.filters.length
		)
			return null;
		const ingest = plan.ingest[0];
		if (
			ingest?.selectionMode !== "VIDEO_RELATIVE" ||
			ingest.position !== 0 ||
			input.operation.step !== `ingest:${ingest.key}` ||
			input.operation.payload.inputPath !== ingest.inputPath ||
			input.operation.payload.selectionMode !== ingest.selectionMode ||
			input.operation.payload.position !== ingest.position
		)
			return null;
		const origin = plan.inputs.find((entry) => entry.key === ingest.inputKey);
		if (!origin || !("credentialId" in origin) || !("bucket" in origin))
			return null;
		const planHash = hashEditingEvidence(job.plan);
		const receipts = await deps.prisma.libraryEvidenceReceipt.findMany({
			where: {
				organizationId: input.organizationId,
				jobId: job.id,
				encodingId: input.encodingId,
				kind: "INPUT_CAPTURE",
			},
			orderBy: { createdAt: "asc" },
			take: 101,
		});
		if (receipts.length > 100) throw new Error("INPUT_CAPTURE_LIMIT");
		let receiptId: string;
		let proof: PinnedInputCapture;
		const prior = receipts[0];
		if (prior) {
			proof = pinnedInputCaptureSchema.parse(prior.proof);
			if (
				prior.organizationId !== input.organizationId ||
				prior.jobId !== job.id ||
				prior.encodingId !== input.encodingId ||
				prior.proofHash !== hashEditingEvidence(prior.proof) ||
				proof.organizationId !== input.organizationId ||
				proof.jobId !== job.id ||
				proof.encodingId !== input.encodingId ||
				proof.planHash !== planHash ||
				proof.ingestKey !== ingest.key
			)
				throw new Error("INPUT_CAPTURE_WAS_CHANGED");
			receiptId = prior.id;
		} else {
			const directory = await mkdtemp(join(tmpdir(), "bitovp-input-capture-"));
			let browser: ObjectStorageBrowser | undefined;
			const controller = new AbortController();
			let pending: Promise<void> | undefined;
			const checkpoint = () =>
				(pending ??= input.checkpoint().finally(() => {
					pending = undefined;
				}));
			const timer = setInterval(() => {
				void checkpoint().catch((error: unknown) => controller.abort(error));
			}, 5000);
			timer.unref?.();
			try {
				await chmod(directory, 0o700);
				browser = await deps.browserFor(origin.credentialId);
				const key = ingest.inputPath.replace(/^\/+/, "");
				const identity = await browser.headObject?.({
					bucket: origin.bucket,
					key,
				});
				if (
					!identity ||
					!(
						identity.generation ||
						(identity.versionId && identity.versionId !== "null")
					)
				)
					return null;
				const sourcePath = join(directory, "source.mp4");
				const captured = await downloadPinnedEditingMedia({
					browser,
					bucket: origin.bucket,
					key,
					destinationPath: sourcePath,
					expectedIdentity: identity,
					signal: controller.signal,
				});
				let sourceFacts: Awaited<
					ReturnType<typeof probeEditingNormalizationSource>
				>["source"];
				try {
					sourceFacts = (
						await probeEditingNormalizationSource({
							sourcePath,
							signal: controller.signal,
						})
					).source;
				} catch (error) {
					if (
						error instanceof MediaOperationError &&
						error.code === "UNSUPPORTED_MEDIA"
					)
						return null;
					throw error;
				}
				await checkpoint();
				receiptId = (deps.uuid ?? randomUUID)();
				proof = pinnedInputCaptureSchema.parse({
					schemaVersion: 1,
					profile: "PINNED_HTTP_INPUT_V1",
					organizationId: input.organizationId,
					jobId: job.id,
					encodingId: input.encodingId,
					expiresAt:
						Math.floor((deps.now?.() ?? new Date()).getTime() / 1000) +
						7 * 86400,
					storage: {
						credentialId: origin.credentialId,
						bucket: origin.bucket,
						key,
						size: captured.bytes,
						expect: {
							...(identity.etag ? { etag: identity.etag } : {}),
							...(identity.versionId ? { versionId: identity.versionId } : {}),
							...(identity.generation
								? { generation: identity.generation }
								: {}),
						},
					},
					sha256: captured.sha256,
					sourceFacts,
					ingestKey: ingest.key,
					planHash,
				});
				const stored = await deps.prisma.libraryEvidenceReceipt.create({
					data: {
						id: receiptId,
						organizationId: input.organizationId,
						sourceId: null,
						jobId: job.id,
						encodingId: input.encodingId,
						kind: "INPUT_CAPTURE",
						proof: json(proof),
						proofHash: hashEditingEvidence(proof),
					},
				});
				if (stored.proofHash !== hashEditingEvidence(stored.proof))
					throw new Error("INPUT_CAPTURE_WAS_CHANGED");
				proof = pinnedInputCaptureSchema.parse(stored.proof);
			} catch (error) {
				if (controller.signal.aborted && controller.signal.reason)
					throw controller.signal.reason;
				throw error;
			} finally {
				clearInterval(timer);
				await pending?.catch(() => {});
				browser?.dispose?.();
				await rm(directory, { recursive: true, force: true });
			}
		}
		await input.checkpoint();
		const credentials = createInputCaptureCredentials({
			secret: deps.config.secret,
			organizationId: input.organizationId,
			receiptId,
			expiresAt: proof.expiresAt,
			now: Math.floor((deps.now?.() ?? new Date()).getTime() / 1000),
		});
		let inputId: string;
		try {
			inputId = await input.sdk.createHttpsInput({
				name: "BitOVP version-pinned input",
				host: base.hostname,
				...(base.port ? { port: Number(base.port) } : {}),
				...credentials,
			});
		} catch {
			throw new Error("INPUT_CAPTURE_PROVIDER_FAILED");
		}
		await input.checkpoint();
		return {
			inputId,
			inputPath: `/api/encoding-input-captures/${receiptId}/content`,
			inputReceiptId: receiptId,
		};
	};
}
