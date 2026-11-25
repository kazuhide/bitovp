import { afterEach, expect, it, vi } from "vitest";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

it.each([
	["SPEKE", "FMP4", "fmp4"],
	["SPEKE", "MP4", "mp4"],
	["SPEKE", "TS", "ts"],
	["SPEKE", "PROGRESSIVE_TS", "progressive-ts"],
	["SPEKE", "WEBM", "webm"],
	["SPEKE", "PROGRESSIVE_WEBM", "progressive-webm"],
	["FAIRPLAY", "PROGRESSIVE_TS", "progressive-ts"],
	["CENC", "PROGRESSIVE_WEBM", "progressive-webm"],
] as const)("creates and lists %s on the exact %s muxing through the installed SDK", async (kind, muxingKind, segment) => {
	const requests: { url: URL; method: string; body: unknown }[] = [];
	vi.stubGlobal("fetch", async (input: string, options: RequestInit) => {
		const method = options.method ?? "GET";
		requests.push({
			url: new URL(input),
			method,
			body: options.body ? JSON.parse(String(options.body)) : undefined,
		});
		const value =
			method === "POST"
				? { id: "drm-resource" }
				: {
						items: [
							{ id: "drm-resource", outputs: [{ outputPath: "protected/" }] },
						],
						totalCount: 1,
					};
		return new Response(JSON.stringify({ data: { result: value } }), {
			status: method === "POST" ? 201 : 200,
			headers: { "content-type": "application/json" },
		});
	});
	const audit = vi.fn(async () => {});
	const sdk = createBitmovinSdkOps({ apiKey: "local-sdk-test" }, audit);
	const destination = { outputId: "output", outputPath: "protected/" };
	const key = "ab".repeat(16),
		iv = "cd".repeat(16),
		kid = "ef".repeat(16);
	const provider = { url: "https://provider.example.test/test-only" },
		systemIds = ["edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"];
	const spekeFields = {
		provider,
		systemIds,
		contentId: "program-123",
		name: "Protected program",
		kid,
		iv,
	};
	const result =
		kind === "SPEKE"
			? await sdk.createSpekeDrm("encoding", "muxing", {
					muxingKind,
					...spekeFields,
					destination,
				})
			: kind === "CENC"
				? await sdk.createCencDrm("encoding", "muxing", {
						muxingKind,
						key,
						kid,
						destination,
					})
				: await sdk.createFairPlayDrm("encoding", "muxing", {
						muxingKind,
						key,
						iv,
						uri: "skd://example",
						destination,
					});
	expect(result).toBe("drm-resource");
	expect(
		await sdk.listMuxingDrm("encoding", "muxing", muxingKind, kind),
	).toEqual([{ id: "drm-resource", outputPath: "protected/" }]);
	const path = `/v1/encoding/encodings/encoding/muxings/${segment}/muxing/drm/${kind.toLowerCase()}`;
	expect(requests.map((r) => [r.method, r.url.pathname])).toEqual([
		["POST", path],
		["GET", path],
	]);
	expect(requests[0]?.body).toMatchObject({
		outputs: [destination],
		...(kind === "SPEKE"
			? spekeFields
			: kind === "CENC"
				? { key, kid }
				: { key, iv, uri: "skd://example" }),
	});
	expect(requests[1]?.url.searchParams.get("limit")).toBe("100");
	expect(JSON.stringify(audit.mock.calls)).not.toContain(key);
	expect(JSON.stringify(audit.mock.calls)).not.toContain(provider.url);
});
