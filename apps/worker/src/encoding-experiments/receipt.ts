import {
	type ExperimentRuntime,
	type ExperimentTrialInput,
	experimentResultSchema,
} from "@bitovp/core/encoding-experiments";

export function readMeasurement(
	value: unknown,
	runtime: Pick<ExperimentRuntime, "runtimeId" | "additionalScoringProfiles">,
	frameCount: number,
	requestedProfiles?: ExperimentTrialInput["additionalScoringProfiles"],
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
	return result;
}
