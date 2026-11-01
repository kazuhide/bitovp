import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
	AutoExecutionCandidate,
	AutoExecutionWorkloadMode,
} from "./auto-execution-policy";

const CACHE_BYTES = 256 * 1024;
const MAX_CANDIDATES = 32;
const SHA256 = /^[a-f0-9]{64}$/;
export type NativeCalibrationTemplate = Pick<
	AutoExecutionCandidate,
	"concurrency" | "cpuThreads" | "decoderThreads" | "inflightFrames"
>;
export type NativeCalibrationTrial = {
	scope: "native-with-cpu-parity";
	cpuVerified: true;
	workFrames: number;
	wallMs: number;
	maxRssBytesPerComparison: number;
	gpuOwnedBytesPerComparison: number;
	resourceSnapshotScope: "before-result-serialization";
	warmup?: false;
};
export type NativeCalibrationProfile = {
	version: 2;
	profileKey: string;
	workloadMode: AutoExecutionWorkloadMode;
	sampleFrames: number;
	fixedWorkUnits: number;
	candidatesRaw: readonly (NativeCalibrationTemplate & {
		trials: readonly NativeCalibrationTrial[];
	})[];
};
export type NativeCalibrationContext = {
	signal: AbortSignal;
	workloadMode?: AutoExecutionWorkloadMode;
	sampleFrames: number;
	fixedWorkUnits: number;
	budgetMs: number;
	trialTimeoutMs?: number;
	cacheable?: boolean;
};
type TrialContext = Pick<
	NativeCalibrationContext,
	"signal" | "sampleFrames" | "fixedWorkUnits" | "workloadMode"
>;
type Diagnostic =
	| "cache-invalid"
	| "cache-unavailable"
	| "cache-write-unavailable"
	| "budget-exhausted"
	| "trial-timeout"
	| "candidate-limit";
type Dependencies = {
	cacheDirectory: string;
	runTrial(
		template: NativeCalibrationTemplate,
		context: TrialContext,
	): Promise<NativeCalibrationTrial>;
	withExclusiveCalibration<T>(
		work: (leaseSignal: AbortSignal) => Promise<T>,
		signal: AbortSignal,
	): Promise<T>;
	now?: () => number;
	onDiagnostic?: (reason: Diagnostic) => void;
};

const integer = (
	n: unknown,
	min: number,
	max = Number.MAX_SAFE_INTEGER,
): n is number =>
	typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max;
const record = (
	v: unknown,
	keys: readonly string[],
): v is Record<string, unknown> =>
	v !== null &&
	typeof v === "object" &&
	!Array.isArray(v) &&
	Object.keys(v).every((key) => keys.includes(key));
const templateKeys = [
	"concurrency",
	"cpuThreads",
	"decoderThreads",
	"inflightFrames",
];
function templateId(t: NativeCalibrationTemplate) {
	return [t.concurrency, t.cpuThreads, t.decoderThreads, t.inflightFrames].join(
		":",
	);
}
function validTemplate(
	v: unknown,
	allowTrials = false,
): v is NativeCalibrationTemplate & Record<string, unknown> {
	return (
		record(v, allowTrials ? [...templateKeys, "trials"] : templateKeys) &&
		integer(v.concurrency, 1, 32) &&
		[1, 2, 4].includes(Number(v.cpuThreads)) &&
		typeof v.cpuThreads === "number" &&
		[1, 2].includes(Number(v.decoderThreads)) &&
		typeof v.decoderThreads === "number" &&
		[1, 2, 4].includes(Number(v.inflightFrames)) &&
		typeof v.inflightFrames === "number"
	);
}
function validTrial(v: unknown, frames: number): v is NativeCalibrationTrial {
	return (
		record(v, [
			"scope",
			"cpuVerified",
			"workFrames",
			"wallMs",
			"maxRssBytesPerComparison",
			"gpuOwnedBytesPerComparison",
			"resourceSnapshotScope",
			"warmup",
		]) &&
		v.scope === "native-with-cpu-parity" &&
		v.cpuVerified === true &&
		v.workFrames === frames &&
		typeof v.wallMs === "number" &&
		Number.isFinite(v.wallMs) &&
		v.wallMs > 0 &&
		v.wallMs <= Number.MAX_SAFE_INTEGER &&
		integer(v.maxRssBytesPerComparison, 1) &&
		integer(v.gpuOwnedBytesPerComparison, 0) &&
		v.resourceSnapshotScope === "before-result-serialization" &&
		(v.warmup === undefined || v.warmup === false)
	);
}
function validProfile(
	v: unknown,
	key: string,
	frames: number,
	units: number,
	mode: AutoExecutionWorkloadMode,
	partial = false,
): v is NativeCalibrationProfile {
	if (
		!record(v, [
			"version",
			"profileKey",
			"workloadMode",
			"sampleFrames",
			"fixedWorkUnits",
			"candidatesRaw",
		]) ||
		v.version !== 2 ||
		v.profileKey !== key ||
		v.workloadMode !== mode ||
		!["fixed-batch", "parallel-batch"].includes(mode) ||
		!SHA256.test(key) ||
		!integer(frames, 1, 256) ||
		!integer(units, 1, 32) ||
		(mode === "parallel-batch" && units !== 1) ||
		v.sampleFrames !== frames ||
		v.fixedWorkUnits !== units ||
		!Array.isArray(v.candidatesRaw) ||
		v.candidatesRaw.length > MAX_CANDIDATES
	)
		return false;
	const seen = new Set<string>();
	return v.candidatesRaw.every((candidate) => {
		if (
			!validTemplate(candidate, true) ||
			(mode === "fixed-batch" && candidate.concurrency > units) ||
			seen.has(templateId(candidate)) ||
			!record(candidate, [...templateKeys, "trials"]) ||
			!Array.isArray(candidate.trials) ||
			!integer(candidate.trials.length, partial ? 1 : 3, 3) ||
			!candidate.trials.every((t: unknown) =>
				validTrial(
					t,
					frames * (mode === "parallel-batch" ? candidate.concurrency : units),
				),
			)
		)
			return false;
		seen.add(templateId(candidate));
		return true;
	});
}
function frozen(profile: NativeCalibrationProfile): NativeCalibrationProfile {
	for (const candidate of profile.candidatesRaw) {
		for (const trial of candidate.trials) Object.freeze(trial);
		Object.freeze(candidate.trials);
		Object.freeze(candidate);
	}
	Object.freeze(profile.candidatesRaw);
	return Object.freeze(profile);
}

function cancellable<T>(
	pending: Promise<T>,
	signal: AbortSignal,
	complete: () => void = () => {},
) {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (work: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", cancel);
			complete();
			work();
		};
		const cancel = () => finish(() => reject(signal.reason));
		signal.addEventListener("abort", cancel, { once: true });
		pending.then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error)),
		);
		if (signal.aborted) cancel();
	});
}

/** The adapter owns process cleanup; a lease is held until runTrial settles. */
export function createNativeAutoCalibration(deps: Dependencies) {
	if (!isAbsolute(deps.cacheDirectory))
		throw new Error("NATIVE_CALIBRATION_CACHE_PATH_INVALID");
	const flights = new Map<
		string,
		{
			controller: AbortController;
			waiters: number;
			done: boolean;
			promise: Promise<NativeCalibrationProfile>;
		}
	>();
	const clock = deps.now ?? (() => performance.now());
	const diagnostic = (reason: Diagnostic) => deps.onDiagnostic?.(reason);
	const pathFor = (key: string, c: NativeCalibrationContext) =>
		join(
			deps.cacheDirectory,
			`${key}-${c.workloadMode ?? "fixed-batch"}-${c.sampleFrames}-${c.fixedWorkUnits}.json`,
		);
	async function privateDirectory(readOnly = false) {
		if (!readOnly)
			await mkdir(deps.cacheDirectory, { recursive: true, mode: 0o700 });
		const s = await lstat(deps.cacheDirectory);
		if (
			!s.isDirectory() ||
			(process.getuid && s.uid !== process.getuid()) ||
			(readOnly && (s.mode & 0o077) !== 0)
		)
			throw new Error("Cache directory is not privately owned");
		if (!readOnly) await chmod(deps.cacheDirectory, 0o700);
	}
	async function readCache(key: string, c: NativeCalibrationContext) {
		if (!c.cacheable) return undefined;
		let file: Awaited<ReturnType<typeof open>> | undefined;
		try {
			await privateDirectory(c.budgetMs === 0);
			c.signal.throwIfAborted();
			file = await open(
				pathFor(key, c),
				constants.O_RDONLY | constants.O_NOFOLLOW,
			);
			const s = await file.stat();
			if (
				!s.isFile() ||
				s.size > CACHE_BYTES ||
				(s.mode & 0o077) !== 0 ||
				(process.getuid && s.uid !== process.getuid())
			)
				throw new Error("Invalid private cache file");
			const bytes = Buffer.alloc(CACHE_BYTES + 1);
			let length = 0;
			while (length < bytes.length) {
				const read = await file.read(
					bytes,
					length,
					bytes.length - length,
					length,
				);
				if (!read.bytesRead) break;
				length += read.bytesRead;
			}
			if (length > CACHE_BYTES)
				throw new Error("Cache metadata limit exceeded");
			const value: unknown = JSON.parse(bytes.toString("utf8", 0, length));
			if (
				!validProfile(
					value,
					key,
					c.sampleFrames,
					c.fixedWorkUnits,
					c.workloadMode ?? "fixed-batch",
				)
			)
				throw new Error("Invalid calibration cache");
			c.signal.throwIfAborted();
			return value;
		} catch (error) {
			c.signal.throwIfAborted();
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				diagnostic("cache-invalid");
			return undefined;
		} finally {
			await file?.close();
		}
	}
	async function writeCache(
		profile: NativeCalibrationProfile,
		c: NativeCalibrationContext,
	) {
		if (!c.cacheable) return;
		const complete = {
			...profile,
			candidatesRaw: profile.candidatesRaw.filter(
				(candidate) => candidate.trials.length === 3,
			),
		};
		if (!complete.candidatesRaw.length) return;
		const temporary = join(
			deps.cacheDirectory,
			`${profile.profileKey}-${randomUUID()}.tmp`,
		);
		let file: Awaited<ReturnType<typeof open>> | undefined;
		let created = false;
		try {
			c.signal.throwIfAborted();
			await privateDirectory();
			const bytes = JSON.stringify(complete);
			if (Buffer.byteLength(bytes) > CACHE_BYTES)
				throw new Error("Cache metadata limit exceeded");
			file = await open(
				temporary,
				constants.O_WRONLY |
					constants.O_CREAT |
					constants.O_EXCL |
					constants.O_NOFOLLOW,
				0o600,
			);
			created = true;
			await file.writeFile(bytes);
			await file.sync();
			await file.close();
			file = undefined;
			c.signal.throwIfAborted();
			await rename(temporary, pathFor(profile.profileKey, c));
		} catch {
			c.signal.throwIfAborted();
			diagnostic("cache-write-unavailable");
		} finally {
			await file?.close();
			if (created) await rm(temporary, { force: true });
		}
	}
	async function measure(
		template: NativeCalibrationTemplate,
		c: NativeCalibrationContext,
	) {
		const timeout = new AbortController();
		const timer = setTimeout(
			() =>
				timeout.abort(
					new DOMException("Calibration trial timed out", "TimeoutError"),
				),
			c.trialTimeoutMs ?? 5000,
		);
		const signal = AbortSignal.any([c.signal, timeout.signal]);
		try {
			const observed = await deps.runTrial(template, {
				signal,
				workloadMode: c.workloadMode,
				sampleFrames: c.sampleFrames,
				fixedWorkUnits: c.fixedWorkUnits,
			});
			c.signal.throwIfAborted();
			if (
				!validTrial(
					observed,
					c.sampleFrames *
						(c.workloadMode === "parallel-batch"
							? template.concurrency
							: c.fixedWorkUnits),
				)
			)
				throw new Error("NATIVE_CALIBRATION_TRIAL_INVALID");
			if (timeout.signal.aborted) {
				diagnostic("trial-timeout");
				return undefined;
			}
			return { ...observed };
		} catch (error) {
			c.signal.throwIfAborted();
			if (
				timeout.signal.aborted &&
				(error === timeout.signal.reason ||
					(error instanceof Error &&
						["AbortError", "TimeoutError"].includes(error.name)))
			) {
				diagnostic("trial-timeout");
				return undefined;
			}
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}
	const covers = (
		profile: NativeCalibrationProfile,
		templates: NativeCalibrationTemplate[],
	) =>
		templates.every((t) =>
			profile.candidatesRaw.some(
				(candidate) =>
					templateId(candidate) === templateId(t) &&
					candidate.trials.length === 3,
			),
		);
	/** Screen a bounded one-wave shortlist, then confirm before exploring more.
	 * Raw timings remain end-to-end samples, never full-video forecasts. */
	async function parallelSearch(
		templates: NativeCalibrationTemplate[],
		c: NativeCalibrationContext,
		candidates: (NativeCalibrationTemplate & {
			trials: NativeCalibrationTrial[];
		})[],
		deadline: number,
	) {
		const serial = templates
			.filter((t) => t.concurrency === 1)
			.sort(
				(a, b) =>
					a.decoderThreads - 1 - (b.decoderThreads - 1) ||
					[2, 1, 4].indexOf(a.cpuThreads) - [2, 1, 4].indexOf(b.cpuThreads) ||
					b.inflightFrames - a.inflightFrames,
			);
		const control = serial[0];
		if (!control) return;
		const shortlist = [
			control,
			...templates
				.filter((t) => templateId(t) !== templateId(control))
				.slice(0, 7),
		];
		const row = (t: NativeCalibrationTemplate) =>
			candidates.find((candidate) => templateId(candidate) === templateId(t));
		const typical = (t: NativeCalibrationTemplate) => {
			const walls = (row(t)?.trials.map((trial) => trial.wallMs) ?? []).sort(
				(a, b) => a - b,
			);
			return walls[Math.floor(walls.length / 2)] ?? 0;
		};
		const rate = (t: NativeCalibrationTemplate) =>
			(c.sampleFrames * t.concurrency) / typical(t);
		// Only new trial starts are bounded. After one screening trial, reserve
		// one trial plus 10%/10ms headroom so both confirmations can start; the
		// third may finish after the deadline. These are scheduling estimates.
		const confirmationReserve = (t: NativeCalibrationTemplate) =>
			Math.max(0, 2 - (row(t)?.trials.length ?? 0)) * typical(t) * 1.1 + 10;
		const collect = async (t: NativeCalibrationTemplate) => {
			c.signal.throwIfAborted();
			if (clock() >= deadline) {
				diagnostic("budget-exhausted");
				return false;
			}
			let target = row(t);
			if (!target && candidates.length >= MAX_CANDIDATES) {
				diagnostic("candidate-limit");
				return false;
			}
			const observed = await measure(t, c);
			if (!observed) return false;
			if (!target) {
				target = { ...t, trials: [] };
				candidates.push(target);
			}
			target.trials.push(observed);
			return true;
		};
		const complete = async (t: NativeCalibrationTemplate) => {
			while ((row(t)?.trials.length ?? 0) < 3)
				if (!(await collect(t))) return false;
			return true;
		};
		if (!(await complete(control))) return;
		const strongestParallel = () =>
			shortlist
				.filter((t) => t.concurrency > 1 && (row(t)?.trials.length ?? 0) > 0)
				.sort(
					(a, b) =>
						rate(b) - rate(a) || shortlist.indexOf(a) - shortlist.indexOf(b),
				)[0];
		for (const t of shortlist.slice(1)) {
			if ((row(t)?.trials.length ?? 0) > 0) continue;
			const finalist = strongestParallel();
			if (finalist && (row(finalist)?.trials.length ?? 0) < 3) {
				const nextEstimate = Math.max(...shortlist.map(typical)) * 1.25;
				if (deadline - clock() <= confirmationReserve(finalist) + nextEstimate)
					break;
			}
			if (!(await collect(t))) return;
		}
		const finalist = strongestParallel();
		if (finalist && !(await complete(finalist))) return;
		const ranked = shortlist
			.filter(
				(t) =>
					(row(t)?.trials.length ?? 0) > 0 && (row(t)?.trials.length ?? 0) < 3,
			)
			.sort(
				(a, b) =>
					rate(b) - rate(a) || shortlist.indexOf(a) - shortlist.indexOf(b),
			);
		// Confirm the strongest alternative serial shape before another parallel
		// finalist, so higher compute-thread counts can earn complete evidence.
		const bestSerial = ranked.find((t) => t.concurrency === 1);
		const remaining = bestSerial
			? [bestSerial, ...ranked.filter((t) => t !== bestSerial)]
			: ranked;
		for (const t of remaining) {
			if (deadline - clock() <= confirmationReserve(t)) break;
			if (!(await complete(t))) return;
		}
	}
	async function calibrate(
		key: string,
		templates: NativeCalibrationTemplate[],
		context: NativeCalibrationContext,
	) {
		const cached = await readCache(key, context);
		context.signal.throwIfAborted();
		// Atomic metadata reads neither consume hardware nor fill missing trials.
		if (context.budgetMs === 0)
			return frozen(
				cached ?? {
					version: 2,
					profileKey: key,
					workloadMode: context.workloadMode ?? "fixed-batch",
					sampleFrames: context.sampleFrames,
					fixedWorkUnits: context.fixedWorkUnits,
					candidatesRaw: [],
				},
			);
		if (cached && covers(cached, templates)) return frozen(cached);
		return deps.withExclusiveCalibration(async (leaseSignal) => {
			const c = {
				...context,
				signal: AbortSignal.any([context.signal, leaseSignal]),
			};
			c.signal.throwIfAborted();
			const profile: NativeCalibrationProfile = (await readCache(key, c)) ?? {
				version: 2,
				profileKey: key,
				workloadMode: c.workloadMode ?? "fixed-batch",
				sampleFrames: c.sampleFrames,
				fixedWorkUnits: c.fixedWorkUnits,
				candidatesRaw: [],
			};
			const candidates = profile.candidatesRaw.map((candidate) => ({
				...candidate,
				trials: [...candidate.trials],
			}));
			const deadline = clock() + c.budgetMs;
			if (c.workloadMode === "parallel-batch")
				await parallelSearch(templates, c, candidates, deadline);
			else {
				outer: for (const template of templates) {
					if (
						candidates.some(
							(candidate) => templateId(candidate) === templateId(template),
						)
					)
						continue;
					if (candidates.length >= MAX_CANDIDATES) {
						diagnostic("candidate-limit");
						break;
					}
					const trials: NativeCalibrationTrial[] = [];
					for (let repeat = 0; repeat < 3; repeat++) {
						c.signal.throwIfAborted();
						if (clock() >= deadline) {
							diagnostic("budget-exhausted");
							if (trials.length) candidates.push({ ...template, trials });
							break outer;
						}
						const observed = await measure(template, c);
						if (!observed) {
							if (trials.length) candidates.push({ ...template, trials });
							break outer;
						}
						trials.push(observed);
					}
					candidates.push({ ...template, trials });
				}
			}
			const result = { ...profile, candidatesRaw: candidates };
			c.signal.throwIfAborted();
			await writeCache(result, c);
			c.signal.throwIfAborted();
			return frozen(result);
		}, context.signal);
	}
	function joinFlight(
		flight: NonNullable<ReturnType<typeof flights.get>>,
		signal: AbortSignal,
	) {
		flight.waiters++;
		let left = false;
		const leave = () => {
			if (left) return false;
			left = true;
			flight.waiters--;
			const abandoned = !flight.waiters && !flight.done;
			if (abandoned)
				flight.controller.abort(
					signal.reason ??
						new DOMException("No calibration waiters remain", "AbortError"),
				);
			return abandoned;
		};
		return cancellable(flight.promise, signal)
			.catch(async (error) => {
				// The last caller may delete its media as soon as this rejects.
				// Keep its lifetime until all processes and the lease have drained.
				if (leave()) await flight.promise.catch(() => undefined);
				throw error;
			})
			.finally(() => {
				leave();
			});
	}
	async function obtain(
		key: string,
		input: readonly NativeCalibrationTemplate[],
		context: NativeCalibrationContext,
	): Promise<NativeCalibrationProfile> {
		context.signal.throwIfAborted();
		if (
			!SHA256.test(key) ||
			(context.workloadMode !== undefined &&
				!["fixed-batch", "parallel-batch"].includes(context.workloadMode)) ||
			!integer(context.sampleFrames, 1, 256) ||
			!integer(context.fixedWorkUnits, 1, 32) ||
			(context.workloadMode === "parallel-batch" &&
				context.fixedWorkUnits !== 1) ||
			!Number.isFinite(context.budgetMs) ||
			context.budgetMs < 0 ||
			context.budgetMs > 60000 ||
			!integer(context.trialTimeoutMs ?? 5000, 1, 30000) ||
			(context.cacheable !== undefined &&
				typeof context.cacheable !== "boolean") ||
			input.length > MAX_CANDIDATES ||
			input.some(
				(t) =>
					!validTemplate(t) ||
					(context.workloadMode !== "parallel-batch" &&
						t.concurrency > context.fixedWorkUnits),
			) ||
			new Set(input.map(templateId)).size !== input.length ||
			(input.length > 0 && !input.some((t) => t.concurrency === 1))
		)
			throw new Error("NATIVE_CALIBRATION_OPTIONS_INVALID");
		const selectedContext = {
			...context,
			workloadMode: context.workloadMode ?? "fixed-batch",
		};
		const templates = input.map((t) => Object.freeze({ ...t }));
		const serial = templates.findIndex((t) => t.concurrency === 1);
		if (serial > 0) templates.unshift(...templates.splice(serial, 1));
		const flightKey = JSON.stringify([
			key,
			selectedContext.workloadMode,
			context.sampleFrames,
			context.fixedWorkUnits,
			context.cacheable === true,
			context.budgetMs,
			context.trialTimeoutMs ?? 5000,
			templates.map(templateId).sort(),
		]);
		let flight = flights.get(flightKey);
		if (flight?.controller.signal.aborted) {
			await cancellable(
				flight.promise.catch(() => undefined),
				context.signal,
			);
			return obtain(key, templates, selectedContext);
		}
		if (!flight) {
			const controller = new AbortController();
			const current = {
				controller,
				waiters: 0,
				done: false,
				promise: Promise.resolve(
					undefined as unknown as NativeCalibrationProfile,
				),
			};
			current.promise = Promise.resolve()
				.then(() =>
					calibrate(key, templates, {
						...selectedContext,
						signal: controller.signal,
					}),
				)
				.finally(() => {
					current.done = true;
					if (flights.get(flightKey) === current) flights.delete(flightKey);
				});
			flights.set(flightKey, current);
			flight = current;
		}
		return joinFlight(flight, context.signal);
	}
	return { obtain };
}

/** Sample wall times remain raw; only memory gets a full-result allowance. */
export function toPolicyCandidates(
	profile: NativeCalibrationProfile,
	fullFrameCount: number,
	padding: {
		hostMarginFactor: number;
		hostPerFrameBytes: number;
		gpuPerProcessOverheadBytes: number;
		gpuMarginFactor: number;
	},
) {
	if (
		!validProfile(
			profile,
			profile.profileKey,
			profile.sampleFrames,
			profile.fixedWorkUnits,
			profile.workloadMode,
			true,
		) ||
		!integer(fullFrameCount, 1) ||
		!integer(padding.hostPerFrameBytes, 1) ||
		!integer(padding.gpuPerProcessOverheadBytes, 0) ||
		![padding.hostMarginFactor, padding.gpuMarginFactor].every(
			(n) => Number.isFinite(n) && n >= 1,
		)
	)
		throw new Error("NATIVE_CALIBRATION_MEMORY_ESTIMATE_INVALID");
	return profile.candidatesRaw
		.filter((candidate) => candidate.trials.length === 3)
		.map((candidate) => {
			const host = Math.ceil(
				Math.max(...candidate.trials.map((t) => t.maxRssBytesPerComparison)) *
					padding.hostMarginFactor +
					fullFrameCount * padding.hostPerFrameBytes,
			);
			const gpu = Math.ceil(
				(Math.max(
					...candidate.trials.map((t) => t.gpuOwnedBytesPerComparison),
				) +
					padding.gpuPerProcessOverheadBytes) *
					padding.gpuMarginFactor,
			);
			if (!integer(host, 1) || !integer(gpu, 1))
				throw new Error("NATIVE_CALIBRATION_MEMORY_ESTIMATE_INVALID");
			return {
				...candidate,
				workload:
					profile.workloadMode === "parallel-batch"
						? {
								mode: "parallel-batch" as const,
								sampleFrames: profile.sampleFrames,
							}
						: {
								mode: "fixed-batch" as const,
								sampleFrames: profile.sampleFrames,
								fixedWorkUnits: profile.fixedWorkUnits,
							},
				profileKey: profile.profileKey,
				scope: "native-with-cpu-parity" as const,
				hostBytesPerComparison: host,
				gpuBytesPerComparison: gpu,
				trials: candidate.trials.map((trial) => ({
					workFrames: trial.workFrames,
					wallMs: trial.wallMs,
					cpuVerified: true as const,
					warmup: false as const,
				})),
				memoryEstimate: {
					source: "sample-rss-and-owned-gpu-plus-caller-overhead" as const,
					fullFrameCount,
					...padding,
					resourceSnapshotScope: "before-result-serialization" as const,
				},
			};
		});
}
