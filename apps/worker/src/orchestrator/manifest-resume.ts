import { classifyProviderStatusWord, type StepLogEntry } from "@bitovp/core";
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
	const before = await status(id).catch(() => undefined);
	if (classifyProviderStatusWord(before?.status) === "TERMINAL")
		return "TERMINAL";
	if (!before || !isActiveManifest(before.status)) return "UNVERIFIED";
	if (!(await sdk.ownsManifest(kind, id, jobId, step).catch(() => false)))
		return "UNVERIFIED";
	await beforeStop();
	// A lost STOP reply can still mean Bitmovin accepted it. Only the readback
	// establishes the lifecycle; a 202 receipt by itself never does.
	await sdk.stopManifest(kind, id).catch(() => undefined);
	const after = await status(id).catch(() => undefined);
	if (classifyProviderStatusWord(after?.status) === "TERMINAL")
		return "TERMINAL";
	if (after && !isActiveManifest(after.status)) return "UNVERIFIED";
	return "ACTIVE";
}
