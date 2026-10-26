import { afterEach, describe, expect, it, vi } from "vitest";
import { projectPerTitleEncodingImport } from "@/app/vod/new/per-title-encoding-import";
import { createPerTitleEncodingHttpPort } from "./per-title-encoding-http";
import { loadPerTitleEncodingSnapshot } from "./per-title-encoding-loader";

const encodingId = "00000000-0000-4000-8000-000000000001";
const configId = "00000000-0000-4000-8000-000000000002";
const streamId = "00000000-0000-4000-8000-000000000003";
const tenantOrgId = "00000000-0000-4000-8000-000000000004";
const apiKey = "fixture-only-http-import-key";
const success = (result: unknown) =>
	new Response(JSON.stringify({ status: "SUCCESS", data: { result } }), {
		status: 200,
	});

function fixture(unknownAt?: "global" | "stream") {
	const global = {
		minBitrate: 100000,
		maxBitrate: 4000000,
		minBitrateStepSize: 1.5,
		maxBitrateStepSize: 3,
		targetQualityCrf: 0,
		resolutionScaleFactor: 0,
		fixedResolutionAndBitrateConfiguration: {
			forcedRenditionAboveHighestFixedRepresentation: 0,
		},
		...(unknownAt === "global"
			? { futureGlobalSetting: "fixture-unknown-value" }
			: {}),
	};
	const stream = {
		id: streamId,
		codecConfigId: configId,
		mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
		perTitleSettings: {
			fixedResolutionAndBitrateSettings: {
				minBitrate: 300000,
				maxBitrate: 650000,
			},
			codecMaxBitrateFactor: 2,
			...(unknownAt === "stream"
				? { futureStreamSetting: "fixture-unknown-value" }
				: {}),
		},
		appliedSettings: { width: 1280, height: 720 },
	};
	const transport = vi.fn<typeof fetch>(async (input, init) => {
		const url = new URL(String(input));
		expect(init?.method).toBe("GET");
		if (url.pathname.endsWith("/start"))
			return success({ perTitle: { h264Configuration: global } });
		if (url.pathname.endsWith("/streams"))
			return success({ totalCount: 1, items: [stream] });
		if (url.pathname.endsWith("/type")) return success({ type: "H264" });
		return success({ id: configId, width: 640, bitrate: null });
	});
	return { global, stream, transport };
}

afterEach(() => vi.restoreAllMocks());

describe("Per-Title raw HTTP read port", () => {
	it("loads original HTTP fields through the loader and projection without adding a height", async () => {
		const source = fixture();
		const outsideFetch = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("Network is forbidden"));
		const signal = new AbortController().signal;
		const port = createPerTitleEncodingHttpPort({
			apiKey,
			tenantOrgId,
			signal,
			fetch: source.transport,
		});
		const snapshot = await loadPerTitleEncodingSnapshot(port, encodingId, {
			signal,
		});
		const projected = projectPerTitleEncodingImport(snapshot);
		expect(projected.issues).toEqual([]);
		expect(projected.configurations[0]?.reference.global).toEqual(
			source.global,
		);
		expect(projected.configurations[0]?.reference.streams[0]).toMatchObject({
			width: 640,
			perTitleSettings: {
				minBitrate: 300000,
				maxBitrate: 650000,
				codecMaxBitrateFactor: 2,
			},
		});
		expect(
			projected.configurations[0]?.reference.streams[0]?.height,
		).toBeUndefined();
		expect(projected.configurations[0]?.goal.rows?.[0]?.height).toBeUndefined();
		expect(source.transport).toHaveBeenCalledTimes(4);
		for (const [input, init] of source.transport.mock.calls) {
			const url = new URL(String(input));
			expect(url.origin).toBe("https://api.bitmovin.com");
			expect(url.href).not.toContain(apiKey);
			expect(url.href).not.toContain(tenantOrgId);
			expect(init).toMatchObject({
				method: "GET",
				signal,
				redirect: "error",
				cache: "no-store",
			});
			const headers = new Headers(init?.headers);
			expect(headers.get("X-Api-Key")).toBe(apiKey);
			expect(headers.get("X-Tenant-Org-Id")).toBe(tenantOrgId);
		}
		expect(outsideFetch).not.toHaveBeenCalled();
	});

	it.each([
		"global",
		"stream",
	] as const)("preserves unknown %s HTTP fields so projection can reject rather than discard them", async (location) => {
		const source = fixture(location);
		const signal = new AbortController().signal;
		const port = createPerTitleEncodingHttpPort({
			apiKey,
			signal,
			fetch: source.transport,
		});
		const snapshot = await loadPerTitleEncodingSnapshot(port, encodingId, {
			signal,
		});
		expect(JSON.stringify(snapshot)).toContain("fixture-unknown-value");
		const projected = projectPerTitleEncodingImport(snapshot);
		expect(projected).toEqual({
			configurations: [],
			issues: [
				{
					codec: "H264",
					code:
						location === "global"
							? "UNSUPPORTED_GLOBAL_SETTINGS"
							: "UNSUPPORTED_STREAM_SETTINGS",
				},
			],
		});
		expect(JSON.stringify(projected)).not.toContain("fixture-unknown-value");
	});

	it.each([
		401, 403, 404, 429, 500,
	])("does not read or expose a provider error body for HTTP %s", async (status) => {
		const canceled = vi.fn();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const transport = vi.fn<typeof fetch>(
			async () =>
				new Response(new ReadableStream({ cancel: canceled }), { status }),
		);
		const port = createPerTitleEncodingHttpPort({
			apiKey,
			signal: new AbortController().signal,
			fetch: transport,
		});
		await expect(
			port.encoding.encodings.getStartRequest(encodingId),
		).rejects.toMatchObject({ httpStatusCode: status });
		expect(canceled).toHaveBeenCalledOnce();
		expect(error).not.toHaveBeenCalled();
	});

	it.each([
		"not JSON",
		JSON.stringify({ status: "ERROR", data: { result: {} } }),
		JSON.stringify({ status: "SUCCESS", data: {} }),
	])("rejects malformed success envelopes without echoing the payload", async (body) => {
		const transport = vi.fn<typeof fetch>(async () => new Response(body));
		const port = createPerTitleEncodingHttpPort({
			apiKey,
			signal: new AbortController().signal,
			fetch: transport,
		});
		await expect(
			port.encoding.encodings.getStartRequest(encodingId),
		).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
	});

	it("caps declared response sizes before consuming the stream", async () => {
		const canceled = vi.fn();
		const transport = vi.fn<typeof fetch>(
			async () =>
				new Response(new ReadableStream({ cancel: canceled }), {
					headers: { "content-length": "1048577" },
				}),
		);
		const port = createPerTitleEncodingHttpPort({
			apiKey,
			signal: new AbortController().signal,
			fetch: transport,
		});
		await expect(
			port.encoding.encodings.getStartRequest(encodingId),
		).rejects.toMatchObject({ code: "IMPORT_LIMIT_EXCEEDED" });
		expect(canceled).toHaveBeenCalledOnce();
	});

	it("also caps responses whose content length is absent", async () => {
		const canceled = vi.fn();
		const transport = vi.fn<typeof fetch>(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(1048577));
						},
						cancel: canceled,
					}),
				),
		);
		const port = createPerTitleEncodingHttpPort({
			apiKey,
			signal: new AbortController().signal,
			fetch: transport,
		});
		await expect(
			port.encoding.encodings.getStartRequest(encodingId),
		).rejects.toMatchObject({ code: "IMPORT_LIMIT_EXCEEDED" });
		expect(canceled).toHaveBeenCalledOnce();
	});

	it("shares a total byte budget across all reads of one import", async () => {
		const body = JSON.stringify({
			status: "SUCCESS",
			data: { result: { padding: "x".repeat(1048400) } },
		});
		const transport = vi.fn<typeof fetch>(async () => new Response(body));
		const port = createPerTitleEncodingHttpPort({
			apiKey,
			signal: new AbortController().signal,
			fetch: transport,
		});
		for (let index = 0; index < 8; index++)
			await port.encoding.encodings.getStartRequest(encodingId);
		await expect(
			port.encoding.encodings.getStartRequest(encodingId),
		).rejects.toMatchObject({ code: "IMPORT_LIMIT_EXCEEDED" });
		expect(transport).toHaveBeenCalledTimes(9);
	});

	it("does not issue a request after cancellation or for an invalid path identifier", async () => {
		const controller = new AbortController();
		const transport = vi.fn<typeof fetch>();
		const port = createPerTitleEncodingHttpPort({
			apiKey,
			signal: controller.signal,
			fetch: transport,
		});
		await expect(
			port.encoding.encodings.getStartRequest("../elsewhere"),
		).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
		controller.abort();
		await expect(
			port.encoding.encodings.getStartRequest(encodingId),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(transport).not.toHaveBeenCalled();
	});
});
