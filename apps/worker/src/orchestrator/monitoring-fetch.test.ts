import { afterEach, describe, expect, it, vi } from "vitest";
import { createMonitoringFetch } from "./monitoring-fetch";

const STATUS = "https://api.bitmovin.com/v1/encoding/encodings/enc-1/status";
const HEARTBEAT =
	"https://api.bitmovin.com/v1/encoding/encodings/enc-1/live/heartbeat";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("monitoring transport", () => {
	it("aborts a pending header request at the shared deadline without retrying", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const reason = new Error("monitoring deadline");
		let observedSignal: AbortSignal | undefined;
		const nativeFetch = vi.fn((_url: string, init: RequestInit) => {
			observedSignal = init.signal ?? undefined;
			return new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				);
			});
		});
		vi.stubGlobal("fetch", nativeFetch);
		const result = createMonitoringFetch(controller.signal)(STATUS);
		const rejected = expect(result).rejects.toBe(reason);
		setTimeout(() => controller.abort(reason), 1_000);
		await vi.advanceTimersByTimeAsync(1_000);
		await rejected;
		expect(observedSignal?.aborted).toBe(true);
		expect(nativeFetch).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cancels a pending body reader and releases its lock before rejecting", async () => {
		const controller = new AbortController();
		const cancel = vi.fn();
		const response = new Response(new ReadableStream({ cancel }));
		const nativeFetch = vi.fn(async () => response);
		vi.stubGlobal("fetch", nativeFetch);
		const result = createMonitoringFetch(controller.signal)(HEARTBEAT);
		await Promise.resolve();
		expect(response.body?.locked).toBe(true);
		const reason = new Error("body deadline");
		controller.abort(reason);
		await expect(result).rejects.toBe(reason);
		expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
		expect(response.body?.locked).toBe(false);
		expect(nativeFetch).toHaveBeenCalledTimes(1);
	});

	it("buffers the complete body so SDK text parsing cannot outlive the deadline", async () => {
		const controller = new AbortController();
		const response = new Response('{"status":"RUNNING"}', {
			headers: { "content-type": "application/json" },
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response),
		);
		const buffered = await createMonitoringFetch(controller.signal)(STATUS);
		expect(await buffered.text()).toBe('{"status":"RUNNING"}');
		expect(buffered.headers.get("content-type")).toBe("application/json");
		expect(response.body?.locked).toBe(false);
	});

	it("cancels oversized control responses", async () => {
		const cancel = vi.fn();
		let observedSignal: AbortSignal | null | undefined;
		const response = new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array(1024 * 1024 + 1));
				},
				cancel,
			}),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				observedSignal = init.signal;
				return response;
			}),
		);
		await expect(
			createMonitoringFetch(new AbortController().signal)(STATUS),
		).rejects.toThrow("control-response limit");
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(observedSignal?.aborted).toBe(true);
		expect(response.body?.locked).toBe(false);
	});

	it("starts no request after cancellation", async () => {
		const controller = new AbortController();
		controller.abort(new Error("expired"));
		const nativeFetch = vi.fn();
		vi.stubGlobal("fetch", nativeFetch);
		await expect(
			createMonitoringFetch(controller.signal)(STATUS),
		).rejects.toThrow("expired");
		expect(nativeFetch).not.toHaveBeenCalled();
	});

	it("cancels a late response from a fetch implementation that ignored abort", async () => {
		const controller = new AbortController();
		let release: ((response: Response) => void) | undefined;
		const nativeFetch = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					release = resolve;
				}),
		);
		vi.stubGlobal("fetch", nativeFetch);
		const result = createMonitoringFetch(controller.signal)(STATUS);
		controller.abort(new Error("expired"));
		const cancel = vi.fn();
		const response = new Response(new ReadableStream({ cancel }));
		release?.(response);
		await expect(result).rejects.toThrow("expired");
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(response.body?.locked).toBe(false);
		expect(nativeFetch).toHaveBeenCalledTimes(1);
	});

	it.each([
		[STATUS, "POST"],
		[STATUS.replace("/status", "/stop"), "POST"],
		[STATUS.replace("/status", "/live/start"), "POST"],
		["https://api.bitmovin.com/v1/encoding/encodings", "GET"],
		[`${STATUS}?page=1`, "GET"],
		[STATUS.replace("api.bitmovin.com", "example.com"), "GET"],
	])("refuses unrelated operations: %s %s", async (url, method) => {
		const nativeFetch = vi.fn();
		vi.stubGlobal("fetch", nativeFetch);
		await expect(
			createMonitoringFetch(new AbortController().signal)(url, { method }),
		).rejects.toThrow("refuses unrelated provider operation");
		expect(nativeFetch).not.toHaveBeenCalled();
	});
});
