import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditRecorder } from "./sdk-ops";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("real SDK RTMP ingest update transport", () => {
	it("sends the exact PATCH URL/body once and keeps keys out of audit", async () => {
		const transport = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ status: "SUCCESS", data: { result: {} } }),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", transport);
		const record = vi.fn<AuditRecorder>(async () => undefined);
		const ops = createBitmovinSdkOps(
			{ apiKey: "test-only", bitmovinAccountId: "original-account" },
			record,
		);
		await ops.updateLiveRtmpIngestPoints("encoding-owned", [
			{ applicationName: "backup", streamKey: "private-key" },
		]);
		expect(transport).toHaveBeenCalledTimes(1);
		const [url, init] = transport.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(new URL(url).pathname).toBe(
			"/v1/encoding/live/encodings/encoding-owned/actions/update-rtmp-ingest-points",
		);
		expect(init.method).toBe("PATCH");
		expect(JSON.parse(init.body as string)).toEqual({
			ingestPoints: [{ applicationName: "backup", streamKey: "private-key" }],
		});
		expect(JSON.stringify(record.mock.calls)).not.toContain("private-key");
	});
	it("does not retry an unknown PATCH outcome or log the SDK request body", async () => {
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
		const transport = vi.fn(async () => {
			throw new Error("private-key disconnected");
		});
		vi.stubGlobal("fetch", transport);
		const record = vi.fn<AuditRecorder>(async () => undefined);
		const ops = createBitmovinSdkOps({ apiKey: "test-only" }, record);
		await expect(
			ops.updateLiveRtmpIngestPoints("encoding-owned", [
				{ applicationName: "backup", streamKey: "private-key" },
			]),
		).rejects.toThrow("provider result is unknown");
		expect(transport).toHaveBeenCalledTimes(1);
		expect(warnings).not.toHaveBeenCalled();
		expect(JSON.stringify(record.mock.calls)).not.toContain("private-key");
	});
});
