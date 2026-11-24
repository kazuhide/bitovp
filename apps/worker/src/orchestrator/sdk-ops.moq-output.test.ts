import { readFileSync } from "node:fs";
import {
	type CompiledOperation,
	compileLiveChannel,
	liveChannelPlanSchema,
} from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ExecutorContext, executeStep } from "./executor";
import { fakeSdk } from "./fake-sdk";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

const relayUrl = "moqt://relay.example:443/moq";
const authToken = "private-publish-token";
const playbackUrl =
	"https://subscribe.example.com/moq/subscribe-only-token?auth=subscribe-secret";
const legacyLongPlaybackUrl = `${playbackUrl}&legacy=${"a".repeat(8192)}`;
const namespace = ["bitovp", "protocol-test"];

function mockProvider() {
	const fetch = vi.fn(
		async (_url: string | URL, _init?: RequestInit) =>
			new Response(
				JSON.stringify({
					status: "SUCCESS",
					data: { result: { id: "moq-output-id" } },
				}),
				{
					status: 201,
					headers: { "content-type": "application/json" },
				},
			),
	);
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

describe("MoQ output SDK boundary", () => {
	it("sends both CMAF renditions to the created MoQ output before live start", async () => {
		const fetch = mockProvider();
		const raw = JSON.parse(
			readFileSync(
				new URL(
					"../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const keys = new Set(["v720", "a128"]);
		raw.renditions = raw.renditions.filter((r: { key: string }) =>
			keys.has(r.key),
		);
		raw.muxings = raw.muxings
			.filter((m: { streamKey: string }) => keys.has(m.streamKey))
			.map((m: { streamKey: string }) => ({
				...m,
				kind: "CMAF",
				segmentLength: 0.5,
				...(m.streamKey === "v720" ? { framesPerCmafChunk: 3 } : {}),
			}));
		raw.outputs = [
			{
				key: "origin",
				kind: "MOQ",
				credentialId: "00000000-0000-4000-8000-000000000001",
				trackNamespace: namespace,
				draftVersion: "DRAFT_16",
			},
		];
		raw.liveManifests = [];
		raw.start.encodingOption = "CUSTOM";
		const ops = compileLiveChannel(liveChannelPlanSchema.parse(raw));
		const ctx: ExecutorContext = {
			sdk: createBitmovinSdkOps({ apiKey: "test-key" }, async () => {}),
			ids: new Map([
				["encoding", "encoding-id"],
				["stream:v720", "video-stream-id"],
				["stream:a128", "audio-stream-id"],
			]),
			resolveCredential: async () => ({
				provider: "MOQ",
				config: {},
				secret: { relayUrl, authToken },
			}),
			poll: { intervalMs: 1, timeoutMs: 10, sleep: async () => {} },
		};
		for (const op of ops.filter(
			(op) =>
				op.kind === "CREATE_OUTPUT_MOQ" ||
				op.kind === "CREATE_MUXING_CMAF" ||
				op.kind === "START_LIVE_ENCODING",
		)) {
			const { resourceId } = await executeStep(op, ctx);
			if (resourceId) ctx.ids.set(op.step, resourceId);
		}
		expect(
			fetch.mock.calls.map(([url, req]) => [
				req?.method,
				new URL(url).pathname,
			]),
		).toEqual([
			["POST", "/v1/encoding/outputs/moq"],
			["POST", "/v1/encoding/encodings/encoding-id/muxings/cmaf"],
			["POST", "/v1/encoding/encodings/encoding-id/muxings/cmaf"],
			["POST", "/v1/encoding/encodings/encoding-id/live/start"],
		]);
		const [, video, audio, start] = fetch.mock.calls.map(([, req]) =>
			JSON.parse(String(req?.body)),
		);
		expect(video).toMatchObject({
			segmentLength: 0.5,
			framesPerCmafChunk: 3,
			streams: [{ streamId: "video-stream-id" }],
			outputs: [
				{
					outputId: "moq-output-id",
					outputPath: "output/live-rtmp-simple/video/720p",
				},
			],
		});
		expect(audio).toMatchObject({
			segmentLength: 0.5,
			streams: [{ streamId: "audio-stream-id" }],
			outputs: [
				{
					outputId: "moq-output-id",
					outputPath: "output/live-rtmp-simple/audio/128000",
				},
			],
		});
		expect(audio).not.toHaveProperty("framesPerCmafChunk");
		expect(start).toMatchObject({ streamKey: "myStreamKey" });
		expect(start.hlsManifests ?? []).toEqual([]);
		expect(start.dashManifests ?? []).toEqual([]);
	});

	it("sends MoQ fields to the provider and keeps relay credentials out of the audit trail", async () => {
		const fetch = mockProvider();
		const record = vi.fn(async () => {});
		const sdk = createBitmovinSdkOps({ apiKey: "test-key" }, record);
		expect(
			await sdk.createMoqOutput({
				name: "MoQ",
				relayUrl,
				trackNamespace: namespace,
				draftVersion: "DRAFT_18",
				authToken,
				authTokenType: 1,
			}),
		).toBe("moq-output-id");
		expect(String(fetch.mock.calls[0]?.[0])).toMatch(
			/\/encoding\/outputs\/moq$/,
		);
		expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
			type: "MOQ",
			name: "MoQ",
			relayUrl,
			trackNamespace: namespace,
			draftVersion: "DRAFT_18",
			authToken,
			authTokenType: 1,
		});
		expect(JSON.stringify(record.mock.calls)).not.toContain(authToken);
		expect(JSON.stringify(record.mock.calls)).not.toContain(relayUrl);
		expect(JSON.stringify(record.mock.calls)).toContain("DRAFT_18");
	});

	it("omits authorization fields for a relay protocol probe without a token", async () => {
		const fetch = mockProvider();
		const sdk = createBitmovinSdkOps({ apiKey: "test-key" }, async () => {});
		await sdk.createMoqOutput({
			name: "Probe",
			relayUrl,
			trackNamespace: namespace,
			draftVersion: "DRAFT_16",
		});
		const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
		expect(body.draftVersion).toBe("DRAFT_16");
		expect(body).not.toHaveProperty("authToken");
		expect(body).not.toHaveProperty("authTokenType");
	});

	it("withholds secret-bearing provider error prose from thrown errors and audit records", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							status: "ERROR",
							data: { code: 1001, message: `Failed ${relayUrl} ${authToken}` },
						}),
						{ status: 400, headers: { "content-type": "application/json" } },
					),
			),
		);
		const record = vi.fn(async () => {});
		const sdk = createBitmovinSdkOps({ apiKey: "test-key" }, record);
		await expect(
			sdk.createMoqOutput({
				name: "MoQ",
				relayUrl,
				trackNamespace: namespace,
				draftVersion: "DRAFT_18",
				authToken,
			}),
		).rejects.toThrow("MoQ output creation failed");
		expect(JSON.stringify(record.mock.calls)).not.toContain(authToken);
		expect(JSON.stringify(record.mock.calls)).not.toContain(relayUrl);
	});

	it("does not send an unknown SDK draft version", async () => {
		const fetch = mockProvider();
		const sdk = createBitmovinSdkOps({ apiKey: "test-key" }, async () => {});
		await expect(
			sdk.createMoqOutput({
				name: "MoQ",
				relayUrl,
				trackNamespace: namespace,
				draftVersion: "DRAFT_23",
			}),
		).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("MoQ compiled operation execution", () => {
	const operation: CompiledOperation = {
		step: "output:moq",
		kind: "CREATE_OUTPUT_MOQ",
		refs: {},
		payload: {
			name: "MoQ",
			credentialId: "credential-id",
			trackNamespace: namespace,
			draftVersion: "DRAFT_18",
		},
	};
	function context(provider = "MOQ"): ExecutorContext {
		return {
			sdk: fakeSdk(),
			ids: new Map(),
			resolveCredential: vi.fn(async () => ({
				provider,
				config: {},
				secret: { relayUrl, authToken },
			})),
			poll: { intervalMs: 1, timeoutMs: 10, sleep: async () => {} },
		};
	}
	it("resolves the vaulted relay and token only at execution", async () => {
		const ctx = context();
		const result = await executeStep(operation, ctx);
		expect(ctx.sdk.createMoqOutput).toHaveBeenCalledWith({
			name: "MoQ",
			relayUrl,
			authToken,
			trackNamespace: namespace,
			draftVersion: "DRAFT_18",
		});
		expect(result.resourceId).toBeTruthy();
		expect(JSON.stringify(result)).not.toContain(relayUrl);
		expect(JSON.stringify(result)).not.toContain(authToken);
	});
	it.each([
		{ label: "current", url: playbackUrl },
		{ label: "legacy over-length", url: legacyLongPlaybackUrl },
		{ label: "legacy unescaped space", url: `${playbackUrl} space` },
	])("excludes the $label subscriber URL from Encoder arguments, wire and audit snapshots", async ({
		url,
	}) => {
		const fetch = mockProvider();
		const record = vi.fn(async () => {});
		const ctx = context();
		ctx.sdk = createBitmovinSdkOps({ apiKey: "test-key" }, record);
		const createOutput = vi.spyOn(ctx.sdk, "createMoqOutput");
		ctx.resolveCredential = vi.fn(async () => ({
			provider: "MOQ",
			config: {},
			// This is the credential store's JSON round trip, including a numeric type.
			secret: JSON.parse(
				JSON.stringify({
					relayUrl,
					authToken,
					authTokenType: 0,
					playbackUrl: url,
				}),
			),
		}));

		const result = await executeStep(operation, ctx);

		expect(createOutput).toHaveBeenCalledWith({
			name: "MoQ",
			relayUrl,
			authToken,
			authTokenType: 0,
			trackNamespace: namespace,
			draftVersion: "DRAFT_18",
		});
		const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
		expect(body).toMatchObject({
			relayUrl,
			authToken,
			authTokenType: 0,
			trackNamespace: namespace,
			draftVersion: "DRAFT_18",
		});
		expect(body).not.toHaveProperty("playbackUrl");
		expect(
			JSON.stringify([
				createOutput.mock.calls,
				body,
				record.mock.calls,
				result,
			]),
		).not.toContain(playbackUrl);
		expect(JSON.stringify([record.mock.calls, result])).not.toContain(
			authToken,
		);
	});
	it.each([
		{
			label: "an invalid publisher URL",
			patch: { relayUrl: "https://relay.example" },
			path: ["relayUrl"],
		},
		{
			label: "an empty token",
			patch: { authToken: "" },
			path: ["authToken"],
		},
		{
			label: "a token type without a token",
			patch: { authToken: undefined, authTokenType: 0 },
			path: ["authTokenType"],
		},
		{
			label: "an invalid token type",
			patch: { authTokenType: -1 },
			path: ["authTokenType"],
		},
		{
			label: "a token type above the provider int32 limit",
			patch: { authTokenType: 2_147_483_648 },
			path: ["authTokenType"],
		},
		{
			label: "an unexpected field",
			patch: { unexpected: true },
			path: [],
		},
	])("rejects $label in a stored credential before any MoQ call", async ({
		patch,
		path,
	}) => {
		const ctx = context();
		ctx.resolveCredential = vi.fn(async () => ({
			provider: "MOQ",
			config: {},
			secret: JSON.parse(
				JSON.stringify({
					relayUrl,
					authToken,
					playbackUrl: legacyLongPlaybackUrl,
					...patch,
				}),
			),
		}));
		await expect(executeStep(operation, ctx)).rejects.toMatchObject({
			issues: expect.arrayContaining([expect.objectContaining({ path })]),
		});
		expect(ctx.sdk.createMoqOutput).not.toHaveBeenCalled();
	});
	it("withholds the playback capability from Encoder failure records and errors", async () => {
		const fetch = mockProvider();
		fetch.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					status: "ERROR",
					data: {
						code: 1001,
						message: `Failed ${playbackUrl} ${relayUrl} ${authToken}`,
					},
				}),
				{ status: 400, headers: { "content-type": "application/json" } },
			),
		);
		const record = vi.fn(async () => {});
		const ctx = context();
		ctx.sdk = createBitmovinSdkOps({ apiKey: "test-key" }, record);
		const createOutput = vi.spyOn(ctx.sdk, "createMoqOutput");
		ctx.resolveCredential = vi.fn(async () => ({
			provider: "MOQ",
			config: {},
			secret: { relayUrl, authToken, playbackUrl },
		}));

		const failure = await executeStep(operation, ctx).catch((error) => error);

		expect(failure).toBeInstanceOf(Error);
		expect(failure.message).toContain("MoQ output creation failed");
		expect(createOutput.mock.calls[0]?.[0]).not.toHaveProperty("playbackUrl");
		const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
		expect(body).not.toHaveProperty("playbackUrl");
		expect(
			JSON.stringify([
				createOutput.mock.calls,
				body,
				record.mock.calls,
				{ message: failure.message, stack: failure.stack },
			]),
		).not.toContain(playbackUrl);
		expect(JSON.stringify(record.mock.calls)).not.toContain(authToken);
		expect(JSON.stringify(record.mock.calls)).not.toContain(relayUrl);
	});
	it("rejects a different credential provider before any MoQ call", async () => {
		const ctx = context("AWS_S3");
		await expect(executeStep(operation, ctx)).rejects.toThrow(
			"needs a MOQ credential",
		);
		expect(ctx.sdk.createMoqOutput).not.toHaveBeenCalled();
	});
});
