import type { CompiledOperation } from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ExecutorContext, executeStep } from "./executor";
import { fakeSdk } from "./fake-sdk";
import { BitmovinCallError, type SdkOps } from "./sdk-ops";

const op: CompiledOperation = {
	step: "await:encoding",
	kind: "AWAIT_ENCODING",
	payload: {},
	refs: { encodingId: "encoding" },
};
function context(
	getEncodingStatus: SdkOps["getEncodingStatus"],
): ExecutorContext {
	return {
		sdk: fakeSdk({ getEncodingStatus }),
		ids: new Map([["encoding", "enc"]]),
		resolveCredential: vi.fn(),
		poll: { intervalMs: 1, timeoutMs: 10000, sleep: vi.fn(async () => {}) },
	};
}
const transient = () =>
	new BitmovinCallError("GET", "/encoding/encodings/enc/status", {
		httpStatusCode: 502,
		shortMessage: "Bad Gateway",
	});
afterEach(() => vi.restoreAllMocks());
describe("VOD status read recovery", () => {
	it.each([429, 502, 503, 504])("recovers HTTP%s", async (code) => {
		const get = vi
			.fn()
			.mockRejectedValueOnce(
				new BitmovinCallError("GET", "/status", { httpStatusCode: code }),
			)
			.mockResolvedValue({ status: "FINISHED" });
		await expect(executeStep(op, context(get))).resolves.toMatchObject({
			response: { status: "FINISHED" },
		});
		expect(get).toHaveBeenCalledTimes(2);
	});
	it.each([400, 401, 403, 404, 500])("does not retry HTTP%s", async (code) => {
		const error = Object.assign(new Error("HTTPfailure"), {
			httpStatusCode: code,
			cause: { code: "ECONNRESET" },
		});
		const get = vi.fn().mockRejectedValue(error);
		await expect(executeStep(op, context(get))).rejects.toBe(error);
		expect(get).toHaveBeenCalledTimes(1);
	});
	it("recovers a wrapped network error", async () => {
		const get = vi
			.fn()
			.mockRejectedValueOnce(
				new BitmovinCallError(
					"GET",
					"/status",
					Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
				),
			)
			.mockResolvedValue({ status: "FINISHED" });
		await expect(executeStep(op, context(get))).resolves.toMatchObject({
			response: { status: "FINISHED" },
		});
	});
	it("does not retry arbitrary errors", async () => {
		const error = new TypeError("unexpected response");
		const get = vi.fn().mockRejectedValue(error);
		await expect(executeStep(op, context(get))).rejects.toBe(error);
		expect(get).toHaveBeenCalledTimes(1);
	});
	it("limits consecutive failures to five retries and keeps the last error", async () => {
		const error = transient();
		const get = vi.fn().mockRejectedValue(error);
		const c = context(get);
		await expect(executeStep(op, c)).rejects.toBe(error);
		expect(get).toHaveBeenCalledTimes(6);
		expect(c.poll.sleep).toHaveBeenCalledTimes(5);
	});
	it("resets the failure budget after a successful RUNNING read", async () => {
		const get = vi.fn();
		for (let i = 0; i < 5; i++) get.mockRejectedValueOnce(transient());
		get.mockResolvedValueOnce({ status: "RUNNING" });
		for (let i = 0; i < 5; i++) get.mockRejectedValueOnce(transient());
		get.mockResolvedValue({ status: "FINISHED" });
		await expect(executeStep(op, context(get))).resolves.toMatchObject({
			response: { status: "FINISHED" },
		});
		expect(get).toHaveBeenCalledTimes(12);
	});
	it("keeps cooperative cancellation active during a read outage", async () => {
		const get = vi.fn().mockRejectedValue(transient());
		const c = context(get);
		c.shouldCancel = vi.fn().mockResolvedValue(true);
		await expect(executeStep(op, c)).rejects.toMatchObject({
			name: "CancelRequested",
		});
		expect(get).toHaveBeenCalledTimes(1);
		expect(c.poll.sleep).not.toHaveBeenCalled();
	});
	it("does not extend the existing deadline", async () => {
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const get = vi.fn().mockRejectedValue(transient());
		const c = context(get);
		c.poll = {
			intervalMs: 100,
			timeoutMs: 25,
			sleep: vi.fn(async (ms) => {
				now += ms;
			}),
		};
		await expect(executeStep(op, c)).rejects.toBeInstanceOf(BitmovinCallError);
		expect(get).toHaveBeenCalledTimes(1);
		expect(c.poll.sleep).toHaveBeenCalledWith(25);
	});
	it("does not retry a START mutation", async () => {
		const c = context(vi.fn());
		const error = transient();
		vi.mocked(c.sdk.startEncoding).mockRejectedValue(error);
		await expect(
			executeStep({ ...op, kind: "START_ENCODING" }, c),
		).rejects.toBe(error);
		expect(c.sdk.startEncoding).toHaveBeenCalledTimes(1);
	});
	it("does not broaden manifest polling", async () => {
		const c = context(vi.fn());
		const error = transient();
		vi.mocked(c.sdk.getHlsManifestStatus).mockRejectedValue(error);
		c.ids.set("manifest", "manifest-id");
		await expect(
			executeStep(
				{ ...op, kind: "AWAIT_MANIFEST_HLS", refs: { manifestId: "manifest" } },
				c,
			),
		).rejects.toBe(error);
		expect(c.sdk.getHlsManifestStatus).toHaveBeenCalledTimes(1);
	});
	it("continues polling after a transient502 without restarting the encode", async () => {
		const get = vi
			.fn()
			.mockRejectedValueOnce(transient())
			.mockResolvedValueOnce({ status: "RUNNING" })
			.mockResolvedValue({ status: "FINISHED" });
		const ctx = context(get);
		await expect(executeStep(op, ctx)).resolves.toMatchObject({
			response: { status: "FINISHED" },
		});
		expect(get).toHaveBeenCalledTimes(3);
		expect(ctx.sdk.startEncoding).not.toHaveBeenCalled();
	});
});
