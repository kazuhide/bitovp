import { z } from "zod";
import type { CompiledOperation } from "../plan/compiler";
import type { PlanIssue } from "../plan/validate";
import type { LiveChannelPlan } from "./schema";

const release = z
	.string()
	.trim()
	.min(1)
	.max(256)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/);
const outputPath = z
	.string()
	.min(1)
	.max(2048)
	.refine((value) => !value.includes("\0"));

/** A feature setting in the ordinary Live plan; the provider owns its graph. */
export const aisaManagedLiveSettingSchema = z
	.strictObject({
		preset: z.literal("AISA_PREVIEW_MANAGED"),
		outputId: z.uuid(),
		recordingPath: outputPath,
		analysisPath: outputPath,
		esVersion: release.optional(),
		aicaVersion: release.optional(),
	})
	.refine(
		(value) => value.recordingPath !== value.analysisPath,
		"Recording and analysis paths must differ",
	);
export type AisaManagedLiveSetting = z.infer<
	typeof aisaManagedLiveSettingSchema
>;

type AisaPlanLike = {
	bitmovin: {
		accountId?: string;
		cloudRegion: string;
		staticIpId?: unknown;
		labels?: unknown;
		fallbackCloudRegions?: unknown;
		infrastructure?: unknown;
	};
	liveInput: {
		kind: string;
		inputId?: string;
		url?: string;
		name?: string;
		adMarkersSource?: unknown;
	};
	outputs: readonly unknown[];
	ingest: readonly unknown[];
	renditions: readonly unknown[];
	muxings: readonly unknown[];
	liveManifests: readonly unknown[];
	drm?: readonly unknown[];
	deliveryMirrors?: readonly unknown[];
	adMarkers?: unknown;
	start: {
		streamKey: string;
		aiSceneAnalysisLive?: AisaManagedLiveSetting;
		autoRestart?: unknown;
		autoShutdown?: unknown;
		reupload?: unknown;
		esam?: unknown;
		cacheControl?: unknown;
		adInsertion?: unknown;
		encodingOption?: unknown;
		liveEncodingMode?: unknown;
	};
};

export function isAisaManagedLivePlan(plan: unknown): boolean {
	if (!plan || typeof plan !== "object" || !("start" in plan)) return false;
	const start = plan.start;
	return (
		!!start &&
		typeof start === "object" &&
		"aiSceneAnalysisLive" in start &&
		start.aiSceneAnalysisLive !== undefined
	);
}

/** Every rejected field would otherwise be silently discarded by managed Create. */
export function validateAisaManagedLivePlan(plan: AisaPlanLike): PlanIssue[] {
	if (!isAisaManagedLivePlan(plan)) return [];
	const issues: PlanIssue[] = [];
	const reject = (path: string) =>
		issues.push({
			code: "AISA_LIVE_UNSUPPORTED_SETTING",
			level: "error",
			path,
			message: `AISA Live Preview managed preset does not support ${path}`,
		});
	for (const key of [
		"outputs",
		"ingest",
		"renditions",
		"muxings",
		"liveManifests",
		"drm",
		"deliveryMirrors",
	] as const) {
		if (plan[key]?.length) reject(key);
	}
	for (const key of [
		"autoRestart",
		"autoShutdown",
		"reupload",
		"esam",
		"cacheControl",
		"adInsertion",
		"encodingOption",
		"liveEncodingMode",
	] as const) {
		if (plan.start[key] !== undefined) reject(`start.${key}`);
	}
	for (const key of [
		"staticIpId",
		"labels",
		"fallbackCloudRegions",
		"infrastructure",
	] as const) {
		if (plan.bitmovin[key] !== undefined) reject(`bitmovin.${key}`);
	}
	if (plan.adMarkers !== undefined) reject("adMarkers");
	if (!plan.bitmovin.accountId) reject("bitmovin.accountId");
	if (plan.bitmovin.cloudRegion === "EXTERNAL") reject("bitmovin.cloudRegion");
	if (plan.liveInput.kind !== "RTMP" && plan.liveInput.kind !== "HLS")
		reject("liveInput.kind");
	if (
		plan.liveInput.kind === "RTMP" &&
		!/^[a-zA-Z]{3,20}$/.test(plan.start.streamKey)
	)
		reject("start.streamKey");
	if (plan.liveInput.kind === "HLS") {
		try {
			const url = new URL(plan.liveInput.url ?? "");
			if (
				!["http:", "https:"].includes(url.protocol) ||
				!url.hostname ||
				url.username ||
				url.password ||
				url.hash
			)
				reject("liveInput.url");
		} catch {
			reject("liveInput.url");
		}
		if (plan.liveInput.adMarkersSource !== undefined)
			reject("liveInput.adMarkersSource");
	}
	return issues;
}

export type AisaManagedCreateRequest = {
	name: string;
	input:
		| { type: "RTMP"; streamKey: string }
		| { type: "REFERENCE"; inputId: string; streamKey: string }
		| { type: "HLS"; url: string; name?: string };
	cloudRegion: string;
	encoderVersion: string;
	recording: { outputs: AisaManagedOutput[] };
	outputs: AisaManagedOutput[];
};
type AisaManagedOutput = {
	outputId: string;
	outputPath: string;
	acl: [{ permission: "PRIVATE" }];
};

/** Accepts only a validated managed plan; no ordinary graph settings are dropped. */
export function buildAisaManagedCreateRequest(
	plan: LiveChannelPlan,
): AisaManagedCreateRequest {
	const setting = plan.start.aiSceneAnalysisLive;
	if (!setting || validateAisaManagedLivePlan(plan).length) {
		throw new Error("Unsupported AISA Live managed settings");
	}
	const input = plan.liveInput;
	let selected: AisaManagedCreateRequest["input"];
	if (input.kind === "RTMP") {
		selected = input.inputId
			? {
					type: "REFERENCE",
					inputId: input.inputId,
					streamKey: plan.start.streamKey,
				}
			: { type: "RTMP", streamKey: plan.start.streamKey };
	} else if (input.kind === "HLS" && input.url) {
		selected = {
			type: "HLS",
			url: input.url,
			...(input.name ? { name: input.name } : {}),
		};
	} else throw new Error("Unsupported AISA Live source");
	const destination = (path: string): AisaManagedOutput => ({
		outputId: setting.outputId,
		outputPath: path,
		acl: [{ permission: "PRIVATE" }],
	});
	return {
		name: plan.name,
		input: selected,
		cloudRegion: plan.bitmovin.cloudRegion,
		encoderVersion: plan.bitmovin.encoderVersion,
		recording: { outputs: [destination(setting.recordingPath)] },
		outputs: [destination(setting.analysisPath)],
	};
}

export function compileAisaManagedLiveChannel(
	plan: LiveChannelPlan,
): CompiledOperation[] {
	const request = buildAisaManagedCreateRequest(plan);
	const setting = plan.start.aiSceneAnalysisLive;
	return [
		{
			step: "analysis",
			kind: "CREATE_AISA_LIVE_ANALYSIS",
			payload: { request },
			refs: {},
		},
		{
			step: "encoding",
			kind: "RESOLVE_AISA_LIVE_ENCODING",
			payload: {},
			refs: { analysisId: "analysis" },
		},
		{
			step: "start",
			kind: "START_AISA_LIVE_ANALYSIS",
			payload: {
				...(setting?.esVersion ? { esVersion: setting.esVersion } : {}),
				...(setting?.aicaVersion ? { aicaVersion: setting.aicaVersion } : {}),
			},
			refs: { analysisId: "analysis", encodingId: "encoding" },
		},
		{
			step: "await:running",
			kind: "AWAIT_LIVE_RUNNING",
			payload: {},
			refs: { analysisId: "analysis", encodingId: "encoding" },
		},
	];
}
