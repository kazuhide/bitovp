import {
	type CompiledOperation,
	curlForStep,
	redactSecrets,
} from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeStep } from "./executor";
import { type AuditRecorder, createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

function setup() {
	const requests: Record<string, unknown>[] = [];
	const fetch = vi.fn(async (_url: string, init: RequestInit) => {
		requests.push(JSON.parse(String(init.body)));
		return new Response(
			JSON.stringify({ data: { result: { id: "created" } } }),
			{
				status: 200,
				headers: { "content-type": "application/json" },
			},
		);
	});
	vi.stubGlobal("fetch", fetch);
	const audit = vi.fn<AuditRecorder>(async () => {});
	const sdk = createBitmovinSdkOps(
		{ apiKey: "synthetic-key", tenantOrgId: null },
		audit,
	);
	return { sdk, audit, fetch, requests };
}

function operation(kind: "HLS" | "DASH", vttUrl: string): CompiledOperation {
	return {
		step: "external-subtitle",
		kind:
			kind === "HLS"
				? "CREATE_HLS_VTT_MEDIA"
				: "CREATE_DASH_REPRESENTATION_VTT",
		payload: {
			vttUrl,
			...(kind === "HLS"
				? { name: "English", groupId: "subtitles", uri: "subtitles.m3u8" }
				: {}),
		},
		refs: {
			manifestId: "manifest",
			periodId: "period",
			adaptationSetId: "set",
		},
	};
}

const ids = () =>
	new Map([
		["manifest", "manifest-id"],
		["period", "period-id"],
		["set", "set-id"],
	]);

describe.each([
	"HLS",
	"DASH",
] as const)("external %s VTT SDK boundary", (kind) => {
	it.each([
		"https://cdn.example.test/sub.vtt?token=SYNTHETIC_URL_SECRET",
		"https://cdn.example.test/sub.vtt?ticket=SYNTHETIC_URL_SECRET",
		"https://cdn.example.test/sub.vtt?X-Amz-Signature=SYNTHETIC_URL_SECRET",
		"https://cdn.example.test/sub.vtt#SYNTHETIC_URL_SECRET",
		"https://synthetic-user:SYNTHETIC_URL_SECRET@cdn.example.test/sub.vtt",
		"https://SYNTHETIC_URL_SECRET@cdn.example.test/sub.vtt",
		"ftp://cdn.example.test/sub.vtt",
		"SYNTHETIC_URL_SECRET",
	])("rejects bypassed URLs before network, audit or executor snapshots: %s", async (url) => {
		const { sdk, fetch, audit } = setup();
		const result = executeStep(operation(kind, url), {
			sdk,
			ids: ids(),
			resolveCredential: vi.fn(),
			poll: { intervalMs: 1, timeoutMs: 1, sleep: async () => {} },
		});
		const error = await result.catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).toMatch(/public.*query.*signed URLs/i);
		expect(String(error)).not.toContain("SYNTHETIC_URL_SECRET");
		expect(redactSecrets({ error: String(error) })).toEqual({
			error: String(error),
		});
		expect(fetch).not.toHaveBeenCalled();
		expect(audit).not.toHaveBeenCalled();
	});

	it("preserves the public URL in SDK wire, audit, executor snapshot and cURL", async () => {
		const { sdk, requests, audit } = setup();
		const url = "https://cdn.example.test/subtitles/en.vtt";
		const op = operation(kind, url);
		const result = await executeStep(op, {
			sdk,
			ids: ids(),
			resolveCredential: vi.fn(),
			poll: { intervalMs: 1, timeoutMs: 1, sleep: async () => {} },
		});
		expect(requests[0]?.vttUrl).toBe(url);
		expect(audit.mock.calls[0]?.[0].request).toMatchObject({ vttUrl: url });
		expect(result.request).toMatchObject({ vttUrl: url });
		const curl = curlForStep({
			...op,
			status: "DONE",
			request: redactSecrets(result.request),
		});
		expect(curl.ok).toBe(true);
		if (!curl.ok) throw new Error(curl.code);
		expect(curl.command).toContain(url);
	});

	it("captures the validated URL before asynchronous audit recording", async () => {
		const { sdk, requests, audit, fetch } = setup();
		const payload = {
			vttUrl: "https://cdn.example.test/sub.vtt",
			name: "English",
			groupId: "subtitles",
			uri: "subtitles.m3u8",
		};
		const originalFetch = fetch.getMockImplementation();
		if (!originalFetch) throw new Error("Missing mock fetch");
		fetch.mockImplementation(async (...args) => {
			const response = originalFetch(...args);
			payload.vttUrl =
				"https://cdn.example.test/sub.vtt?token=SYNTHETIC_URL_SECRET";
			return response;
		});
		if (kind === "HLS") await sdk.createHlsVttMedia("manifest", payload);
		else
			await sdk.createDashVttRepresentation(
				"manifest",
				"period",
				"set",
				payload,
			);
		expect(requests[0]?.vttUrl).toBe("https://cdn.example.test/sub.vtt");
		expect(audit.mock.calls[0]?.[0].request).toMatchObject({
			vttUrl: "https://cdn.example.test/sub.vtt",
		});
		expect(JSON.stringify(audit.mock.calls)).not.toContain(
			"SYNTHETIC_URL_SECRET",
		);
	});
});
