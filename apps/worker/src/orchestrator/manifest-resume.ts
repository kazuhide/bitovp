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

const isActiveManifest = (status: unknown) =>
	status === "RUNNING" || status === "QUEUED";

function definitivelyRefusedManifestProbe(error: unknown): boolean {
	const status = isBitmovinError(error) ? error.httpStatusCode : undefined;
	return (
		typeof status === "number" &&
		Number.isInteger(status) &&
		status >= 400 &&
		status < 500 &&
		status !== 408 &&
		status !== 429
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
		const before = (await status(id))?.status;
		const lifecycle = classifyProviderStatusWord(before);
		if (lifecycle === "TERMINAL") return "TERMINAL";
		// ACTIVE keeps the durable cleanup pending when a read is inconclusive.
		if (lifecycle === "UNKNOWN") return "ACTIVE";
		if (!isActiveManifest(before)) return "UNVERIFIED";
		if (!(await sdk.ownsManifest(kind, id, jobId, step))) return "UNVERIFIED";
	} catch (error) {
		// SDK parsing failures can lack an HTTP status. They leave both the
		// task lifecycle and authority to send STOP unresolved.
		return definitivelyRefusedManifestProbe(error) ? "UNVERIFIED" : "ACTIVE";
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
		const after = (await status(id))?.status;
		const lifecycle = classifyProviderStatusWord(after);
		if (lifecycle === "TERMINAL") return "TERMINAL";
		return stopMayHaveLanded &&
			(lifecycle === "UNKNOWN" || isActiveManifest(after))
			? "ACTIVE"
			: "UNVERIFIED";
	} catch (error) {
		return stopMayHaveLanded && !definitivelyRefusedManifestProbe(error)
			? "ACTIVE"
			: "UNVERIFIED";
	}
}
