import {
	CODEC_CONFIG_API_PATH,
	capturedPerTitleSettingsSchema,
	type PerTitleCodec,
	type PerTitleGoal,
} from "@bitovp/core";
import { z } from "zod";
import {
	type PerTitleReference,
	parsePerTitlePreset,
	perTitleReferenceSchema,
} from "./per-title-simulator-preset";

const encodingId = z.uuid();
const apiKey = z
	.string()
	.trim()
	.min(1)
	.max(512)
	.regex(/^[\x21-\x7e]+$/);

export const perTitleEncodingImportRequestSchema = z.union([
	z.object({ encodingId, bitmovinAccountId: z.uuid() }).strict(),
	z
		.object({
			encodingId,
			apiKey,
			tenantOrgId: z.string().trim().pipe(z.uuid()).optional(),
		})
		.strict(),
]);

export type PerTitleEncodingSnapshot = {
	startRequest: unknown;
	streams: readonly {
		stream: unknown;
		codecType: string;
		configuration: unknown;
	}[];
};

export type PerTitleEncodingImportedConfiguration = {
	codec: PerTitleCodec;
	goal: PerTitleGoal;
	reference: PerTitleReference;
};

export const perTitleEncodingImportIssueCodeSchema = z.enum([
	"NO_PER_TITLE_CONFIGURATION",
	"UNSUPPORTED_CODEC",
	"UNSUPPORTED_GLOBAL_SETTINGS",
	"UNSUPPORTED_STREAM_SETTINGS",
	"MISSING_BITRATE_LIMITS",
	"INVALID_CONFIGURATION",
	"TOO_MANY_TEMPLATES",
	"MISSING_CODEC_CONFIGURATION",
]);

export type PerTitleEncodingImportIssue = {
	codec?: PerTitleCodec;
	code: z.infer<typeof perTitleEncodingImportIssueCodeSchema>;
	fields?: string[];
};

export type PerTitleEncodingImportResponse = {
	configurations: PerTitleEncodingImportedConfiguration[];
	issues: PerTitleEncodingImportIssue[];
};

const configurationKeys = {
	H264: "h264Configuration",
	H265: "h265Configuration",
	H265V2: "h265V2Configuration",
	VP9: "vp9Configuration",
	AV1: "av1Configuration",
} as const satisfies Record<PerTitleCodec, string>;
const codecs = Object.keys(configurationKeys) as PerTitleCodec[];
const templateModes = new Set([
	"PER_TITLE_TEMPLATE",
	"PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
	"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
]);
const globalSchema = perTitleReferenceSchema.shape.global;
const globalKeys = new Set(Object.keys(globalSchema.shape));
const settingsKeys = new Set([
	"fixedResolutionAndBitrateSettings",
	"codecMaxBitrateFactor",
	"codecBufsizeFactor",
]);
const streamSchema = perTitleReferenceSchema.shape.streams.element;

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function defined(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(value).filter(([, item]) => item !== undefined),
	);
}

function normalizeNested(
	value: Record<string, unknown>,
	keys: readonly string[],
): Record<string, unknown> {
	const next = defined(value);
	for (const key of keys) {
		const nested = object(next[key]);
		if (nested) next[key] = defined(nested);
	}
	return next;
}

function isCodec(value: string): value is PerTitleCodec {
	return Object.hasOwn(configurationKeys, value);
}

/** Projects template settings only; provider metadata and secrets never enter a draft. */
export function projectPerTitleEncodingImport(
	snapshot: PerTitleEncodingSnapshot,
): PerTitleEncodingImportResponse {
	const result: PerTitleEncodingImportResponse = {
		configurations: [],
		issues: [],
	};
	const perTitle = object(object(snapshot.startRequest)?.perTitle);
	if (!perTitle)
		return { ...result, issues: [{ code: "NO_PER_TITLE_CONFIGURATION" }] };
	const grouped = new Map<PerTitleCodec, PerTitleReference["streams"]>();
	const blocked = new Set<PerTitleCodec>();
	const reportGeneral = (code: PerTitleEncodingImportIssue["code"]) => {
		if (!result.issues.some((issue) => !issue.codec && issue.code === code))
			result.issues.push({ code });
	};
	const report = (
		codec: PerTitleCodec,
		code: PerTitleEncodingImportIssue["code"],
		fields?: string[],
	) => {
		if (!blocked.has(codec))
			result.issues.push({ codec, code, ...(fields ? { fields } : {}) });
		blocked.add(codec);
	};
	if (
		Object.entries(perTitle).some(
			([key, value]) =>
				value !== undefined &&
				value !== null &&
				!Object.values(configurationKeys).some((known) => known === key),
		)
	)
		reportGeneral("UNSUPPORTED_CODEC");
	for (const entry of snapshot.streams) {
		const stream = object(entry.stream);
		if (!stream) {
			reportGeneral("INVALID_CONFIGURATION");
			continue;
		}
		if (
			stream.mode === undefined ||
			stream.mode === "STANDARD" ||
			stream.mode === "PER_TITLE_RESULT"
		)
			continue;
		if (!isCodec(entry.codecType)) {
			const path = Object.hasOwn(CODEC_CONFIG_API_PATH, entry.codecType)
				? CODEC_CONFIG_API_PATH[entry.codecType]
				: undefined;
			if (!path || path[0] === "video") reportGeneral("UNSUPPORTED_CODEC");
			continue;
		}
		const codec = entry.codecType;
		if (typeof stream.mode !== "string" || !templateModes.has(stream.mode)) {
			report(codec, "UNSUPPORTED_STREAM_SETTINGS");
			continue;
		}
		if (blocked.has(codec)) continue;
		const configuration = object(entry.configuration);
		if (!configuration) {
			report(codec, "MISSING_CODEC_CONFIGURATION");
			continue;
		}
		const projected: Record<string, unknown> = {
			id: stream.id,
			codec,
			mode: stream.mode,
		};
		for (const key of ["width", "height", "bitrate"])
			if (configuration[key] !== undefined) projected[key] = configuration[key];
		if (stream.perTitleSettings !== undefined) {
			const settings = object(stream.perTitleSettings);
			if (!settings) {
				report(codec, "INVALID_CONFIGURATION");
				continue;
			}
			const normalized = normalizeNested(settings, [
				"fixedResolutionAndBitrateSettings",
			]);
			if (Object.keys(normalized).some((key) => !settingsKeys.has(key))) {
				report(codec, "UNSUPPORTED_STREAM_SETTINGS");
				continue;
			}
			const parsed = capturedPerTitleSettingsSchema.safeParse(normalized);
			if (!parsed.success) {
				report(
					codec,
					parsed.error.issues.some(
						(issue) => issue.code === "unrecognized_keys",
					)
						? "UNSUPPORTED_STREAM_SETTINGS"
						: "INVALID_CONFIGURATION",
				);
				continue;
			}
			const { fixedResolutionAndBitrateSettings, ...factors } = parsed.data;
			projected.perTitleSettings = {
				...fixedResolutionAndBitrateSettings,
				...factors,
			};
		}
		const checked = streamSchema.safeParse(projected);
		if (!checked.success) {
			report(codec, "INVALID_CONFIGURATION");
			continue;
		}
		const streams = grouped.get(codec) ?? [];
		if (streams.length >= 64) {
			report(codec, "TOO_MANY_TEMPLATES");
			continue;
		}
		streams.push(checked.data);
		grouped.set(codec, streams);
	}
	for (const codec of codecs) {
		if (blocked.has(codec)) continue;
		const raw = perTitle[configurationKeys[codec]];
		const streams = grouped.get(codec);
		if (raw === undefined || raw === null) {
			if (streams?.length) report(codec, "MISSING_CODEC_CONFIGURATION");
			continue;
		}
		if (!streams?.length) {
			report(codec, "NO_PER_TITLE_CONFIGURATION");
			continue;
		}
		const value = object(raw);
		if (!value) {
			report(codec, "INVALID_CONFIGURATION");
			continue;
		}
		const normalized = normalizeNested(value, [
			"autoRepresentations",
			"fixedResolutionAndBitrateConfiguration",
		]);
		if (Object.keys(normalized).some((key) => !globalKeys.has(key))) {
			report(codec, "UNSUPPORTED_GLOBAL_SETTINGS");
			continue;
		}
		const missing = ["minBitrate", "maxBitrate"].filter(
			(key) => normalized[key] === undefined,
		);
		if (missing.length) {
			report(codec, "MISSING_BITRATE_LIMITS", missing);
			continue;
		}
		const checked = globalSchema.safeParse(normalized);
		if (!checked.success) {
			report(
				codec,
				checked.error.issues.some((issue) => issue.code === "unrecognized_keys")
					? "UNSUPPORTED_GLOBAL_SETTINGS"
					: "INVALID_CONFIGURATION",
			);
			continue;
		}
		try {
			const loaded = parsePerTitlePreset(
				JSON.stringify({
					version: 1,
					reference: { codec, global: checked.data, streams },
				}),
				[codec],
			);
			if (loaded.reference)
				result.configurations.push({
					codec,
					goal: loaded.goal,
					reference: loaded.reference,
				});
		} catch {
			report(codec, "INVALID_CONFIGURATION");
		}
	}
	if (!result.configurations.length && !result.issues.length)
		result.issues.push({ code: "NO_PER_TITLE_CONFIGURATION" });
	return result;
}
