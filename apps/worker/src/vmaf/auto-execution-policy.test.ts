import { describe, expect, it } from "vitest";
import {
	AUTO_GPU_SHARE_CAPACITY,
	type AutoExecutionCandidate,
	type AutoExecutionRequest,
	selectAutoExecutionPlan,
} from "./auto-execution-policy";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const key = "native-device-driver-model-geometry-codecs-cpu-parity";

function candidate(
	concurrency: number,
	wallMs: number,
	changes: Partial<AutoExecutionCandidate> = {},
): AutoExecutionCandidate {
	return {
		profileKey: key,
		scope: "native-with-cpu-parity",
		concurrency,
		inflightFrames: 1,
		cpuThreads: 1,
		decoderThreads: 1,
		hostBytesPerComparison: 512 * MiB,
		gpuBytesPerComparison: 256 * MiB,
		trials: [-10, 0, 10].map((offset) => ({
			workFrames: 480,
			wallMs: wallMs + offset,
			cpuVerified: true,
		})),
		...changes,
	};
}

function request(
	changes: Partial<AutoExecutionRequest> = {},
): AutoExecutionRequest {
	return {
		expectedProfileKey: key,
		resources: {
			cpuCapacity: 64,
			hostBudgetBytes: 32 * GiB,
			hostAvailableBytes: 32 * GiB,
			gpuTotalBytes: 8 * GiB,
			gpuBudgetBytes: 6 * GiB,
			gpuAvailableBytes: 6 * GiB,
			integrated: false,
		},
		baseline: { hostBytes: 512 * MiB, gpuBytes: 256 * MiB },
		candidates: [candidate(1, 4800), candidate(2, 2600), candidate(4, 2500)],
		...changes,
	};
}

describe("automatic native VMAF execution planning", () => {
	it.each([
		"host",
		"gpu",
	] as const)("does not discard a measured serial %s footprint when the cold estimate is smaller", (kind) => {
		const input = request({
			candidates: [
				candidate(1, 1000, {
					...(kind === "host"
						? { hostBytesPerComparison: 2 * GiB }
						: { gpuBytesPerComparison: 7 * GiB }),
				}),
			],
		});
		if (kind === "host")
			Object.assign(input.resources, {
				hostBudgetBytes: GiB,
				hostAvailableBytes: GiB,
			});
		const result = selectAutoExecutionPlan(input);
		expect(result.status).toBe("unavailable");
		expect(
			kind === "host"
				? result.plan?.hostBytesPerComparison
				: result.plan?.gpuBytesPerComparison,
		).toBe(kind === "host" ? 2 * GiB : 7 * GiB);
	});
	it("waits when a measured serial footprint exceeds current free memory", () => {
		const input = request({
			candidates: [candidate(1, 1000, { hostBytesPerComparison: 2 * GiB })],
		});
		input.resources.hostAvailableBytes = GiB;
		expect(selectAutoExecutionPlan(input)).toMatchObject({
			status: "wait",
			plan: { hostBytesPerComparison: 2 * GiB },
		});
	});
	it("chooses the resource knee instead of multiplying each parent's parallelism", () => {
		const result = selectAutoExecutionPlan(request());
		expect(result).toMatchObject({
			status: "ready",
			plan: {
				maxActiveComparisons: 2,
				inflightFrames: 1,
				cpuThreads: 1,
				decoderThreads: 1,
				cpuChargePerComparison: 4,
				source: "calibrated",
				gpuShareCredits: AUTO_GPU_SHARE_CAPACITY / 2,
			},
		});
		expect(result.reasons).toContain("calibrated-resource-knee");
		// There is deliberately no per-parent rendition count in this request.
		expect(result.plan?.maxActiveComparisons).toBe(2);
	});

	it("increases parallelism only when the extra throughput is material", () => {
		const input = request();
		input.candidates = [...input.candidates, candidate(8, 2000)];
		expect(selectAutoExecutionPlan(input).plan?.maxActiveComparisons).toBe(8);
	});

	it("uses fewer resources at the five-percent throughput boundary", () => {
		const input = request({
			candidates: [candidate(1, 2000), candidate(2, 1900)],
		});
		expect(selectAutoExecutionPlan(input).plan?.maxActiveComparisons).toBe(1);
		input.candidates = [candidate(1, 2001), candidate(2, 1900)];
		expect(selectAutoExecutionPlan(input).plan?.maxActiveComparisons).toBe(2);
	});

	it("uses exact integer GPU shares for every supported concurrency", () => {
		for (let count = 1; count <= 32; count++) {
			const result = selectAutoExecutionPlan(
				request({
					resources: {
						...request().resources,
						cpuCapacity: 128,
						gpuTotalBytes: 16 * GiB,
						gpuBudgetBytes: 16 * GiB,
						gpuAvailableBytes: 16 * GiB,
					},
					candidates:
						count === 1
							? [candidate(1, 1000)]
							: [candidate(1, 4800), candidate(count, 1000)],
				}),
			);
			expect(result.status).toBe("ready");
			expect(Number.isSafeInteger(AUTO_GPU_SHARE_CAPACITY / count)).toBe(true);
			expect((result.plan?.gpuShareCredits ?? 0) * count).toBe(
				AUTO_GPU_SHARE_CAPACITY,
			);
		}
	});

	it("counts both input decoders as well as CPU verification", () => {
		const input = request();
		input.resources.cpuCapacity = 7;
		const result = selectAutoExecutionPlan(input);
		expect(result.plan).toMatchObject({
			maxActiveComparisons: 1,
			cpuChargePerComparison: 4,
		});
		expect(result.reasons).toContain("profile-resource-limited");
	});

	it("keeps a fractional CPU quota exclusive without inventing extra cores", () => {
		const input = request();
		input.resources.cpuCapacity = 0.5;
		expect(selectAutoExecutionPlan(input)).toMatchObject({
			status: "ready",
			plan: {
				maxActiveComparisons: 1,
				cpuThreads: 1,
				decoderThreads: 1,
				cpuChargePerComparison: 0.5,
				source: "conservative",
			},
		});
	});

	it("does not reuse a depth or thread setting that exceeds the new capacity", () => {
		const input = request({
			candidates: [
				candidate(1, 4500),
				candidate(2, 2000, {
					inflightFrames: 4,
					gpuBytesPerComparison: 4 * GiB,
				}),
			],
		});
		expect(selectAutoExecutionPlan(input).plan).toMatchObject({
			maxActiveComparisons: 1,
			inflightFrames: 1,
		});
		input.resources.gpuBudgetBytes = 8 * GiB;
		input.resources.gpuAvailableBytes = 8 * GiB;
		expect(selectAutoExecutionPlan(input).plan).toMatchObject({
			maxActiveComparisons: 2,
			inflightFrames: 4,
		});
	});

	it("reserves shared GPU memory against the host budget too", () => {
		const input = request({
			candidates: [candidate(1, 4800), candidate(4, 1000)],
		});
		input.resources.hostBudgetBytes = 2 * GiB;
		expect(selectAutoExecutionPlan(input).plan?.maxActiveComparisons).toBe(4);
		input.resources.integrated = true;
		expect(selectAutoExecutionPlan(input).plan).toMatchObject({
			maxActiveComparisons: 1,
			hostBytesPerComparison: 768 * MiB,
		});
	});

	it("waits for temporary host pressure instead of declaring the job impossible", () => {
		const input = request();
		input.resources.hostAvailableBytes = 128 * MiB;
		expect(selectAutoExecutionPlan(input)).toMatchObject({
			status: "wait",
			reasons: expect.arrayContaining(["host-memory-pressure"]),
		});
		input.resources.hostBudgetBytes = 128 * MiB;
		expect(selectAutoExecutionPlan(input)).toMatchObject({
			status: "unavailable",
			reasons: expect.arrayContaining(["host-capacity-insufficient"]),
		});
	});

	it("distinguishes exhausted GPU headroom from insufficient device capacity", () => {
		const input = request();
		input.resources.gpuAvailableBytes = 0;
		expect(selectAutoExecutionPlan(input)).toMatchObject({
			status: "wait",
			reasons: expect.arrayContaining(["gpu-memory-pressure"]),
		});
		input.resources.gpuBudgetBytes = 128 * MiB;
		expect(selectAutoExecutionPlan(input)).toMatchObject({
			status: "unavailable",
			reasons: expect.arrayContaining(["gpu-capacity-insufficient"]),
		});
	});

	it("uses a lower-memory measured plan while a larger plan cannot start", () => {
		const input = request({
			candidates: [
				candidate(1, 1000, { gpuBytesPerComparison: 2 * GiB }),
				candidate(2, 2000),
			],
		});
		input.resources.gpuAvailableBytes = 512 * MiB;
		expect(selectAutoExecutionPlan(input).plan).toMatchObject({
			maxActiveComparisons: 2,
			gpuBytesPerComparison: 256 * MiB,
		});
	});

	it.each([
		undefined,
		null,
	])("uses one exclusive comparison when GPU memory is unknown (%s)", (value) => {
		const input: AutoExecutionRequest = request();
		input.resources.gpuAvailableBytes = value;
		expect(selectAutoExecutionPlan(input)).toMatchObject({
			status: "ready",
			plan: {
				maxActiveComparisons: 1,
				inflightFrames: 1,
				source: "conservative",
				gpuShareCredits: AUTO_GPU_SHARE_CAPACITY,
			},
			reasons: expect.arrayContaining(["gpu-memory-unknown"]),
		});
	});

	it.each([
		{ cpuCapacity: 0 },
		{ cpuCapacity: Number.NaN },
		{ hostBudgetBytes: Number.POSITIVE_INFINITY },
		{ hostAvailableBytes: -1 },
		{ gpuAvailableBytes: Number.NaN },
		{ gpuBudgetBytes: 9 * GiB },
	])("does not launch from invalid resource data %j", (changes) => {
		const input = request();
		Object.assign(input.resources, changes);
		expect(selectAutoExecutionPlan(input).status).toBe("unavailable");
	});

	it.each([
		{ profileKey: "different-native-model-or-device" },
		{ scope: "engine-only" },
		{ concurrency: 0 },
		{ concurrency: 33 },
		{ inflightFrames: 3 },
		{ cpuThreads: 8 },
		{ decoderThreads: 0 },
		{ gpuBytesPerComparison: Number.NaN },
		{ hostBytesPerComparison: 0 },
		{ trials: [{ workFrames: 480, wallMs: 1000, cpuVerified: true }] },
		{
			trials: [1, 2, 3].map(() => ({
				workFrames: 480,
				wallMs: 1000,
				cpuVerified: false,
			})),
		},
		{
			trials: [1, 2, 3].map(() => ({ workFrames: 480, wallMs: 1000 })),
		},
		{
			trials: [1, 2, 3].map(() => ({
				workFrames: 480,
				wallMs: 1000,
				cpuVerified: true,
				warmup: true,
			})),
		},
	])("does not promote incompatible calibration %j", (changes) => {
		const input = request({
			candidates: [
				candidate(1, 4800),
				{ ...candidate(2, 1000), ...changes } as AutoExecutionCandidate,
			],
		});
		expect(selectAutoExecutionPlan(input)).toMatchObject({
			status: "ready",
			plan: {
				maxActiveComparisons: 1,
			},
		});
	});

	it("does not infer a parallel speedup from an incomplete calibration", () => {
		const input = request({ candidates: [candidate(2, 1000)] });
		expect(selectAutoExecutionPlan(input)).toMatchObject({
			status: "ready",
			plan: { maxActiveComparisons: 1, source: "conservative" },
			reasons: expect.arrayContaining(["missing-serial-control"]),
		});
	});

	it("never ranks candidates measured on different work amounts", () => {
		const input = request({
			candidates: [
				candidate(1, 1000),
				candidate(2, 500, {
					trials: [1, 2, 3].map(() => ({
						workFrames: 960,
						wallMs: 500,
						cpuVerified: true,
					})),
				}),
			],
		});
		expect(selectAutoExecutionPlan(input).plan?.source).toBe("conservative");
		input.candidates = [...input.candidates].reverse();
		expect(selectAutoExecutionPlan(input).plan?.source).toBe("conservative");
	});

	it("breaks otherwise equal resource ties deterministically", () => {
		const small = candidate(2, 1000, { inflightFrames: 2 });
		const large = candidate(2, 1000, { inflightFrames: 4 });
		for (const candidates of [
			[candidate(1, 4800), large, small],
			[candidate(1, 4800), small, large],
		])
			expect(
				selectAutoExecutionPlan(request({ candidates })).plan?.inflightFrames,
			).toBe(2);
	});

	it("rejects invalid baseline footprints rather than guessing memory", () => {
		for (const baseline of [
			{ hostBytes: 0, gpuBytes: 256 * MiB },
			{ hostBytes: 512 * MiB, gpuBytes: Number.NaN },
		])
			expect(selectAutoExecutionPlan(request({ baseline })).status).toBe(
				"unavailable",
			);
	});

	it("keeps every ready plan inside its resource dimensions across constrained hosts", () => {
		let checked = 0;
		for (const cpuCapacity of [0.5, 2, 4, 8, 20])
			for (const hostBudgetBytes of [256 * MiB, 512 * MiB, 2 * GiB, 8 * GiB])
				for (const gpuBudgetBytes of [128 * MiB, 256 * MiB, GiB, 8 * GiB])
					for (const integrated of [false, true]) {
						const result = selectAutoExecutionPlan(
							request({
								resources: {
									cpuCapacity,
									hostBudgetBytes,
									gpuTotalBytes: 8 * GiB,
									gpuBudgetBytes,
									gpuAvailableBytes: gpuBudgetBytes,
									integrated,
								},
							}),
						);
						checked++;
						if (result.status !== "ready") continue;
						const plan = result.plan;
						expect(plan).toBeDefined();
						if (!plan) throw new Error("Ready decision has no execution plan");
						expect(
							plan.maxActiveComparisons * plan.cpuChargePerComparison,
						).toBeLessThanOrEqual(cpuCapacity);
						expect(
							plan.maxActiveComparisons * plan.hostBytesPerComparison,
						).toBeLessThanOrEqual(hostBudgetBytes);
						expect(
							plan.maxActiveComparisons * plan.gpuBytesPerComparison,
						).toBeLessThanOrEqual(gpuBudgetBytes);
						expect(plan.maxActiveComparisons * plan.gpuShareCredits).toBe(
							AUTO_GPU_SHARE_CAPACITY,
						);
					}
		expect(checked).toBe(160);
	});

	it("does not reorder or mutate cached measurements", () => {
		const input = request();
		const original = structuredClone(input);
		for (const profile of input.candidates) {
			for (const trial of profile.trials) Object.freeze(trial);
			Object.freeze(profile.trials);
			Object.freeze(profile);
		}
		Object.freeze(input.candidates);
		Object.freeze(input.resources);
		Object.freeze(input.baseline);
		Object.freeze(input);
		expect(selectAutoExecutionPlan(input).status).toBe("ready");
		expect(input).toEqual(original);
	});
});
