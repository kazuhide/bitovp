/** LCM(1..32): every supported pool size receives an exact integer share. */
export const AUTO_GPU_SHARE_CAPACITY = 144_403_552_893_600;

export type AutoExecutionResources = {
	cpuCapacity: number;
	/** Stable, spendable capacity after the caller's control/safety reserve. */
	hostBudgetBytes: number;
	/** Current spendable headroom; omitted means the full host budget is free. */
	hostAvailableBytes?: number;
	gpuTotalBytes?: number | null;
	/** Spendable GPU capacity after reserves; defaults to the physical total. */
	gpuBudgetBytes?: number | null;
	/** Current spendable device headroom, not the selected memory heap's size. */
	gpuAvailableBytes?: number | null;
	integrated: boolean;
};

export type AutoExecutionCandidate = {
	profileKey: string;
	scope: "native-with-cpu-parity";
	concurrency: number;
	inflightFrames: 1 | 2 | 4;
	cpuThreads: 1 | 2 | 4;
	decoderThreads: 1 | 2;
	/** Non-GPU host memory, including the caller's full-result storage estimate. */
	hostBytesPerComparison: number;
	/** Workspace and opaque driver/decoder allowances supplied by the caller. */
	gpuBytesPerComparison: number;
	trials: readonly {
		workFrames: number;
		wallMs: number;
		cpuVerified: true;
		warmup?: false;
	}[];
};

export type AutoExecutionRequest = {
	resources: AutoExecutionResources;
	/** A trusted single-comparison estimate; the policy never guesses pixels. */
	baseline: { hostBytes: number; gpuBytes: number };
	/** Binds native source, device/driver, model and all measurement settings. */
	expectedProfileKey: string;
	/** An operator override applies to candidate selection and the fallback. */
	fixedCpuThreads?: number;
	candidates: readonly AutoExecutionCandidate[];
};

export type AutoExecutionReason =
	| "calibrated-resource-knee"
	| "no-compatible-profile"
	| "incomparable-profile-work"
	| "missing-serial-control"
	| "profile-resource-limited"
	| "gpu-memory-unknown"
	| "cpu-capacity-low"
	| "host-capacity-insufficient"
	| "gpu-capacity-insufficient"
	| "host-memory-pressure"
	| "gpu-memory-pressure"
	| "invalid-resource-data"
	| "invalid-baseline";

export type AutoExecutionPlan = {
	/** A device-wide target; it is never limited by one parent's mirror count. */
	maxActiveComparisons: number;
	inflightFrames: 1 | 2 | 4;
	cpuThreads: number;
	decoderThreads: 1 | 2;
	cpuChargePerComparison: number;
	/** Includes GPU memory conservatively for an integrated/shared-memory GPU. */
	hostBytesPerComparison: number;
	gpuBytesPerComparison: number;
	/** Throughput sharing only. CPU, RAM and device bytes remain separate. */
	gpuShareCredits: number;
	source: "calibrated" | "conservative";
};

export type AutoExecutionDecision = {
	status: "ready" | "wait" | "unavailable";
	plan?: AutoExecutionPlan;
	reasons: AutoExecutionReason[];
};

const positiveBytes = (n: unknown): n is number =>
	typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const nonnegativeBytes = (n: unknown): n is number =>
	typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const cpuCharge = (threads: number, decoderThreads: number) =>
	threads + 2 * decoderThreads + 1;
const hostCharge = (host: number, gpu: number, integrated: boolean) =>
	host + (integrated ? gpu : 0);

function median(values: readonly number[]) {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const upper = sorted[middle] as number;
	const lower = sorted[middle - 1] as number;
	return sorted.length % 2 ? upper : lower + (upper - lower) / 2;
}

function validCandidate(candidate: AutoExecutionCandidate, key: string) {
	return (
		candidate !== null &&
		typeof candidate === "object" &&
		candidate.profileKey === key &&
		candidate.scope === "native-with-cpu-parity" &&
		Number.isInteger(candidate.concurrency) &&
		candidate.concurrency >= 1 &&
		candidate.concurrency <= 32 &&
		[1, 2, 4].includes(candidate.inflightFrames) &&
		[1, 2, 4].includes(candidate.cpuThreads) &&
		[1, 2].includes(candidate.decoderThreads) &&
		positiveBytes(candidate.hostBytesPerComparison) &&
		positiveBytes(candidate.gpuBytesPerComparison) &&
		Array.isArray(candidate.trials) &&
		candidate.trials.length >= 3 &&
		candidate.trials.every(
			(trial) =>
				trial !== null &&
				typeof trial === "object" &&
				positiveBytes(trial.workFrames) &&
				trial.workFrames === candidate.trials[0]?.workFrames &&
				typeof trial.wallMs === "number" &&
				Number.isFinite(trial.wallMs) &&
				trial.wallMs > 0 &&
				trial.wallMs <= Number.MAX_SAFE_INTEGER &&
				trial.cpuVerified === true &&
				(trial.warmup === undefined || trial.warmup === false),
		) &&
		Number.isFinite(
			(candidate.trials[0]?.workFrames ?? 0) /
				median(candidate.trials.map((trial) => trial.wallMs)),
		)
	);
}

/** Select a resource-efficient measured plan; admission still owns the queue. */
export function selectAutoExecutionPlan(
	request: AutoExecutionRequest,
): AutoExecutionDecision {
	const { resources: r, baseline } = request;
	const hostAvailable = r?.hostAvailableBytes ?? r?.hostBudgetBytes;
	const total = r?.gpuTotalBytes ?? undefined;
	const gpuBudget = r?.gpuBudgetBytes ?? total;
	const gpuAvailable = r?.gpuAvailableBytes ?? undefined;
	const fallbackThreads = request.fixedCpuThreads ?? 1;
	if (
		!r ||
		!Number.isSafeInteger(fallbackThreads) ||
		fallbackThreads < 1 ||
		fallbackThreads > 256 ||
		!Number.isFinite(r.cpuCapacity) ||
		r.cpuCapacity <= 0 ||
		!Number.isSafeInteger(Math.ceil(r.cpuCapacity)) ||
		!positiveBytes(r.hostBudgetBytes) ||
		!nonnegativeBytes(hostAvailable) ||
		typeof r.integrated !== "boolean" ||
		(total !== undefined && !positiveBytes(total)) ||
		(gpuBudget !== undefined &&
			(!positiveBytes(gpuBudget) ||
				(total !== undefined && gpuBudget > total))) ||
		(gpuAvailable !== undefined &&
			(!nonnegativeBytes(gpuAvailable) ||
				(total !== undefined && gpuAvailable > total)))
	)
		return { status: "unavailable", reasons: ["invalid-resource-data"] };
	if (
		!baseline ||
		!positiveBytes(baseline.hostBytes) ||
		!positiveBytes(baseline.gpuBytes) ||
		!positiveBytes(
			hostCharge(baseline.hostBytes, baseline.gpuBytes, r.integrated),
		)
	)
		return { status: "unavailable", reasons: ["invalid-baseline"] };

	const reasons: AutoExecutionReason[] = [];
	const gpuKnown = total !== undefined && gpuAvailable !== undefined;
	if (!gpuKnown) reasons.push("gpu-memory-unknown");
	const planFor = (candidate: AutoExecutionCandidate): AutoExecutionPlan => ({
		maxActiveComparisons: candidate.concurrency,
		inflightFrames: candidate.inflightFrames,
		cpuThreads: candidate.cpuThreads,
		decoderThreads: candidate.decoderThreads,
		cpuChargePerComparison: cpuCharge(
			candidate.cpuThreads,
			candidate.decoderThreads,
		),
		hostBytesPerComparison: hostCharge(
			candidate.hostBytesPerComparison,
			candidate.gpuBytesPerComparison,
			r.integrated,
		),
		gpuBytesPerComparison: candidate.gpuBytesPerComparison,
		gpuShareCredits: AUTO_GPU_SHARE_CAPACITY / candidate.concurrency,
		source: "calibrated",
	});
	const fitsCapacity = (plan: AutoExecutionPlan) => {
		const count = plan.maxActiveComparisons;
		const host = count * plan.hostBytesPerComparison;
		const gpu = count * plan.gpuBytesPerComparison;
		return (
			positiveBytes(host) &&
			positiveBytes(gpu) &&
			count * plan.cpuChargePerComparison <= r.cpuCapacity &&
			host <= r.hostBudgetBytes &&
			(gpuBudget === undefined || gpu <= gpuBudget)
		);
	};
	// Active children already consume the live free-memory readings. Check a
	// new comparison here, not the entire pool again; admission reserves each.
	const fitsHeadroom = (plan: AutoExecutionPlan) =>
		plan.hostBytesPerComparison <= hostAvailable &&
		(gpuAvailable === undefined || plan.gpuBytesPerComparison <= gpuAvailable);
	const pressure = (plan: AutoExecutionPlan): AutoExecutionReason[] => [
		...(plan.hostBytesPerComparison > hostAvailable
			? (["host-memory-pressure"] as const)
			: []),
		...(gpuAvailable !== undefined && plan.gpuBytesPerComparison > gpuAvailable
			? (["gpu-memory-pressure"] as const)
			: []),
	];
	let compatible: AutoExecutionCandidate[] =
		typeof request.expectedProfileKey === "string" &&
		request.expectedProfileKey.length > 0 &&
		Array.isArray(request.candidates)
			? request.candidates.filter(
					(candidate) =>
						validCandidate(candidate, request.expectedProfileKey) &&
						(request.fixedCpuThreads === undefined ||
							candidate.cpuThreads === request.fixedCpuThreads),
				)
			: [];
	if (new Set(compatible.map((c) => c.trials[0]?.workFrames)).size > 1) {
		reasons.push("incomparable-profile-work");
		compatible = [];
	}
	// A completed concurrent trial proves correctness, not an improvement over
	// serial work. Partial calibration must not promote parallelism by itself.
	if (compatible.length && !compatible.some((c) => c.concurrency === 1)) {
		reasons.push("missing-serial-control");
		compatible = [];
	}
	const scored = gpuKnown
		? compatible
				.map((candidate) => ({
					plan: planFor(candidate),
					throughput:
						(candidate.trials[0]?.workFrames ?? 0) /
						median(candidate.trials.map((trial) => trial.wallMs)),
				}))
				.filter(({ plan }) => fitsCapacity(plan))
		: [];
	if (scored.length < compatible.length)
		reasons.push("profile-resource-limited");
	const choose = (entries: typeof scored) => {
		const fastest = Math.max(...entries.map((entry) => entry.throughput));
		const cost = (plan: AutoExecutionPlan) =>
			plan.maxActiveComparisons *
			(plan.cpuChargePerComparison / r.cpuCapacity +
				plan.hostBytesPerComparison / r.hostBudgetBytes +
				plan.gpuBytesPerComparison / (gpuBudget as number));
		return entries
			.filter((entry) => entry.throughput >= fastest * 0.95)
			.sort(
				(a, b) =>
					cost(a.plan) - cost(b.plan) ||
					a.plan.maxActiveComparisons - b.plan.maxActiveComparisons ||
					a.plan.inflightFrames - b.plan.inflightFrames ||
					a.plan.cpuThreads - b.plan.cpuThreads ||
					a.plan.decoderThreads - b.plan.decoderThreads ||
					a.plan.hostBytesPerComparison - b.plan.hostBytesPerComparison ||
					a.plan.gpuBytesPerComparison - b.plan.gpuBytesPerComparison,
			)[0]?.plan as AutoExecutionPlan;
	};
	const ready = scored.filter(({ plan }) => fitsHeadroom(plan));
	if (ready.length)
		return {
			status: "ready",
			plan: choose(ready),
			reasons: ["calibrated-resource-knee", ...reasons],
		};

	// A cold estimate cannot overrule a completed measurement of these exact
	// serial settings, even when that measurement was filtered by capacity.
	const measuredSerial = compatible.filter(
		(candidate) =>
			candidate.concurrency === 1 &&
			candidate.inflightFrames === 1 &&
			candidate.cpuThreads === fallbackThreads &&
			candidate.decoderThreads === 1,
	);
	const fallbackHost = Math.max(
		baseline.hostBytes,
		...measuredSerial.map((candidate) => candidate.hostBytesPerComparison),
	);
	const fallbackGpu = Math.max(
		baseline.gpuBytes,
		...measuredSerial.map((candidate) => candidate.gpuBytesPerComparison),
	);
	const fallback: AutoExecutionPlan = {
		maxActiveComparisons: 1,
		inflightFrames: 1,
		cpuThreads: fallbackThreads,
		decoderThreads: 1,
		cpuChargePerComparison: Math.min(
			r.cpuCapacity,
			cpuCharge(fallbackThreads, 1),
		),
		hostBytesPerComparison: hostCharge(fallbackHost, fallbackGpu, r.integrated),
		gpuBytesPerComparison: fallbackGpu,
		gpuShareCredits: AUTO_GPU_SHARE_CAPACITY,
		source: "conservative",
	};
	if (r.cpuCapacity < cpuCharge(fallbackThreads, 1))
		reasons.push("cpu-capacity-low");
	if (fitsCapacity(fallback) && fitsHeadroom(fallback))
		return {
			status: "ready",
			plan: fallback,
			reasons: ["no-compatible-profile", ...reasons],
		};
	if (scored.length) {
		const plan = choose(scored);
		return { status: "wait", plan, reasons: [...reasons, ...pressure(plan)] };
	}
	if (fallback.hostBytesPerComparison > r.hostBudgetBytes)
		reasons.push("host-capacity-insufficient");
	if (gpuBudget !== undefined && fallback.gpuBytesPerComparison > gpuBudget)
		reasons.push("gpu-capacity-insufficient");
	return {
		status: fitsCapacity(fallback) ? "wait" : "unavailable",
		plan: fallback,
		reasons: [...reasons, ...pressure(fallback)],
	};
}
