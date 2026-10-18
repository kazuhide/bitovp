import type {
	VmafComputeTaskSummary,
	VmafTaskProgress,
} from "@/app/qc/vmaf-shared";

/** Strict public projection: never spread worker JSON (it may carry URLs or images). */
export function publicVmafProgress(value: unknown): VmafTaskProgress | null {
	if (!value || typeof value !== "object") return null;
	const p = value as Record<string, unknown>;
	const phases = [
		"MANIFEST",
		"REFERENCE_DOWNLOAD",
		"DISTORTED_DOWNLOAD",
		"MODEL_DOWNLOAD",
		"REFERENCE_PROBE",
		"DISTORTED_PROBE",
		"ALIGNMENT",
		"SCORING",
		"RESULT_UPLOAD",
		"RECEIPT_UPLOAD",
		"STAGING",
		"QUEUED",
		"RETRYING",
	];
	if (
		p.version !== 1 ||
		typeof p.phase !== "string" ||
		!phases.includes(p.phase) ||
		typeof p.updatedAt !== "string" ||
		!Number.isFinite(Date.parse(p.updatedAt))
	)
		return null;
	const integer = (v: unknown) =>
		typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
	return {
		phase: p.phase as VmafTaskProgress["phase"],
		updatedAt: new Date(p.updatedAt).toISOString(),
		...(p.phase === "SCORING" && integer(p.framesProcessed)
			? { framesProcessed: p.framesProcessed as number }
			: {}),
		...(p.phase === "SCORING" &&
		integer(p.totalFrames) &&
		(p.totalFrames as number) > 0
			? { totalFrames: p.totalFrames as number }
			: {}),
	};
}

export const publicVmafTaskSelect = {
	id: true,
	vmafJobId: true,
	targetKey: true,
	attempt: true,
	profileId: true,
	state: true,
	reservedUsd: true,
	createdAt: true,
	cleanedAt: true,
	error: true,
	progress: true,
} as const;

type Task = {
	id: string;
	targetKey: string;
	attempt: number;
	profileId: string;
	state: string;
	reservedUsd: number;
	createdAt: Date;
	cleanedAt: Date | null;
	error: string | null;
	progress: unknown;
};

/** Keep cleanup history, but only the highest attempt for a pair is current. */
export function publicVmafTasks(tasks: Task[]): VmafComputeTaskSummary[] {
	const latest = new Map<string, Task>();
	for (const task of tasks) {
		const key = task.targetKey ?? task.id;
		const prior = latest.get(key);
		if (!prior || (task.attempt ?? 0) > (prior.attempt ?? 0))
			latest.set(key, task);
	}
	return tasks.map((task) => {
		const progress = publicVmafProgress(task.progress);
		const raw =
			task.progress && typeof task.progress === "object"
				? (task.progress as Record<string, unknown>)
				: {};
		return {
			id: task.id,
			profileId: task.profileId,
			state: task.state,
			reservedUsd: task.reservedUsd,
			createdAt: task.createdAt.toISOString(),
			cleanedAt: task.cleanedAt?.toISOString() ?? null,
			error: task.error ? "Cloud task needs operator attention" : null,
			current: latest.get(task.targetKey ?? task.id)?.id === task.id,
			attempt: (task.attempt ?? 0) + 1,
			...(raw.provisioningModel === "SPOT" ||
			raw.provisioningModel === "STANDARD"
				? { provisioningModel: raw.provisioningModel }
				: {}),
			progress,
		};
	});
}
