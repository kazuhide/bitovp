import { CREDENTIAL_PROVIDER_SHAPES } from "@bitovp/core";
import type { CredentialSummary } from "@bitovp/db";
import { pickByLabel } from "./harness-rails";

export type S3VerificationStorage = {
	s3CredentialLabel: string;
	s3RoleCredentialLabel?: string;
	inputBucket: string;
	outputBucket: string;
	sourceObject: string;
};

export type S3RoleVerificationBinding = {
	roleCredentialId: string;
	observerCredentialId: string;
	inputBucket: string;
	outputBucket: string;
};

export function s3VerificationStorageEnv(
	env: NodeJS.ProcessEnv = process.env,
): S3VerificationStorage {
	return {
		s3CredentialLabel: env.VERIFY_S3_LABEL ?? "verify-aws",
		s3RoleCredentialLabel: env.VERIFY_S3_ROLE_BASED_LABEL?.trim() || undefined,
		inputBucket: env.VERIFY_S3_INPUT_BUCKET ?? "ap-northeast-1-input",
		outputBucket: env.VERIFY_S3_OUTPUT_BUCKET ?? "ap-northeast-1-output",
		sourceObject:
			env.VERIFY_SOURCE_OBJECT ?? "big_buck_bunny_1080p_h264_short.mov",
	};
}

export function selectS3RoleObserver(
	settings: S3VerificationStorage,
	rows: readonly CredentialSummary[],
	labelPrefix = "verify-",
):
	| { binding: S3RoleVerificationBinding; observer: CredentialSummary }
	| undefined {
	const label = settings.s3RoleCredentialLabel;
	if (!label?.startsWith(labelPrefix)) return undefined;
	const role = pickByLabel(
		rows.filter(
			(row) => row.provider === "AWS_S3_ROLE_BASED" && row.label === label,
		),
		label,
		"S3 role verification credential",
	);
	const observer = pickByLabel(
		rows.filter(
			(row) => row.provider === "AWS_S3" && row.label.startsWith(labelPrefix),
		),
		settings.s3CredentialLabel,
		"S3 verification observer",
	);
	if (
		!role ||
		!observer ||
		!CREDENTIAL_PROVIDER_SHAPES.AWS_S3_ROLE_BASED.config.safeParse(role.config)
			.success
	)
		return undefined;
	return {
		binding: {
			roleCredentialId: role.id,
			observerCredentialId: observer.id,
			inputBucket: settings.inputBucket,
			outputBucket: settings.outputBucket,
		},
		observer,
	};
}
