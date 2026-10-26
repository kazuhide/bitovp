import { createRequire } from "node:module";
import type BitmovinApi from "@bitmovin/api-sdk";
import { afterEach, expect, it, vi } from "vitest";
import { projectPerTitleEncodingImport } from "@/app/vod/new/per-title-encoding-import";
import { createPerTitleEncodingHttpPort } from "./per-title-encoding-http";
import { loadPerTitleEncodingSnapshot } from "./per-title-encoding-loader";

const require = createRequire(import.meta.url);
const { default: RealBitmovinApi } = require("@bitmovin/api-sdk") as {
	default: typeof BitmovinApi;
};
const { version: sdkVersion } = require("@bitmovin/api-sdk/package.json") as {
	version: string;
};
const uuid = (suffix: number) =>
	`00000000-0000-4000-8000-${suffix.toString(16).padStart(12, "0")}`;

afterEach(() => vi.restoreAllMocks());

it("imports actual SDK response models without inventing dimensions or losing zero and nested settings", async () => {
	const encodingId = uuid(1);
	const configId = uuid(2);
	const apiKey = "fixture-only-sdk-import-key";
	const tenantOrgId = uuid(3);
	const global = {
		minBitrate: 100000,
		maxBitrate: 4000000,
		minBitrateStepSize: 1.5,
		maxBitrateStepSize: 3,
		targetQualityCrf: 0,
		resolutionScaleFactor: 0,
		autoRepresentations: { adoptConfigurationThreshold: 0 },
		fixedResolutionAndBitrateConfiguration: {
			forcedRenditionAboveHighestFixedRepresentation: 0,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.2,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode:
				"LAST_CALCULATED_BITRATE",
		},
	};
	const fixedSettings = {
		minBitrate: 300000,
		maxBitrate: 650000,
		bitrateSelectionMode: "COMPLEXITY_RANGE",
		lowComplexityBoundaryForMaxBitrate: 900000,
		highComplexityBoundaryForMaxBitrate: 4000000,
	};
	const sourceStreams = [
		{
			id: uuid(4),
			codecConfigId: configId,
			mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
			perTitleSettings: {
				fixedResolutionAndBitrateSettings: fixedSettings,
				codecMaxBitrateFactor: 2,
				codecBufsizeFactor: 3,
			},
			appliedSettings: { width: 1280, height: 720 },
			inputStreams: [
				{ inputId: uuid(20), inputPath: "fixture-input-metadata" },
			],
		},
		{
			id: uuid(5),
			codecConfigId: configId,
			mode: "PER_TITLE_TEMPLATE",
			perTitleSettings: { codecMaxBitrateFactor: 1.25, codecBufsizeFactor: 2 },
		},
		{ id: uuid(6), codecConfigId: uuid(30), mode: "PER_TITLE_RESULT" },
		{ id: uuid(7), codecConfigId: uuid(31), mode: "STANDARD" },
	];
	const calls: { path: string; method: string; headers: Headers }[] = [];
	const outsideFetch = vi
		.spyOn(globalThis, "fetch")
		.mockRejectedValue(new Error("External network access is forbidden"));
	const transport: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		expect(url.origin).toBe("https://api.bitmovin.com");
		expect(method).toBe("GET");
		calls.push({
			path: url.pathname,
			method,
			headers: new Headers(init?.headers),
		});
		let result: unknown;
		switch (url.pathname) {
			case `/v1/encoding/encodings/${encodingId}/start`:
				result = {
					perTitle: { h264Configuration: global },
					previewHlsManifests: [{ manifestId: uuid(21) }],
				};
				break;
			case `/v1/encoding/encodings/${encodingId}/streams`:
				expect(url.searchParams.get("limit")).toBe("100");
				expect(url.searchParams.get("offset")).toBe("0");
				result = {
					totalCount: sourceStreams.length,
					offset: 0,
					limit: 100,
					items: sourceStreams,
				};
				break;
			case `/v1/encoding/configurations/${configId}/type`:
				result = { type: "H264" };
				break;
			case `/v1/encoding/configurations/video/h264/${configId}`:
				result = { id: configId, width: 640, bitrate: null, profile: "HIGH" };
				break;
			default:
				throw new Error("Unexpected provider read");
		}
		return new Response(
			JSON.stringify({
				requestId: uuid(40),
				status: "SUCCESS",
				data: { result },
			}),
			{
				status: 200,
				headers: { "content-type": "application/json" },
			},
		);
	};
	const api = new RealBitmovinApi({ apiKey, tenantOrgId, fetch: transport });
	const snapshot = await loadPerTitleEncodingSnapshot(api, encodingId, {
		signal: new AbortController().signal,
	});
	expect(Object.getPrototypeOf(snapshot.startRequest).constructor.name).toBe(
		"StartEncodingRequest",
	);
	expect(
		Object.getPrototypeOf(snapshot.streams[0]?.stream).constructor.name,
	).toBe("Stream");
	expect(
		Object.getPrototypeOf(snapshot.streams[0]?.configuration).constructor.name,
	).toBe("H264VideoConfiguration");
	const imported = projectPerTitleEncodingImport(snapshot);
	expect(imported.issues).toEqual([]);
	expect(imported.configurations).toHaveLength(1);
	const loaded = imported.configurations[0];
	expect(loaded?.reference.global).toEqual(global);
	expect(loaded?.reference.streams[0]).toEqual({
		id: uuid(4),
		codec: "H264",
		mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
		width: 640,
		bitrate: null,
		perTitleSettings: {
			...fixedSettings,
			codecMaxBitrateFactor: 2,
			codecBufsizeFactor: 3,
		},
	});
	expect(loaded?.goal.rows?.[0]?.width).toBe(640);
	expect(loaded?.goal.rows?.[0]?.height).toBeUndefined();
	expect(loaded?.reference.streams[0]?.height).toBeUndefined();
	expect(loaded?.reference.streams[1]?.perTitleSettings).toEqual({
		codecMaxBitrateFactor: 1.25,
		codecBufsizeFactor: 2,
	});
	expect(loaded?.goal.targetQualityCrf).toBe(0);
	expect(loaded?.goal.resolutionScaleFactor).toBe(0);
	expect(loaded?.goal.countPolicy).toEqual({ kind: "unrestricted" });
	expect(calls.map(({ path }) => path)).toEqual([
		`/v1/encoding/encodings/${encodingId}/start`,
		`/v1/encoding/encodings/${encodingId}/streams`,
		`/v1/encoding/configurations/${configId}/type`,
		`/v1/encoding/configurations/video/h264/${configId}`,
	]);
	for (const call of calls) {
		expect(call.headers.get("X-Api-Key")).toBe(apiKey);
		expect(call.headers.get("X-Tenant-Org-Id")).toBe(tenantOrgId);
		expect(call.headers.get("X-Api-Client-Version")).toBe(sdkVersion);
	}
	expect(outsideFetch).not.toHaveBeenCalled();
	const serialized = JSON.stringify(imported);
	expect(serialized).not.toContain(apiKey);
	expect(serialized).not.toContain(tenantOrgId);
	expect(serialized).not.toContain("fixture-input-metadata");
	expect(serialized).not.toContain("inputStreams");
});

it("preserves unsupported HTTP fields through the raw import port that SDK deserialization would erase", async () => {
	const encodingId = uuid(1);
	const configId = uuid(2);
	const transport: typeof fetch = async (input) => {
		const url = new URL(String(input));
		let result: unknown;
		if (url.pathname.endsWith("/start"))
			result = {
				perTitle: {
					h264Configuration: {
						minBitrate: 100000,
						maxBitrate: 4000000,
						futurePerTitleSetting: 1,
					},
				},
			};
		else if (url.pathname.endsWith("/streams"))
			result = {
				totalCount: 1,
				items: [
					{ id: uuid(4), mode: "PER_TITLE_TEMPLATE", codecConfigId: configId },
				],
			};
		else if (url.pathname.endsWith("/type")) result = { type: "H264" };
		else result = { id: configId, width: 640 };
		return new Response(
			JSON.stringify({ status: "SUCCESS", data: { result } }),
			{ status: 200 },
		);
	};
	const api = new RealBitmovinApi({
		apiKey: "fixture-only-sdk-import-key",
		fetch: transport,
	});
	const snapshot = await loadPerTitleEncodingSnapshot(api, encodingId, {
		signal: new AbortController().signal,
	});
	// The installed SDK drops the future setting before a caller can inspect it.
	expect(projectPerTitleEncodingImport(snapshot).issues).toEqual([]);
	const signal = new AbortController().signal;
	const original = await loadPerTitleEncodingSnapshot(
		createPerTitleEncodingHttpPort({
			apiKey: "fixture-only-sdk-import-key",
			signal,
			fetch: transport,
		}),
		encodingId,
		{ signal },
	);
	expect(projectPerTitleEncodingImport(original)).toEqual({
		configurations: [],
		issues: [{ codec: "H264", code: "UNSUPPORTED_GLOBAL_SETTINGS" }],
	});
});
