import { classifyProviderStatusWord, type StepLogEntry } from "@bitovp/core";
import { isBitmovinError } from "./ops/shared";
import type { ManifestKind, SdkOps } from "./sdk-ops";

const formats: Partial<Record<StepLogEntry["kind"], ManifestKind>> = {
	CREATE_MANIFEST_HLS: "hls",
	CREATE_MANIFEST_DASH: "dash",
	CREATE_MANIFEST_SMOOTH: "smooth",
};

export function recordedRoleManifests(
	entries: readonly StepLogEntry[],
	outputKinds: ReadonlyMap<string, string>,
) {
	return entries.flatMap((entry) => {
		const kind = formats[entry.kind];
		if (entry.status !== "DONE" || !kind) return [];
		const mirrors = entry.refs.mirrorOutputIds ?? [];
		const refs = [entry.refs.outputId, ...[mirrors].flat()];
		if (
			!refs.some(
				(ref) =>
					typeof ref === "string" && outputKinds.get(ref) === "S3_ROLE_BASED",
			)
		)
			return [];
		const attempted = entries.some(
			(step) =>
				step.kind === `START_MANIFEST_${kind.toUpperCase()}` &&
				step.refs.manifestId === entry.step &&
				(step.status === "DONE" ||
					step.status === "RUNNING" ||
					step.startedAt !== undefined),
		);
		return [{ entry, kind, attempted }];
	});
}

const isActiveManifest = (status: string) =>
	status === "RUNNING" || status === "QUEUED";

function isRetryableManifestError(error: unknown): boolean {
	return (
		isBitmovinError(error) &&
		typeof error.httpStatusCode === "number" &&
		// The SDK uses 0 when the transport did not return an HTTP response.
		[0, 408, 429, 500, 502, 503, 504].includes(error.httpStatusCode)
	);
}

export async function stopRecordedRoleManifest(
	sdk: SdkOps,
	kind: ManifestKind,
	id: string,
	jobId: string,
	step: string,
	beforeStop: () => Promise<void>,
): Promise<"TERMINAL" | "ACTIVE" | "UNVERIFIED"> {
	const status =
		kind === "hls"
			? sdk.getHlsManifestStatus
			: kind === "dash"
				? sdk.getDashManifestStatus
				: sdk.getSmoothManifestStatus;
	try {
		const before = await status(id);
		if (classifyProviderStatusWord(before.status) === "TERMINAL")
			return "TERMINAL";
		if (!isActiveManifest(before.status)) return "UNVERIFIED";
		if (!(await sdk.ownsManifest(kind, id, jobId, step))) return "UNVERIFIED";
	} catch (error) {
		// A temporary lookup failure cannot prove that the task stopped or that
		// it belongs to this job. Delay without sending a mutation.
		return isRetryableManifestError(error) ? "ACTIVE" : "UNVERIFIED";
	}
	await beforeStop();
	// A lost STOP reply can still mean Bitmovin accepted it. Only the readback
	// establishes the lifecycle; a 202 receipt by itself never does.
	const stopMayHaveLanded = await sdk.stopManifest(kind, id).then(
		() => true,
		// A conflict can occur while a previous STOP is taking effect.
		(error: unknown) =>
			!isBitmovinError(error) ||
			![400, 401, 403, 404, 405].includes(error.httpStatusCode ?? 0),
	);
	try {
		const after = await status(id);
		if (classifyProviderStatusWord(after.status) === "TERMINAL")
			return "TERMINAL";
		return stopMayHaveLanded && isActiveManifest(after.status)
			? "ACTIVE"
			: "UNVERIFIED";
	} catch (error) {
		return stopMayHaveLanded && isRetryableManifestError(error)
			? "ACTIVE"
			: "UNVERIFIED";
	}
}
