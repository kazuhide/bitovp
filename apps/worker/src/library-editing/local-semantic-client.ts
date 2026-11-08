import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import {
	hashEditingEvidence,
	LOCAL_SEMANTIC_OUTPUT_TOKENS,
	type LocalSemanticConfiguration,
	type LocalSemanticJob,
	type LocalSemanticReceipt,
	type LocalSemanticStage,
	localSemanticJobSchema,
	localSemanticPromptVersion,
	localSemanticStageSchema,
} from "@bitovp/core";
import { MediaOperationError } from "./process";

export type SemanticRpc = (
	method: "GET" | "POST",
	path: string,
	body: unknown | undefined,
	signal: AbortSignal,
) => Promise<unknown>;
export class LocalSemanticHttpError extends Error {
	constructor(
		readonly status: number,
		readonly gatewayCode?: string,
	) {
		super("LOCAL_SEMANTIC_GATEWAY_HTTP");
	}
}
const nativeTerminalCodes = new Set([
	"CANCELED",
	"CLEANUP_FAILED",
	"DEADLINE",
	"GATEWAY_STOPPING",
	"GPU_PLACEMENT_UNVERIFIED",
	"LEASE_LOST",
	"NOT_CAPABLE",
	"OUTPUT_INVALID",
	"RESOURCE_BUSY",
	"RESTARTED",
	"RUNTIME_FAILED",
	"RUNTIME_QUARANTINED",
	"RUNTIME_STOP_UNCONFIRMED",
]);
// Only known, temporary socket/DNS failures permit another read of the same job.
const transientTransportCodes = new Set([
	"ECONNRESET",
	"ETIMEDOUT",
	"EPIPE",
	"ECONNREFUSED",
	"EAI_AGAIN",
]);
const transportCodes = new Set([
	...transientTransportCodes,
	"ABORT_ERR",
	"ENOTFOUND",
	"ERR_TLS_CERT_ALTNAME_INVALID",
	"CERT_HAS_EXPIRED",
	"CERT_NOT_YET_VALID",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);
export class LocalSemanticTransportError extends MediaOperationError {
	readonly osCode: string;
	readonly retryable: boolean;
	constructor(code: unknown) {
		super("LOCAL_SEMANTIC_UNAVAILABLE");
		this.osCode =
			typeof code === "string" && transportCodes.has(code)
				? code
				: "UNKNOWN_TRANSPORT";
		this.retryable = transientTransportCodes.has(this.osCode);
	}
}
export function createLocalSemanticRpc(
	config: LocalSemanticConfiguration,
): SemanticRpc {
	const ca = readFileSync(config.caFile);
	return (method, path, body, signal) =>
		new Promise((resolve, reject) => {
			const timeout = AbortSignal.timeout(15_000);
			let httpError: LocalSemanticHttpError | undefined;
			const transportError = (error: unknown) => {
				if (httpError) return httpError;
				const code =
					error && typeof error === "object" && "code" in error
						? error.code
						: undefined;
				return new LocalSemanticTransportError(
					code === "ABORT_ERR" && timeout.aborted && !signal.aborted
						? "ETIMEDOUT"
						: code,
				);
			};
			const bytes =
				body === undefined ? undefined : Buffer.from(JSON.stringify(body));
			const req = request(
				new URL(path, config.url),
				{
					method,
					ca,
					rejectUnauthorized: true,
					agent: false,
					signal: AbortSignal.any([signal, timeout]),
					headers: {
						authorization: `Bearer ${config.token}`,
						accept: "application/json",
						...(bytes
							? {
									"content-type": "application/json",
									"content-length": bytes.length,
								}
							: {}),
					},
				},
				(res) => {
					if (
						!res.statusCode ||
						res.statusCode < 200 ||
						res.statusCode >= 300
					) {
						const status = res.statusCode ?? 0;
						httpError = new LocalSemanticHttpError(status);
						let raw = "";
						res.setEncoding("utf8");
						res.on("error", () => reject(new LocalSemanticHttpError(status)));
						res.on("data", (chunk: string) => {
							raw += chunk;
							if (Buffer.byteLength(raw) > 4096)
								res.destroy(new Error("response limit"));
						});
						res.on("end", () => {
							let code: string | undefined;
							try {
								const value: unknown = JSON.parse(raw);
								if (
									value &&
									typeof value === "object" &&
									"error" in value &&
									value.error &&
									typeof value.error === "object" &&
									"code" in value.error &&
									typeof value.error.code === "string" &&
									/^[A-Z][A-Z0-9_]{0,95}$/.test(value.error.code)
								)
									code = value.error.code;
							} catch {
								/* HTTP status is sufficient for an untrusted error body. */
							}
							reject(new LocalSemanticHttpError(status, code));
						});
						return;
					}
					let size = 0;
					const chunks: Buffer[] = [];
					res.on("error", (error) => reject(transportError(error)));
					res.on("data", (chunk: Buffer) => {
						size += chunk.length;
						if (size > 256 * 1024) {
							reject(new MediaOperationError("LOCAL_SEMANTIC_RESPONSE_LIMIT"));
							res.destroy();
						} else chunks.push(chunk);
					});
					res.on("end", () => {
						try {
							resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
						} catch {
							reject(
								new MediaOperationError("LOCAL_SEMANTIC_RESPONSE_INVALID"),
							);
						}
					});
				},
			);
			req.on("error", (error) => reject(transportError(error)));
			req.end(bytes);
		});
}

/** RFC 4122 UUID5, also used by the Gateway for cancellation-before-acceptance. */
export function localSemanticJobId(organizationId: string, requestKey: string) {
	const bytes = createHash("sha1")
		.update(Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex"))
		.update(`bitovp-semantic:${organizationId}:${requestKey}`)
		.digest()
		.subarray(0, 16);
	bytes[6] = ((bytes[6] ?? 0) & 15) | 0x50;
	bytes[8] = ((bytes[8] ?? 0) & 63) | 0x80;
	const h = bytes.toString("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export type LocalSemanticRunInput = {
	organizationId: string;
	requestKey: string;
	stage: LocalSemanticStage;
	prompt: string;
	inputHash: string;
	schemaHash: string;
	signal: AbortSignal;
};
export type LocalSemanticObservedResult = {
	content: unknown;
	receipt: LocalSemanticReceipt;
	terminalJob: LocalSemanticJob;
};

export type LocalSemanticCleanupInput = {
	jobId: string;
	stage: LocalSemanticStage;
	requestHash: string;
};
type LocalSemanticCleanupState = "SUCCEEDED" | "FAILED" | "CANCELLED";
export type LocalSemanticCleanupResult =
	| { cleanupConfirmed: true; outcome: "TOMBSTONED" }
	| {
			cleanupConfirmed: true;
			outcome: "TERMINAL";
			state: LocalSemanticCleanupState;
	  };

/** Only independently owned reservation metadata may reach this worker-only API. */
function cleanupInput(value: unknown): LocalSemanticCleanupInput {
	try {
		if (
			!value ||
			typeof value !== "object" ||
			Object.getPrototypeOf(value) !== Object.prototype ||
			Object.getOwnPropertySymbols(value).length
		)
			throw new Error();
		const d = Object.getOwnPropertyDescriptors(value),
			fields = ["jobId", "stage", "requestHash"];
		if (
			Object.keys(d).length !== fields.length ||
			!fields.every((field) => Object.hasOwn(d, field))
		)
			throw new Error();
		for (const item of Object.values(d))
			if (!item.enumerable || !("value" in item)) throw new Error();
		const jobId = localSemanticJobSchema.shape.id.parse(d.jobId?.value);
		const stage = localSemanticStageSchema.parse(d.stage?.value);
		const requestHash: unknown = d.requestHash?.value;
		if (
			typeof requestHash !== "string" ||
			requestHash.length !== 64 ||
			!/^[a-f0-9]{64}$/.test(requestHash)
		)
			throw new Error();
		return { jobId, stage, requestHash };
	} catch {
		throw new MediaOperationError("LOCAL_SEMANTIC_CANCEL_UNCONFIRMED");
	}
}

export function createLocalSemanticClient(
	config: LocalSemanticConfiguration,
	dependencies: {
		rpc?: SemanticRpc;
		wait?: (signal: AbortSignal) => Promise<void>;
	} = {},
) {
	const rpc = dependencies.rpc ?? createLocalSemanticRpc(config);
	const wait =
		dependencies.wait ??
		((signal: AbortSignal) => delay(1000, undefined, { signal }));
	function operations(known: LocalSemanticCleanupInput) {
		const expectedId = known.jobId,
			expectedHash = known.requestHash;
		const ownedJob = (value: unknown) => {
			const parsed = localSemanticJobSchema.safeParse(value);
			if (
				!parsed.success ||
				parsed.data.id !== expectedId ||
				parsed.data.stage !== known.stage ||
				parsed.data.requestHash !== expectedHash
			)
				throw new MediaOperationError("LOCAL_SEMANTIC_RESPONSE_UNVERIFIED");
			return parsed.data;
		};
		const reportTransport = (
			error: LocalSemanticTransportError,
			retryCount: number,
			retryAllowed: boolean,
		) => {
			try {
				console.warn(
					JSON.stringify({
						event: "LOCAL_SEMANTIC_TRANSPORT",
						stage: known.stage,
						jobId: expectedId,
						osCode: error.osCode,
						retryCount,
						retryAllowed,
					}),
				);
			} catch {
				/* Diagnostics never alter retries, original failures or independent cleanup. */
			}
		};
		const postOnce = async (
			path: string,
			value: unknown,
			signal: AbortSignal,
		) => {
			try {
				return await rpc("POST", path, value, signal);
			} catch (error) {
				if (error instanceof LocalSemanticTransportError)
					reportTransport(error, 0, false);
				throw error;
			}
		};
		const readStatus = async (signal: AbortSignal, retryTransient: boolean) => {
			const attempts = retryTransient ? 3 : 1;
			for (let attempt = 1; ; attempt++) {
				signal.throwIfAborted();
				try {
					return ownedJob(
						await rpc(
							"GET",
							`/v1/semantic-jobs/${expectedId}`,
							undefined,
							signal,
						),
					);
				} catch (error) {
					const retryAllowed =
						error instanceof LocalSemanticTransportError &&
						error.retryable &&
						!signal.aborted &&
						attempt < attempts;
					if (error instanceof LocalSemanticTransportError)
						reportTransport(error, attempt - 1, retryAllowed);
					signal.throwIfAborted();
					if (!retryAllowed) throw error;
					await wait(signal);
				}
			}
		};
		async function confirmCleanup(): Promise<LocalSemanticCleanupResult> {
			const cleanup = AbortSignal.timeout(30_000);
			try {
				let tombstoned = false,
					terminalState: LocalSemanticCleanupState | undefined;
				try {
					ownedJob(
						await postOnce(
							`/v1/semantic-jobs/${expectedId}/cancel`,
							{},
							cleanup,
						),
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
					const state = await readStatus(cleanup, false);
					if (
						state.state === "SUCCEEDED" ||
						state.state === "FAILED" ||
						state.state === "CANCELLED"
					) {
						if (!state.cleanupConfirmed) throw new Error("cleanup uncertain");
						terminalState = state.state;
						break;
					}
					await wait(cleanup);
				}
				if (!tombstoned && !terminalState) throw new Error("cleanup deadline");
				if (tombstoned)
					return { cleanupConfirmed: true, outcome: "TOMBSTONED" };
				if (!terminalState) throw new Error("cleanup state");
				return {
					cleanupConfirmed: true,
					outcome: "TERMINAL",
					state: terminalState,
				};
			} catch {
				throw new MediaOperationError("LOCAL_SEMANTIC_CANCEL_UNCONFIRMED");
			}
		}
		return { ownedJob, postOnce, readStatus, confirmCleanup };
	}

	async function execute(
		input: LocalSemanticRunInput,
	): Promise<LocalSemanticObservedResult> {
		input.signal.throwIfAborted();
		const maxTokens = LOCAL_SEMANTIC_OUTPUT_TOKENS[input.stage];
		// A UTF-8 byte upper bound leaves room for output and chat/template tokens.
		if (Buffer.byteLength(input.prompt) > 8192 - maxTokens - 1024)
			throw new MediaOperationError("LOCAL_STORY_CONTEXT_LIMIT");
		const body = {
			version: "bitovp-semantic-job-v1",
			requestKey: input.requestKey,
			organizationId: input.organizationId,
			profile: config.profile,
			stage: input.stage,
			prompt: input.prompt,
			inputHash: input.inputHash,
			promptVersion: localSemanticPromptVersion(input.stage),
			schemaHash: input.schemaHash,
		};
		const expectedId = localSemanticJobId(
			input.organizationId,
			input.requestKey,
		);
		const expectedHash = hashEditingEvidence(body);
		const { ownedJob, postOnce, readStatus, confirmCleanup } = operations({
			jobId: expectedId,
			stage: input.stage,
			requestHash: expectedHash,
		});
		try {
			let response = await postOnce("/v1/semantic-jobs", body, input.signal);
			for (;;) {
				input.signal.throwIfAborted();
				const job = ownedJob(response);
				if (job.state === "SUCCEEDED") {
					const result = job.result,
						receipt = result?.receipt;
					if (
						!result ||
						!receipt ||
						!job.cleanupConfirmed ||
						receipt.profile !== config.profile ||
						receipt.inputHash !== input.inputHash ||
						receipt.schemaHash !== input.schemaHash ||
						receipt.requestHash !== expectedHash ||
						receipt.maxOutputTokens !== maxTokens ||
						receipt.promptVersion !== body.promptVersion ||
						receipt.promptHash !==
							createHash("sha256").update(input.prompt).digest("hex")
					)
						throw new MediaOperationError("LOCAL_SEMANTIC_RECEIPT_UNVERIFIED");
					const terminalJob = structuredClone({ ...job, result });
					const content: unknown = JSON.parse(terminalJob.result.content);
					input.signal.throwIfAborted();
					return { content, receipt: structuredClone(receipt), terminalJob };
				}
				if (job.state === "FAILED" || job.state === "CANCELLED") {
					try {
						console.warn(
							JSON.stringify({
								event: "LOCAL_SEMANTIC_JOB_TERMINAL",
								stage: input.stage,
								jobId: expectedId,
								state: job.state,
								cleanupConfirmed: job.cleanupConfirmed,
								errorCode: !job.errorCode
									? "UNREPORTED_NATIVE_ERROR"
									: nativeTerminalCodes.has(job.errorCode)
										? job.errorCode
										: "UNCLASSIFIED_NATIVE_ERROR",
							}),
						);
					} catch {
						// Diagnostics must not change the failure or independent cleanup.
					}
					throw new MediaOperationError("LOCAL_SEMANTIC_JOB_FAILED");
				}
				await wait(input.signal);
				response = await readStatus(input.signal, true);
			}
		} catch (failure) {
			// A deterministic ID lets the server tombstone a late POST as well.
			await confirmCleanup();
			throw failure;
		}
	}
	return {
		async run(
			input: LocalSemanticRunInput,
		): Promise<{ content: unknown; receipt: LocalSemanticReceipt }> {
			const observed = await execute(input);
			return { content: observed.content, receipt: observed.receipt };
		},
		runObserved: execute,
		async cleanupOnly(
			input: LocalSemanticCleanupInput,
		): Promise<LocalSemanticCleanupResult> {
			return operations(cleanupInput(input)).confirmCleanup();
		},
	};
}
