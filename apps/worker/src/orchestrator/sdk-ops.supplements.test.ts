import {
	compilePlan,
	encodingPlanSchema,
	planHasErrors,
	validatePlan,
} from "@bitovp/core";
import { afterEach, expect, it, vi } from "vitest";
import { loadPlan } from "../../../../packages/core/src/plan/test-support";
import { auditedOperationCases } from "../../../../scripts/api-coverage-test-cases";
import { executeStep } from "./executor";
import { ProviderCreateRefusal } from "./provider-create-refusal";
import { createBitmovinSdkOps } from "./sdk-ops";

const cases = [
	{
		path: "/encoding/encodings/{encoding_id}/captions/scc",
		item: {
			kind: "SCC_CONVERSION",
			key: "sample",
			inputKey: "main",
			inputPath: "media/captions.scc",
			destination: {
				outputKey: "origin",
				path: "extras/",
			},
			filename: "captions.vtt",
		},
		body: {
			input: {
				inputId: "input-id",
				inputPath: "media/captions.scc",
			},
			outputs: [
				{
					outputId: "output-id",
					outputPath: "extras/",
				},
			],
			fileName: "captions.vtt",
			outputFormat: "WEBVTT",
		},
	},
	{
		path: "/encoding/encodings/{encoding_id}/sidecars",
		item: {
			kind: "SIDECAR",
			key: "sample",
			inputKey: "main",
			inputPath: "media/captions.vtt",
			destination: {
				outputKey: "origin",
				path: "extras/",
			},
		},
		body: {
			inputId: "input-id",
			inputPath: "media/captions.vtt",
			outputs: [
				{
					outputId: "output-id",
					outputPath: "extras/",
				},
			],
			type: "WEB_VTT",
		},
	},
	{
		path: "/encoding/encodings/{encoding_id}/sidecars/webvtt",
		item: {
			kind: "WEBVTT_SIDECAR",
			key: "sample",
			inputKey: "main",
			inputPath: "media/captions.vtt",
			destination: {
				outputKey: "origin",
				path: "extras/",
			},
		},
		body: {
			inputId: "input-id",
			inputPath: "media/captions.vtt",
			outputs: [
				{
					outputId: "output-id",
					outputPath: "extras/",
				},
			],
			type: "WEB_VTT",
		},
	},
	{
		path: "/encoding/encodings/{encoding_id}/scte-35-triggers",
		item: {
			kind: "SCTE35_TRIGGER",
			key: "sample",
			base64EncodedMetadata: "AAEC",
		},
		body: {
			base64EncodedMetadata: "AAEC",
		},
	},
	{
		path: "/encoding/encodings/{encoding_id}/streams/{stream_id}/bifs",
		item: {
			kind: "BIF",
			key: "sample",
			renditionKey: "v540",
			destination: {
				outputKey: "origin",
				path: "extras/",
			},
			distance: 10,
			width: 320,
			filename: "preview.bif",
		},
		body: {
			filename: "preview.bif",
			distance: 10,
			width: 320,
			outputs: [
				{
					outputId: "output-id",
					outputPath: "extras/",
				},
			],
		},
	},
	{
		path: "/encoding/encodings/{encoding_id}/streams/{stream_id}/burn-in-subtitles/assa",
		item: {
			kind: "BURN_IN_ASSA",
			key: "sample",
			renditionKey: "v540",
			inputKey: "main",
			inputPath: "media/captions.ass",
			characterEncoding: "UTF_8",
		},
		body: {
			input: {
				inputId: "input-id",
				inputPath: "media/captions.ass",
			},
			characterEncoding: "UTF-8",
		},
	},
	{
		path: "/encoding/encodings/{encoding_id}/streams/{stream_id}/burn-in-subtitles/dvbsub",
		item: {
			kind: "BURN_IN_DVBSUB",
			key: "sample",
			renditionKey: "v540",
			ingestKey: "subtitle",
		},
		body: {
			inputStreamId: "subtitle-track",
		},
	},
	{
		path: "/encoding/encodings/{encoding_id}/streams/{stream_id}/captions/608-708/scc",
		item: {
			kind: "CEA_SCC",
			key: "sample",
			renditionKey: "v540",
			inputKey: "main",
			inputPath: "media/captions.scc",
			smpteTimecodeFlavor: "DROP_FRAME",
		},
		body: {
			input: {
				inputId: "input-id",
				inputPath: "media/captions.scc",
			},
			smpteTimecodeFlavor: "DROP_FRAME",
		},
	},
	{
		path: "/encoding/encodings/{encoding_id}/streams/{stream_id}/captions/608-708/srt",
		item: {
			kind: "CEA_SRT",
			key: "sample",
			renditionKey: "v540",
			inputKey: "main",
			inputPath: "media/captions.srt",
			characterEncoding: "UTF_8",
			ccChannel: "CC3",
		},
		body: {
			input: {
				inputId: "input-id",
				inputPath: "media/captions.srt",
			},
			characterEncoding: "UTF-8",
			ccChannel: "CC3",
		},
	},
	{
		path: "/encoding/encodings/{encoding_id}/streams/{stream_id}/qc/psnr",
		item: {
			kind: "PSNR",
			key: "sample",
			renditionKey: "v540",
		},
		body: null,
	},
];

afterEach(() => vi.unstubAllGlobals());

it.each(
	auditedOperationCases(
		import.meta.url,
		"worker-supplement-create",
		cases,
		({ path }) => [`POST ${path}`],
	),
)("compiles the supplement and sends its exact SDK request to $path", async ({
	path,
	item,
	body,
}) => {
	const base = loadPlan("mp4-fixed-bitrate-hls-vtt-on-aws");
	const plan = encodingPlanSchema.parse({
		...base,
		ingest: [
			...base.ingest,
			{
				key: "subtitle",
				inputKey: "main",
				inputPath: "media/video.ts",
				selectionMode: "SUBTITLE_RELATIVE",
				position: 2,
			},
		],
		supplements: [item],
	});
	expect(
		planHasErrors(validatePlan(plan)),
		JSON.stringify(validatePlan(plan)),
	).toBe(false);
	const step = compilePlan(plan).find(
		(step) => step.kind === "CREATE_ENCODING_SUPPLEMENT",
	);
	if (!step) throw new Error("No supplement step");
	const audit = vi.fn(async () => {});
	const send = vi.fn(async () =>
		Response.json({
			status: "SUCCESS",
			data: { result: body ? { id: "supplement-id" } : {} },
		}),
	);
	vi.stubGlobal("fetch", send);
	const result = await executeStep(step, {
		sdk: createBitmovinSdkOps(
			{ apiKey: "test-only", tenantOrgId: "fixture-org" },
			audit,
		),
		ids: new Map([
			["encoding", "encoding-id"],
			["output:origin", "output-id"],
			["input:main", "input-id"],
			["stream:v540", "stream-id"],
			["ingest:subtitle", "subtitle-track"],
		]),
		resolveCredential: vi.fn(),
		poll: { intervalMs: 1, timeoutMs: 50, sleep: async () => {} },
	});
	expect(result.resourceId).toBe(body ? "supplement-id" : undefined);
	expect(send).toHaveBeenCalledOnce();
	const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
	expect(init.method).toBe("POST");
	expect(new URL(url).pathname).toBe(
		`/v1${path.replace("{encoding_id}", "encoding-id").replace("{stream_id}", "stream-id")}`,
	);
	expect(new Headers(init.headers).get("X-Tenant-Org-Id")).toBe("fixture-org");
	if (body) expect(JSON.parse(init.body as string)).toEqual(body);
	else expect(init.body).toBeUndefined();
	expect(audit).toHaveBeenCalledOnce();
});

it("records a known PSNR refusal from the installed SDK without repeating the POST", async () => {
	const response = vi.fn(async () =>
		Response.json(
			{ status: "ERROR", data: { code: 1000, message: "rate limit" } },
			{ status: 429 },
		),
	);
	vi.stubGlobal("fetch", response);
	const sdk = createBitmovinSdkOps({ apiKey: "test-only" }, async () => {});
	await expect(
		sdk.createEncodingSupplement(
			"encoding-id",
			{ kind: "PSNR", key: "quality", renditionKey: "video" },
			{ streamId: "stream-id" },
		),
	).rejects.toMatchObject({ status: 429 });
	expect(response).toHaveBeenCalledOnce();
});

it.each([
	403, 429,
])("retains PSNR refusal %i when the response stream breaks", async (status) => {
	const transport = vi.fn(
		async (_url: string, _init: RequestInit) =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("{"));
						controller.error(new Error("Body interrupted"));
					},
				}),
				{ status },
			),
	);
	vi.stubGlobal("fetch", transport);
	const audit = vi.fn(async () => {});
	const sdk = createBitmovinSdkOps(
		{ apiKey: "test-only", withholdProviderDetails: true },
		audit,
	);
	const request = sdk.createEncodingSupplement(
		"encoding-id",
		{ kind: "PSNR", key: "quality", renditionKey: "video" },
		{ streamId: "stream-id" },
	);
	await expect(request).rejects.toBeInstanceOf(ProviderCreateRefusal);
	await expect(request).rejects.toMatchObject({ status });
	expect(transport).toHaveBeenCalledTimes(1);
	expect(transport.mock.calls[0]?.[1]).toMatchObject({
		method: "POST",
		redirect: "manual",
	});
	expect(audit).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({
			method: "POST",
			path: "/encoding/encodings/encoding-id/streams/stream-id/qc/psnr",
			statusCode: status,
			error: "Bitmovin request failed",
		}),
	);
});

it("keeps a redirected PSNR refusal ambiguous", async () => {
	const denial = Response.json({ status: "ERROR" }, { status: 403 });
	Object.defineProperty(denial, "redirected", { value: true });
	const transport = vi.fn(async () => denial);
	vi.stubGlobal("fetch", transport);
	const sdk = createBitmovinSdkOps({ apiKey: "test-only" }, async () => {});
	await expect(
		sdk.createEncodingSupplement(
			"encoding-id",
			{ kind: "PSNR", key: "quality", renditionKey: "video" },
			{ streamId: "stream-id" },
		),
	).rejects.toMatchObject({ httpStatusCode: 0 });
	expect(transport).toHaveBeenCalledOnce();
});

it("reuses a BIF whose owned create completed before the worker saved its reply", async () => {
	const step = "supplement:bif";
	const job = "fixture-job";
	const resourceId = "recorded-bif";
	const transport = vi
		.fn()
		.mockResolvedValueOnce(
			Response.json({
				status: "SUCCESS",
				data: {
					result: {
						items: [{ id: resourceId }],
						totalCount: 1,
					},
				},
			}),
		)
		.mockResolvedValueOnce(
			Response.json({
				status: "SUCCESS",
				data: {
					result: {
						customData: { bitovp: { job, step } },
					},
				},
			}),
		);
	vi.stubGlobal("fetch", transport);
	const sdk = createBitmovinSdkOps(
		{
			apiKey: "test-only",
			stamp: {
				jobId: job,
				currentStep: () => step,
				adoptWindow: () => true,
			},
		},
		async () => {},
	);
	await expect(
		sdk.createEncodingSupplement(
			"encoding-id",
			{
				kind: "BIF",
				key: "bif",
				renditionKey: "video",
				filename: "preview.bif",
				width: 240,
				distance: 10,
				destination: { outputKey: "extras", path: "extras/" },
			},
			{
				streamId: "stream-id",
				destination: { outputId: "output-id", outputPath: "extras/" },
			},
		),
	).resolves.toBe(resourceId);
	expect(
		transport.mock.calls.map(([url, init]) => [
			init.method,
			new URL(url).pathname,
		]),
	).toEqual([
		["GET", "/v1/encoding/encodings/encoding-id/streams/stream-id/bifs"],
		[
			"GET",
			"/v1/encoding/encodings/encoding-id/streams/stream-id/bifs/recorded-bif/customData",
		],
	]);
});
