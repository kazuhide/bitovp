import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	hashEditingEvidence,
	LOCAL_SEMANTIC_MODEL,
	LOCAL_SEMANTIC_MODEL_DIGEST,
	type LocalSemanticStage,
	localSemanticReceiptSchema,
} from "@bitovp/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createLocalSemanticClient,
	LocalSemanticHttpError,
	LocalSemanticTransportError,
	localSemanticJobId,
	type SemanticRpc,
} from "./local-semantic-client";

const https = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: https.request }));
const temporaryDirectories: string[] = [];
beforeEach(() => https.request.mockReset());
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((p) => rm(p, { recursive: true, force: true })),
	);
});

const config = {
	url: "https://fixture.invalid",
	token: "x".repeat(40),
	caFile: "/fixture/ca.pem",
	profile: "nvidia" as const,
	configId: randomUUID(),
};
function fixture(
	change?: (job: Record<string, unknown>) => unknown,
	stage: LocalSemanticStage = "LOCAL_LEDGER_V1",
	profile: "amd" | "nvidia" = config.profile,
) {
	const controller = new AbortController(),
		organizationId = randomUUID(),
		requestKey = randomUUID();
	const input = {
		organizationId,
		requestKey,
		stage,
		prompt: "Evidence only",
		inputHash: "a".repeat(64),
		schemaHash: "b".repeat(64),
		signal: controller.signal,
	};
	let canceled = false;
	let body: Record<string, unknown>;
	const rpc = vi.fn<SemanticRpc>(async (method, path, value, signal) => {
		if (path.endsWith("/cancel")) {
			expect(signal.aborted).toBe(false);
			canceled = true;
		}
		if (path === "/v1/semantic-jobs") body = value as Record<string, unknown>;
		const base = {
			id: localSemanticJobId(organizationId, requestKey),
			stage: input.stage,
			requestHash: hashEditingEvidence(body),
			cleanupConfirmed: false,
		};
		if (canceled)
			return { ...base, state: "CANCELLED", cleanupConfirmed: true };
		if (method === "POST") return { ...base, state: "QUEUED" };
		const result = {
			...base,
			state: "SUCCEEDED",
			cleanupConfirmed: true,
			result: {
				content: '{"summary":"recorded"}',
				receipt: {
					version: "bitovp-semantic-receipt-v1",
					profile,
					model: LOCAL_SEMANTIC_MODEL,
					modelDigest: LOCAL_SEMANTIC_MODEL_DIGEST,
					runtimeVersion: "0.40.14",
					inputHash: input.inputHash,
					promptHash: createHash("sha256").update(input.prompt).digest("hex"),
					schemaHash: input.schemaHash,
					promptVersion: "local-story-v1",
					context: 8192,
					maxOutputTokens: 1024,
					thinking: false,
					requestHash: base.requestHash,
					elapsedMs: 12,
					apiStats: {
						promptEvalCount: 10,
						evalCount: 8,
						doneReason: "stop",
						loadDurationNs: 1,
						promptEvalDurationNs: 1,
						evalDurationNs: 1,
					},
					placement: [
						{
							name: LOCAL_SEMANTIC_MODEL,
							size: 29_000_000_000,
							sizeVram: 14_000_000_000,
							contextLength: 8192,
						},
					],
					cleanupConfirmed: true,
					schemaVerified: false,
				},
			},
		};
		return change ? change(result) : result;
	});
	return {
		rpc,
		input,
		controller,
		client: createLocalSemanticClient(
			{ ...config, profile },
			{ rpc, wait: async () => {} },
		),
	};
}
describe("additive native story-choice receipts", () => {
	it.each([
		"amd",
		"nvidia",
	] as const)("binds the new prompt and 512-token receipt on %s without using the legacy prompt version", async (profile) => {
		const f = fixture(
			(job) => {
				const result = job.result as {
					content: string;
					receipt: Record<string, unknown>;
				};
				result.content = JSON.stringify({
					planId: "p0",
					message: "出来事の紹介",
					uncertainty: "",
				});
				result.receipt.promptVersion = "local-story-choice-v1";
				result.receipt.maxOutputTokens = 512;
				return job;
			},
			"LOCAL_STORY_CHOICE_V1",
			profile,
		);
		const result = await f.client.run(f.input);
		expect(result.receipt.promptVersion).toBe("local-story-choice-v1");
		expect(result.receipt.maxOutputTokens).toBe(512);
		expect(f.rpc.mock.calls[0]?.[2]).toMatchObject({
			stage: "LOCAL_STORY_CHOICE_V1",
			promptVersion: "local-story-choice-v1",
		});
		expect(f.rpc.mock.calls.map((call) => call[0])).toEqual(["POST", "GET"]);
	});
});

describe("observed native result capture", () => {
	it.each([
		"owner",
		"receipt",
		"json",
	] as const)("preserves %s rejection and the original independent cleanup on runObserved", async (fault) => {
		const f = fixture((job) => {
			if (fault === "owner") job.requestHash = "f".repeat(64);
			else if (fault === "receipt")
				(job.result as { receipt: Record<string, unknown> }).receipt.inputHash =
					"f".repeat(64);
			else
				(job.result as { content: string }).content = "{synthetic invalid JSON";
			return job;
		});
		const result = f.client.runObserved(f.input);
		if (fault === "json")
			await expect(result).rejects.toBeInstanceOf(SyntaxError);
		else
			await expect(result).rejects.toMatchObject({
				code:
					fault === "owner"
						? "LOCAL_SEMANTIC_RESPONSE_UNVERIFIED"
						: "LOCAL_SEMANTIC_RECEIPT_UNVERIFIED",
			});
		expect(f.rpc.mock.calls.map((c) => c[0])).toEqual([
			"POST",
			"GET",
			"POST",
			"GET",
		]);
	});
	it("keeps S0 above a caller abort if cleanup cannot confirm stopping", async () => {
		const f = fixture(),
			original = f.rpc.getMockImplementation();
		if (!original) throw new Error("Missing synthetic client");
		let cancelPosted = false;
		f.rpc.mockImplementation(async (...args) => {
			if (args[1].endsWith("/cancel")) cancelPosted = true;
			else if (cancelPosted) throw new LocalSemanticHttpError(404);
			return original(...args);
		});
		const client = createLocalSemanticClient(config, {
			rpc: f.rpc,
			wait: async () => f.controller.abort(new Error("PARENT_ABORT")),
		});
		await expect(client.runObserved(f.input)).rejects.toMatchObject({
			code: "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
		});
		expect(
			f.rpc.mock.calls.filter((c) => c[1] === "/v1/semantic-jobs"),
		).toHaveLength(1);
	});
	it.each([
		["LOCAL_LEDGER_V1", "local-story-v1", 1024],
		["LOCAL_FLOW_CONTEXT_V1", "local-story-flow-context-v1", 1536],
		["LOCAL_FLOW_ROUTE_V1", "local-story-flow-route-v1", 1536],
	] as const)("captures the full owned %s result once with the old projection and RPC count", async (stage, promptVersion, maxOutputTokens) => {
		let wire: Record<string, unknown> | undefined;
		const rawContent = ' \n{"exact":"合成\\n入力","number":0.125}\n';
		const f = fixture((job) => {
			wire = job;
			const result = job.result as {
				content: string;
				receipt: Record<string, unknown>;
			};
			result.content = rawContent;
			Object.assign(result.receipt, { promptVersion, maxOutputTokens });
			return job;
		}, stage);
		const old = await f.client.run(f.input);
		expect(Object.keys(old).sort()).toEqual(["content", "receipt"]);
		const calls = f.rpc.mock.calls.map((c) => [c[0], c[1]]);
		f.rpc.mockClear();
		const clones = vi.spyOn(globalThis, "structuredClone");
		const observed = await f.client.runObserved(f.input);
		expect(Object.keys(observed).sort()).toEqual([
			"content",
			"receipt",
			"terminalJob",
		]);
		expect({ content: observed.content, receipt: observed.receipt }).toEqual(
			old,
		);
		expect(f.rpc.mock.calls.map((c) => [c[0], c[1]])).toEqual(calls);
		expect(observed.terminalJob).toMatchObject({
			id: localSemanticJobId(f.input.organizationId, f.input.requestKey),
			state: "SUCCEEDED",
			stage,
			cleanupConfirmed: true,
			result: { content: rawContent, receipt: old.receipt },
		});
		expect(
			clones.mock.calls.filter(
				([value]) =>
					value &&
					typeof value === "object" &&
					"state" in value &&
					value.state === "SUCCEEDED",
			),
		).toHaveLength(1);
		expect(observed.receipt).not.toBe(observed.terminalJob.result?.receipt);
		observed.receipt.apiStats.evalCount = 999;
		expect(observed.terminalJob.result?.receipt.apiStats.evalCount).toBe(8);
		if (!wire) throw new Error("Missing synthetic terminal response");
		(wire.result as { content: string }).content = "mutated wire object";
		expect(observed.terminalJob.result?.content).toBe(rawContent);
	});
	it("does not capture or publish a late success after the caller aborts", async () => {
		const f = fixture((job) => {
			f.controller.abort(new Error("PARENT_CANCELED"));
			return job;
		});
		const clones = vi.spyOn(globalThis, "structuredClone");
		await expect(f.client.runObserved(f.input)).rejects.toThrow(
			"PARENT_CANCELED",
		);
		expect(
			clones.mock.calls.filter(
				([value]) =>
					value &&
					typeof value === "object" &&
					"state" in value &&
					value.state === "SUCCEEDED",
			),
		).toHaveLength(0);
		expect(f.rpc.mock.calls.map((c) => c[0])).toEqual([
			"POST",
			"GET",
			"POST",
			"GET",
		]);
		expect(f.rpc.mock.calls.at(-1)?.[3]).not.toBe(f.input.signal);
		expect(f.rpc.mock.calls.at(-1)?.[3].aborted).toBe(false);
	});
});
type CleanupState = "SUCCEEDED" | "FAILED" | "CANCELLED";
function cleanupFixture(
	state: CleanupState = "CANCELLED",
	change?: (
		job: Record<string, unknown>,
		method: "GET" | "POST",
	) => Record<string, unknown>,
	wait: (signal: AbortSignal) => Promise<void> = async () => {},
) {
	const known = {
		jobId: localSemanticJobId(randomUUID(), randomUUID()),
		stage: "LOCAL_FLOW_ROUTE_V1" as const,
		requestHash: "a".repeat(64),
	};
	const rpc = vi.fn<SemanticRpc>(async (method, path, body, signal) => {
		expect(signal.aborted).toBe(false);
		expect(path).toBe(
			"/v1/semantic-jobs/" + known.jobId + (method === "POST" ? "/cancel" : ""),
		);
		expect(body).toEqual(method === "POST" ? {} : undefined);
		const result = {
			id: known.jobId,
			stage: known.stage,
			requestHash: known.requestHash,
			state: method === "POST" ? "CANCELLING" : state,
			cleanupConfirmed: method === "GET",
			...(method === "GET" && state === "SUCCEEDED"
				? {
						result: {
							content:
								'{"privateNativeBody":"must not be returned by cleanup"}',
							receipt: {
								version: "bitovp-semantic-receipt-v1",
								profile: "nvidia",
								model: LOCAL_SEMANTIC_MODEL,
								modelDigest: LOCAL_SEMANTIC_MODEL_DIGEST,
								runtimeVersion: "0.40.14",
								inputHash: "b".repeat(64),
								promptHash: "c".repeat(64),
								schemaHash: "d".repeat(64),
								promptVersion: "local-story-flow-route-v1",
								context: 8192,
								maxOutputTokens: 1536,
								thinking: false,
								requestHash: known.requestHash,
								elapsedMs: 12,
								apiStats: {
									promptEvalCount: 10,
									evalCount: 8,
									doneReason: "stop",
									loadDurationNs: 1,
									promptEvalDurationNs: 1,
									evalDurationNs: 1,
								},
								placement: [
									{
										name: LOCAL_SEMANTIC_MODEL,
										size: 2,
										sizeVram: 1,
										contextLength: 8192,
									},
								],
								cleanupConfirmed: true,
								schemaVerified: false,
							},
						},
					}
				: {}),
		};
		return change ? change(result, method) : result;
	});
	return {
		known,
		rpc,
		client: createLocalSemanticClient(config, { rpc, wait }),
	};
}
describe("cleanup-only known reservation recovery", () => {
	beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
	it.each([
		"SUCCEEDED",
		"FAILED",
		"CANCELLED",
	] as const)("confirms only stopping for owned terminal %s with no create or result admission", async (state) => {
		const f = cleanupFixture(state);
		expect(await f.client.cleanupOnly(f.known)).toEqual({
			cleanupConfirmed: true,
			outcome: "TERMINAL",
			state,
		});
		expect(f.rpc.mock.calls.map((c) => c[0])).toEqual(["POST", "GET"]);
		expect(f.rpc.mock.calls.every((c) => c[1] !== "/v1/semantic-jobs")).toBe(
			true,
		);
		expect(f.rpc.mock.calls[0]?.[3]).toBe(f.rpc.mock.calls[1]?.[3]);
	});
	it("accepts only an explicit cancel-endpoint tombstone", async () => {
		const f = cleanupFixture();
		f.rpc.mockImplementation(async () => {
			throw new LocalSemanticHttpError(404, "JOB_NOT_FOUND");
		});
		expect(await f.client.cleanupOnly(f.known)).toEqual({
			cleanupConfirmed: true,
			outcome: "TOMBSTONED",
		});
		expect(f.rpc).toHaveBeenCalledTimes(1);
		for (const code of [undefined, "NOT_FOUND"]) {
			const bad = cleanupFixture();
			bad.rpc.mockImplementation(async () => {
				throw new LocalSemanticHttpError(404, code);
			});
			await expect(bad.client.cleanupOnly(bad.known)).rejects.toMatchObject({
				code: "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
			});
			expect(bad.rpc).toHaveBeenCalledTimes(1);
		}
		const polling = cleanupFixture();
		const original = polling.rpc.getMockImplementation();
		if (!original) throw new Error("Missing synthetic cleanup");
		polling.rpc.mockImplementation(async (...args) => {
			if (args[0] === "GET")
				throw new LocalSemanticHttpError(404, "JOB_NOT_FOUND");
			return original(...args);
		});
		await expect(
			polling.client.cleanupOnly(polling.known),
		).rejects.toMatchObject({ code: "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED" });
		expect(polling.rpc.mock.calls.map((c) => c[0])).toEqual(["POST", "GET"]);
	});
	it.each([
		"GET",
		"POST",
	] as const)("refuses a foreign owner at the %s response", async (point) => {
		for (const field of ["id", "stage", "requestHash"] as const) {
			const f = cleanupFixture("SUCCEEDED", (job, method) =>
				method === point
					? {
							...job,
							[field]:
								field === "id"
									? randomUUID()
									: field === "stage"
										? "LOCAL_LEDGER_V1"
										: "f".repeat(64),
						}
					: job,
			);
			await expect(f.client.cleanupOnly(f.known)).rejects.toMatchObject({
				code: "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
			});
			expect(f.rpc).toHaveBeenCalledTimes(point === "POST" ? 1 : 2);
		}
	});
	it("refuses a terminal job whose cleanup remains unconfirmed", async () => {
		const f = cleanupFixture("SUCCEEDED", (job) => ({
			...job,
			cleanupConfirmed: false,
		}));
		await expect(f.client.cleanupOnly(f.known)).rejects.toMatchObject({
			code: "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
		});
		expect(f.rpc.mock.calls.map((c) => c[0])).toEqual(["POST", "GET"]);
	});
	it.each([
		"GET",
		"POST",
	] as const)("does not retry a lost cleanup %s", async (point) => {
		const f = cleanupFixture(),
			original = f.rpc.getMockImplementation();
		if (!original) throw new Error("Missing synthetic cleanup");
		f.rpc.mockImplementation(async (...args) => {
			if (args[0] === point)
				throw new LocalSemanticTransportError("ECONNRESET");
			return original(...args);
		});
		await expect(f.client.cleanupOnly(f.known)).rejects.toMatchObject({
			code: "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
		});
		expect(f.rpc).toHaveBeenCalledTimes(point === "POST" ? 1 : 2);
	});
	it("uses only a bounded independent cleanup deadline even after a caller has aborted", async () => {
		const parent = new AbortController(),
			deadline = new AbortController();
		parent.abort(new Error("PARENT_ABORTED"));
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockImplementation(() => deadline.signal);
		const f = cleanupFixture(
			"CANCELLED",
			(job, method) =>
				method === "GET"
					? { ...job, state: "RUNNING", cleanupConfirmed: false }
					: job,
			async (signal) => {
				expect(signal).toBe(deadline.signal);
				expect(signal).not.toBe(parent.signal);
				deadline.abort();
			},
		);
		await expect(f.client.cleanupOnly(f.known)).rejects.toMatchObject({
			code: "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
		});
		expect(timeout).toHaveBeenCalledExactlyOnceWith(30_000);
		expect(f.rpc.mock.calls.map((c) => c[0])).toEqual(["POST", "GET"]);
	});
	it("rejects malformed known metadata and accessors with no RPC or leaked cause", async () => {
		const f = cleanupFixture();
		let reads = 0;
		const getter = Object.defineProperty({ ...f.known }, "jobId", {
			enumerable: true,
			get: () => {
				reads++;
				throw new Error("PRIVATE_KNOWN_JOB");
			},
		});
		for (const value of [
			null,
			getter,
			{ ...f.known, jobId: "../../other" },
			{ ...f.known, requestHash: "a".repeat(63) },
			{ ...f.known, stage: "UNKNOWN" },
			{ ...f.known, prompt: "forbidden source" },
		])
			await expect(
				Reflect.apply(f.client.cleanupOnly, null, [value]),
			).rejects.toMatchObject({ code: "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED" });
		expect(f.rpc).not.toHaveBeenCalled();
		expect(reads).toBe(0);
	});
});
describe("best-effort transport diagnostics", () => {
	it("keeps the existing GET recovery if the diagnostic sink throws", async () => {
		const f = fixture(),
			original = f.rpc.getMockImplementation();
		if (!original) throw new Error("Missing synthetic client");
		vi.spyOn(console, "warn").mockImplementation(() => {
			throw new Error("PRIVATE_SINK_FAILURE");
		});
		let failed = false;
		f.rpc.mockImplementation(async (...args) => {
			if (args[0] === "GET" && !failed) {
				failed = true;
				throw new LocalSemanticTransportError("ECONNRESET");
			}
			return original(...args);
		});
		await expect(f.client.runObserved(f.input)).resolves.toMatchObject({
			content: { summary: "recorded" },
		});
		expect(f.rpc.mock.calls.map((c) => c[0])).toEqual(["POST", "GET", "GET"]);
	});
});
describe("authenticated local semantic client protocol", () => {
	it.each(
		(
			[
				["LOCAL_FLOW_CONTEXT_V1", "local-story-flow-context-v1"],
				["LOCAL_FLOW_ROUTE_V1", "local-story-flow-route-v1"],
			] as const
		).flatMap(([stage, promptVersion]) =>
			(["amd", "nvidia"] as const).map((profile) => ({
				stage,
				promptVersion,
				profile,
			})),
		),
	)("runs $stage on $profile with one create and the registered receipt", async ({
		stage,
		promptVersion,
		profile,
	}) => {
		const change = (job: Record<string, unknown>) => {
			const receipt = (job.result as { receipt: Record<string, unknown> })
				.receipt;
			receipt.promptVersion = promptVersion;
			receipt.maxOutputTokens = 1536;
			return job;
		};
		const f = fixture(change, stage, profile);
		const result = await f.client.run(f.input);
		expect(result.receipt).toMatchObject({
			profile,
			promptVersion,
			maxOutputTokens: 1536,
			context: 8192,
		});
		expect(
			f.rpc.mock.calls.filter(
				(c) => c[0] === "POST" && c[1] === "/v1/semantic-jobs",
			),
		).toHaveLength(1);
		expect(f.rpc.mock.calls[0]?.[2]).toMatchObject({
			stage,
			profile,
			promptVersion,
		});
		expect(f.rpc.mock.calls.some((c) => c[1].endsWith("/cancel"))).toBe(false);
		const bad = fixture(
			(job) => {
				change(job);
				(
					job.result as { receipt: Record<string, unknown> }
				).receipt.promptVersion = "local-story-v1";
				return job;
			},
			stage,
			profile,
		);
		await expect(bad.client.run(bad.input)).rejects.toMatchObject({
			code: "LOCAL_SEMANTIC_RECEIPT_UNVERIFIED",
		});
		expect(
			bad.rpc.mock.calls.filter((c) => c[1].endsWith("/cancel")),
		).toHaveLength(1);
	});
	it.each([
		["LOCAL_FLOW_CONTEXT_V1", "local-story-flow-context-v1"],
		["LOCAL_FLOW_ROUTE_V1", "local-story-flow-route-v1"],
	] as const)("enforces the exact 5632-byte prompt budget before sending %s", async (stage, promptVersion) => {
		const change = (job: Record<string, unknown>) => {
			Object.assign(
				(job.result as { receipt: Record<string, unknown> }).receipt,
				{ promptVersion, maxOutputTokens: 1536 },
			);
			return job;
		};
		const f = fixture(change, stage);
		f.input.prompt = "あ".repeat(1877) + "x";
		expect(Buffer.byteLength(f.input.prompt)).toBe(5632);
		await expect(f.client.run(f.input)).resolves.toMatchObject({
			receipt: { maxOutputTokens: 1536 },
		});
		const over = fixture(change, stage);
		over.input.prompt = f.input.prompt + "x";
		await expect(over.client.run(over.input)).rejects.toMatchObject({
			code: "LOCAL_STORY_CONTEXT_LIMIT",
		});
		expect(over.rpc).not.toHaveBeenCalled();
	});
	it.each([
		["LOCAL_CAPTION_JA_V1", "caption-ja-v1"],
		["LOCAL_CAPTION_JA_V2", "caption-ja-v2"],
	] as const)("uses %s's independent prompt identity and rejects an old-stage receipt", async (stage, promptVersion) => {
		const change = (job: Record<string, unknown>) => {
			const receipt = (job.result as { receipt: Record<string, unknown> })
				.receipt;
			receipt.promptVersion = promptVersion;
			receipt.maxOutputTokens = 1536;
			return job;
		};
		const f = fixture(change, stage);
		await f.client.run(f.input);
		expect(f.rpc.mock.calls[0]?.[2]).toMatchObject({
			stage,
			promptVersion,
		});
		const bad = fixture((job) => {
			change(job);
			(
				job.result as { receipt: Record<string, unknown> }
			).receipt.promptVersion = "local-story-v1";
			return job;
		}, stage);
		await expect(bad.client.run(bad.input)).rejects.toMatchObject({
			code: "LOCAL_SEMANTIC_RECEIPT_UNVERIFIED",
		});
	});
	it("binds final content to the exact request, profile, fixed model and completed cleanup", async () => {
		const f = fixture(),
			result = await f.client.run(f.input);
		expect(result.content).toEqual({ summary: "recorded" });
		expect(result.receipt.modelDigest).toBe(LOCAL_SEMANTIC_MODEL_DIGEST);
		expect(f.rpc.mock.calls[0]?.[2]).not.toHaveProperty("model");
		expect(f.rpc.mock.calls.some((c) => c[1].endsWith("/cancel"))).toBe(false);
	});
	it.each([
		{ key: "inputHash", value: "c".repeat(64), semantic: true },
		{ key: "schemaHash", value: "c".repeat(64), semantic: true },
		{ key: "promptHash", value: "c".repeat(64), semantic: true },
		{ key: "requestHash", value: "c".repeat(64), semantic: true },
		{ key: "profile", value: "amd", semantic: true },
		{ key: "maxOutputTokens", value: 1536, semantic: true },
		{ key: "modelDigest", value: "c".repeat(64), semantic: false },
		{ key: "cleanupConfirmed", value: false, semantic: false },
	])("rejects a mismatched $key and cancels only its deterministic job", async ({
		key,
		value,
		semantic,
	}) => {
		const f = fixture((job) => {
			const clone = structuredClone(job) as {
				result: { receipt: Record<string, unknown> };
			};
			clone.result.receipt[key] = value;
			if (semantic)
				expect(
					localSemanticReceiptSchema.safeParse(clone.result.receipt).success,
				).toBe(true);
			return clone;
		});
		await expect(f.client.run(f.input)).rejects.toMatchObject({
			code: semantic
				? "LOCAL_SEMANTIC_RECEIPT_UNVERIFIED"
				: "LOCAL_SEMANTIC_RESPONSE_UNVERIFIED",
		});
		expect(
			f.rpc.mock.calls.some(
				(c) =>
					c[1] ===
					`/v1/semantic-jobs/${localSemanticJobId(f.input.organizationId, f.input.requestKey)}/cancel`,
			),
		).toBe(true);
	});
	it("uses an independent cleanup signal after the caller aborts and never publishes a late result", async () => {
		const f = fixture();
		const client = createLocalSemanticClient(config, {
			rpc: f.rpc,
			wait: async () => f.controller.abort(new Error("CANCELED")),
		});
		await expect(client.run(f.input)).rejects.toThrow("CANCELED");
		expect(
			f.rpc.mock.calls.filter((c) => c[1] === "/v1/semantic-jobs"),
		).toHaveLength(1);
		expect(f.rpc.mock.calls.some((c) => c[1].endsWith("/cancel"))).toBe(true);
	});
	it("rejects oversized UTF-8 input before any network or cancellation request", async () => {
		const f = fixture();
		await expect(
			f.client.run({ ...f.input, prompt: "あ".repeat(3000) }),
		).rejects.toMatchObject({ code: "LOCAL_STORY_CONTEXT_LIMIT" });
		expect(f.rpc).not.toHaveBeenCalled();
	});
	it("does not treat a polling 404 as a cancellation tombstone", async () => {
		const f = fixture(),
			original = f.rpc.getMockImplementation();
		if (!original) throw new Error("Missing fixture implementation");
		let cancelPosted = false;
		const rpc: SemanticRpc = async (...args) => {
			if (args[1].endsWith("/cancel")) cancelPosted = true;
			else if (cancelPosted) throw new LocalSemanticHttpError(404);
			return original(...args);
		};
		const client = createLocalSemanticClient(config, {
			rpc,
			wait: async () => f.controller.abort(),
		});
		await expect(client.run(f.input)).rejects.toMatchObject({
			code: "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
		});
	});
	it("requires the same job owner and request when confirming cancellation", async () => {
		const f = fixture(),
			original = f.rpc.getMockImplementation();
		if (!original) throw new Error("Missing fixture implementation");
		let cancelPosted = false;
		const rpc: SemanticRpc = async (...args) => {
			const result = (await original(...args)) as Record<string, unknown>;
			if (cancelPosted) return { ...result, id: randomUUID() };
			if (args[1].endsWith("/cancel")) cancelPosted = true;
			return result;
		};
		const client = createLocalSemanticClient(config, {
			rpc,
			wait: async () => f.controller.abort(),
		});
		await expect(client.run(f.input)).rejects.toMatchObject({
			code: "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
		});
	});
	it.each([
		undefined,
		"NOT_FOUND",
		"JOB_NOT_FOUND",
	])("accepts a missing-job tombstone only from the cancel endpoint's explicit code %s", async (code) => {
		const f = fixture(),
			original = f.rpc.getMockImplementation();
		if (!original) throw new Error("Missing fixture implementation");
		const rpc: SemanticRpc = async (...args) => {
			if (args[1].endsWith("/cancel"))
				throw new LocalSemanticHttpError(404, code);
			return original(...args);
		};
		const client = createLocalSemanticClient(config, {
			rpc,
			wait: async () => f.controller.abort(new Error("CANCELED")),
		});
		if (code === "JOB_NOT_FOUND")
			await expect(client.run(f.input)).rejects.toThrow("CANCELED");
		else
			await expect(client.run(f.input)).rejects.toMatchObject({
				code: "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
			});
	});
});

type TransportFault = {
	code?: string;
	side?: "req" | "res";
	method?: "GET" | "POST";
	cleanup?: boolean;
	status?: number;
	raw?: string;
	before?: () => void;
};
async function httpsFixture(
	faults: TransportFault[],
	change?: (job: Record<string, unknown>) => unknown,
) {
	const f = fixture(change);
	const directory = await mkdtemp(
		join(tmpdir(), "bitovp-semantic-transport-test-"),
	);
	temporaryDirectories.push(directory);
	const caFile = join(directory, "ca.pem");
	await writeFile(caFile, "Nonsecret dummy CA; node:https is mocked");
	const calls: Array<{
		method: string;
		path: string;
		body: unknown;
		signal: AbortSignal;
	}> = [];
	let canceled = false;
	https.request.mockImplementation(
		(
			url: URL,
			options: { method: string; signal: AbortSignal },
			respond: (res: EventEmitter) => void,
		) => {
			const req = new EventEmitter() as EventEmitter & {
				end(bytes?: Buffer): void;
			};
			req.end = (bytes) => {
				const body = bytes ? JSON.parse(bytes.toString()) : undefined;
				calls.push({
					method: options.method,
					path: url.pathname,
					body,
					signal: options.signal,
				});
				queueMicrotask(async () => {
					try {
						if (url.pathname.endsWith("/cancel")) canceled = true;
						const next = faults[0];
						const fault =
							next &&
							(next.method ?? "GET") === options.method &&
							(next.cleanup ?? false) === canceled
								? faults.shift()
								: undefined;
						// A failed POST response may already have been accepted by the server.
						const result = await f.rpc(
							options.method as "GET" | "POST",
							url.pathname,
							body,
							options.signal,
						);
						fault?.before?.();
						if (fault?.code && fault.side !== "res") {
							req.emit(
								"error",
								Object.assign(
									new Error("private URL/token/body must not be logged"),
									{ code: fault.code },
								),
							);
							return;
						}
						const res = new EventEmitter() as EventEmitter & {
							statusCode: number;
							destroy(): void;
							setEncoding(): void;
						};
						res.statusCode = fault?.status ?? 200;
						res.destroy = () => {
							res.emit(
								"error",
								Object.assign(new Error("destroyed"), { code: "ECONNRESET" }),
							);
						};
						res.setEncoding = () => {};
						respond(res);
						if (fault?.code) {
							res.emit(
								"error",
								Object.assign(new Error("private response details"), {
									code: fault.code,
								}),
							);
							return;
						}
						const raw = fault?.raw ?? JSON.stringify(result);
						res.emit("data", res.statusCode >= 300 ? raw : Buffer.from(raw));
						res.emit("end");
					} catch (error) {
						req.emit("error", error);
					}
				});
			};
			return req;
		},
	);
	return { ...f, calls, config: { ...config, caFile } };
}
function normalGets(f: Awaited<ReturnType<typeof httpsFixture>>) {
	const cancelIndex = f.calls.findIndex((c) => c.path.endsWith("/cancel"));
	return f.calls
		.slice(0, cancelIndex < 0 ? undefined : cancelIndex)
		.filter((c) => c.method === "GET");
}
describe("owned native terminal diagnostics", () => {
	beforeEach(() => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	it.each([
		"FAILED",
		"CANCELLED",
	] as const)("records %s's allowlisted reason without retrying the job or logging source data", async (state) => {
		const f = fixture((job) => {
			delete job.result;
			return {
				...job,
				state,
				cleanupConfirmed: true,
				errorCode: "OUTPUT_INVALID",
			};
		});
		await expect(f.client.run(f.input)).rejects.toMatchObject({
			code: "LOCAL_SEMANTIC_JOB_FAILED",
		});
		expect(console.warn).toHaveBeenCalledTimes(1);
		expect(
			JSON.parse(String(vi.mocked(console.warn).mock.calls[0]?.[0])),
		).toEqual({
			event: "LOCAL_SEMANTIC_JOB_TERMINAL",
			stage: "LOCAL_LEDGER_V1",
			jobId: localSemanticJobId(f.input.organizationId, f.input.requestKey),
			state,
			cleanupConfirmed: true,
			errorCode: "OUTPUT_INVALID",
		});
		expect(
			f.rpc.mock.calls.map((c) => [c[0], c[1].endsWith("/cancel")]),
		).toEqual([
			["POST", false],
			["GET", false],
			["POST", true],
			["GET", false],
		]);
		const logs = JSON.stringify(vi.mocked(console.warn).mock.calls);
		for (const privateText of [
			config.token,
			config.url,
			f.input.prompt,
			f.input.organizationId,
		])
			expect(logs).not.toContain(privateText);
	});
	it.each([
		[undefined, "UNREPORTED_NATIVE_ERROR"],
		["PRIVATE_PROMPT_FRAGMENT", "UNCLASSIFIED_NATIVE_ERROR"],
	] as const)("projects an untrusted terminal code %s to a fixed marker", async (errorCode, expected) => {
		const f = fixture((job) => {
			delete job.result;
			return { ...job, state: "FAILED", cleanupConfirmed: false, errorCode };
		});
		await expect(f.client.run(f.input)).rejects.toMatchObject({
			code: "LOCAL_SEMANTIC_JOB_FAILED",
		});
		expect(
			JSON.parse(String(vi.mocked(console.warn).mock.calls[0]?.[0])),
		).toMatchObject({
			errorCode: expected,
			cleanupConfirmed: false,
		});
		expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
			"PRIVATE_PROMPT_FRAGMENT",
		);
	});
	it("preserves the original failure and independent cleanup if logging throws", async () => {
		vi.mocked(console.warn).mockImplementation(() => {
			throw new Error("Diagnostic sink failed");
		});
		const f = fixture((job) => {
			delete job.result;
			return { ...job, state: "FAILED", errorCode: "OUTPUT_INVALID" };
		});
		await expect(f.client.run(f.input)).rejects.toMatchObject({
			code: "LOCAL_SEMANTIC_JOB_FAILED",
		});
		expect(console.warn).toHaveBeenCalledTimes(1);
		const cancel = f.rpc.mock.calls.find((c) => c[1].endsWith("/cancel"));
		expect(cancel?.[3]).not.toBe(f.input.signal);
		expect(cancel?.[3].aborted).toBe(false);
		expect(
			f.rpc.mock.calls.filter((c) => c[1] === "/v1/semantic-jobs"),
		).toHaveLength(1);
	});
	it("does not report a foreign terminal response before ownership verification", async () => {
		const f = fixture((job) => {
			delete job.result;
			return {
				...job,
				id: randomUUID(),
				state: "FAILED",
				errorCode: "OUTPUT_INVALID",
			};
		});
		await expect(f.client.run(f.input)).rejects.toMatchObject({
			code: "LOCAL_SEMANTIC_RESPONSE_UNVERIFIED",
		});
		expect(console.warn).not.toHaveBeenCalled();
	});
});
describe("status-only HTTPS transport resilience", () => {
	beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
	it.each([
		"req",
		"res",
	] as const)("recovers a single lost %s GET without POST replay or cancellation", async (side) => {
		const f = await httpsFixture([{ code: "ECONNRESET", side }]);
		const result = await createLocalSemanticClient(f.config, {
			wait: async () => {},
		}).run(f.input);
		expect(result.content).toEqual({ summary: "recorded" });
		expect(f.calls.filter((c) => c.path === "/v1/semantic-jobs")).toHaveLength(
			1,
		);
		expect(f.calls.filter((c) => c.path.endsWith("/cancel"))).toHaveLength(0);
		expect(normalGets(f).map((c) => c.path)).toEqual(
			Array(2).fill(
				`/v1/semantic-jobs/${localSemanticJobId(f.input.organizationId, f.input.requestKey)}`,
			),
		);
	});
	it.each([
		"ECONNRESET",
		"ETIMEDOUT",
		"EPIPE",
		"ECONNREFUSED",
		"EAI_AGAIN",
	])("allows exactly two recovery reads for %s", async (code) => {
		const f = await httpsFixture([{ code }, { code }]);
		await expect(
			createLocalSemanticClient(f.config, { wait: async () => {} }).run(
				f.input,
			),
		).resolves.toHaveProperty("content.summary", "recorded");
		expect(normalGets(f)).toHaveLength(3);
		expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
	});
	it("stops after three GET attempts and preserves one independent cleanup sequence", async () => {
		const f = await httpsFixture(
			Array.from({ length: 3 }, () => ({ code: "ECONNRESET" })),
		);
		await expect(
			createLocalSemanticClient(f.config, { wait: async () => {} }).run(
				f.input,
			),
		).rejects.toMatchObject({
			code: "LOCAL_SEMANTIC_UNAVAILABLE",
			osCode: "ECONNRESET",
		});
		expect(normalGets(f)).toHaveLength(3);
		expect(f.calls.filter((c) => c.path === "/v1/semantic-jobs")).toHaveLength(
			1,
		);
		const cleanup = f.calls.slice(
			f.calls.findIndex((c) => c.path.endsWith("/cancel")),
		);
		expect(cleanup.map((c) => c.method)).toEqual(["POST", "GET"]);
		expect(
			cleanup.every((c) => c.signal !== f.input.signal && !c.signal.aborted),
		).toBe(true);
		expect(
			vi
				.mocked(console.warn)
				.mock.calls.map((c) => JSON.parse(String(c[0])).retryAllowed),
		).toEqual([true, true, false]);
	});
	it.each([
		"ERR_TLS_CERT_ALTNAME_INVALID",
		"CERT_HAS_EXPIRED",
		"DEPTH_ZERO_SELF_SIGNED_CERT",
		"ENOTFOUND",
		"ABORT_ERR",
		"UNKNOWN_OS_CODE/private-secret",
	])("does not retry permanent or unknown transport %s", async (code) => {
		const f = await httpsFixture([{ code }]);
		await expect(
			createLocalSemanticClient(f.config, { wait: async () => {} }).run(
				f.input,
			),
		).rejects.toMatchObject({ code: "LOCAL_SEMANTIC_UNAVAILABLE" });
		expect(normalGets(f)).toHaveLength(1);
		expect(f.calls.filter((c) => c.path.endsWith("/cancel"))).toHaveLength(1);
		const diagnostic = JSON.parse(
			String(vi.mocked(console.warn).mock.calls[0]?.[0]),
		);
		expect(Object.keys(diagnostic).sort()).toEqual(
			[
				"event",
				"stage",
				"jobId",
				"osCode",
				"retryCount",
				"retryAllowed",
			].sort(),
		);
		expect(diagnostic).toEqual({
			event: "LOCAL_SEMANTIC_TRANSPORT",
			stage: f.input.stage,
			jobId: localSemanticJobId(f.input.organizationId, f.input.requestKey),
			osCode: code.startsWith("UNKNOWN") ? "UNKNOWN_TRANSPORT" : code,
			retryCount: 0,
			retryAllowed: false,
		});
		const logs = JSON.stringify(vi.mocked(console.warn).mock.calls);
		for (const secret of [
			f.config.url,
			f.config.token,
			f.input.prompt,
			"private-secret",
			"private URL",
			"private response",
		])
			expect(logs).not.toContain(secret);
	});
	it.each([
		401, 403, 500,
	])("does not retry HTTP %s even when its response stream is lost", async (status) => {
		const f = await httpsFixture([{ status, code: "ECONNRESET", side: "res" }]);
		await expect(
			createLocalSemanticClient(f.config, { wait: async () => {} }).run(
				f.input,
			),
		).rejects.toMatchObject({ status });
		expect(normalGets(f)).toHaveLength(1);
		expect(console.warn).not.toHaveBeenCalled();
	});
	it.each([
		"not-json",
		"{}",
		"x".repeat(256 * 1024 + 1),
	])("does not retry invalid or oversized responses", async (raw) => {
		const f = await httpsFixture([{ raw }]);
		await expect(
			createLocalSemanticClient(f.config, { wait: async () => {} }).run(
				f.input,
			),
		).rejects.toMatchObject({
			code:
				raw === "{}"
					? "LOCAL_SEMANTIC_RESPONSE_UNVERIFIED"
					: raw === "not-json"
						? "LOCAL_SEMANTIC_RESPONSE_INVALID"
						: "LOCAL_SEMANTIC_RESPONSE_LIMIT",
		});
		expect(normalGets(f)).toHaveLength(1);
		expect(console.warn).not.toHaveBeenCalled();
	});
	it("never retries a lost create POST and retains cancellation of its deterministic job", async () => {
		const f = await httpsFixture([{ method: "POST", code: "ECONNRESET" }]);
		await expect(
			createLocalSemanticClient(f.config, { wait: async () => {} }).run(
				f.input,
			),
		).rejects.toMatchObject({ code: "LOCAL_SEMANTIC_UNAVAILABLE" });
		expect(f.calls.map((c) => c.method)).toEqual(["POST", "POST", "GET"]);
		expect(f.calls.filter((c) => c.path === "/v1/semantic-jobs")).toHaveLength(
			1,
		);
		expect(normalGets(f)).toHaveLength(0);
		expect(
			JSON.parse(String(vi.mocked(console.warn).mock.calls[0]?.[0]))
				.retryAllowed,
		).toBe(false);
	});
	it("interrupts recovery backoff on parent abort without another normal GET", async () => {
		const f = await httpsFixture([{ code: "ECONNRESET" }]);
		let waits = 0;
		const wait = vi.fn(async (signal: AbortSignal) => {
			if (++waits === 2) {
				f.controller.abort(new Error("PARENT_CANCELED"));
				signal.throwIfAborted();
			}
		});
		await expect(
			createLocalSemanticClient(f.config, { wait }).run(f.input),
		).rejects.toThrow("PARENT_CANCELED");
		expect(normalGets(f)).toHaveLength(1);
		expect(f.calls.filter((c) => c.path.endsWith("/cancel"))).toHaveLength(1);
		expect(f.calls.at(-1)?.signal.aborted).toBe(false);
	});
	it.each([
		"id",
		"requestHash",
		"receipt",
	])("still rejects a forged %s after a recovered GET", async (field) => {
		const f = await httpsFixture([{ code: "ECONNRESET" }], (job) => {
			const clone = structuredClone(job) as {
				id: string;
				requestHash: string;
				result: { receipt: { inputHash: string } };
			};
			if (field === "id") clone.id = randomUUID();
			else if (field === "requestHash") clone.requestHash = "d".repeat(64);
			else clone.result.receipt.inputHash = "d".repeat(64);
			return clone;
		});
		await expect(
			createLocalSemanticClient(f.config, { wait: async () => {} }).run(
				f.input,
			),
		).rejects.toMatchObject({
			code:
				field === "receipt"
					? "LOCAL_SEMANTIC_RECEIPT_UNVERIFIED"
					: "LOCAL_SEMANTIC_RESPONSE_UNVERIFIED",
		});
		expect(normalGets(f)).toHaveLength(2);
		expect(f.calls.filter((c) => c.path.endsWith("/cancel"))).toHaveLength(1);
	});
	it("does not retry a native FAILED job", async () => {
		const f = await httpsFixture([], (job) => ({
			...job,
			state: "FAILED",
			result: undefined,
		}));
		await expect(
			createLocalSemanticClient(f.config, { wait: async () => {} }).run(
				f.input,
			),
		).rejects.toMatchObject({ code: "LOCAL_SEMANTIC_JOB_FAILED" });
		expect(normalGets(f)).toHaveLength(1);
	});
	it("never extends cleanup with transport retries", async () => {
		const f = await httpsFixture([
			{ code: "CERT_HAS_EXPIRED" },
			{ code: "ECONNRESET", cleanup: true },
		]);
		await expect(
			createLocalSemanticClient(f.config, { wait: async () => {} }).run(
				f.input,
			),
		).rejects.toMatchObject({ code: "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED" });
		expect(f.calls.map((c) => c.method)).toEqual([
			"POST",
			"GET",
			"POST",
			"GET",
		]);
		expect(
			JSON.parse(String(vi.mocked(console.warn).mock.calls.at(-1)?.[0]))
				.retryAllowed,
		).toBe(false);
	});
	it("classifies the individual request timeout as temporary only before parent abort", async () => {
		const actualTimeout = AbortSignal.timeout.bind(AbortSignal);
		const requestTimeout = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
			ms === 15_000 ? requestTimeout.signal : actualTimeout(ms),
		);
		const f = await httpsFixture([
			{ code: "ABORT_ERR", before: () => requestTimeout.abort() },
		]);
		// Each later request gets its own unexpired 15-second deadline.
		const wait = async () => {
			if (requestTimeout.signal.aborted)
				vi.mocked(AbortSignal.timeout).mockImplementation(actualTimeout);
		};
		await expect(
			createLocalSemanticClient(f.config, { wait }).run(f.input),
		).resolves.toHaveProperty("content.summary", "recorded");
		expect(normalGets(f)).toHaveLength(2);
		expect(
			JSON.parse(String(vi.mocked(console.warn).mock.calls[0]?.[0])).osCode,
		).toBe("ETIMEDOUT");
	});
	it("does not classify a caller abort as a retryable individual timeout", async () => {
		const f = await httpsFixture([
			{
				code: "ABORT_ERR",
				before: () => f.controller.abort(new Error("PARENT_DEADLINE")),
			},
		]);
		await expect(
			createLocalSemanticClient(f.config, { wait: async () => {} }).run(
				f.input,
			),
		).rejects.toThrow("PARENT_DEADLINE");
		expect(normalGets(f)).toHaveLength(1);
		expect(
			JSON.parse(String(vi.mocked(console.warn).mock.calls[0]?.[0]))
				.retryAllowed,
		).toBe(false);
		expect(f.calls.at(-1)?.signal.aborted).toBe(false);
	});
});
