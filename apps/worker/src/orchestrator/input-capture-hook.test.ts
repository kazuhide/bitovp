import { afterEach, describe, expect, it, vi } from "vitest";
import { type ExecutorContext, executeStep } from "./executor";
import { fakeSdk } from "./fake-sdk";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

const operation = {
	step: "ingest:video",
	kind: "CREATE_INGEST_INPUT_STREAM" as const,
	payload: {
		inputPath: "original.mp4",
		selectionMode: "VIDEO_RELATIVE",
		position: 0,
	},
	refs: { encodingId: "encoding", inputId: "input:main" },
};
function setup(capture: ReturnType<typeof vi.fn>) {
	const sdk = fakeSdk();
	const context = {
		sdk,
		ids: new Map([
			["encoding", "encoding-id"],
			["input:main", "original-input-id"],
		]),
		resolveCredential: vi.fn(),
		poll: { intervalMs: 1, timeoutMs: 1000, sleep: async () => {} },
		captureIngestInput: capture,
	} as ExecutorContext;
	return { sdk, context };
}
describe("provider capture uses the actual ingest request", () => {
	it("sends gateway Basic Auth through the installed SDK while keeping the audit secret-free", async () => {
		const bodies: unknown[] = [],
			audits: unknown[] = [];
		vi.stubGlobal(
			"fetch",
			async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const url = new URL(
					input instanceof Request ? input.url : String(input),
				);
				expect(url.origin).toBe("https://api.bitmovin.com");
				expect(url.pathname).toBe("/v1/encoding/inputs/https");
				bodies.push(JSON.parse(String(init?.body)));
				return new Response(
					JSON.stringify({ data: { result: { id: "input-id" } } }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
		);
		const sdk = createBitmovinSdkOps(
			{ apiKey: "synthetic-only" },
			async (entry) => {
				audits.push(entry);
			},
		);
		expect(
			await sdk.createHttpsInput({
				name: "Pinned",
				host: "capture.example.test",
				port: 8443,
				username: "v1.org.expiry",
				password: "test-only-capability",
			}),
		).toBe("input-id");
		expect(bodies).toEqual([
			expect.objectContaining({
				username: "v1.org.expiry",
				password: "test-only-capability",
				port: 8443,
			}),
		]);
		expect(JSON.stringify(audits)).not.toContain("test-only-capability");
		expect(JSON.stringify(audits)).not.toContain("v1.org.expiry");
	});
	it("sanitizes an SDK error before the audit can persist echoed gateway credentials", async () => {
		const capability = "synthetic-gateway-capability-only";
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							status: "ERROR",
							data: {
								code: 1001,
								message: `Failed username=synthetic-user password=${capability}`,
							},
						}),
						{ status: 400, headers: { "content-type": "application/json" } },
					),
			),
		);
		const audits: unknown[] = [];
		const sdk = createBitmovinSdkOps(
			{ apiKey: "synthetic-only" },
			async (entry) => {
				audits.push(entry);
			},
		);
		await expect(
			sdk.createHttpsInput({
				name: "Pinned",
				host: "capture.example.test",
				username: "synthetic-user",
				password: capability,
			}),
		).rejects.toThrow("HTTPS input creation failed");
		expect(JSON.stringify(audits)).not.toContain(capability);
		expect(JSON.stringify(audits)).not.toContain("synthetic-user");
	});
	it("substitutes the pinned gateway input and persists only non-secret lineage", async () => {
		const capture = vi.fn(async () => ({
			inputId: "gateway-input-id",
			inputPath: "/api/encoding-input-captures/receipt/content",
			inputReceiptId: "receipt",
		}));
		const f = setup(capture);
		const result = await executeStep(operation, f.context);
		expect(capture).toHaveBeenCalledWith({
			operation,
			encodingId: "encoding-id",
		});
		expect(f.sdk.createIngestInputStream).toHaveBeenCalledWith("encoding-id", {
			inputId: "gateway-input-id",
			inputPath: "/api/encoding-input-captures/receipt/content",
			selectionMode: "VIDEO_RELATIVE",
			position: 0,
		});
		expect(result.response).toMatchObject({
			inputReceiptId: "receipt",
			providerInputId: "gateway-input-id",
		});
		expect(result.request).toMatchObject({ inputPath: "original.mp4" });
	});
	it("leaves the old input unchanged when no authoritative capture is possible", async () => {
		const f = setup(vi.fn(async () => null));
		await executeStep(operation, f.context);
		expect(f.sdk.createIngestInputStream).toHaveBeenCalledWith("encoding-id", {
			inputId: "original-input-id",
			inputPath: "original.mp4",
			selectionMode: "VIDEO_RELATIVE",
			position: 0,
		});
	});
	it("does not issue ingest creation after capture failure", async () => {
		const f = setup(
			vi.fn(async () => {
				throw new Error("INPUT_CAPTURE_WAS_CHANGED");
			}),
		);
		await expect(executeStep(operation, f.context)).rejects.toThrow(
			"INPUT_CAPTURE_WAS_CHANGED",
		);
		expect(f.sdk.createIngestInputStream).not.toHaveBeenCalled();
	});
});
