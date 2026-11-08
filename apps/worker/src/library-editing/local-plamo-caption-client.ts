import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
	hashEditingEvidence,
	type LocalPlamoCaptionJobRequest,
	type LocalPlamoCaptionReceipt,
	type LocalSemanticConfiguration,
	type localCaptionModelIdentityV3Schema,
	localPlamoCaptionJobRequestSchema,
	localPlamoCaptionJobSchema,
} from "@bitovp/core";
import {
	createLocalSemanticRpc,
	LocalSemanticHttpError,
	LocalSemanticTransportError,
	localSemanticJobId,
	type SemanticRpc,
} from "./local-semantic-client";
import { MediaOperationError } from "./process";

/** Dedicated protocol: a PLaMo proof is never converted into a Qwen/Story receipt. */
export function createLocalPlamoCaptionClient(
	config: LocalSemanticConfiguration,
	identity: ReturnType<typeof localCaptionModelIdentityV3Schema.parse>,
	dependencies: {
		rpc?: SemanticRpc;
		wait?: (signal: AbortSignal) => Promise<void>;
	} = {},
) {
	const rpc = dependencies.rpc ?? createLocalSemanticRpc(config),
		wait =
			dependencies.wait ??
			((signal: AbortSignal) => delay(1000, undefined, { signal }));
	return {
		async run(input: {
			request: LocalPlamoCaptionJobRequest;
			signal: AbortSignal;
		}): Promise<{ content: string; receipt: LocalPlamoCaptionReceipt }> {
			input.signal.throwIfAborted();
			const body = localPlamoCaptionJobRequestSchema.parse(input.request);
			if (
				identity.profile !== config.profile ||
				body.profile !== config.profile ||
				body.manifestHash !== identity.manifestHash ||
				body.schemaHash !== identity.schemaHash
			)
				throw new MediaOperationError("LOCAL_CAPTION_MODEL_CHANGED");
			const expectedId = localSemanticJobId(
					body.organizationId,
					body.requestKey,
				),
				expectedHash = hashEditingEvidence(body),
				base = "/v1/plamo-caption-jobs";
			const owned = (value: unknown) => {
				const parsed = localPlamoCaptionJobSchema.safeParse(value);
				if (
					!parsed.success ||
					parsed.data.id !== expectedId ||
					parsed.data.requestHash !== expectedHash
				)
					throw new MediaOperationError("LOCAL_SEMANTIC_RESPONSE_UNVERIFIED");
				return parsed.data;
			};
			const read = async (signal: AbortSignal, retry: boolean) => {
				for (let attempt = 0; ; attempt++) {
					try {
						return owned(
							await rpc("GET", `${base}/${expectedId}`, undefined, signal),
						);
					} catch (error) {
						signal.throwIfAborted();
						if (
							!retry ||
							attempt >= 2 ||
							!(error instanceof LocalSemanticTransportError) ||
							!error.retryable
						)
							throw error;
						await wait(signal);
					}
				}
			};
			try {
				let response = await rpc("POST", base, body, input.signal);
				for (;;) {
					input.signal.throwIfAborted();
					const job = owned(response);
					if (job.state === "SUCCEEDED") {
						const result = job.result,
							receipt = result?.receipt;
						if (
							!result ||
							!receipt ||
							!job.cleanupConfirmed ||
							hashEditingEvidence(receipt.identity) !==
								hashEditingEvidence(identity) ||
							receipt.inputHash !== body.inputHash ||
							receipt.schemaHash !== body.schemaHash ||
							receipt.manifestHash !== body.manifestHash ||
							receipt.requestHash !== expectedHash ||
							receipt.promptHash !==
								createHash("sha256").update(body.prompt).digest("hex")
						)
							throw new MediaOperationError(
								"LOCAL_SEMANTIC_RECEIPT_UNVERIFIED",
							);
						return { content: result.content, receipt };
					}
					if (job.state === "FAILED" || job.state === "CANCELLED")
						throw new MediaOperationError("LOCAL_SEMANTIC_JOB_FAILED");
					await wait(input.signal);
					response = await read(input.signal, true);
				}
			} catch (failure) {
				// No repeated create POST: UUID5 permits cancellation even after an ambiguous acceptance.
				const cleanup = AbortSignal.timeout(30_000);
				try {
					let tombstoned = false,
						confirmed = false;
					try {
						owned(
							await rpc("POST", `${base}/${expectedId}/cancel`, {}, cleanup),
						);
					} catch (error) {
						if (
							error instanceof LocalSemanticHttpError &&
							error.status === 404 &&
							error.gatewayCode === "JOB_NOT_FOUND"
						)
							tombstoned = true;
						else throw error;
					}
					while (!tombstoned && !cleanup.aborted) {
						const job = await read(cleanup, false);
						if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(job.state)) {
							if (!job.cleanupConfirmed) throw new Error("release unconfirmed");
							confirmed = true;
							break;
						}
						await wait(cleanup);
					}
					if (!tombstoned && !confirmed) throw new Error("cleanup deadline");
				} catch {
					throw new MediaOperationError("LOCAL_SEMANTIC_CANCEL_UNCONFIRMED");
				}
				throw failure;
			}
		},
	};
}
