import { AKAMAI_MSL_VERSION_BEHAVIOR } from "./akamai-msl-constraint";
import type { PlanOutput } from "./schema";
import type { PlanIssue } from "./validate";

/** Expected saved-plan refusal, not an infrastructure/compiler failure. */
export class MslEncoderVersionError extends Error {
	constructor(readonly issue: PlanIssue) {
		super(issue.message);
		this.name = "MslEncoderVersionError";
	}
}

/** Shared submit/replay rail. Aliases are external state, never version numbers. */
export function checkMslEncoderVersion(
	outputs: readonly PlanOutput[],
	encoderVersion: string,
): PlanIssue[] {
	const issues: PlanIssue[] = [];
	const parts = /^\d+\.\d+\.\d+$/.test(encoderVersion)
		? encoderVersion.split(".").map(Number)
		: null;
	const version = parts?.every(Number.isSafeInteger)
		? (parts as [number, number, number])
		: null;
	for (const output of outputs) {
		if (output.kind !== "AKAMAI_MSL") continue;
		// Validators also receive TS-constructed plans; schema/other rails own
		// an unknown version. Do not crash while reporting their issues.
		if (!Object.hasOwn(AKAMAI_MSL_VERSION_BEHAVIOR, output.mslVersion))
			continue;
		const minimum =
			AKAMAI_MSL_VERSION_BEHAVIOR[output.mslVersion].minEncoderVersion;
		if (minimum === null) continue;
		const difference =
			version === null
				? null
				: version[0] - minimum[0] ||
					version[1] - minimum[1] ||
					version[2] - minimum[2];
		if (version === null) {
			issues.push({
				code: "MSL_ENCODER_VERSION",
				level: "warning",
				path: "bitmovin.encoderVersion",
				message: `${output.mslVersion} requires encoder ${minimum.join(".")} or newer. The selected version is unresolved; this validation does not resolve aliases. Pin a supported numeric version before delivery verification.`,
			});
		} else if (difference !== null && difference < 0) {
			issues.push({
				code: "MSL_ENCODER_VERSION",
				level: "error",
				path: "bitmovin.encoderVersion",
				message: `${output.mslVersion} requires encoder ${minimum.join(".")} or newer; selected ${encoderVersion}.`,
			});
		}
	}
	return issues;
}
