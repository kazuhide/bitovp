import { createHash } from "node:crypto";
import {
	type ExperimentNvencSdkSettings,
	type ExperimentRuntime,
	type ExperimentTrialInput,
	experimentResultSchema,
} from "@bitovp/core/encoding-experiments";

function sdkManifestReceipt(settings: ExperimentNvencSdkSettings) {
	const lines = (
		prefix: string,
		fields: NonNullable<ExperimentNvencSdkSettings["session"]>,
	) =>
		Object.keys(fields)
			.sort()
			.map((field) => `${prefix}\t${field}\t${Number(fields[field])}\n`);
	const rows = [
		...lines("init", settings.session ?? {}),
		...(settings.pictures ?? [])
			.toSorted((a, b) => a.frameIndex - b.frameIndex)
			.flatMap(({ frameIndex, fields, reconfigure, qpMap, metadata }) => [
				...lines(`reconfigure\t${frameIndex}`, reconfigure ?? {}),
				...lines(`picture\t${frameIndex}`, fields ?? {}),
				...(qpMap ? [`qpmap\t${frameIndex}\t${qpMap}\n`] : []),
				...(metadata ?? []).map(
					({ type, payload }) =>
						`metadata\t${frameIndex}\t${type}\t${payload}\n`,
				),
			]),
	];
	return {
		fieldCount: rows.length,
		manifestSha256: createHash("sha256").update(rows.join("")).digest("hex"),
	};
}

export function readMeasurement(
	value: unknown,
	runtime: Pick<
		ExperimentRuntime,
		"runtimeId" | "additionalScoringProfiles" | "nvencSdk"
	>,
	frameCount: number,
	requestedProfiles?: ExperimentTrialInput["additionalScoringProfiles"],
	requestedSdk?: ExperimentNvencSdkSettings,
) {
	const result = experimentResultSchema.parse(value);
	const secondary = result.additionalScores?.[0];
	if (
		result.runtimeId !== runtime.runtimeId ||
		result.frameCount !== frameCount ||
		BigInt(result.durationTicks) * BigInt(result.timeBase.num) * 30n !==
			BigInt(frameCount) * BigInt(result.timeBase.den) ||
		secondary?.scoringProfileId !== requestedProfiles?.[0]
	)
		throw new Error("EXPERIMENT_RECEIPT_MISMATCH");
	if (secondary) {
		const profile = runtime.additionalScoringProfiles?.[0];
		if (
			profile?.scoringProfileId !== secondary.scoringProfileId ||
			(secondary.status === "succeeded" &&
				(profile.scorerSha256 !== secondary.scorerSha256 ||
					profile.modelSha256 !== secondary.modelSha256))
		)
			throw new Error("EXPERIMENT_RECEIPT_MISMATCH");
	}
	const appliedSdk = result.nvencSdkApplied;
	if (requestedSdk) {
		const expected = sdkManifestReceipt(requestedSdk);
		if (
			runtime.nvencSdk?.version !== requestedSdk.version ||
			appliedSdk?.fieldCount !== expected.fieldCount ||
			appliedSdk.manifestSha256 !== expected.manifestSha256
		)
			throw new Error("EXPERIMENT_RECEIPT_MISMATCH");
	} else if (appliedSdk) {
		throw new Error("EXPERIMENT_RECEIPT_MISMATCH");
	}
	return result;
}
