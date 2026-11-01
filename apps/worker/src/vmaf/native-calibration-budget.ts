import {
	type AutoExecutionCandidate,
	autoExecutionWorkloadKey,
} from "./auto-execution-policy";

type Request = {
	profileKey: string;
	maxConcurrency: number;
	signal: AbortSignal;
	run(budgetMs: number, signal: AbortSignal): Promise<AutoExecutionCandidate[]>;
};
type Flight = {
	ownerSignal: AbortSignal;
	promise: Promise<AutoExecutionCandidate[]>;
};
type State = {
	active: number;
	generation: number;
	searched: boolean;
	flight?: Flight;
	lastFailure?: { generation: number; error: unknown };
};
const positive = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function adequate(rows: AutoExecutionCandidate[], key: string, max: number) {
	const measured = rows.filter((candidate) => {
		const work = candidate.trials[0]?.workFrames;
		return (
			candidate.profileKey === key &&
			candidate.scope === "native-with-cpu-parity" &&
			positive(candidate.concurrency) &&
			candidate.concurrency <= max &&
			positive(candidate.hostBytesPerComparison) &&
			positive(candidate.gpuBytesPerComparison) &&
			[1, 2, 4].includes(candidate.cpuThreads) &&
			[1, 2].includes(candidate.decoderThreads) &&
			[1, 2, 4].includes(candidate.inflightFrames) &&
			positive(work) &&
			candidate.trials.length >= 3 &&
			candidate.trials.every(
				(trial) =>
					trial.cpuVerified === true &&
					trial.workFrames === work &&
					Number.isFinite(trial.wallMs) &&
					trial.wallMs > 0 &&
					(trial.warmup === undefined || trial.warmup === false),
			)
		);
	});
	const protocols = new Set(measured.map(autoExecutionWorkloadKey));
	if (protocols.size !== 1 || protocols.has(undefined)) return false;
	const serial = measured.filter((candidate) => candidate.concurrency === 1);
	return (
		serial.length > 0 &&
		(max === 1 || measured.some((candidate) => candidate.concurrency > 1))
	);
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal) {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (work: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", cancel);
			work();
		};
		const cancel = () => finish(() => reject(signal.reason));
		signal.addEventListener("abort", cancel, { once: true });
		promise.then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error)),
		);
		if (signal.aborted) cancel();
	});
}

/** One successful search per profile/process. Followers always convert cached
 * raw observations themselves: their full-result RAM may differ by duration. */
export function createNativeCalibrationBudget(
	options: { searchBudgetMs?: number } = {},
) {
	const searchBudgetMs = options.searchBudgetMs ?? 30_000;
	if (!positive(searchBudgetMs) || searchBudgetMs > 30_000)
		throw new Error("NATIVE_CALIBRATION_BUDGET_OPTIONS_INVALID");
	const states = new Map<string, State>();
	const forgetIdle = (key: string, state: State) => {
		if (
			!state.active &&
			!state.flight &&
			!state.searched &&
			states.get(key) === state
		)
			states.delete(key);
	};
	const start = (request: Request, state: State) => {
		const generation = ++state.generation;
		const flight: Flight = {
			ownerSignal: request.signal,
			promise: Promise.resolve([]),
		};
		state.flight = flight;
		flight.promise = Promise.resolve()
			.then(() => request.run(searchBudgetMs, request.signal))
			.then((rows) => {
				request.signal.throwIfAborted();
				// Incomplete but settled searches also consume this process's budget.
				state.searched = true;
				return rows;
			})
			.catch((error) => {
				if (!request.signal.aborted) state.lastFailure = { generation, error };
				throw error;
			})
			.finally(() => {
				if (state.flight === flight) state.flight = undefined;
				forgetIdle(request.profileKey, state);
			});
		return flight;
	};
	return {
		async calibrate(request: Request): Promise<AutoExecutionCandidate[]> {
			request.signal.throwIfAborted();
			if (
				!/^[a-f0-9]{64}$/.test(request.profileKey) ||
				!positive(request.maxConcurrency) ||
				request.maxConcurrency > 32
			)
				throw new Error("NATIVE_CALIBRATION_BUDGET_OPTIONS_INVALID");
			let state = states.get(request.profileKey);
			if (!state) {
				// Bound bookkeeping without evicting a profile and accidentally
				// spending its search budget again. Additional profiles use cache only.
				if (states.size >= 4096) return request.run(0, request.signal);
				state = { active: 0, generation: 0, searched: false };
				states.set(request.profileKey, state);
			}
			const selected = state;
			const born = selected.generation;
			selected.active++;
			try {
				for (;;) {
					request.signal.throwIfAborted();
					const pending = selected.flight;
					if (pending) {
						// The origin owns its media. If it cancels, followers wait for
						// its process/lease drain and then use their own input paths.
						try {
							await waitFor(pending.promise, request.signal);
						} catch (error) {
							request.signal.throwIfAborted();
							if (!pending.ownerSignal.aborted) throw error;
						}
					}
					const beforeRead = selected.generation;
					const cached = await request.run(0, request.signal);
					request.signal.throwIfAborted();
					if (selected.lastFailure && selected.lastFailure.generation > born)
						throw selected.lastFailure.error;
					// A search may have started while this cache read was pending. Do
					// not return stale candidates or spend a second search budget.
					if (selected.generation !== beforeRead || selected.flight) continue;
					if (
						adequate(cached, request.profileKey, request.maxConcurrency) ||
						selected.searched
					)
						return cached;
					// The owner awaits run itself, including cancellation drain, before
					// its caller can delete the input files. Followers above
					// wait for the flight and then invoke their own cache-only callback.
					return await start(request, selected).promise;
				}
			} finally {
				selected.active--;
				forgetIdle(request.profileKey, selected);
			}
		},
	};
}
