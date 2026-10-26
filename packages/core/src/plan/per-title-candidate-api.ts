import type { PerTitleProposal } from "./per-title-simulator";
import {
	perTitleFixedResolutionAndBitrateSettingsSchema,
	perTitleSchema,
	perTitleStreamSettingsSchema,
} from "./schema";

const codecFields = {
	H264: "h264Configuration",
	H265: "h265Configuration",
	H265V2: "h265V2Configuration",
	VP9: "vp9Configuration",
	AV1: "av1Configuration",
} as const;
const fixedFields = Object.keys(
	perTitleFixedResolutionAndBitrateSettingsSchema.shape,
);
const bitrateFields = [
	"minBitrate",
	"maxBitrate",
	"lowComplexityBoundaryForMaxBitrate",
	"highComplexityBoundaryForMaxBitrate",
] as const;

/** Supported arithmetic range of this simulator, not an Encoding API maximum. */
export const PER_TITLE_SIMULATOR_MAX_BITRATE = 2_147_483_647;

/** Arithmetic feasibility does not make a configuration valid for the API. */
export function constrainPerTitleApiCandidate(
	proposal: PerTitleProposal,
): PerTitleProposal {
	const global = perTitleSchema.safeParse({
		[codecFields[proposal.codec]]: proposal.api.global,
	});
	const fields = global.success
		? []
		: global.error.issues.map((issue) => issue.path.join("."));
	const overLimitFields: string[] = [];
	for (const field of ["minBitrate", "maxBitrate"] as const)
		if (proposal.api.global[field] > PER_TITLE_SIMULATOR_MAX_BITRATE)
			overLimitFields.push(`global.${field}`);
	const invalidRows: string[] = [];
	const overLimitRows: string[] = [];
	for (const stream of proposal.api.streams) {
		const settings = stream.perTitleSettings;
		if (settings === undefined) continue;
		const parsed = perTitleStreamSettingsSchema.safeParse(settings);
		const fixedOnly =
			stream.mode !== "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" &&
			fixedFields.some((key) => Object.hasOwn(settings, key));
		const unsupportedFactors =
			proposal.codec !== "H264" &&
			proposal.codec !== "H265" &&
			(settings.codecMaxBitrateFactor !== undefined ||
				settings.codecBufsizeFactor !== undefined);
		if (!parsed.success || fixedOnly || unsupportedFactors) {
			invalidRows.push(stream.rowId);
			fields.push("streams.perTitleSettings");
		}
		const outside = bitrateFields.filter((field) => {
			const value = settings[field];
			return value !== undefined && value > PER_TITLE_SIMULATOR_MAX_BITRATE;
		});
		if (outside.length) {
			overLimitRows.push(stream.rowId);
			overLimitFields.push(
				...outside.map((field) => `streams.perTitleSettings.${field}`),
			);
		}
	}
	if (fields.length === 0 && overLimitFields.length === 0) return proposal;
	const diagnostics: PerTitleProposal["diagnostics"] = [
		...proposal.diagnostics,
	];
	if (fields.length)
		diagnostics.push({
			code: "invalid-setting",
			severity: "conflict",
			message:
				"The calculated Per-Title settings do not satisfy the encoding plan API schema.",
			values: { fields: [...new Set(fields)].join(", ") },
			...(invalidRows.length ? { rowIds: invalidRows } : {}),
		});
	if (overLimitFields.length)
		diagnostics.push({
			code: "model-limit",
			severity: "conflict",
			message:
				"Bitrate values exceed this simulator's supported bitrate range.",
			values: {
				limit: "bitrate",
				maximumBitrate: PER_TITLE_SIMULATOR_MAX_BITRATE,
				fields: [...new Set(overLimitFields)].join(", "),
			},
			...(overLimitRows.length ? { rowIds: overLimitRows } : {}),
		});
	const result: PerTitleProposal = {
		...proposal,
		status: "conflict",
		applicable: false,
		diagnostics,
		scenarios: proposal.scenarios.map((scenario) => ({
			...scenario,
			status: "unknown",
			modelCountRange: null,
		})),
	};
	if (proposal.derivation) {
		result.derivation = {
			...proposal.derivation,
			targetSatisfied: false,
			...(proposal.derivation.constraints
				? {
						constraints: {
							...proposal.derivation.constraints,
							status: "unknown",
						},
					}
				: {}),
		};
		delete result.derivation.integerWitness;
		delete result.derivation.minimumStepRange;
	}
	return result;
}
