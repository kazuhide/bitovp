import type { AisaLiveClient } from "@bitovp/core/aisa-live-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBitmovinSdkOps, type SdkOpsOptions } from "./sdk-ops";

const sdkMock = vi.hoisted(() => ({ factory: vi.fn() }));
vi.mock("@bitovp/core/aisa-live-client", async (original) => ({
	...(await original<typeof import("@bitovp/core/aisa-live-client")>()),
	createAisaLiveClient: sdkMock.factory,
}));

const runId = "a0000000-0000-4000-8000-000000000001";
const analysisId = "a0000000-0000-4000-8000-000000000002";
const encodingId = "a0000000-0000-4000-8000-000000000003";
const finalSnapshot = {
	analysisId,
	encodingId,
	isFinal: true,
	sequence: 1,
	producedAt: "2026-11-07T00:00:00.000Z",
	mediaTimeOriginUnixMs: 1794009600000,
	analyzedStartTimeSeconds: 0,
	analyzedEndTimeSeconds: 60,
	metadata: { version: "1", disclaimer: "Preview" },
	observations: [],
	keyMoments: [],
	sourceGaps: [],
};
const request = {
	name: "A match",
	input: { type: "RTMP" as const, streamKey: "match" },
	cloudRegion: "GOOGLE_EUROPE_WEST_1",
	recording: { outputs: [{ outputId: runId, outputPath: "recording" }] },
	outputs: [{ outputId: runId, outputPath: "analysis" }],
};

function fixture() {
	let createDispatched = false;
	let startDispatched = false;
	let bound: string | undefined;
	let provider: Record<string, unknown> | undefined;
	const client: AisaLiveClient = {
		list: vi.fn(async () => ({ items: provider ? [provider] : [] })),
		get: vi.fn(async () => provider),
		create: vi.fn(async (body) => {
			provider = { analysisId, encodingId, status: "CREATED", name: body.name };
			return provider;
		}),
		start: vi.fn(async () => {
			if (provider) provider.status = "QUEUED";
		}),
		stop: vi.fn(async () => {
			if (provider) provider.status = "FINISHED";
		}),
		latest: vi.fn(async () => finalSnapshot),
	};
	sdkMock.factory.mockReturnValue(client);
	const beforeCreate = vi.fn(async () => {
		createDispatched = true;
	});
	const beforeStart = vi.fn(async () => {
		startDispatched = true;
	});
	const check = vi.fn(async () => {});
	const options: SdkOpsOptions = {
		apiKey: "private-test-key",
		tenantOrgId: "organization",
		startControl: { check, sleep: async () => {} },
		aisaLive: {
			runId: () => runId,
			analysisId: () => bound,
			encodingId: () => encodingId,
			creationMayExist: () => createDispatched,
			beforeCreate,
			startMayExist: () => startDispatched,
			beforeStart,
			sleep: async () => {},
		},
	};
	const ops = createBitmovinSdkOps(options, async () => {});
	return {
		ops,
		client,
		beforeCreate,
		beforeStart,
		check,
		bind: () => {
			bound = analysisId;
		},
		setProvider: (value: Record<string, unknown> | undefined) => {
			provider = value;
		},
		markDispatched: () => {
			createDispatched = true;
		},
	};
}

describe("managed AISA worker boundary", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});
	beforeEach(() => {
		vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW", "true");
		sdkMock.factory.mockReset();
	});

	it("loads the optional SDK only for an AISA operation and durably marks dispatch before POST", async () => {
		const f = fixture();
		expect(sdkMock.factory).not.toHaveBeenCalled();
		vi.mocked(f.client.create).mockImplementation(async (body) => {
			expect(f.beforeCreate).toHaveBeenCalledOnce();
			return { analysisId, encodingId, status: "CREATED", name: body.name };
		});
		expect(await f.ops.createAisaLiveAnalysis(request)).toBe(analysisId);
		expect(f.client.create).toHaveBeenCalledWith(
			expect.objectContaining({
				name: `${request.name} [bitovp-run:${runId}]`,
			}),
		);
	});

	it("adopts a response-lost create by exact run identity without a duplicate POST", async () => {
		const f = fixture();
		vi.mocked(f.client.create).mockImplementationOnce(async (body) => {
			f.setProvider({
				analysisId,
				encodingId,
				status: "CREATED",
				name: body.name,
			});
			throw new Error("lost response with a private upstream body");
		});
		expect(await f.ops.createAisaLiveAnalysis(request)).toBe(analysisId);
		expect(await f.ops.createAisaLiveAnalysis(request)).toBe(analysisId);
		expect(f.client.create).toHaveBeenCalledOnce();
	});

	it("never repeats an ambiguous create when a subsequent scan is empty", async () => {
		const f = fixture();
		vi.mocked(f.client.create).mockRejectedValue(
			new Error("secret provider details"),
		);
		await expect(f.ops.createAisaLiveAnalysis(request)).rejects.toThrow(
			"AISA_LIVE_CREATE_OUTCOME_UNKNOWN",
		);
		await expect(f.ops.createAisaLiveAnalysis(request)).rejects.toThrow(
			"AISA_LIVE_CREATE_OUTCOME_UNKNOWN",
		);
		expect(f.client.create).toHaveBeenCalledOnce();
	});

	it("refuses a stale generation before any provider write", async () => {
		const f = fixture();
		f.check.mockRejectedValueOnce(new Error("lease lost"));
		await expect(f.ops.createAisaLiveAnalysis(request)).rejects.toThrow(
			"lease lost",
		);
		expect(f.client.create).not.toHaveBeenCalled();
	});

	it("does not start a foreign encoding and does not repeat an uncertain start", async () => {
		const f = fixture();
		f.setProvider({ analysisId, encodingId, status: "CREATED" });
		await expect(
			f.ops.startAisaLiveAnalysis(analysisId, runId),
		).rejects.toThrow("AISA_LIVE_IDENTITY_MISMATCH");
		expect(f.client.start).not.toHaveBeenCalled();
		vi.mocked(f.client.start).mockRejectedValue(new Error("network lost"));
		await expect(
			f.ops.startAisaLiveAnalysis(analysisId, encodingId),
		).rejects.toThrow("AISA_LIVE_START_OUTCOME_UNKNOWN");
		await expect(
			f.ops.startAisaLiveAnalysis(analysisId, encodingId),
		).rejects.toThrow("AISA_LIVE_START_OUTCOME_UNKNOWN");
		expect(f.client.start).toHaveBeenCalledOnce();
	});

	it("recognizes a started Analysis and passes component versions only to its SDK", async () => {
		const f = fixture();
		f.setProvider({ analysisId, encodingId, status: "RUNNING" });
		await f.ops.startAisaLiveAnalysis(analysisId, encodingId, {
			esVersion: "es-dev",
			aicaVersion: "aica-dev",
		});
		expect(f.client.start).not.toHaveBeenCalled();
		expect(f.beforeStart).not.toHaveBeenCalled();
	});

	it("waits for Analysis final metadata before observing the independently finished Encoder", async () => {
		const f = fixture();
		f.bind();
		f.setProvider({ analysisId, encodingId, status: "RUNNING" });
		const order: string[] = [];
		vi.mocked(f.client.stop).mockImplementation(async () => {
			order.push("analysis-stop");
			f.setProvider({ analysisId, encodingId, status: "FINISHED" });
		});
		vi.mocked(f.client.latest).mockImplementation(async () => {
			order.push("final-result");
			return finalSnapshot;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				order.push("encoding-status");
				return new Response(
					JSON.stringify({
						status: "SUCCESS",
						data: { result: { status: "FINISHED" } },
					}),
				);
			}),
		);
		await f.ops.stopLiveEncoding(encodingId);
		expect(order).toEqual(["analysis-stop", "final-result", "encoding-status"]);
	});

	it("keeps finalization pending when Encoder stop fallback succeeds after an Analysis failure", async () => {
		const f = fixture();
		f.bind();
		f.setProvider({ analysisId, encodingId, status: "RUNNING" });
		vi.mocked(f.client.stop).mockRejectedValue(
			new Error("private provider failure"),
		);
		const paths: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL | Request) => {
				paths.push(String(url));
				return new Response(
					JSON.stringify({
						status: "SUCCESS",
						data: { result: { status: "RUNNING" } },
					}),
				);
			}),
		);
		await expect(f.ops.stopLiveEncoding(encodingId)).rejects.toThrow(
			"AISA_LIVE_FINALIZATION_PENDING",
		);
		expect(
			paths.some((path) =>
				path.endsWith(`/encoding/encodings/${encodingId}/live/stop`),
			),
		).toBe(true);
	});

	it("does not mutate either provider resource when the Analysis belongs to another Encoding", async () => {
		const f = fixture();
		f.bind();
		f.setProvider({ analysisId, encodingId: runId, status: "RUNNING" });
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		await expect(f.ops.stopLiveEncoding(encodingId)).rejects.toThrow(
			"AISA_LIVE_IDENTITY_MISMATCH",
		);
		expect(fetch).not.toHaveBeenCalled();
		expect(f.client.stop).not.toHaveBeenCalled();
	});

	it("bounds a provider read failure with Encoder stop using the exact durable run binding", async () => {
		const f = fixture();
		f.bind();
		vi.mocked(f.client.get).mockRejectedValue(new Error("network failure"));
		const paths: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL | Request) => {
				paths.push(String(url));
				return new Response(
					JSON.stringify({
						status: "SUCCESS",
						data: { result: { status: "RUNNING" } },
					}),
				);
			}),
		);
		await expect(f.ops.stopLiveEncoding(encodingId)).rejects.toThrow(
			"AISA_LIVE_FINALIZATION_PENDING",
		);
		expect(
			paths.some((path) =>
				path.endsWith(`/encoding/encodings/${encodingId}/live/stop`),
			),
		).toBe(true);
	});
});
