import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type CompiledOperation,
	compileLiveChannel,
	compilePlan,
	encodingPlanSchema,
	liveChannelPlanSchema,
	validateLiveChannel,
	validatePlan,
} from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeStep } from "./executor";
import { createBitmovinSdkOps } from "./sdk-ops";

const load = (family: "plan" | "live", name: string) =>
	JSON.parse(
		readFileSync(
			join(
				__dirname,
				`../../../../packages/core/src/${family}/__fixtures__/${name}.plan.json`,
			),
			"utf8",
		),
	);

/** Exercise compiler, executor and installed SDK; native fetch is never called. */
async function captureStart(operations: CompiledOperation[]) {
	const start = operations.find(
		(operation) =>
			operation.kind === "START_ENCODING" ||
			operation.kind === "START_LIVE_ENCODING",
	);
	if (!start) throw new Error("Missing compiled START");
	const ids = new Map(
		operations.map((operation, index) => [
			operation.step,
			`synthetic-${index}`,
		]),
	);
	const encodingId = ids.get(start.refs.encodingId as string);
	if (!encodingId) throw new Error("Missing synthetic encoding reference");
	const requests: { method: string; path: string; body: unknown }[] = [];
	const startPath = `/v1/encoding/encodings/${encodingId}/${start.kind === "START_LIVE_ENCODING" ? "live/" : ""}start`;
	vi.stubGlobal(
		"fetch",
		async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const method = init?.method ?? "GET";
			expect(url.origin).toBe("https://api.bitmovin.com");
			expect(new Headers(init?.headers).get("X-Api-Key")).toBe(
				"synthetic-only",
			);
			expect(method).toBe("POST");
			expect(url.pathname).toBe(startPath);
			requests.push({
				method,
				path: url.pathname,
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			});
			return new Response(
				JSON.stringify({ data: { result: { status: "CREATED" } } }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		},
	);
	await executeStep(start, {
		sdk: createBitmovinSdkOps({ apiKey: "synthetic-only" }, async () => {}),
		ids,
		resolveCredential: async () => {
			throw new Error("START must not resolve a credential in this fixture");
		},
		poll: { intervalMs: 1, timeoutMs: 1, sleep: vi.fn() },
	});
	expect(requests.map((request) => request.method)).toEqual(["POST"]);
	return { body: requests[0]?.body, ids };
}

afterEach(() => vi.unstubAllGlobals());

describe("compiled START through the installed SDK transport", () => {
	it.each([
		["H264", "pertitle-h264-fmp4-ts-dash-hls-on-aws"],
		["H265", "pertitle-h265-fmp4-dash-hls-on-aws"],
		["VP9", "pertitle-vp9-webm-fmp4-dash-on-aws"],
		["AV1", "pertitle-av1-fmp4-dash-on-aws"],
	] as const)("preserves the %s Per-Title configuration on the wire", async (_codec, name) => {
		const plan = encodingPlanSchema.parse(load("plan", name));
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const { body } = await captureStart(compilePlan(plan));
		expect(body).toMatchObject({ perTitle: plan.perTitle });
	});

	it.each([
		"JUST_IN_TIME",
		"POST_ENCODING",
	] as const)("preserves VOD START options with %s manifests", async (timing) => {
		const plan = encodingPlanSchema.parse(
			load("plan", "fixed-bitrate-hls-on-aws"),
		);
		plan.generation = {
			timing,
			encodingMode: "TWO_PASS",
			audioVideoSyncMode: "RESYNC_AT_START",
			handleVariableInputFps: false,
		};
		for (const rendition of plan.renditions)
			if ("presetConfiguration" in rendition)
				rendition.presetConfiguration = null;
		const pools = ["00000000-0000-4000-8000-000000000001"];
		plan.bitmovin.schedulingPriority = 0;
		plan.bitmovin.prewarmedEncoderPoolIds = pools;
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const { body, ids } = await captureStart(compilePlan(plan));
		expect(body).toEqual({
			encodingMode: "TWO_PASS",
			tweaks: { audioVideoSyncMode: "RESYNC_AT_START" },
			handleVariableInputFps: false,
			scheduling: { priority: 0, prewarmedEncoderPoolIds: pools },
			...(timing === "JUST_IN_TIME"
				? {
						manifestGenerator: "V2",
						vodHlsManifests: plan.manifests.map((manifest) => ({
							manifestId: ids.get(`manifest:${manifest.key}`),
						})),
					}
				: {}),
		});
	});

	it("preserves AI output destinations, languages and explicit false controls", async () => {
		const plan = encodingPlanSchema.parse(
			load("plan", "ai-scene-analysis-pertitle"),
		);
		const ai = plan.aiSceneAnalysis;
		if (!ai) throw new Error("Missing AI fixture");
		ai.automaticAdPlacement = {
			allSceneBoundaries: { isEnabled: false, insertCueTags: false },
		};
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const { body, ids } = await captureStart(compilePlan(plan));
		expect(body).toMatchObject({
			perTitle: plan.perTitle,
			aiSceneAnalysis: {
				features: {
					assetDescription: {
						filename: ai.assetDescription.filename,
						outputs: [
							{
								outputId: ids.get("output:origin"),
								outputPath: ai.assetDescription.destination.path,
								acl: [{ permission: "PUBLIC_READ" }],
							},
						],
					},
					automaticAdPlacement: ai.automaticAdPlacement,
					outputLanguageCodes: { outputLanguageCodes: ["ja", "ko"] },
				},
			},
		});
	});

	it("preserves Live manifest units, explicit null, zero and false through START", async () => {
		const plan = liveChannelPlanSchema.parse(load("live", "live-rtmp-simple"));
		plan.start.encodingOption = "CUSTOM";
		plan.start.liveEncodingMode = "SINGLE_PASS";
		plan.start.reupload = {
			dashManifestInterval: null,
			muxingInitFileInterval: 30,
		};
		plan.start.autoRestart = {
			restartOnEncoderError: false,
			segmentsWrittenTimeout: 60,
		};
		plan.start.autoShutdown = { streamTimeoutMinutes: 5 };
		for (const manifest of plan.liveManifests) {
			manifest.liveEdgeOffset = 0;
			if (manifest.kind === "HLS") manifest.insertProgramDateTime = false;
			else {
				manifest.suggestedPresentationDelay = 1500;
				manifest.minimumUpdatePeriod = 2000;
			}
		}
		expect(
			validateLiveChannel(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const { body, ids } = await captureStart(compileLiveChannel(plan));
		expect(body).toMatchObject({
			streamKey: plan.start.streamKey,
			liveEncodingMode: "SINGLE_PASS",
			manifestGenerator: "V2",
			reuploadSettings: {
				dashManifestInterval: null,
				muxingInitFileInterval: 30,
			},
			autoRestartConfiguration: {
				restartOnEncoderError: false,
				segmentsWrittenTimeout: 60,
			},
			autoShutdownConfiguration: { streamTimeoutMinutes: 5 },
			hlsManifests: expect.arrayContaining([
				expect.objectContaining({
					liveEdgeOffset: 0,
					insertProgramDateTime: false,
				}),
			]),
			dashManifests: plan.liveManifests
				.filter((manifest) => manifest.kind === "DASH")
				.map((manifest) => ({
					manifestId: ids.get(`manifest:${manifest.key}`),
					timeshift: manifest.timeshift,
					liveEdgeOffset: 0,
					suggestedPresentationDelay: 1.5,
					minimumUpdatePeriod: 2,
				})),
		});
	});

	it.each([
		"CUSTOM",
		"HD",
	] as const)("keeps concurrent %s Live reupload controls independent", async (encodingOption) => {
		const bodies = new Map<string, Record<string, unknown>>();
		vi.stubGlobal(
			"fetch",
			async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const url = new URL(String(input));
				expect(url.origin).toBe("https://api.bitmovin.com");
				expect(init?.method).toBe("POST");
				expect(new Headers(init?.headers).get("X-Api-Key")).toBe(
					"synthetic-only",
				);
				const match =
					/^\/v1\/encoding\/encodings\/(nulls|interval|default)\/live\/(hd\/)?start$/.exec(
						url.pathname,
					);
				if (!match) throw new Error("Unexpected synthetic START target");
				expect(Boolean(match[2])).toBe(encodingOption === "HD");
				bodies.set(match[1] as string, JSON.parse(String(init?.body)));
				await Promise.resolve();
				return new Response(JSON.stringify({ data: { result: {} } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		);
		const sdk = createBitmovinSdkOps(
			{ apiKey: "synthetic-only" },
			async () => {},
		);
		await Promise.all([
			sdk.startLiveEncoding("nulls", {
				encodingOption,
				streamKey: "testStream",
				reuploadSettings: {
					dashManifestInterval: null,
					muxingInitFileInterval: null,
				},
			}),
			sdk.startLiveEncoding("interval", {
				encodingOption,
				streamKey: "testStream",
				reuploadSettings: { dashManifestInterval: 60 },
			}),
			sdk.startLiveEncoding("default", {
				encodingOption,
				streamKey: "testStream",
			}),
		]);
		expect(bodies.size).toBe(3);
		expect(bodies.get("nulls")?.reuploadSettings).toEqual({
			dashManifestInterval: null,
			muxingInitFileInterval: null,
		});
		expect(bodies.get("interval")?.reuploadSettings).toEqual({
			dashManifestInterval: 60,
		});
		expect(bodies.get("default")).not.toHaveProperty("reuploadSettings");
	});
});
