import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

// Explicit opt-in check: this script never loads production credentials or sends requests.
const require = createRequire(import.meta.url);
const packageName = "@bitmovin-internal/api-sdk";
const expectedVersion = "1.289.0-develop.4d2bbf1d";
const configuredPath = process.env.BITOVP_AISA_LIVE_SDK_PATH?.trim();
const modulePath = configuredPath ? resolve(configuredPath) : packageName;
let SDK;
try {
	assert.equal(require(`${modulePath}/package.json`).version, expectedVersion);
	SDK = require(modulePath);
} catch {
	throw new Error(
		`Install ${packageName}@${expectedVersion} separately and set BITOVP_AISA_LIVE_SDK_PATH to its package directory`,
	);
}
globalThis.fetch = async () => {
	throw new Error("Real network is disabled by the AISA SDK contract check");
};

const apiBase = "https://api.bitmovin.com/v1";
const analysisId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const encodingId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const inputId = "dddddddd-dddd-4ddd-addd-dddddddddddd";
const outputId = "cccccccc-cccc-4ccc-accc-cccccccccccc";
const outputs = [{ outputId, outputPath: "synthetic/analysis", acl: [{ permission: "PRIVATE" }] }];
const recording = {
	outputs: [{ outputId, outputPath: "synthetic/recording", acl: [{ permission: "PRIVATE" }] }],
};
const envelope = (value) => Response.json({ data: { result: value } });
const plain = (value) => JSON.parse(JSON.stringify(value));

function client(transport, headers = {}) {
	return new SDK.default({
		apiKey: "synthetic-test-key",
		tenantOrgId: "synthetic-tenant",
		baseUrl: apiBase,
		headers,
		fetch: transport,
	});
}

test("the public SDK and pinned preview SDK coexist without replacing each other", () => {
	const publicRequire = createRequire(new URL("../apps/web/package.json", import.meta.url));
	const publicSDK = publicRequire("@bitmovin/api-sdk");
	assert.equal(
		publicRequire("@bitmovin/api-sdk/package.json").version,
		publicRequire("./package.json").dependencies["@bitmovin/api-sdk"],
	);
	const option = { analysisId, outputs };
	assert.equal(
		Object.hasOwn(new publicSDK.StartLiveEncodingRequest({ aiSceneAnalysisLive: option }), "aiSceneAnalysisLive"),
		false,
	);
	const preview = new SDK.StartLiveEncodingRequest({
		aiSceneAnalysisLive: new SDK.AiSceneAnalysisLive(option),
	});
	assert.equal(preview.aiSceneAnalysisLive.analysisId, analysisId);
});

for (const [label, Input, values, expected] of [
	["RTMP", SDK.AiSceneAnalysisLiveRtmpInput, { streamKey: "synthetickey" }, { type: "RTMP", streamKey: "synthetickey" }],
	["HLS", SDK.AiSceneAnalysisLiveHlsInput, { url: "https://example.invalid/live.m3u8?signature=synthetic%2Fvalue" },
		{ type: "HLS", url: "https://example.invalid/live.m3u8?signature=synthetic%2Fvalue" }],
	["REFERENCE", SDK.AiSceneAnalysisLiveReferenceInput, { inputId }, { type: "REFERENCE", inputId }],
]) {
	test(`plain and typed ${label} creation preserve request and returned identities`, async () => {
		const api = client(async (url, init) => {
			assert.equal(String(url), `${apiBase}/ai-scene-analysis/live-analyses`);
			assert.equal(init.method, "POST");
			assert.deepEqual(JSON.parse(init.body), {
				name: "Synthetic creation", input: expected,
				encoderVersion: "2.291.0", recording, outputs,
			});
			const headers = new Headers(init.headers);
			assert.equal(headers.get("X-Api-Key"), "synthetic-test-key");
			assert.equal(headers.get("X-Tenant-Org-Id"), "synthetic-tenant");
			assert.equal(headers.get("X-BITMOVIN-ES-VERSION"), null);
			return envelope({ analysisId, encodingId, inputId, status: "CREATED" });
		});
		for (const input of [expected, new Input(values)]) {
			const result = await api.aiSceneAnalysis.liveAnalyses.create(
				new SDK.AiSceneAnalysisLiveCreateRequest({
					name: "Synthetic creation", input,
					encoderVersion: "2.291.0", recording, outputs,
				}),
			);
			assert.equal(result.analysisId, analysisId);
			assert.equal(result.encodingId, encodingId);
			assert.equal(result.inputId, inputId);
		}
	});
}

test("HLS creation preserves feature selection and requested versus effective clocks", async () => {
	const request = {
		name: "Synthetic HLS clock", input: { type: "HLS", url: "https://example.invalid/live.m3u8" },
		features: { skipAdvertisements: true }, clockSource: "MANIFEST_WALL_CLOCK",
		recording, outputs,
	};
	const warning = {
		code: "LIVE_ANALYSIS_CLOCK_SOURCE_FALLBACK", message: "Synthetic clock fallback",
		timestamp: "2026-11-16T00:00:00.000Z",
	};
	const api = client(async (url, init) => {
		assert.equal(String(url), `${apiBase}/ai-scene-analysis/live-analyses`);
		assert.deepEqual(JSON.parse(init.body), request);
		return envelope({
			analysisId, encodingId, features: request.features, clockSource: request.clockSource,
			effectiveClockSource: "SYSTEM_CLOCK", warnings: [warning],
		});
	});
	const result = await api.aiSceneAnalysis.liveAnalyses.create(new SDK.AiSceneAnalysisLiveCreateRequest(request));
	assert.deepEqual(plain(result.features), request.features);
	assert.equal(result.clockSource, "MANIFEST_WALL_CLOCK");
	assert.equal(result.effectiveClockSource, "SYSTEM_CLOCK");
	assert.deepEqual(plain(result.warnings), [warning]);
});

test("Start and Stop are bodyless and support component headers independently of encoderVersion", async () => {
	for (const action of ["start", "stop"]) {
		const api = client(async (url, init) => {
			assert.equal(String(url), `${apiBase}/ai-scene-analysis/live-analyses/${analysisId}/${action}`);
			assert.equal(init.method, "POST");
			assert.equal(init.body, undefined);
			const headers = new Headers(init.headers);
			assert.equal(headers.get("X-BITMOVIN-ES-VERSION"), action === "start" ? "synthetic-es" : null);
			assert.equal(headers.get("X-BITMOVIN-AICA-VERSION"), action === "start" ? "synthetic-aica" : null);
			return envelope({ analysisId, encodingId, status: action === "start" ? "QUEUED" : "RUNNING" });
		}, action === "start" ? {
			"X-BITMOVIN-ES-VERSION": "synthetic-es",
			"X-BITMOVIN-AICA-VERSION": "synthetic-aica",
		} : {});
		const result = await api.aiSceneAnalysis.liveAnalyses[action](analysisId);
		assert.equal(result.analysisId, analysisId);
	}
});

test("latest results preserve key moments, unknown categories, observations and media origin", async () => {
	const observation = { id: "observation-a", text: "Synthetic match event", startTimeSeconds: 0, endTimeSeconds: 20 };
	const moment = {
		id: "moment-a", lastUpdatedSequence: 1, importanceLevel: 1,
		startInSeconds: 2, endInSeconds: 10, anchorInSeconds: 6,
		observations: [observation.id], categories: ["sport/tennis", "future/unknown"],
	};
	const snapshot = {
		analysisId, encodingId, sequence: 1, isFinal: false,
		producedAt: "2026-11-07T00:00:00Z", mediaTimeOriginUnixMs: 1794009600000,
		analyzedStartTimeSeconds: 0, analyzedEndTimeSeconds: 20,
		metadata: { version: "synthetic", disclaimer: "Synthetic fixture" },
		effectiveClockSource: "MANIFEST_WALL_CLOCK",
		sourceGaps: [{ startTimeSeconds: 10, endTimeSeconds: 12, reason: "ANALYSIS_LAG" }],
		observations: [observation], keyMoments: [moment],
	};
	const api = client(async (url, init) => {
		assert.equal(String(url), `${apiBase}/ai-scene-analysis/live-analyses/${analysisId}/results/latest`);
		assert.equal(init.method, "GET");
		return envelope(snapshot);
	});
	const result = await api.aiSceneAnalysis.liveAnalyses.results.latest.get(analysisId);
	assert.ok(result.keyMoments[0] instanceof SDK.AiSceneAnalysisLiveKeyMoment);
	assert.deepEqual(plain(result.keyMoments[0]), moment);
	assert.deepEqual(plain(result.metadata), snapshot.metadata);
	assert.equal(result.mediaTimeOriginUnixMs, snapshot.mediaTimeOriginUnixMs);
	assert.equal(result.effectiveClockSource, snapshot.effectiveClockSource);
	assert.deepEqual(plain(result.sourceGaps), snapshot.sourceGaps);
});

test("service-managed media descriptors use the tenant-authenticated API", async () => {
	const media = { hlsUrl: "https://api.bitmovin.com/v1/synthetic/recording.m3u8" };
	const api = client(async (url, init) => {
		assert.equal(String(url), `${apiBase}/ai-scene-analysis/live-analyses/${analysisId}/media`);
		assert.equal(init.method, "GET");
		const headers = new Headers(init.headers);
		assert.equal(headers.get("X-Api-Key"), "synthetic-test-key");
		assert.equal(headers.get("X-Tenant-Org-Id"), "synthetic-tenant");
		return envelope(media);
	});
	assert.deepEqual(plain(await api.aiSceneAnalysis.liveAnalyses.media.get(analysisId)), media);
});

test("result-not-ready retains the documented machine-readable error code", async () => {
	const api = client(async () => Response.json({
		data: { developerMessage: "LIVE_ANALYSIS_RESULT_NOT_AVAILABLE" },
	}, { status: 404 }));
	await assert.rejects(
		api.aiSceneAnalysis.liveAnalyses.results.latest.get(analysisId),
		(error) => error.httpStatusCode === 404 && error.developerMessage === "LIVE_ANALYSIS_RESULT_NOT_AVAILABLE",
	);
});
