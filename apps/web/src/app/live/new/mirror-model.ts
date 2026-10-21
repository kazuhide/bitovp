import type { CredentialSummaryWire } from "@bitovp/core";
import { liveOutputKindForProvider } from "@/app/vod/new/stream-model";
import type { LiveWizardState } from "./build-live-plan";
import { liveMirrorEntries } from "./live-output-model";

export const liveStorageKind = (kind: string | null) =>
	kind !== null &&
	["S3", "GENERIC_S3", "GCS", "GCS_SERVICE_ACCOUNT", "AZURE"].includes(kind);

/** Form-only guard. Expert JSON and provider contracts remain unchanged. */
export function liveMirrorProblem(
	state: LiveWizardState,
	credentials?: Pick<CredentialSummaryWire, "id" | "provider">[],
):
	| "liveMirror.unsupported"
	| "liveMirror.sameDestination"
	| "liveMirror.unavailable"
	| null {
	const seen = [state.output];
	for (const { output: mirror } of liveMirrorEntries(state)) {
		if (!liveStorageKind(mirror.kind)) return "liveMirror.unsupported";
		if (
			credentials &&
			!credentials.some(
				(c) =>
					c.id === mirror.credentialId &&
					liveOutputKindForProvider(c.provider) === mirror.kind,
			)
		)
			return "liveMirror.unavailable";
		// Both empty buckets are still equal; never interpret missing values as
		// proof of independent storage. Schema validation also refuses empties.
		const normalized = (value: unknown) =>
			typeof value === "string" ? value.trim() : "";
		if (
			seen.some(
				(output) =>
					mirror.kind === output.kind &&
					normalized(mirror.credentialId) === normalized(output.credentialId) &&
					normalized(mirror.bucket) === normalized(output.bucket),
			)
		)
			return "liveMirror.sameDestination";
		seen.push(mirror);
	}
	return null;
}
