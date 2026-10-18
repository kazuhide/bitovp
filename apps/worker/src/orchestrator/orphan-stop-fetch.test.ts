import type { AppPrismaClient } from "@bitovp/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeWorkerSdk } from "./make-sdk";
import { createOrphanStopFetch } from "./orphan-stop-fetch";
import { createBitmovinSdkOps } from "./sdk-ops";
import {
	createUnstoppedEncodingReconciler,
	type StopRemoteDeps,
} from "./stop-remote-encodings";

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("orphan-only SDK deadline includes the response body", () => {
	it("the real orphan factory releases single-flight after abort so later ticks progress", async () => {
		vi.useFakeTimers();
		let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
		const cancel = vi.fn();
		const wire = vi
			.fn(
				async () =>
					new Response(
						JSON.stringify({ data: { result: { status: "FINISHED" } } }),
					),
			)
			.mockImplementationOnce(
				async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(c) {
								stream = c;
								c.enqueue(new TextEncoder().encode("{"));
							},
							cancel,
						}),
					),
			);
		vi.stubGlobal("fetch", wire);
		const row = {
			id: "job-1",
			status: "ERROR",
			updatedAt: new Date(0),
			remoteStopRequestedAt: null,
			createdBy: "worker:watch",
			bitmovinAccountId: "account",
			stepLog: [
				{
					step: "encoding",
					kind: "CREATE_ENCODING",
					payload: {},
					refs: {},
					status: "DONE",
					resourceId: "enc-test",
				},
			],
		};
		const prisma = {
			encodingJob: {
				findMany: vi.fn(async () => [{ id: row.id }]),
				findUnique: vi.fn(async () => row),
				updateMany: vi.fn(async () => ({ count: 1 })),
			},
			appSetting: {
				upsert: vi.fn(async () => ({
					value: { afterId: null, encodingAfter: null, complete: true },
				})),
				updateMany: vi.fn(async () => ({ count: 1 })),
			},
			auditLog: { create: vi.fn(async () => ({})) },
		} as unknown as AppPrismaClient;
		const deps: StopRemoteDeps = {
			prisma,
			revealBitmovinAccount: async () => ({
				apiKey: "fixture",
				tenantOrgId: null,
			}),
			makeSdk: makeWorkerSdk(prisma),
		};
		const tick = createUnstoppedEncodingReconciler(deps);
		const first = tick();
		try {
			await vi.advanceTimersByTimeAsync(1);
			for (let i = 0; i < 5; i += 1) expect(await tick()).toBe(0);
			expect(wire).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(8000);
			expect(cancel).toHaveBeenCalledTimes(1);
			await first;
			await tick();
			expect(wire).toHaveBeenCalledTimes(2);
		} finally {
			if (!cancel.mock.calls.length) stream?.close();
			await first;
		}
	});
	it("forwards the orphan option through the production factory and preserves STOP audit", async () => {
		const wire = vi.fn(
			async (_url: unknown, _init?: RequestInit) =>
				new Response(JSON.stringify({ data: { result: { id: "enc-test" } } })),
		);
		vi.stubGlobal("fetch", wire);
		const create = vi.fn(async () => ({}));
		const sdk = makeWorkerSdk({
			auditLog: { create },
		} as unknown as AppPrismaClient)({
			apiKey: "fixture",
			tenantOrgId: null,
			bitmovinAccountId: "account",
			orphanStopOnly: true,
		});
		await sdk.stopEncoding("enc-test");
		expect(wire.mock.calls).toHaveLength(1);
		expect(wire.mock.calls[0]?.[1]).toMatchObject({
			redirect: "error",
			signal: expect.any(AbortSignal),
		});
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					actor: "worker:orchestrator",
					path: "/encoding/encodings/enc-test/stop",
				}),
			}),
		);
		await expect(
			sdk.createEncoding({
				name: "refused",
				cloudRegion: "AWS_AP_NORTHEAST_1",
				encoderVersion: "STABLE",
			}),
		).rejects.toBeDefined();
		expect(wire.mock.calls).toHaveLength(1);
	});
	it("aborts before headers and makes no automatic transport retry", async () => {
		vi.useFakeTimers();
		let aborted = false;
		const wire = vi.fn(
			(_url: string, init: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener(
						"abort",
						() => {
							aborted = true;
							reject(init.signal?.reason);
						},
						{ once: true },
					);
				}),
		);
		vi.stubGlobal("fetch", wire);
		const result = createOrphanStopFetch()(
			"https://api.bitmovin.com/v1/encoding/encodings/enc-test/status",
		).catch(() => "aborted");
		await vi.advanceTimersByTimeAsync(8000);
		expect(await result).toBe("aborted");
		expect(aborted).toBe(true);
		expect(wire).toHaveBeenCalledTimes(1);
	});
	it("refuses non-control routes before fetch", async () => {
		const wire = vi.fn();
		vi.stubGlobal("fetch", wire);
		const fetcher = createOrphanStopFetch();
		for (const [url, method] of [
			["https://other.example/v1/encoding/encodings/enc-test/status", "GET"],
			["https://api.bitmovin.com/v1/encoding/encodings/enc-test/start", "POST"],
			["https://api.bitmovin.com/v1/encoding/encodings/enc-test/stop", "GET"],
		])
			await expect(fetcher(url as string, { method })).rejects.toBeDefined();
		expect(wire).not.toHaveBeenCalled();
	});
	it("cancels an oversized control response", async () => {
		const cancel = vi.fn();
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					new ReadableStream({
						start(c) {
							c.enqueue(new Uint8Array(1024 * 1024 + 1));
						},
						cancel,
					}),
				),
		);
		await expect(
			createOrphanStopFetch()(
				"https://api.bitmovin.com/v1/encoding/encodings/enc-test/status",
			),
		).rejects.toThrow("limit");
		expect(cancel).toHaveBeenCalledTimes(1);
	});
	it.each([
		"GET",
		"STOP",
	])("cancels a trickling %s body and awaits cancellation", async (method) => {
		vi.useFakeTimers();
		let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
		let releaseCancel: (() => void) | undefined;
		const cancel = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					releaseCancel = resolve;
				}),
		);
		const wire = vi.fn(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							stream = controller;
							controller.enqueue(new TextEncoder().encode('{"data":'));
						},
						cancel,
					}),
				),
		);
		vi.stubGlobal("fetch", wire);
		const record = vi.fn(async () => {});
		const sdk = createBitmovinSdkOps(
			{ apiKey: "fixture", orphanStopOnly: true },
			record,
		);
		let settled = false;
		const request = (
			method === "GET"
				? sdk.getEncodingStatus("enc-test")
				: sdk.stopEncoding("enc-test")
		).then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		try {
			for (let second = 0; second < 7; second += 1) {
				await vi.advanceTimersByTimeAsync(1000);
				stream?.enqueue(new TextEncoder().encode(" "));
			}
			await vi.advanceTimersByTimeAsync(1000);
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(settled).toBe(false);
			releaseCancel?.();
			await request;
			expect(settled).toBe(true);
			expect(wire).toHaveBeenCalledTimes(1);
			if (method === "STOP") expect(record).toHaveBeenCalledTimes(1);
		} finally {
			releaseCancel?.();
			if (!cancel.mock.calls.length) stream?.close();
			await request;
		}
	});
});
