import type { AppPrismaClient } from "@bitovp/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeWorkerSdk } from "./make-sdk";
import { CancelRequested } from "./ops/exec-shared";

const modes = ["VOD", "CUSTOM", "HD"] as const;
function reply(result: unknown, status = 200) {
	return new Response(JSON.stringify({ status: "SUCCESS", data: { result } }), {
		status,
		headers: { "content-type": "application/json" },
	});
}
function settleWindow() {
	return new Response(
		JSON.stringify({
			status: "ERROR",
			data: { code: 1004, message: "Synthetic settle window" },
		}),
		{ status: 500, headers: { "content-type": "application/json" } },
	);
}
function make(control: {
	check(attempted: boolean): Promise<void>;
	sleep(ms: number): Promise<void>;
}) {
	return makeWorkerSdk({
		auditLog: { create: vi.fn(async () => ({})) },
	} as unknown as AppPrismaClient)({
		apiKey: "synthetic-key",
		tenantOrgId: null,
		bitmovinAccountId: "synthetic-account",
		startControl: control,
	});
}
function start(sdk: ReturnType<typeof make>, mode: (typeof modes)[number]) {
	return mode === "VOD"
		? sdk.startEncoding("owned-encoding", {})
		: sdk.startLiveEncoding("owned-encoding", {
				streamKey: "synthetic",
				encodingOption: mode,
			});
}
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("START control through the production SDK factory", () => {
	it.each(
		modes,
	)("%s stops its first 1004 delay promptly without another send or success reconciliation", async (mode) => {
		vi.useFakeTimers();
		const calls: { method: string; path: string }[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({
					method: init?.method ?? "GET",
					path: new URL(url).pathname,
				});
				return init?.method === "POST"
					? settleWindow()
					: reply({ status: "RUNNING" });
			}),
		);
		let cancelled = false;
		let signal: CancelRequested | undefined;
		const sdk = make({
			check: async (attempted) => {
				if (cancelled) {
					signal = new CancelRequested("start", !attempted);
					throw signal;
				}
			},
			sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		});
		let outcome: unknown;
		void start(sdk, mode).then(
			() => {
				outcome = "success";
			},
			(error) => {
				outcome = error;
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(1);
		cancelled = true;
		await vi.advanceTimersByTimeAsync(1_000);
		expect(outcome).toBeInstanceOf(CancelRequested);
		expect(outcome).toBe(signal);
		expect(signal?.beforeSend).toBe(false);
		expect(calls).toHaveLength(1);
	});
	it.each(
		modes,
	)("%s preserves an ownership error during the retry wait", async (mode) => {
		vi.useFakeTimers();
		const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
			init?.method === "POST" ? settleWindow() : reply({ status: "RUNNING" }),
		);
		vi.stubGlobal("fetch", fetch);
		const lost = new Error("Synthetic owner replaced");
		let current = true;
		const sdk = make({
			check: async () => {
				if (!current) throw lost;
			},
			sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		});
		let outcome: unknown;
		void start(sdk, mode).then(
			() => {
				outcome = "success";
			},
			(error) => {
				outcome = error;
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		current = false;
		await vi.advanceTimersByTimeAsync(1_000);
		expect(outcome).toBe(lost);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it.each(
		modes,
	)("%s awaits an in-flight accepted response before propagating cancellation", async (mode) => {
		vi.useFakeTimers();
		let accept: ((response: Response) => void) | undefined;
		const fetch = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					accept = resolve;
				}),
		);
		vi.stubGlobal("fetch", fetch);
		let cancelled = false;
		const sdk = make({
			check: async (attempted) => {
				if (cancelled) throw new CancelRequested("start", !attempted);
			},
			sleep: async () => {},
		});
		let outcome: unknown;
		void start(sdk, mode).then(
			() => {
				outcome = "success";
			},
			(error) => {
				outcome = error;
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		cancelled = true;
		expect(outcome).toBeUndefined();
		expect(accept).toBeDefined();
		accept?.(reply({ id: "owned-encoding" }, 202));
		await vi.advanceTimersByTimeAsync(0);
		expect(outcome).toBeInstanceOf(CancelRequested);
		expect((outcome as CancelRequested).beforeSend).toBe(false);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
