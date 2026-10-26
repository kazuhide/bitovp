import type { PerTitleCodec } from "@bitovp/core";
import { z } from "zod";
import {
	type PerTitleEncodingImportResponse,
	perTitleEncodingImportIssueCodeSchema,
} from "./per-title-encoding-import";
import { parsePerTitlePreset } from "./per-title-simulator-preset";

const codec = z.enum(["H264", "H265", "H265V2", "VP9", "AV1"]);
const response = z
	.object({
		configurations: z
			.array(
				z
					.object({
						codec,
						goal: z.unknown(),
						reference: z.unknown(),
					})
					.strict(),
			)
			.max(5),
		issues: z
			.array(
				z
					.object({
						codec: codec.optional(),
						code: perTitleEncodingImportIssueCodeSchema.catch(
							"INVALID_CONFIGURATION",
						),
						fields: z
							.array(z.enum(["minBitrate", "maxBitrate"]))
							.max(2)
							.optional(),
					})
					.strict(),
			)
			.max(64),
	})
	.strict();

/** Recheck the response at the browser boundary without exposing source values. */
export function validateEncodingImport(
	value: unknown,
	allowedCodecs: readonly PerTitleCodec[],
): PerTitleEncodingImportResponse {
	const parsed = response.parse(value);
	const configurations: PerTitleEncodingImportResponse["configurations"] = [];
	const issues: PerTitleEncodingImportResponse["issues"] = [...parsed.issues];
	const seen = new Set<PerTitleCodec>();
	for (const configuration of parsed.configurations) {
		if (!allowedCodecs.includes(configuration.codec)) {
			issues.push({ codec: configuration.codec, code: "UNSUPPORTED_CODEC" });
			continue;
		}
		try {
			const checked = parsePerTitlePreset(
				JSON.stringify({
					version: 1,
					goal: configuration.goal,
					reference: configuration.reference,
				}),
				allowedCodecs,
			);
			if (
				!checked.reference ||
				checked.goal.codec !== configuration.codec ||
				checked.goal.countPolicy.kind !== "unrestricted" ||
				seen.has(configuration.codec)
			)
				throw new Error("Invalid import");
			seen.add(configuration.codec);
			configurations.push({
				codec: configuration.codec,
				...checked,
				reference: checked.reference,
			});
		} catch {
			issues.push({
				codec: configuration.codec,
				code: "INVALID_CONFIGURATION",
			});
		}
	}
	return { configurations, issues };
}
