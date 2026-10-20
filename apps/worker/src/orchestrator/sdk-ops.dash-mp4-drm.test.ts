import {
	compilePlan,
	curlForStep,
	encodingPlanSchema,
	type StepLogEntry,
	validatePlan,
} from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeStep } from "./executor";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

function copiedRequest(entry: StepLogEntry) {
	const result = curlForStep(entry);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error("Expected a reproducible manifest request");
	const url = result.command.match(/^curl -X POST '([^']+)'/)?.[1];
	const data = result.command.match(/--data '([\s\S]*)'$/)?.[1];
	expect(url).toBeDefined();
	expect(data).toBeDefined();
	return {
		path: new URL(url as string).pathname,
		body: JSON.parse(data as string),
	};
}

function onDemandPlan(explicit: boolean, encrypted: boolean) {
	const streams = ["video", "audio"];
	return encodingPlanSchema.parse({
		planVersion: 1,
		name: "MP4 DRM routing",
		bitmovin: {},
		inputs: [{ key: "in", kind: "HTTPS", host: "https://example.com" }],
		outputs: [
			{
				key: "out",
				kind: "S3",
				bucket: "example",
				credentialId: "00000000-0000-4000-8000-000000000001",
			},
		],
		ingest: streams.map((key) => ({
			key,
			inputKey: "in",
			inputPath: "/input.mp4",
			selectionMode: key === "video" ? "VIDEO_RELATIVE" : "AUDIO_RELATIVE",
		})),
		renditions: [
			{
				key: "video",
				codec: "H264",
				ingestKey: "video",
				height: 360,
				bitrate: 300000,
				dashSetKey: "video",
			},
			{
				key: "audio",
				codec: "AAC",
				ingestKey: "audio",
				bitrate: 128000,
				rate: 48000,
				dashSetKey: "audio",
			},
		],
		muxings: streams.map((key) => ({
			key,
			kind: "MP4",
			streamKey: key,
			filename: `${key}.mp4`,
			fragmentDuration: 6000,
			manifestType: "DASH_ON_DEMAND",
			destination: {
				outputKey: "out",
				path: `test/clear/${key}`,
				acl: "PRIVATE",
			},
		})),
		drm: encrypted
			? streams.map((key) => ({
					key: `${key}-cenc`,
					kind: "CENC",
					muxingKey: key,
					credentialId: "00000000-0000-4000-8000-000000000002",
					kid: "12345678901234567890123456789012",
					encryptionMode: "CTR",
					destination: {
						outputKey: "out",
						path: `test/cenc/${key}`,
						acl: "PRIVATE",
					},
				}))
			: [],
		manifests: [
			{
				key: "dash",
				kind: "DASH",
				manifestName: "stream.mpd",
				name: "DASH",
				profile: "ON_DEMAND",
				drmKind: encrypted ? "CENC" : undefined,
				adaptationSets: explicit
					? [
							{ key: "video", type: "VIDEO" },
							{ key: "audio", type: "AUDIO" },
						]
					: undefined,
				destination: { outputKey: "out", path: "test/", acl: "PRIVATE" },
			},
		],
		generation: { timing: "POST_ENCODING" },
	});
}

describe.each([
	false,
	true,
])("installed SDK OnDemand transport (explicit sets: %s)", (explicit) => {
	it.each([
		false,
		true,
	])("uses the correct MP4 endpoint and resolved IDs (encrypted: %s)", async (encrypted) => {
		const calls: { path: string; body: unknown }[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				calls.push({
					path: new URL(url).pathname,
					body: JSON.parse(init.body as string),
				});
				return new Response(
					JSON.stringify({ data: { result: { id: "created" } } }),
					{ status: 201, headers: { "content-type": "application/json" } },
				);
			}),
		);
		const plan = onDemandPlan(explicit, encrypted);
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const ops = compilePlan(plan);
		const ids = new Map(ops.map((op, i) => [op.step, `resource-${i}`]));
		const sdk = createBitmovinSdkOps(
			{ apiKey: "test-only", tenantOrgId: null, bitmovinAccountId: "account" },
			async () => {},
		);
		const manifestOps = ops.filter(
			(op) =>
				op.kind === "CREATE_DASH_REPRESENTATION_MP4" ||
				op.kind === "CREATE_DASH_CONTENT_PROTECTION",
		);
		for (const op of manifestOps) {
			const result = await executeStep(op, {
				sdk,
				ids,
				resolveCredential: vi.fn(),
				poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
			});
			expect(
				copiedRequest({ ...op, status: "DONE", request: result.request }),
			).toEqual(calls.at(-1));
		}
		expect(calls).toEqual(
			plan.muxings.map((muxing) => {
				const rep = ops.find(
					(op) => op.step === `manifest:dash:rep:${muxing.key}`,
				);
				if (!rep) throw new Error("Missing representation");
				return {
					path: `/v1/encoding/manifests/dash/${ids.get("manifest:dash")}/periods/${ids.get("manifest:dash:period")}/adaptationsets/${ids.get(rep.refs.adaptationSetId as string)}/representations/mp4${encrypted ? "/drm" : ""}`,
					body: {
						typeDiscriminator: encrypted ? "DRM_MP4" : "MP4",
						encodingId: ids.get("encoding"),
						muxingId: ids.get(`muxing:${muxing.key}`),
						type: "SEGMENT_BASE",
						filePath: `${encrypted ? "cenc" : "clear"}/${muxing.key}/${muxing.key}.mp4`,
						...(encrypted ? { drmId: ids.get(`drm:${muxing.key}-cenc`) } : {}),
					},
				};
			}),
		);
	});
});

it.each([
	"FMP4",
	"WEBM",
] as const)("copies the actual %s ContentProtection SDK URL and JSON", async (representationKind) => {
	const calls: { path: string; body: unknown }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			calls.push({
				path: new URL(url).pathname,
				body: JSON.parse(init.body as string),
			});
			return new Response(
				JSON.stringify({ data: { result: { id: "created" } } }),
				{ status: 201, headers: { "content-type": "application/json" } },
			);
		}),
	);
	const refs = {
		manifestId: "manifest",
		periodId: "period",
		adaptationSetId: "set",
		representationId: "representation",
		encodingId: "encoding",
		muxingId: "muxing",
		drmId: "drm",
	};
	const op = {
		step: "content-protection",
		kind: "CREATE_DASH_CONTENT_PROTECTION" as const,
		payload: representationKind === "WEBM" ? { representationKind } : {},
		refs,
	};
	const sdk = createBitmovinSdkOps(
		{ apiKey: "test-only", tenantOrgId: null, bitmovinAccountId: "account" },
		async () => {},
	);
	const result = await executeStep(op, {
		sdk,
		ids: new Map(Object.values(refs).map((key) => [key, `${key}-id`])),
		resolveCredential: vi.fn(),
		poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
	});
	expect(calls).toHaveLength(1);
	expect(
		copiedRequest({ ...op, status: "DONE", request: result.request }),
	).toEqual(calls[0]);
	expect(calls[0]?.body).not.toHaveProperty("representationKind");
});
