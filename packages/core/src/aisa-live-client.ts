import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";

export type AisaLiveCreateRequest = {
	name: string;
	input:
		| { type: "RTMP"; streamKey: string }
		| { type: "REFERENCE"; inputId: string; streamKey?: string }
		| { type: "HLS"; url: string; name?: string };
	cloudRegion?: string;
	encoderVersion?: string;
	recording: { outputs: AisaLiveDestination[] };
	outputs: AisaLiveDestination[];
};
type AisaLiveDestination = {
	outputId: string;
	outputPath: string;
	acl?: { permission: "PRIVATE" }[];
};

async function readBoundedBody(
	response: Response,
	limit: number,
): Promise<Uint8Array | null> {
	const declared = response.headers.get("content-length");
	if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
		void response.body?.cancel().catch(() => {});
		return null;
	}
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const bytes = new Uint8Array(limit);
	let used = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return bytes.subarray(0, used);
			if (value.byteLength > limit - used) {
				void reader.cancel().catch(() => {});
				return null;
			}
			bytes.set(value, used);
			used += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
}

export const AISA_LIVE_PREVIEW_SDK_VERSION = "1.288.0-develop.02b690c6";
const SDK_PACKAGE = "@bitmovin-internal/api-sdk";
const API_BASE = "https://api.bitmovin.com/v1";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const requireModule = createRequire(import.meta.url);

export type AisaLiveErrorCode =
	| "LIVE_ANALYSIS_RESULT_NOT_AVAILABLE"
	| "AISA_LIVE_SDK_UNAVAILABLE"
	| "AISA_LIVE_SDK_VERSION_MISMATCH";

/** Carries no raw SDK message, request, response, credentials, or cause. */
export class AisaLiveError extends Error {
	constructor(
		readonly httpStatusCode: number,
		readonly code?: AisaLiveErrorCode,
	) {
		super(
			code === "AISA_LIVE_SDK_UNAVAILABLE"
				? "The AISA Live Preview SDK is not installed or could not be loaded"
				: code === "AISA_LIVE_SDK_VERSION_MISMATCH"
					? "The installed AISA Live Preview SDK does not match the required version"
					: `AISA Live API request failed (${httpStatusCode})`,
		);
		this.name = "AisaLiveError";
	}
}

export function aisaLivePreviewEnabled(): boolean {
	return process.env.BITOVP_AISA_LIVE_PREVIEW === "true";
}

export type AisaLiveVersions = { esVersion?: string; aicaVersion?: string };
export type AisaLiveClient = {
	list(params: { offset: number; limit: number }): Promise<unknown>;
	create(analysis: AisaLiveCreateRequest): Promise<unknown>;
	get(id: string): Promise<unknown>;
	start(id: string): Promise<unknown>;
	stop(id: string): Promise<unknown>;
	latest(id: string): Promise<unknown>;
};

type SdkApi = {
	aiSceneAnalysis: {
		liveAnalyses: Omit<AisaLiveClient, "latest"> & {
			results: { latest: { get(id: string): Promise<unknown> } };
		};
	};
};
type SdkModule = {
	default: new (configuration: {
		apiKey: string;
		tenantOrgId?: string;
		baseUrl: string;
		headers: Record<string, string>;
		fetch: typeof fetch;
	}) => SdkApi;
	AiSceneAnalysisLiveCreateRequest: new (
		analysis: AisaLiveCreateRequest,
	) => AisaLiveCreateRequest;
};

/** Optional private dependencies are resolved only inside an enabled API call. */
function loadSdk(): SdkModule {
	const configuredPath = process.env.BITOVP_AISA_LIVE_SDK_PATH?.trim();
	const modulePath = configuredPath
		? resolve(/* turbopackIgnore: true */ configuredPath)
		: SDK_PACKAGE;
	const metadataPath = `${modulePath}/package.json`;
	try {
		// Native runtime loading is intentional: this optional SDK is installed
		// separately. Turbopack otherwise replaces these calls with throwing stubs.
		const metadata: unknown = requireModule(
			/* turbopackIgnore: true */ metadataPath,
		);
		if (
			!metadata ||
			typeof metadata !== "object" ||
			!("version" in metadata) ||
			metadata.version !== AISA_LIVE_PREVIEW_SDK_VERSION
		) {
			throw new AisaLiveError(503, "AISA_LIVE_SDK_VERSION_MISMATCH");
		}
		const sdk: unknown = requireModule(/* turbopackIgnore: true */ modulePath);
		if (
			!sdk ||
			typeof sdk !== "object" ||
			!("default" in sdk) ||
			typeof sdk.default !== "function" ||
			!("AiSceneAnalysisLiveCreateRequest" in sdk) ||
			typeof sdk.AiSceneAnalysisLiveCreateRequest !== "function"
		) {
			throw new AisaLiveError(503, "AISA_LIVE_SDK_UNAVAILABLE");
		}
		// All private generated SDK types stay at this version-checked boundary.
		return sdk as SdkModule;
	} catch (error) {
		if (error instanceof AisaLiveError) throw error;
		throw new AisaLiveError(503, "AISA_LIVE_SDK_UNAVAILABLE");
	}
}

export function createAisaLiveClient(options: {
	apiKey: string;
	tenantOrgId?: string;
	versions?: AisaLiveVersions;
	fetch?: typeof fetch;
}): AisaLiveClient {
	const sdk = loadSdk();
	const { apiKey, tenantOrgId, versions = {} } = options;
	const transport = options.fetch ?? fetch;

	async function call(
		action: (api: SdkApi) => Promise<unknown>,
		start = false,
	): Promise<unknown> {
		let status = 0;
		let code: AisaLiveErrorCode | undefined;
		try {
			const api = new sdk.default({
				apiKey,
				...(tenantOrgId ? { tenantOrgId } : {}),
				baseUrl: API_BASE,
				headers: {
					"Correlation-Id": randomUUID(),
					...(start && versions.esVersion
						? { "X-BITMOVIN-ES-VERSION": versions.esVersion }
						: {}),
					...(start && versions.aicaVersion
						? { "X-BITMOVIN-AICA-VERSION": versions.aicaVersion }
						: {}),
				},
				fetch: async (url, init) => {
					const endpoint = new URL(String(url));
					const prefix = "/v1/ai-scene-analysis/live-analyses";
					if (
						endpoint.origin !== "https://api.bitmovin.com" ||
						!(
							endpoint.pathname === prefix ||
							endpoint.pathname.startsWith(`${prefix}/`)
						)
					) {
						throw new AisaLiveError(502);
					}
					const response = await transport(url, {
						...init,
						redirect: "error",
						cache: "no-store",
						signal: AbortSignal.timeout(20_000),
					});
					status = response.status;
					const bytes = await readBoundedBody(response, MAX_RESPONSE_BYTES);
					if (bytes === null) throw new AisaLiveError(502);
					const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
					if (!response.ok) {
						try {
							const body = JSON.parse(text);
							if (
								body?.data?.developerMessage ===
								"LIVE_ANALYSIS_RESULT_NOT_AVAILABLE"
							) {
								code = "LIVE_ANALYSIS_RESULT_NOT_AVAILABLE";
							}
						} catch {
							// Error bodies are untrusted and never become public messages.
						}
					}
					return new Response(text || null, {
						status: response.status,
						headers: response.headers,
					});
				},
			});
			return await action(api);
		} catch {
			throw new AisaLiveError(status >= 400 ? status : 502, code);
		}
	}

	return {
		list: (params) =>
			call((api) => api.aiSceneAnalysis.liveAnalyses.list(params)),
		create: (analysis) =>
			call((api) =>
				api.aiSceneAnalysis.liveAnalyses.create(
					new sdk.AiSceneAnalysisLiveCreateRequest({
						...analysis,
						recording: {
							outputs: analysis.recording.outputs.map((destination) => ({
								...destination,
								acl: [{ permission: "PRIVATE" }],
							})),
						},
						outputs: analysis.outputs.map((destination) => ({
							...destination,
							acl: [{ permission: "PRIVATE" }],
						})),
					}),
				),
			),
		get: (id) => call((api) => api.aiSceneAnalysis.liveAnalyses.get(id)),
		start: (id) =>
			call((api) => api.aiSceneAnalysis.liveAnalyses.start(id), true),
		stop: (id) => call((api) => api.aiSceneAnalysis.liveAnalyses.stop(id)),
		latest: (id) =>
			call((api) => api.aiSceneAnalysis.liveAnalyses.results.latest.get(id)),
	};
}
