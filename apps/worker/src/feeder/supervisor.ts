/**
 * Feeder process supervisor (P3-PR3): owns ONE ffmpeg push for one
 * FeederSession. All process interaction goes through the injected
 * ProcessRunner so the test suite runs without ffmpeg installed (CI has
 * none); the real runner lives in process-runner.ts.
 *
 * Responsibilities:
 * - spawn ffmpeg, capture stderr into a size-bounded ring buffer (lines are
 *   scrubbed of secret literals BEFORE buffering — redaction discipline);
 * - parse `-progress pipe:1` key=value blocks from stdout and detect loop
 *   boundaries (out_time wrap/reset vs the source duration), persisting
 *   {loopIndex, wallClock, streamTimeSec} append-only (C7-style local truth
 *   — P4 VMAF live alignment depends on these);
 * - restart ffmpeg with bounded exponential backoff when it exits while the
 *   session should still be pushing; flip to ERROR when attempts exhaust;
 * - stop on request: SIGTERM, then SIGKILL after a grace period.
 */

export type LoopBoundary = {
	loopIndex: number;
	/** ISO timestamp of the observation (wall clock). */
	wallClock: string;
	/** ffmpeg out_time at the observation, seconds on the OUTPUT clock. */
	streamTimeSec: number;
};

// ---------------------------------------------------------------------------
// Loop boundary tracking
// ---------------------------------------------------------------------------

export type LoopTracker = {
	/** Feed one out_time sample (seconds); returns a boundary when one began. */
	observe(outTimeSec: number): LoopBoundary | undefined;
	/** Loop index currently playing (for carrying across ffmpeg restarts). */
	current(): number;
};

/**
 * Loop-boundary heuristic. `-stream_loop -1` manifests in two ways
 * depending on the codec path, so BOTH are detected:
 * - monotonic out_time (transcode path: the output timeline keeps
 *   counting): a boundary is when floor(outTime/duration) increments;
 * - out_time reset (copy path: input timestamps restart and ffmpeg follows
 *   them): a boundary is when out_time moves backwards.
 * Boundaries are OBSERVATIONS at -progress granularity (~0.5 s), recorded
 * with both clocks; P4 refines to frame accuracy via PTS-modulo (ROADMAP
 * P4). The first sample after a spawn emits the loop's starting boundary,
 * which also anchors loop 0 at push start. `baseLoopIndex` carries loop
 * numbering across supervisor restarts of ffmpeg (each restart begins a
 * new loop at out_time 0).
 */
export function createLoopTracker(
	sourceDurationSec: number | undefined,
	now: () => string,
	baseLoopIndex = 0,
): LoopTracker {
	// Wrap detection needs a sane duration; sub-second sources would alias
	// with progress granularity, so they fall back to reset detection only.
	const duration =
		sourceDurationSec !== undefined && sourceDurationSec >= 1
			? sourceDurationSec
			: undefined;
	let prev: number | undefined;
	let loop = baseLoopIndex;
	// Double-count latch: ffmpeg can briefly report an out_time PAST the
	// duration (quotient boundary fires) and THEN reset the clock backwards
	// for the same wrap. The wrap already counted, so reset detection is
	// suppressed for the immediately following sample window.
	let suppressResetOnce = false;
	const EPSILON = 0.25;

	return {
		observe(outTimeSec: number): LoopBoundary | undefined {
			if (!Number.isFinite(outTimeSec) || outTimeSec < 0) {
				return undefined;
			}
			if (prev === undefined) {
				prev = outTimeSec;
				return { loopIndex: loop, wallClock: now(), streamTimeSec: outTimeSec };
			}
			const resetLatched = suppressResetOnce;
			suppressResetOnce = false;
			let crossed = false;
			if (outTimeSec < prev - EPSILON) {
				if (!resetLatched) {
					// Reset path: one boundary regardless of how far it rewound.
					loop += 1;
					crossed = true;
				}
				// Latched: this reset belongs to the wrap the quotient already
				// counted on the previous sample — swallow it.
			} else if (duration !== undefined) {
				const prevQ = Math.floor(prev / duration);
				const curQ = Math.floor(outTimeSec / duration);
				if (curQ > prevQ) {
					// -re paces near realtime, so curQ - prevQ is 1 in practice;
					// advancing by the delta keeps indices honest if a stall ever
					// skips a whole loop between samples.
					loop += curQ - prevQ;
					crossed = true;
					suppressResetOnce = true;
				}
			}
			prev = outTimeSec;
			return crossed
				? { loopIndex: loop, wallClock: now(), streamTimeSec: outTimeSec }
				: undefined;
		},
		current: () => loop,
	};
}

// ---------------------------------------------------------------------------
// -progress parsing
// ---------------------------------------------------------------------------

/**
 * Accumulates `key=value` lines until the block-terminating `progress=`
 * line, then yields the block's out_time in seconds. Prefers out_time_us;
 * out_time_ms is accepted as microseconds too (ffmpeg's out_time_ms has
 * always been µs — the name is a historical bug); falls back to parsing
 * out_time=HH:MM:SS.micros. N/A values yield nothing.
 */
export function createProgressParser(
	onOutTime: (outTimeSec: number) => void,
): (line: string) => void {
	let block: Record<string, string> = {};
	return (line: string) => {
		const eq = line.indexOf("=");
		if (eq <= 0) {
			return;
		}
		const key = line.slice(0, eq).trim();
		const value = line.slice(eq + 1).trim();
		if (key !== "progress") {
			block[key] = value;
			return;
		}
		const sec = outTimeSecOf(block);
		block = {};
		if (sec !== undefined) {
			onOutTime(sec);
		}
	};
}

function outTimeSecOf(block: Record<string, string>): number | undefined {
	for (const key of ["out_time_us", "out_time_ms"]) {
		const raw = block[key];
		if (raw !== undefined && raw !== "N/A") {
			const us = Number.parseInt(raw, 10);
			if (Number.isFinite(us) && us >= 0) {
				return us / 1_000_000;
			}
		}
	}
	const clock = block.out_time;
	if (clock !== undefined && clock !== "N/A") {
		const m = clock.match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
		if (m?.[1] !== undefined && m[2] !== undefined && m[3] !== undefined) {
			return (
				Number.parseInt(m[1], 10) * 3600 +
				Number.parseInt(m[2], 10) * 60 +
				Number.parseFloat(m[3])
			);
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Process interface (injected — tests use fakes, no real ffmpeg in CI)
// ---------------------------------------------------------------------------

export type FeederProcessEvents = {
	onStdoutLine(line: string): void;
	onStderrLine(line: string): void;
	onExit(code: number | null, signal: string | null): void;
};

export type FeederProcess = {
	pid?: number;
	kill(signal: "SIGTERM" | "SIGKILL"): void;
};

export type ProcessRunner = {
	/** Long-running spawn with line-split stdio (ffmpeg push). */
	spawn(
		bin: string,
		argv: string[],
		events: FeederProcessEvents,
	): FeederProcess;
	/**
	 * One-shot run with buffered output (ffprobe, the loop normalizer). An
	 * aborted `signal` kills the child; the caller reads its own stop flag
	 * afterwards to tell a stop from a failure .
	 */
	run(
		bin: string,
		argv: string[],
		options?: { signal?: AbortSignal },
	): Promise<{ code: number | null; stdout: string; stderr: string }>;
};

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

/** Persistence hooks — the processor binds these to the FeederSession row. */
export type SupervisorStore = {
	/** Create the write-once intent for one spawn before the process exists. */
	beginAttempt(input: {
		attemptNo: number;
		startedAt: string;
	}): Promise<string>;
	/** Atomically bind the actual process and its evidence boundary after spawn. */
	attachAttemptProcess(
		attemptId: string,
		process: {
			pid: number | undefined;
			processSpawnedAt: string;
			evidenceNotBefore: string;
		},
	): Promise<void>;
	/** Persist every provider verdict used by the bind gate. */
	recordAttemptObservation(
		attemptId: string,
		observation: IngestBindObservation,
		accepted: boolean,
	): Promise<void>;
	/** Fill the terminal process result exactly once after the child exits. */
	finishAttempt(
		attemptId: string,
		result: {
			endedAt: string;
			code: number | null;
			signal: string | null;
		},
	): Promise<void>;
	/** Entering/holding PUSHING with the current ffmpeg pid. */
	setPushing(pid: number | undefined): Promise<boolean | undefined>;
	/** Append one boundary (persist immediately — local truth for P4). */
	appendBoundary(boundary: LoopBoundary): Promise<void>;
	/** Persist the full ring-buffer snapshot (already redacted lines). */
	flushLogTail(lines: string[]): Promise<void>;
};

export type IngestBindStatus = "CONNECTED" | "DISCONNECTED" | "UNKNOWN";

export type IngestBindObservation = {
	status: IngestBindStatus;
	/** Provider-emitted sample time, or null when it supplied no usable timestamp. */
	sampledAt: string | null;
	/** Local start time of the HTTP poll which returned this provider sample. */
	probeStartedAt: string | null;
};

export type SupervisorDeps = {
	runner: ProcessRunner;
	ffmpegPath: string;
	argv: string[];
	/** The only argv form that may enter logs (builder contract). */
	redactedArgv: string[];
	/** Scrubs secret literals out of every captured line. */
	redactLine(line: string): string;
	sourceDurationSec: number | undefined;
	/**
	 * Where this supervisor's loop numbering starts . Zero for a
	 * fresh session; on a TAKEOVER it is one past the highest loop index the
	 * previous owner persisted, so the resumed session's boundary array stays
	 * strictly increasing — which is the property `appendBoundary`'s cap relies
	 * on to make a trimmed head detectable.
	 */
	baseLoopIndex?: number;
	store: SupervisorStore;
	now(): string;
	sleep(ms: number): Promise<void>;
	/**
	 * Fail-closed effect-boundary check. It is awaited immediately before every
	 * process spawn, including restarts, so a staged session cannot publish
	 * after its provider run or ownership generation changes.
	 */
	beforeSpawn?: (spawnOrdinal: number) => Promise<void>;
	/**
	 * Called only after the process exists and the pid write returned. A false
	 * result means the owner/session CAS lost and must not acknowledge an effect.
	 */
	afterSpawnPersisted?: (persisted: boolean) => Promise<void>;
	/** A synchronous spawn throw is post-intent ambiguity, not a safe retry. */
	onSpawnError?: (error: unknown) => Promise<void>;
	/**
	 * : answers "has the ENCODER actually bound an input?" (the
	 * processor binds this to the channel's persisted heartbeat). A push can
	 * look perfectly healthy from ffmpeg's side while the encoder sits in
	 * WAITING_FOR_FIRST_CONNECT forever — the 2026-08-15 incident pushed
	 * 9.5 minutes at speed 0.998x into a session the encoder never bound,
	 * and a fresh handshake then bound in 25 seconds. When provided (review-260's held
	 * item, folded in #126: the dep is named for its VALUE — true = the
	 * push may keep running), a
	 * watchdog kills the push after `bindTimeoutMs` unbound and lets the
	 * restart machinery open that fresh session. The tri-state observation is
	 * sampled repeatedly; success requires two polls started strictly after this
	 * attempt's boundary, with the second CONNECTED poll advancing both its local
	 * poll time and provider-emitted sample time. This compares each clock only
	 * with itself; equality with either baseline is ambiguous and rejected. After
	 * `maxBindKills` unproven sessions the feeder fails OUT LOUD
	 * instead of zombie-pushing.
	 */
	mayKeepPushing?: () => Promise<IngestBindObservation>;
	/** A switch cannot accept evidence older than its commit point. */
	bindEvidenceNotBefore?: string;
	/** Restart policy for unexpected ffmpeg exits while pushing. */
	maxRestarts?: number;
	backoffBaseMs?: number;
	backoffCapMs?: number;
	/** SIGTERM → grace → SIGKILL. */
	killGraceMs?: number;
	bindTimeoutMs?: number;
	/** Re-observation cadence inside one bind deadline. */
	bindProbeIntervalMs?: number;
	maxBindKills?: number;
	logTailSize?: number;
	/** Flush the tail to the store every N captured lines (and on events). */
	logFlushEveryLines?: number;
};

export type SupervisorResult = {
	outcome: "STOPPED" | "ERROR";
	error?: string;
};

export type FeederSupervisor = {
	/** Resolves when the push ends for good (stop or restarts exhausted). */
	run(): Promise<SupervisorResult>;
	/** Idempotent; safe from another queue job (in-process registry). */
	requestStop(): void;
};

/** SIGTERM → grace → SIGKILL window, shared with the processor's
 * registry-miss kill ladder so both stop paths escalate identically. */
export const KILL_GRACE_MS = 5_000;

/**
 * A spawn that survives this long (or completes a full source loop) earns
 * the restart budget back: a 24h push must not die because one blip every
 * few hours slowly accumulated into "attempts exhausted".
 */
export const HEALTHY_RUN_RESET_MS = 60_000;

const DEFAULTS = {
	maxRestarts: 5,
	backoffBaseMs: 1_000,
	backoffCapMs: 30_000,
	killGraceMs: KILL_GRACE_MS,
	logTailSize: 200,
	logFlushEveryLines: 25,
	/** #95 bind-watchdog: unbound this long into a push ⇒ fresh handshake. */
	bindTimeoutMs: 90_000,
	/** Multiple provider reads per attempt, rather than one verdict at 90 s. */
	bindProbeIntervalMs: 5_000,
	/** Whole unbound sessions before the feeder fails out loud. */
	maxBindKills: 3,
};

type SupervisorConfig = typeof DEFAULTS;

/**
 * Apply the tuning defaults, ignoring keys the caller left `undefined`.
 *
 * This exists because `{ ...DEFAULTS, ...deps }` does NOT do that. Object
 * spread copies every key that EXISTS on the source, `undefined` value and
 * all — so `processor.ts`, which forwards its own optional knobs positionally
 * (`maxRestarts: deps.maxRestarts, …`), overwrote all six defaults with
 * `undefined` whenever the queue processor was built without them, which is
 * the normal case.
 *
 * Measured on a real session 2026-08-15 , the fallout of that one
 * spread — every consequence downstream of a value that reads as absent:
 *
 * | knob               | intended | actual         | effect                                   |
 * |--------------------|----------|----------------|------------------------------------------|
 * | maxRestarts        | 5        | `undefined`    | `attempt >= undefined` is never true     |
 * | backoffBaseMs/Cap  | 1s→30s   | `NaN`          | `sleep(NaN)` returns at once             |
 * | logTailSize        | 200      | `undefined`    | `length > undefined` false — never trims |
 * | logFlushEveryLines | 25       | `undefined`    | `unflushed < undefined` false — writes   |
 * |                    |          |                | the row on EVERY captured line           |
 * | killGraceMs        | 5s       | `undefined`    | `sleep(undefined)` before SIGKILL        |
 *
 * A feeder whose ffmpeg exited went into an unbounded zero-delay reconnect
 * loop: 710 restarts against Bitmovin's RTMP ingest and a 17,148-line log
 * column (cap 200), one UPDATE per line, in the ~6 minutes before it was
 * stopped by hand. None of it was visible to the type checker, because
 * `undefined` is assignable to every one of these optional fields.
 *
 * Iterating DEFAULTS' own keys is the part that matters: a knob added to
 * DEFAULTS later is resolved here automatically, so the fix cannot rot into
 * the same shape one field at a time.
 */
function resolveConfig(deps: SupervisorDeps): SupervisorConfig {
	const out = { ...DEFAULTS };
	for (const key of Object.keys(DEFAULTS) as (keyof SupervisorConfig)[]) {
		const value = deps[key];
		// `Number.isFinite`, not `!== undefined`: NaN is a legal `number` to the
		// type checker and walks straight past an undefined guard, reproducing
		// this incident exactly (review-213 built the supervisor with NaN knobs
		// and got the same unbounded restart loop). Nothing env-parses these
		// today, but that is what they exist for, and `Number(process.env.X)`
		// on an unset var IS NaN. All six knobs are numeric, so this is strictly
		// stronger with nothing given up.
		if (typeof value === "number" && Number.isFinite(value)) {
			out[key] = value;
		}
	}
	return out;
}

export function createFeederSupervisor(deps: SupervisorDeps): FeederSupervisor {
	const cfg = resolveConfig(deps);
	const ring: string[] = [];
	let unflushed = 0;
	let stopRequested = false;
	let current: FeederProcess | undefined;
	let stopTarget: FeederProcess | undefined;
	let exited = true;
	let nextLoopBase = deps.baseLoopIndex ?? 0;
	const evidenceNow = (): string => {
		const requested = deps.now();
		const requestedMs = Date.parse(requested);
		return Number.isFinite(requestedMs)
			? new Date(requestedMs).toISOString()
			: new Date().toISOString();
	};

	function capture(line: string): void {
		ring.push(`${deps.now()} ${deps.redactLine(line)}`);
		if (ring.length > cfg.logTailSize) {
			ring.splice(0, ring.length - cfg.logTailSize);
		}
		unflushed += 1;
	}

	async function flush(force = false): Promise<void> {
		if (!force && unflushed < cfg.logFlushEveryLines) {
			return;
		}
		unflushed = 0;
		await deps.store.flushLogTail([...ring]);
	}

	type ActiveAttempt = {
		id: string;
		attemptNo: number;
		startedAt: string;
		processSpawnedAt: string;
		evidenceNotBefore: string;
		evidencePersisted: boolean;
		persistenceError?: string;
		process: FeederProcess;
		exit: Promise<{ code: number | null; signal: string | null }>;
		tracker: LoopTracker;
	};

	async function startOnce(attemptNo: number): Promise<ActiveAttempt> {
		// `startedAt` is the durable pre-spawn intent. It is deliberately not an
		// evidence boundary: beginAttempt can spend arbitrary time in storage while
		// an earlier publisher is still CONNECTED.
		const startedAt = evidenceNow();
		const attemptId = await deps.store.beginAttempt({
			attemptNo,
			startedAt,
		});
		const tracker = createLoopTracker(
			deps.sourceDurationSec,
			deps.now,
			nextLoopBase,
		);
		const parseProgress = createProgressParser((outTimeSec) => {
			const boundary = tracker.observe(outTimeSec);
			if (boundary) {
				capture(
					`[feeder] loop boundary #${boundary.loopIndex} at stream ${boundary.streamTimeSec.toFixed(2)}s`,
				);
				// Sequential persists (single writer): boundary first, then tail.
				void deps.store
					.appendBoundary(boundary)
					.then(() => flush(true))
					.catch(() => {
						// Persistence hiccups must not kill the push; the next
						// boundary/flush retries with the full ring snapshot.
					});
			}
		});

		let settleExit: (result: {
			code: number | null;
			signal: string | null;
		}) => void = () => {};
		const exit = new Promise<{ code: number | null; signal: string | null }>(
			(resolve) => {
				settleExit = resolve;
			},
		);
		try {
			current = deps.runner.spawn(deps.ffmpegPath, deps.argv, {
				onStdoutLine: parseProgress,
				onStderrLine: (line) => {
					capture(line);
					void flush().catch(() => {});
				},
				onExit: (code, signal) => {
					exited = true;
					current = undefined;
					settleExit({ code, signal });
				},
			});
			exited = false;
		} catch (err) {
			current = undefined;
			exited = true;
			await deps.onSpawnError?.(err);
			throw err;
		}
		const process = current;
		if (!process) {
			throw new Error(`feeder attempt ${attemptId} spawned no process`);
		}
		// The process now exists. Only this post-return instant can distinguish a
		// CONNECTED sample from the predecessor that was observed while the intent
		// row was being inserted.
		const processSpawnedAt = evidenceNow();
		const processSpawnedAtMs = Date.parse(processSpawnedAt);
		const startedAtMs = Date.parse(startedAt);
		const configuredBoundaryMs = Date.parse(deps.bindEvidenceNotBefore ?? "");
		const evidenceNotBeforeMs = Math.max(
			Number.isFinite(processSpawnedAtMs)
				? processSpawnedAtMs
				: Number.NEGATIVE_INFINITY,
			Number.isFinite(startedAtMs) ? startedAtMs : Number.NEGATIVE_INFINITY,
			Number.isFinite(configuredBoundaryMs)
				? configuredBoundaryMs
				: Number.NEGATIVE_INFINITY,
		);
		if (!Number.isFinite(evidenceNotBeforeMs)) {
			throw new Error("cannot bind feeder attempt: evidence clock is invalid");
		}
		const evidenceNotBefore = new Date(evidenceNotBeforeMs).toISOString();
		let evidencePersisted = false;
		let persistenceError: string | undefined;
		const failPersistence = (message: string): void => {
			persistenceError ??= message;
			capture(`[feeder] ${message} — no provider observation can be accepted`);
		};
		try {
			await deps.store.attachAttemptProcess(attemptId, {
				pid: process.pid,
				processSpawnedAt,
				evidenceNotBefore,
			});
			evidencePersisted = true;
		} catch (err) {
			failPersistence(
				`feeder attempt ${attemptId} could not persist its actual spawn boundary: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		let sessionPersisted = false;
		try {
			const persisted = await deps.store.setPushing(current?.pid);
			sessionPersisted = persisted !== false;
		} catch (err) {
			failPersistence(
				`feeder attempt ${attemptId} could not persist its FeederSession pid/status fence: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		if (!sessionPersisted && !persistenceError) {
			// A clean false is a fenced CAS refusal (for example, stop already won),
			// not a storage fault. Preserve the prior STOPPED outcome while still
			// guaranteeing this just-created process is signalled below.
			stopRequested = true;
		}
		try {
			await deps.afterSpawnPersisted?.(evidencePersisted && sessionPersisted);
		} catch (err) {
			failPersistence(
				`feeder attempt ${attemptId} could not settle its post-spawn durability acknowledgement: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		if (
			(persistenceError || stopRequested) &&
			!exited &&
			current === process &&
			stopTarget !== process
		) {
			// There is no safe retry inside this process: the missing atomic write is
			// the fact that would authorise a CONNECTED verdict. This also closes the
			// race where stop was requested while beginAttempt had no child to signal.
			stopTarget = process;
			process.kill("SIGTERM");
			void (async () => {
				await deps.sleep(cfg.killGraceMs);
				if (!exited && current === process) {
					process.kill("SIGKILL");
				}
			})().catch(() => {});
		}
		return {
			id: attemptId,
			attemptNo,
			startedAt,
			processSpawnedAt,
			evidenceNotBefore,
			evidencePersisted,
			...(persistenceError ? { persistenceError } : {}),
			process,
			exit,
			tracker,
		};
	}

	let bindKills = 0;
	let bindExhausted = false;

	/**
	 * Attempt-bound bind gate (#95 / LF-01): re-observe within the deadline.
	 * A CONNECTED or DISCONNECTED verdict can affect this attempt only after its
	 * provider sample advances beyond the attempt's post-spawn baseline. UNKNOWN
	 * and an unadvanced sample keep probing. Provider timestamps and the spawn
	 * boundary come from different clocks, so absolute comparison would be a
	 * false-proof under skew. Instead, the first valid sample observed by a
	 * strictly post-spawn provider poll is this attempt's baseline. Only a later
	 * post-spawn poll whose local poll time AND provider timestamp both advance
	 * can prove new provider evidence without comparing clock domains. At the
	 * deadline every unproven state is stopped so an unreadable provider cannot
	 * bill forever.
	 */
	async function bindWatchdog(attempt: ActiveAttempt): Promise<void> {
		if (!deps.mayKeepPushing) {
			return;
		}
		// Identity-bound to the spawn it was armed for (review-224 I1): the
		// shared `exited` flag describes the CURRENT spawn, so a watchdog
		// that outlives its own spawn (self-exit → backoff → respawn) would
		// otherwise SIGTERM+SIGKILL the RESPAWNED process at ~0s of its bind
		// window and consume bindKills for sessions it never observed.
		const mine = attempt.process;
		let elapsedMs = 0;
		let lastStatus: IngestBindStatus = "UNKNOWN";
		let baselineProviderSampleMs: number | null = null;
		let baselineProbeStartedMs: number | null = null;
		while (elapsedMs < cfg.bindTimeoutMs) {
			const waitMs = Math.min(
				Math.max(1, cfg.bindProbeIntervalMs),
				cfg.bindTimeoutMs - elapsedMs,
			);
			await deps.sleep(waitMs);
			elapsedMs += waitMs;
			if (stopRequested || exited || current !== mine) {
				return;
			}
			let observation: IngestBindObservation;
			try {
				observation = await deps.mayKeepPushing();
			} catch {
				observation = {
					status: "UNKNOWN",
					sampledAt: null,
					probeStartedAt: null,
				};
			}
			lastStatus = observation.status;
			const sampleMs = Date.parse(observation.sampledAt ?? "");
			const probeStartedMs = Date.parse(observation.probeStartedAt ?? "");
			const evidenceNotBeforeMs = Date.parse(attempt.evidenceNotBefore);
			const validPostBoundaryObservation =
				Number.isFinite(sampleMs) &&
				Number.isFinite(probeStartedMs) &&
				Number.isFinite(evidenceNotBeforeMs) &&
				probeStartedMs > evidenceNotBeforeMs;
			const providerSampleAdvanced =
				validPostBoundaryObservation &&
				baselineProviderSampleMs !== null &&
				baselineProbeStartedMs !== null &&
				sampleMs > baselineProviderSampleMs &&
				probeStartedMs > baselineProbeStartedMs;
			const accepted =
				attempt.evidencePersisted &&
				observation.status === "CONNECTED" &&
				providerSampleAdvanced;
			const disconnectedForThisAttempt =
				attempt.evidencePersisted &&
				observation.status === "DISCONNECTED" &&
				providerSampleAdvanced;
			if (validPostBoundaryObservation) {
				baselineProviderSampleMs =
					baselineProviderSampleMs === null
						? sampleMs
						: Math.max(baselineProviderSampleMs, sampleMs);
				baselineProbeStartedMs =
					baselineProbeStartedMs === null
						? probeStartedMs
						: Math.max(baselineProbeStartedMs, probeStartedMs);
			}
			try {
				await deps.store.recordAttemptObservation(
					attempt.id,
					observation,
					accepted,
				);
			} catch (err) {
				// A CONNECTED verdict that could not be tied to its attempt is not
				// success. Keep probing; the bounded deadline below still stops billing.
				capture(
					`[feeder] attempt ${attempt.id}: could not persist provider observation: ${err instanceof Error ? err.message : String(err)}`,
				);
				continue;
			}
			if (accepted) {
				bindKills = 0;
				return;
			}
			if (disconnectedForThisAttempt) {
				break;
			}
		}
		if (stopRequested || exited || current !== mine) {
			return;
		}
		bindKills += 1;
		if (bindKills >= cfg.maxBindKills) {
			bindExhausted = true;
		}
		capture(
			`[feeder] attempt ${attempt.id}: no accepted post-start CONNECTED evidence before the ${Math.round(cfg.bindTimeoutMs / 1000)}s deadline (last provider status ${lastStatus}) — stopping this process for a bounded retry (${bindKills}/${cfg.maxBindKills})`,
		);
		// Evidence persistence already happened above. A diagnostic-tail write
		// failure must never prevent the bounded safety action itself.
		await flush(true).catch(() => {});
		mine.kill("SIGTERM");
		await deps.sleep(cfg.killGraceMs);
		if (!exited && current === mine) {
			mine.kill("SIGKILL");
		}
	}

	return {
		async run(): Promise<SupervisorResult> {
			capture(
				`[feeder] spawn: ${deps.ffmpegPath} ${deps.redactedArgv.join(" ")}`,
			);
			let attempt = 0;
			let spawnOrdinal = 0;
			const attemptIds: string[] = [];
			for (;;) {
				await deps.beforeSpawn?.(spawnOrdinal);
				const spawnedAtMs = Date.parse(deps.now());
				const loopBaseBefore = nextLoopBase;
				const activeAttempt = await startOnce(spawnOrdinal + 1);
				attemptIds.push(activeAttempt.id);
				spawnOrdinal += 1;
				if (!activeAttempt.persistenceError) {
					void bindWatchdog(activeAttempt).catch(() => {});
				}
				const { code, signal } = await activeAttempt.exit;
				nextLoopBase = activeAttempt.tracker.current() + 1;
				await deps.store.finishAttempt(activeAttempt.id, {
					endedAt: evidenceNow(),
					code,
					signal,
				});
				capture(`[feeder] ffmpeg exited (code ${code}, signal ${signal})`);
				if (activeAttempt.persistenceError) {
					capture(`[feeder] ${activeAttempt.persistenceError}`);
					await flush(true);
					return { outcome: "ERROR", error: activeAttempt.persistenceError };
				}
				if (stopRequested) {
					await flush(true);
					return { outcome: "STOPPED" };
				}
				if (bindExhausted) {
					const error = `provider did not supply advancing CONNECTED evidence across two post-spawn polls for each of ${cfg.maxBindKills} bounded attempts; every process was stopped. Cause remains unresolved between source, ffmpeg/ingest path and provider — correlate FeederPushAttempt ${attemptIds.join(", ")} when comparing stream-copy and normalized-transcode runs`;
					capture(`[feeder] ${error}`);
					await flush(true);
					return { outcome: "ERROR", error };
				}
				// Healthy-window budget reset: runOnce bumps nextLoopBase to
				// tracker.current + 1, so a delta > 1 means at least one full
				// loop wrapped during this spawn.
				const ranMs = Date.parse(deps.now()) - spawnedAtMs;
				if (
					ranMs >= HEALTHY_RUN_RESET_MS ||
					nextLoopBase - loopBaseBefore > 1
				) {
					attempt = 0;
				}
				if (attempt >= cfg.maxRestarts) {
					const error = `ffmpeg exited (code ${code}, signal ${signal}) and ${cfg.maxRestarts} restart attempts are exhausted`;
					capture(`[feeder] ${error}`);
					await flush(true);
					return { outcome: "ERROR", error };
				}
				attempt += 1;
				const delay = Math.min(
					cfg.backoffBaseMs * 2 ** (attempt - 1),
					cfg.backoffCapMs,
				);
				capture(
					`[feeder] unexpected exit while pushing — restart ${attempt}/${cfg.maxRestarts} in ${delay}ms`,
				);
				await flush(true);
				await deps.sleep(delay);
				if (stopRequested) {
					// Stop arrived during backoff — nothing is running to kill.
					return { outcome: "STOPPED" };
				}
			}
		},

		requestStop(): void {
			if (stopRequested) {
				return;
			}
			stopRequested = true;
			const proc = current;
			if (!proc || exited) {
				return;
			}
			stopTarget = proc;
			capture("[feeder] stop requested — SIGTERM");
			proc.kill("SIGTERM");
			void (async () => {
				await deps.sleep(cfg.killGraceMs);
				if (!exited) {
					capture(
						`[feeder] still alive ${cfg.killGraceMs}ms after SIGTERM — SIGKILL`,
					);
					proc.kill("SIGKILL");
				}
			})().catch(() => {});
		},
	};
}
