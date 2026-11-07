import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireModule, configurations } = vi.hoisted(() => ({
	requireModule: vi.fn(),
	configurations: [] as {
		apiKey: string;
		tenantOrgId?: string;
		headers: Record<string, string>;
		fetch: typeof fetch;
	}[],
}));
vi.mock("node:module", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:module")>();
	return {
		...original,
		default: { ...original, createRequire: () => requireModule },
		createRequire: () => requireModule,
	};
});

import {
	AISA_LIVE_PREVIEW_SDK_VERSION,
	AisaLiveError,
	aisaLiveClientForAccount,
	aisaLivePreviewEnabled,
} from "./aisa-live-sdk";

const analysisId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const outputId = "cccccccc-cccc-4ccc-accc-cccccccccccc";
const createRequest = {
	name: "Synthetic contract",
	input: { type: "RTMP" as const, streamKey: "synthetickey" },
	recording: { outputs: [{ outputId, outputPath: "synthetic/recording" }] },
	outputs: [{ outputId, outputPath: "synthetic/analysis" }],
};

class CreateRequest {
	constructor(readonly input: unknown) {}
}
class FakeSdk {
	readonly aiSceneAnalysis;
	constructor(config: (typeof configurations)[number]) {
		configurations.push(config);
		const call = async (path: string, method = "GET", body?: unknown) => {
			const response = await config.fetch(
				`https://api.bitmovin.com/v1/ai-scene-analysis/live-analyses${path}`,
				{
					method,
					headers: {
						...config.headers,
						"X-Api-Key": config.apiKey,
						...(config.tenantOrgId
							? { "X-Tenant-Org-Id": config.tenantOrgId }
							: {}),
					},
					...(body ? { body: JSON.stringify(body) } : {}),
				},
			);
			if (!response.ok) {
				throw Object.assign(new Error("raw SDK request SECRET"), {
					httpStatusCode: response.status,
					developerMessage: "untrusted error SECRET",
				});
			}
			return response.json();
		};
		this.aiSceneAnalysis = {
			liveAnalyses: {
				create: (request: CreateRequest) => call("", "POST", request.input),
				list: ({ offset, limit }: { offset: number; limit: number }) =>
					call(`?offset=${offset}&limit=${limit}`),
				get: (id: string) => call(`/${id}`),
				start: (id: string) => call(`/${id}/start`, "POST"),
				stop: (id: string) => call(`/${id}/stop`, "POST"),
				results: {
					latest: { get: (id: string) => call(`/${id}/results/latest`) },
				},
			},
		};
	}
}

function context(
	account: { tenantOrgId?: string } | null = { tenantOrgId: "tenant-org" },
) {
	return {
		bitmovinAccounts: {
			get: vi.fn(async () => account),
			revealApiKey: vi.fn(async () => "synthetic-secret"),
		},
	};
}

beforeEach(() => {
	configurations.length = 0;
	requireModule.mockReset();
	requireModule.mockImplementation((name: string) =>
		name.endsWith("/package.json")
			? { version: AISA_LIVE_PREVIEW_SDK_VERSION }
			: { default: FakeSdk, AiSceneAnalysisLiveCreateRequest: CreateRequest },
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ analysisId })),
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("AISA Preview SDK isolation", () => {
	it("is disabled by default and enables only with the exact server flag", () => {
		vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW", "");
		expect(aisaLivePreviewEnabled()).toBe(false);
		vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW", "1");
		expect(aisaLivePreviewEnabled()).toBe(false);
		vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW", "true");
		expect(aisaLivePreviewEnabled()).toBe(true);
		expect(requireModule).not.toHaveBeenCalled();
	});

	it("does not load the private SDK or decrypt a key for an unavailable tenant account", async () => {
		const ctx = context(null);
		expect(await aisaLiveClientForAccount(ctx as never, "missing")).toBeNull();
		expect(ctx.bitmovinAccounts.revealApiKey).not.toHaveBeenCalled();
		expect(requireModule).not.toHaveBeenCalled();
	});

	it("loads the configured external package and verifies its exact version", async () => {
		vi.stubEnv("BITOVP_AISA_LIVE_SDK_PATH", "/tmp/synthetic-aisa-sdk");
		await aisaLiveClientForAccount(context() as never, "account-a");
		expect(requireModule).toHaveBeenCalledWith(
			"/tmp/synthetic-aisa-sdk/package.json",
		);
		expect(requireModule).toHaveBeenCalledWith("/tmp/synthetic-aisa-sdk");
	});

	it.each([
		[
			"AISA_LIVE_SDK_UNAVAILABLE",
			() => {
				throw new Error("secret module path");
			},
		],
		["AISA_LIVE_SDK_VERSION_MISMATCH", () => ({ version: "unexpected" })],
	] as const)("fails safely when the optional SDK has %s", async (code, loader) => {
		requireModule.mockImplementation(loader);
		await expect(
			aisaLiveClientForAccount(context() as never, "account-a"),
		).rejects.toMatchObject({ httpStatusCode: 503, code });
		await expect(
			aisaLiveClientForAccount(context() as never, "account-a"),
		).rejects.not.toThrow(/secret module path|unexpected/);
	});

	it("uses the tenant-scoped saved account and keeps overrides on Start only", async () => {
		const ctx = context();
		const api = await aisaLiveClientForAccount(ctx as never, "account-a", {
			esVersion: "synthetic-es",
			aicaVersion: "synthetic-aica",
		});
		await api?.create(createRequest);
		await api?.get(analysisId);
		await api?.start(analysisId);
		await api?.stop(analysisId);
		await api?.latest(analysisId);
		await api?.list({ offset: 25, limit: 25 });
		expect(ctx.bitmovinAccounts.get).toHaveBeenCalledWith("account-a");
		expect(ctx.bitmovinAccounts.revealApiKey).toHaveBeenCalledWith("account-a");
		expect(configurations).toHaveLength(6);
		for (const [index, config] of configurations.entries()) {
			expect(config.apiKey).toBe("synthetic-secret");
			expect(config.tenantOrgId).toBe("tenant-org");
			expect(config.headers["Correlation-Id"]).toMatch(/^[0-9a-f-]{36}$/);
			expect(config.headers["X-BITMOVIN-ES-VERSION"]).toBe(
				index === 2 ? "synthetic-es" : undefined,
			);
			expect(config.headers["X-BITMOVIN-AICA-VERSION"]).toBe(
				index === 2 ? "synthetic-aica" : undefined,
			);
		}
		const calls = vi.mocked(fetch).mock.calls;
		expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({
			...createRequest,
			recording: {
				outputs: [
					{
						...createRequest.recording.outputs[0],
						acl: [{ permission: "PRIVATE" }],
					},
				],
			},
			outputs: [
				{ ...createRequest.outputs[0], acl: [{ permission: "PRIVATE" }] },
			],
		});
		expect(calls[2]?.[1]?.body).toBeUndefined();
		expect(calls[5]?.[0]).toContain("offset=25&limit=25");
		for (const [, init] of calls) {
			expect(init?.redirect).toBe("error");
			expect(init?.cache).toBe("no-store");
			expect(init?.signal).toBeInstanceOf(AbortSignal);
		}
	});

	it("makes exactly one attempt for an ambiguous mutation and removes raw SDK details", async () => {
		vi.mocked(fetch).mockRejectedValue(new Error("network SECRET"));
		const api = await aisaLiveClientForAccount(context() as never, "account-a");
		const error = await api?.start(analysisId).catch((value: unknown) => value);
		expect(error).toBeInstanceOf(AisaLiveError);
		expect(error).toMatchObject({ httpStatusCode: 502 });
		expect(String(error)).not.toContain("SECRET");
		expect(Object.hasOwn(error as object, "cause")).toBe(false);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it.each([
		[
			"LIVE_ANALYSIS_RESULT_NOT_AVAILABLE",
			"LIVE_ANALYSIS_RESULT_NOT_AVAILABLE",
		],
		["unexpected SECRET", undefined],
	])("allows only the known pending error code: %s", async (developerMessage, code) => {
		vi.mocked(fetch).mockResolvedValue(
			Response.json({ data: { developerMessage } }, { status: 404 }),
		);
		const api = await aisaLiveClientForAccount(context() as never, "account-a");
		const error = await api
			?.latest(analysisId)
			.catch((value: unknown) => value);
		expect(error).toMatchObject({ httpStatusCode: 404 });
		expect((error as AisaLiveError).code).toBe(code);
		expect(String(error)).not.toContain("SECRET");
	});

	it("rejects oversized upstream bodies before the SDK reads them", async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response("small", { headers: { "content-length": "99999999" } }),
		);
		const api = await aisaLiveClientForAccount(context() as never, "account-a");
		await expect(api?.get(analysisId)).rejects.toMatchObject({
			httpStatusCode: 502,
		});
	});
});
