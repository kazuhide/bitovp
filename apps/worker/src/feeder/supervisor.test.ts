import { describe, expect, it, vi } from "vitest";
import {
	createFeederSupervisor,
	createLoopTracker,
	createProgressParser,
	type FeederProcess,
	type FeederProcessEvents,
	type LoopBoundary,
	type ProcessRunner,
	type SupervisorDeps,
} from "./supervisor";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const NOW = "2026-06-12T00:00:00.000Z";

describe("createLoopTracker", () => {
	const now = () => NOW;

	it("anchors loop 0 on the first observation", () => {
		const tracker = createLoopTracker(30, now);
		expect(tracker.observe(0.4)).toEqual({
			loopIndex: 0,
			wallClock: NOW,
			streamTimeSec: 0.4,
		});
		expect(tracker.observe(5)).toBeUndefined();
	});

	it("detects monotonic wraps via the duration quotient (transcode path)", () => {
		const tracker = createLoopTracker(10, now);
		tracker.observe(0.5);
		expect(tracker.observe(9.9)).toBeUndefined();
		expect(tracker.observe(10.3)).toMatchObject({
			loopIndex: 1,
			streamTimeSec: 10.3,
		});
		expect(tracker.observe(19.8)).toBeUndefined();
		expect(tracker.observe(20.1)).toMatchObject({ loopIndex: 2 });
		expect(tracker.current()).toBe(2);
	});

	it("detects out_time resets (copy path) regardless of duration", () => {
		const tracker = createLoopTracker(undefined, now);
		tracker.observe(0.2);
		tracker.observe(29.9);
		expect(tracker.observe(0.1)).toMatchObject({
			loopIndex: 1,
			streamTimeSec: 0.1,
		});
	});

	it("does not double-count a wrap when an overshoot sample precedes the reset (latch)", () => {
		const tracker = createLoopTracker(10, now);
		tracker.observe(0.5); // anchor loop 0
		expect(tracker.observe(9.9)).toBeUndefined();
		expect(tracker.observe(10.3)).toMatchObject({ loopIndex: 1 }); // quotient
		// The clock now resets backwards for the SAME wrap — latched, no
		// second boundary.
		expect(tracker.observe(0.1)).toBeUndefined();
		expect(tracker.current()).toBe(1);
		// The latch lasts exactly one sample: later genuine resets count.
		expect(tracker.observe(5)).toBeUndefined();
		expect(tracker.observe(0.2)).toMatchObject({ loopIndex: 2 });
		expect(tracker.current()).toBe(2);
	});

	it("clears the latch on a forward sample so later genuine resets still count", () => {
		const tracker = createLoopTracker(10, now);
		tracker.observe(0.5);
		expect(tracker.observe(10.3)).toMatchObject({ loopIndex: 1 });
		expect(tracker.observe(10.8)).toBeUndefined(); // forward → latch cleared
		expect(tracker.observe(0.1)).toMatchObject({ loopIndex: 2 }); // genuine reset
	});

	it("ignores small backwards jitter within the 0.25s epsilon (no boundary)", () => {
		const tracker = createLoopTracker(30, now);
		tracker.observe(5);
		expect(tracker.observe(4.8)).toBeUndefined(); // 0.2s rewind < epsilon
		expect(tracker.observe(4.9)).toBeUndefined();
		expect(tracker.current()).toBe(0);
	});

	it("advances by the quotient delta when a stall skips a whole loop", () => {
		const tracker = createLoopTracker(10, now);
		tracker.observe(1);
		expect(tracker.observe(25)).toMatchObject({ loopIndex: 2 });
	});

	it("carries a base index across ffmpeg restarts", () => {
		const tracker = createLoopTracker(10, now, 3);
		expect(tracker.observe(0)).toMatchObject({ loopIndex: 3 });
	});

	it("ignores N/A-ish and negative samples", () => {
		const tracker = createLoopTracker(10, now);
		expect(tracker.observe(Number.NaN)).toBeUndefined();
		expect(tracker.observe(-1)).toBeUndefined();
		expect(tracker.observe(0)).toMatchObject({ loopIndex: 0 });
	});
});

describe("createProgressParser", () => {
	it("yields out_time once per progress block, preferring out_time_us", () => {
		const seen: number[] = [];
		const feed = createProgressParser((sec) => seen.push(sec));
		feed("frame=100");
		feed("out_time_us=1500000");
		feed("out_time_ms=9999999999"); // ignored — _us wins
		feed("progress=continue");
		expect(seen).toEqual([1.5]);
	});

	it("accepts out_time_ms as microseconds (ffmpeg's historical naming bug)", () => {
		const seen: number[] = [];
		const feed = createProgressParser((sec) => seen.push(sec));
		feed("out_time_ms=2000000");
		feed("progress=continue");
		expect(seen).toEqual([2]);
	});

	it("falls back to the HH:MM:SS clock and skips N/A blocks", () => {
		const seen: number[] = [];
		const feed = createProgressParser((sec) => seen.push(sec));
		feed("out_time=00:01:30.500000");
		feed("progress=continue");
		feed("out_time_us=N/A");
		feed("out_time=N/A");
		feed("progress=end");
		expect(seen).toEqual([90.5]);
	});
});

// ---------------------------------------------------------------------------
// Supervisor with a fake process runner (no ffmpeg in CI)
// ---------------------------------------------------------------------------

class FakeProcess implements FeederProcess {
	killed: string[] = [];
	constructor(
		readonly pid: number,
		readonly events: FeederProcessEvents,
	) {}
	kill(signal: "SIGTERM" | "SIGKILL"): void {
		this.killed.push(signal);
	}
	progress(outTimeUs: number): void {
		this.events.onStdoutLine(`out_time_us=${outTimeUs}`);
		this.events.onStdoutLine("progress=continue");
	}
	stderr(line: string): void {
		this.events.onStderrLine(line);
	}
	exit(code: number | null, signal: string | null = null): void {
		this.events.onExit(code, signal);
	}
}

function makeRunner() {
	const spawned: FakeProcess[] = [];
	const runner: ProcessRunner = {
		spawn(_bin, _argv, events) {
			const proc = new FakeProcess(4000 + spawned.length, events);
			spawned.push(proc);
			return proc;
		},
		run: vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" })),
	};
	return { runner, spawned };
}

function makeSleeps() {
	const pending: { ms: number; resolve: () => void }[] = [];
	return {
		pending,
		sleep: (ms: number) =>
			new Promise<void>((resolve) => {
				pending.push({ ms, resolve });
			}),
		async release(): Promise<number> {
			// The sleep registers a few microtasks after the triggering event
			// (exit → flush → sleep) — wait for it instead of racing it.
			for (let i = 0; i < 50 && pending.length === 0; i += 1) {
				await tick();
			}
			const next = pending.shift();
			if (!next) {
				throw new Error("no pending sleep");
			}
			next.resolve();
			await tick();
			return next.ms;
		},
	};
}

function makeStore() {
	const boundaries: LoopBoundary[] = [];
	const tails: string[][] = [];
	const pushes: (number | undefined)[] = [];
	const attempts: {
		id: string;
		attemptNo: number;
		startedAt: string;
		processSpawnedAt?: string;
		evidenceNotBefore?: string;
		pid?: number;
		observations: { status: string; accepted: boolean }[];
		ended?: { code: number | null; signal: string | null };
	}[] = [];
	return {
		boundaries,
		tails,
		pushes,
		attempts,
		store: {
			beginAttempt: vi.fn(async ({ attemptNo, startedAt }) => {
				const id = `attempt-${attemptNo}`;
				attempts.push({ id, attemptNo, startedAt, observations: [] });
				return id;
			}),
			attachAttemptProcess: vi.fn(async (id: string, process) => {
				const attempt = attempts.find((item) => item.id === id);
				if (attempt) Object.assign(attempt, process);
			}),
			recordAttemptObservation: vi.fn(
				async (id: string, observation, accepted: boolean) => {
					attempts
						.find((item) => item.id === id)
						?.observations.push({ status: observation.status, accepted });
				},
			),
			finishAttempt: vi.fn(async (id: string, ended) => {
				const attempt = attempts.find((item) => item.id === id);
				if (attempt) attempt.ended = ended;
			}),
			setPushing: vi.fn(async (pid: number | undefined) => {
				pushes.push(pid);
				return true;
			}),
			appendBoundary: vi.fn(async (b: LoopBoundary) => {
				boundaries.push(b);
			}),
			flushLogTail: vi.fn(async (lines: string[]) => {
				tails.push(lines);
			}),
		},
	};
}

function setup(overrides: Partial<SupervisorDeps> = {}) {
	const { runner, spawned } = makeRunner();
	const sleeps = makeSleeps();
	const stored = makeStore();
	const supervisor = createFeederSupervisor({
		runner,
		ffmpegPath: "ffmpeg",
		argv: ["-i", "s.mp4", "rtmp://h/live/sk-secret"],
		redactedArgv: ["-i", "s.mp4", "rtmp://h/live/[REDACTED]"],
		redactLine: (line) => line.split("sk-secret").join("[REDACTED]"),
		sourceDurationSec: 10,
		store: stored.store,
		now: () => NOW,
		sleep: sleeps.sleep,
		maxRestarts: 2,
		backoffBaseMs: 1000,
		backoffCapMs: 4000,
		killGraceMs: 5000,
		bindProbeIntervalMs: 90_000,
		logFlushEveryLines: 1,
		...overrides,
	});
	return { supervisor, spawned, sleeps, ...stored };
}

describe("createFeederSupervisor", () => {
	it("runs the effect-boundary check immediately before the first spawn", async () => {
		const beforeSpawn = vi.fn(async () => {
			throw new Error("provider is not fresh RUNNING");
		});
		const s = setup({ beforeSpawn });

		await expect(s.supervisor.run()).rejects.toThrow(/not fresh RUNNING/);
		expect(beforeSpawn).toHaveBeenCalledTimes(1);
		expect(s.spawned).toHaveLength(0);
		expect(s.pushes).toHaveLength(0);
	});

	it("revalidates before every respawn and refuses the next process when it no longer passes", async () => {
		const beforeSpawn = vi
			.fn<() => Promise<void>>()
			.mockResolvedValueOnce()
			.mockRejectedValueOnce(new Error("run changed"));
		const s = setup({ beforeSpawn });
		const run = s.supervisor.run();
		const refused = expect(run).rejects.toThrow(/run changed/);
		await tick();
		expect(s.spawned).toHaveLength(1);

		s.spawned[0]?.exit(1);
		await s.sleeps.release();
		await refused;
		expect(beforeSpawn).toHaveBeenCalledTimes(2);
		expect(s.spawned).toHaveLength(1);
	});

	it("numbers every spawn monotonically and acknowledges only after pid persistence", async () => {
		const events: string[] = [];
		const beforeSpawn = vi.fn(async (ordinal: number) => {
			events.push(`before:${ordinal}`);
		});
		const afterSpawnPersisted = vi.fn(async (persisted: boolean) => {
			events.push(`persisted:${persisted}`);
		});
		const s = setup({ beforeSpawn, afterSpawnPersisted, maxRestarts: 1 });
		const run = s.supervisor.run();
		await tick();
		expect(events).toEqual(["before:0", "persisted:true"]);

		s.spawned[0]?.exit(1);
		await s.sleeps.release();
		expect(events).toEqual([
			"before:0",
			"persisted:true",
			"before:1",
			"persisted:true",
		]);
		s.supervisor.requestStop();
		s.spawned[1]?.exit(null, "SIGTERM");
		await run;
	});

	it("reports a synchronous spawn ambiguity and never records PUSHING", async () => {
		const onSpawnError = vi.fn(async () => {});
		const runner: ProcessRunner = {
			spawn() {
				throw new Error("spawn syscall outcome unknown");
			},
			run: vi.fn(),
		};
		const s = setup({ runner, onSpawnError });

		await expect(s.supervisor.run()).rejects.toThrow(/outcome unknown/);
		expect(onSpawnError).toHaveBeenCalledTimes(1);
		expect(s.pushes).toHaveLength(0);
	});

	it("signals a process spawned after stop arrived during attempt persistence", async () => {
		let releaseIntent: (() => void) | undefined;
		const intentGate = new Promise<void>((resolve) => {
			releaseIntent = resolve;
		});
		const s = setup();
		const originalBeginAttempt = s.store.beginAttempt.getMockImplementation();
		s.store.beginAttempt.mockImplementationOnce(async (input) => {
			await intentGate;
			if (!originalBeginAttempt) throw new Error("missing beginAttempt fake");
			return originalBeginAttempt(input);
		});
		const run = s.supervisor.run();
		await tick();
		expect(s.spawned).toHaveLength(0);

		s.supervisor.requestStop();
		releaseIntent?.();
		await tick();
		const proc = s.spawned[0];
		if (!proc) throw new Error("no spawn");
		expect(proc.killed).toEqual(["SIGTERM"]);
		proc.exit(null, "SIGTERM");
		await expect(run).resolves.toEqual({ outcome: "STOPPED" });
		expect(await s.sleeps.release()).toBe(5000);
		expect(proc.killed).toEqual(["SIGTERM"]);
	});

	it("spawns, records PUSHING with the pid, detects loop boundaries and stops on SIGTERM", async () => {
		const s = setup();
		const run = s.supervisor.run();
		await tick();
		expect(s.pushes).toEqual([4000]);

		const proc = s.spawned[0];
		if (!proc) throw new Error("no spawn");
		proc.progress(400_000); // first sample anchors loop 0
		proc.progress(9_900_000);
		proc.progress(10_300_000); // wrap → loop 1
		await tick();
		expect(s.boundaries).toEqual([
			{ loopIndex: 0, wallClock: NOW, streamTimeSec: 0.4 },
			{ loopIndex: 1, wallClock: NOW, streamTimeSec: 10.3 },
		]);

		s.supervisor.requestStop();
		expect(proc.killed).toEqual(["SIGTERM"]);
		proc.exit(null, "SIGTERM");
		await expect(run).resolves.toEqual({ outcome: "STOPPED" });
		// One spawn only — a requested stop never restarts.
		expect(s.spawned).toHaveLength(1);
	});

	it("escalates to SIGKILL when ffmpeg ignores SIGTERM past the grace period", async () => {
		const s = setup();
		const run = s.supervisor.run();
		await tick();
		const proc = s.spawned[0];
		if (!proc) throw new Error("no spawn");

		s.supervisor.requestStop();
		expect(proc.killed).toEqual(["SIGTERM"]);
		const graceMs = await s.sleeps.release(); // grace timer elapses
		expect(graceMs).toBe(5000);
		expect(proc.killed).toEqual(["SIGTERM", "SIGKILL"]);
		proc.exit(null, "SIGKILL");
		await expect(run).resolves.toEqual({ outcome: "STOPPED" });
	});

	it("does not SIGKILL when the process exits within the grace period", async () => {
		const s = setup();
		const run = s.supervisor.run();
		await tick();
		const proc = s.spawned[0];
		if (!proc) throw new Error("no spawn");
		s.supervisor.requestStop();
		proc.exit(null, "SIGTERM");
		await expect(run).resolves.toEqual({ outcome: "STOPPED" });
		await s.sleeps.release(); // grace timer fires after exit
		expect(proc.killed).toEqual(["SIGTERM"]);
	});

	it("restarts crashed pushes with exponential backoff, then exhausts to ERROR", async () => {
		const s = setup(); // maxRestarts: 2
		const run = s.supervisor.run();
		await tick();

		s.spawned[0]?.exit(1);
		expect(await s.sleeps.release()).toBe(1000); // restart 1 backoff
		expect(s.spawned).toHaveLength(2);
		s.spawned[1]?.exit(1);
		expect(await s.sleeps.release()).toBe(2000); // restart 2 backoff (doubled)
		expect(s.spawned).toHaveLength(3);
		s.spawned[2]?.exit(1);

		const result = await run;
		expect(result.outcome).toBe("ERROR");
		expect(result.error).toMatch(/2 restart attempts are exhausted/);
		expect(s.pushes).toEqual([4000, 4001, 4002]);
	});

	it("keeps loop indices monotonic across restarts (each restart begins a new loop)", async () => {
		const s = setup();
		const run = s.supervisor.run();
		await tick();
		const first = s.spawned[0];
		if (!first) throw new Error("no spawn");
		first.progress(100_000); // loop 0
		first.progress(11_000_000); // loop 1
		await tick();
		first.exit(1);
		await s.sleeps.release();

		const second = s.spawned[1];
		if (!second) throw new Error("no respawn");
		second.progress(200_000); // new ffmpeg run → loop 2
		await tick();
		expect(s.boundaries.map((b) => b.loopIndex)).toEqual([0, 1, 2]);

		s.supervisor.requestStop();
		second.exit(null, "SIGTERM");
		await run;
	});

	it("records exactly one boundary when an overshoot sample is followed by the wrap reset (synthetic progress)", async () => {
		const s = setup(); // sourceDurationSec: 10
		const run = s.supervisor.run();
		await tick();
		const proc = s.spawned[0];
		if (!proc) throw new Error("no spawn");
		proc.progress(400_000); // anchor loop 0
		proc.progress(9_900_000);
		proc.progress(10_300_000); // sample past duration → quotient boundary
		proc.progress(100_000); // clock resets for the SAME wrap → latched
		await tick();
		// Exactly one wrap boundary (plus the loop-0 anchor) — the
		// double-count sequence used to persist loop 1 AND loop 2.
		expect(s.boundaries.map((b) => b.loopIndex)).toEqual([0, 1]);

		s.supervisor.requestStop();
		proc.exit(null, "SIGTERM");
		await expect(run).resolves.toEqual({ outcome: "STOPPED" });
	});

	it("fails closed when the FeederSession pid/status write rejects", async () => {
		const afterSpawnPersisted = vi.fn(async () => {});
		const s = setup({ afterSpawnPersisted });
		s.store.setPushing.mockRejectedValueOnce(new Error("db blip"));
		const run = s.supervisor.run();
		await tick();
		expect(s.spawned).toHaveLength(1);
		const proc = s.spawned[0];
		if (!proc) throw new Error("no spawn");
		expect(proc.killed).toEqual(["SIGTERM"]);
		expect(afterSpawnPersisted).toHaveBeenCalledWith(false);
		expect(await s.sleeps.release()).toBe(5000);
		expect(proc.killed).toEqual(["SIGTERM", "SIGKILL"]);
		proc.exit(null, "SIGKILL");
		await expect(run).resolves.toMatchObject({
			outcome: "ERROR",
			error: expect.stringMatching(/FeederSession pid\/status fence: db blip/),
		});
		expect(s.attempts[0]?.observations).toEqual([]);
		const log = s.tails.flat().join("\n");
		expect(log).toContain("FeederSession pid/status fence: db blip");
	});

	it("re-earns the restart budget after a healthy (≥60s) run — hour-spaced blips never exhaust it", async () => {
		let clock = Date.parse(NOW);
		const s = setup({ now: () => new Date(clock).toISOString() }); // maxRestarts: 2
		const run = s.supervisor.run();
		await tick();

		// 6 blips, each after a 12h-healthy spawn: without the reset the
		// budget (2) would exhaust at the 3rd; with it, backoff also stays
		// at the base delay because every blip is attempt 1 again.
		for (let i = 0; i < 6; i += 1) {
			clock += 12 * 3600 * 1000;
			s.spawned[i]?.exit(1);
			expect(await s.sleeps.release()).toBe(1000);
			expect(s.spawned).toHaveLength(i + 2);
		}

		s.supervisor.requestStop();
		s.spawned[6]?.exit(null, "SIGTERM");
		await expect(run).resolves.toEqual({ outcome: "STOPPED" });
	});

	it("re-earns the restart budget after a completed loop even within 60s", async () => {
		const s = setup({ maxRestarts: 1 }); // fixed clock — only loops reset
		const run = s.supervisor.run();
		await tick();

		// 3 crashes with a full loop completed before each: budget 1 would
		// exhaust at the 2nd crash without the loop-based reset.
		for (let i = 0; i < 3; i += 1) {
			const proc = s.spawned[i];
			if (!proc) throw new Error(`no spawn ${i}`);
			proc.progress(100_000); // anchor
			proc.progress(11_000_000); // wrap → full loop completed (duration 10)
			await tick();
			proc.exit(1);
			expect(await s.sleeps.release()).toBe(1000);
		}
		expect(s.spawned).toHaveLength(4);

		s.supervisor.requestStop();
		s.spawned[3]?.exit(null, "SIGTERM");
		await expect(run).resolves.toEqual({ outcome: "STOPPED" });
	});

	it("stops cleanly when the stop arrives during restart backoff", async () => {
		const s = setup();
		const run = s.supervisor.run();
		await tick();
		s.spawned[0]?.exit(1);
		await tick(); // backoff sleep now pending
		s.supervisor.requestStop();
		await s.sleeps.release();
		await expect(run).resolves.toEqual({ outcome: "STOPPED" });
		expect(s.spawned).toHaveLength(1); // no respawn after stop
	});

	it("redacts captured stderr lines and bounds the ring buffer", async () => {
		// Flush every line so the early spawn-line snapshot is observable
		// even after the 5-line ring evicts it.
		const s = setup({ logTailSize: 5, logFlushEveryLines: 1 });
		const run = s.supervisor.run();
		await tick();
		const proc = s.spawned[0];
		if (!proc) throw new Error("no spawn");
		proc.stderr("Output #0, flv, to 'rtmp://h/live/sk-secret':");
		for (let i = 0; i < 10; i += 1) {
			proc.stderr(`noise ${i}`);
		}
		s.supervisor.requestStop();
		proc.exit(null, "SIGTERM");
		await run;
		await tick();

		const lastTail = s.tails.at(-1);
		if (!lastTail) throw new Error("no tail flushed");
		expect(lastTail.length).toBeLessThanOrEqual(5);
		expect(lastTail.join("\n")).not.toContain("sk-secret");
		// The spawn line logs the REDACTED argv form only.
		expect(s.tails.flat().join("\n")).toContain("rtmp://h/live/[REDACTED]");
		expect(s.tails.flat().join("\n")).not.toContain("sk-secret");
	});
});

/**
 *  — the tuning defaults must survive the PRODUCTION call shape.
 *
 * `setup` above passes every knob as a real number, which is why 964 worker
 * tests were green while the shipping path had all six disabled: the queue
 * processor forwards its own optionals (`maxRestarts: deps.maxRestarts, …`),
 * and `{ ...DEFAULTS, ...deps }` copies a key that EXISTS with value
 * `undefined` straight over the default. Measured on a real session: 710
 * restarts (cap 5) at zero delay and a 17,148-line log column (cap 200).
 *
 * So this block builds the supervisor the way `processor.ts` does — every
 * knob explicitly `undefined` — and asserts the behaviour the defaults buy.
 */
describe("createFeederSupervisor — bind-watchdog (ledger #95)", () => {
	const observed = (
		status: "CONNECTED" | "DISCONNECTED" | "UNKNOWN",
		sampledAt: string | null = NOW,
		probeStartedAt: string | null = sampledAt,
	) => ({ status, sampledAt, probeStartedAt });
	/**
	 * The incident shape: ffmpeg pushed 9.5 minutes at speed 0.998x with the
	 * right URL and key, and the encoder sat in WAITING_FOR_FIRST_CONNECT
	 * the whole time — a healthy-looking push in a session the encoder never
	 * bound. The cure that worked was a FRESH handshake; the watchdog
	 * automates exactly that, bounded so it fails out loud instead of
	 * cycling forever.
	 */
	it("kills an unbound push after bindTimeout and respawns — the fresh-handshake cure, automated", async () => {
		const s = setup({ mayKeepPushing: async () => observed("DISCONNECTED") });
		const run = s.supervisor.run();
		await tick();
		const first = s.spawned[0];
		if (!first) throw new Error("no spawn");

		// The only pending sleep is the watchdog's arm.
		expect(await s.sleeps.release()).toBe(90_000);
		await tick();
		expect(first.killed).toContain("SIGTERM");
		first.exit(null, "SIGTERM");
		// Watchdog's kill-grace, then the restart backoff.
		expect(await s.sleeps.release()).toBe(5000);
		expect(await s.sleeps.release()).toBe(1000);
		await tick();
		expect(s.spawned).toHaveLength(2);
		expect(
			s.tails
				.flat()
				.some((line) => line.includes("no accepted post-start CONNECTED")),
		).toBe(true);

		// Wind down.
		s.supervisor.requestStop();
		s.spawned[1]?.exit(null, "SIGTERM");
		await expect(run).resolves.toEqual({ outcome: "STOPPED" });
	});

	it("still kills an unbound push when the diagnostic log-tail write fails", async () => {
		const s = setup({ mayKeepPushing: async () => observed("DISCONNECTED") });
		s.store.flushLogTail.mockRejectedValueOnce(new Error("db blip"));
		const run = s.supervisor.run();
		await tick();
		const first = s.spawned[0];
		if (!first) throw new Error("no spawn");

		expect(await s.sleeps.release()).toBe(90_000);
		await tick();
		expect(first.killed).toContain("SIGTERM");
		first.exit(null, "SIGTERM");
		expect(await s.sleeps.release()).toBe(5000);
		expect(await s.sleeps.release()).toBe(1000);
		await tick();

		s.supervisor.requestStop();
		s.spawned[1]?.exit(null, "SIGTERM");
		await expect(run).resolves.toEqual({ outcome: "STOPPED" });
	});

	it("clamps a zero probe interval so the watchdog always makes progress", async () => {
		const probe = vi.fn(async () => observed("DISCONNECTED"));
		const s = setup({
			mayKeepPushing: probe,
			bindProbeIntervalMs: 0,
			bindTimeoutMs: 2,
			maxBindKills: 1,
		});
		const run = s.supervisor.run();
		await tick();

		expect(await s.sleeps.release()).toBe(1);
		expect(probe).toHaveBeenCalledTimes(1);
		expect(s.spawned[0]?.killed).toEqual([]);
		expect(await s.sleeps.release()).toBe(1);
		expect(probe).toHaveBeenCalledTimes(2);
		expect(s.spawned[0]?.killed).toContain("SIGTERM");
		s.spawned[0]?.exit(null, "SIGTERM");
		expect(await s.sleeps.release()).toBe(5000);
		await expect(run).resolves.toMatchObject({ outcome: "ERROR" });
	});

	it("fails OUT LOUD after maxBindKills whole unbound sessions — no infinite fresh-handshake cycle", async () => {
		const s = setup({
			mayKeepPushing: async () => observed("DISCONNECTED"),
			maxBindKills: 2,
		});
		const run = s.supervisor.run();
		await tick();
		// Session 1: watchdog kill.
		expect(await s.sleeps.release()).toBe(90_000);
		await tick();
		s.spawned[0]?.exit(null, "SIGTERM");
		expect(await s.sleeps.release()).toBe(5000); // grace
		expect(await s.sleeps.release()).toBe(1000); // backoff
		await tick();
		// Session 2: watchdog kill = budget exhausted.
		expect(await s.sleeps.release()).toBe(90_000);
		await tick();
		s.spawned[1]?.exit(null, "SIGTERM");
		const result = await run;
		expect(result.outcome).toBe("ERROR");
		expect(result.error).toContain("bounded attempts");
		expect(result.error).toContain("Cause remains unresolved");
		expect(result.error).toContain("FeederPushAttempt attempt-1, attempt-2");
	});

	it("a watchdog outliving its own spawn never touches the RESPAWN — identity-bound (review-224 I1)", async () => {
		const s = setup({ mayKeepPushing: async () => observed("DISCONNECTED") });
		const run = s.supervisor.run();
		await tick();
		const first = s.spawned[0];
		if (!first) throw new Error("no spawn");

		// Spawn #1 dies ON ITS OWN before its bind window elapses — its
		// watchdog's 90s sleep stays PENDING while the restart backoff joins
		// the queue behind it. Release the BACKOFF surgically (the queue is
		// FIFO and the whole point is firing the stale watchdog AFTER the
		// respawn exists).
		first.exit(1, null);
		for (
			let i = 0;
			i < 50 && !s.sleeps.pending.some((p) => p.ms === 1000);
			i += 1
		) {
			await tick();
		}
		const backoffIdx = s.sleeps.pending.findIndex((p) => p.ms === 1000);
		expect(backoffIdx).toBeGreaterThanOrEqual(0);
		s.sleeps.pending.splice(backoffIdx, 1)[0]?.resolve();
		await tick();
		const second = s.spawned[1];
		if (!second) throw new Error("no respawn");

		// NOW the stale watchdog #1 fires. It must recognise the spawn it was
		// armed for is gone and do NOTHING — the first cut SIGTERM+SIGKILLed
		// spawn #2 at second zero of its own bind window here.
		expect(await s.sleeps.release()).toBe(90_000);
		await tick();
		expect(second.killed).toEqual([]);
		expect(
			s.tails.flat().some((line) => line.includes("still not bound")),
		).toBe(false);

		s.supervisor.requestStop();
		second.exit(null, "SIGTERM");
		await expect(run).resolves.toEqual({ outcome: "STOPPED" });
	});

	it("does not accept a CONNECTED poll that began at the same instant as the spawn boundary", async () => {
		const s = setup({
			mayKeepPushing: async () => observed("CONNECTED", NOW),
			bindProbeIntervalMs: 1,
			bindTimeoutMs: 1,
			maxBindKills: 1,
		});
		const run = s.supervisor.run();
		await tick();
		expect(await s.sleeps.release()).toBe(1);
		expect(s.attempts[0]?.observations).toEqual([
			{ status: "CONNECTED", accepted: false },
		]);
		expect(s.spawned[0]?.killed).toContain("SIGTERM");
		s.spawned[0]?.exit(null, "SIGTERM");
		expect(await s.sleeps.release()).toBe(5000);
		await expect(run).resolves.toMatchObject({ outcome: "ERROR" });
	});

	it("does not accept a post-spawn probe carrying a predecessor heartbeat sample", async () => {
		let probeSequence = 0;
		const s = setup({
			mayKeepPushing: async () =>
				observed(
					"CONNECTED",
					new Date(Date.parse(NOW) - 1).toISOString(),
					new Date(Date.parse(NOW) + ++probeSequence).toISOString(),
				),
			bindProbeIntervalMs: 1,
			bindTimeoutMs: 2,
			maxBindKills: 1,
		});
		const run = s.supervisor.run();
		await tick();
		expect(await s.sleeps.release()).toBe(1);
		expect(await s.sleeps.release()).toBe(1);
		expect(s.attempts[0]?.observations).toEqual([
			{ status: "CONNECTED", accepted: false },
			{ status: "CONNECTED", accepted: false },
		]);
		expect(s.spawned[0]?.killed).toContain("SIGTERM");
		s.spawned[0]?.exit(null, "SIGTERM");
		expect(await s.sleeps.release()).toBe(5000);
		await expect(run).resolves.toMatchObject({ outcome: "ERROR" });
	});

	it.each([
		null,
		"not-a-provider-timestamp",
	])("fails closed when a CONNECTED probe has no usable provider sample time (%s)", async (sampledAt) => {
		const s = setup({
			mayKeepPushing: async () =>
				observed(
					"CONNECTED",
					sampledAt,
					new Date(Date.parse(NOW) + 1).toISOString(),
				),
			bindProbeIntervalMs: 1,
			bindTimeoutMs: 1,
			maxBindKills: 1,
		});
		const run = s.supervisor.run();
		await tick();
		expect(await s.sleeps.release()).toBe(1);
		expect(s.attempts[0]?.observations).toEqual([
			{ status: "CONNECTED", accepted: false },
		]);
		expect(s.spawned[0]?.killed).toContain("SIGTERM");
		s.spawned[0]?.exit(null, "SIGTERM");
		expect(await s.sleeps.release()).toBe(5000);
		await expect(run).resolves.toMatchObject({ outcome: "ERROR" });
	});

	it("does not let a static far-future provider clock value satisfy causality", async () => {
		let probeSequence = 0;
		const futureProviderSample = new Date(
			Date.parse(NOW) + 24 * 60 * 60_000,
		).toISOString();
		const s = setup({
			mayKeepPushing: async () =>
				observed(
					"CONNECTED",
					futureProviderSample,
					new Date(Date.parse(NOW) + ++probeSequence).toISOString(),
				),
			bindProbeIntervalMs: 1,
			bindTimeoutMs: 2,
			maxBindKills: 1,
		});
		const run = s.supervisor.run();
		await tick();
		expect(await s.sleeps.release()).toBe(1);
		expect(await s.sleeps.release()).toBe(1);
		expect(s.attempts[0]?.observations).toEqual([
			{ status: "CONNECTED", accepted: false },
			{ status: "CONNECTED", accepted: false },
		]);
		expect(s.spawned[0]?.killed).toContain("SIGTERM");
		s.spawned[0]?.exit(null, "SIGTERM");
		expect(await s.sleeps.release()).toBe(5000);
		await expect(run).resolves.toMatchObject({ outcome: "ERROR" });
	});

	it("never kills a push whose encoder IS bound", async () => {
		let sampleSequence = 0;
		const s = setup({
			mayKeepPushing: async () =>
				observed(
					"CONNECTED",
					new Date(Date.parse(NOW) + ++sampleSequence).toISOString(),
				),
			bindProbeIntervalMs: 1,
			bindTimeoutMs: 3,
		});
		const run = s.supervisor.run();
		await tick();
		expect(await s.sleeps.release()).toBe(1);
		expect(await s.sleeps.release()).toBe(1);
		await tick();
		expect(s.spawned[0]?.killed).toEqual([]);
		s.supervisor.requestStop();
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(run).resolves.toEqual({ outcome: "STOPPED" });
	});

	it("does not accept a pre-switch CONNECTED sample and probes repeatedly until the attempt deadline", async () => {
		const beforeAttempt = new Date(Date.parse(NOW) - 1).toISOString();
		const probe = vi.fn(async () => observed("CONNECTED", beforeAttempt));
		const s = setup({
			mayKeepPushing: probe,
			bindProbeIntervalMs: 30_000,
			bindTimeoutMs: 90_000,
		});
		const run = s.supervisor.run();
		await tick();
		const first = s.spawned[0];
		if (!first) throw new Error("no spawn");

		expect(await s.sleeps.release()).toBe(30_000);
		expect(await s.sleeps.release()).toBe(30_000);
		expect(await s.sleeps.release()).toBe(30_000);
		expect(probe).toHaveBeenCalledTimes(3);
		expect(first.killed).toContain("SIGTERM");
		expect(s.attempts[0]?.observations).toEqual([
			{ status: "CONNECTED", accepted: false },
			{ status: "CONNECTED", accepted: false },
			{ status: "CONNECTED", accepted: false },
		]);
		first.exit(null, "SIGTERM");
		await s.sleeps.release(); // kill grace
		await s.sleeps.release(); // restart backoff
		s.supervisor.requestStop();
		s.spawned[1]?.exit(null, "SIGTERM");
		await expect(run).resolves.toEqual({ outcome: "STOPPED" });
	});

	it("rejects CONNECTED sampled after intent persistence but before the process actually spawns", async () => {
		const intentAt = Date.parse(NOW);
		const predecessorConnectedAt = intentAt + 100;
		const processSpawnedAt = intentAt + 200;
		const currentProcessConnectedAt = intentAt + 300;
		let clock = intentAt;
		const spawned: FakeProcess[] = [];
		const runner: ProcessRunner = {
			spawn(_bin, _argv, events) {
				clock = processSpawnedAt;
				const proc = new FakeProcess(7000, events);
				spawned.push(proc);
				return proc;
			},
			run: vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" })),
		};
		const probe = vi
			.fn()
			.mockResolvedValueOnce(
				observed(
					"CONNECTED",
					new Date(predecessorConnectedAt).toISOString(),
					new Date(processSpawnedAt + 1).toISOString(),
				),
			)
			.mockResolvedValueOnce(
				observed(
					"CONNECTED",
					new Date(currentProcessConnectedAt).toISOString(),
					new Date(processSpawnedAt + 2).toISOString(),
				),
			);
		const s = setup({
			runner,
			now: () => new Date(clock).toISOString(),
			mayKeepPushing: probe,
			bindProbeIntervalMs: 1,
			bindTimeoutMs: 3,
		});
		const originalBeginAttempt = s.store.beginAttempt.getMockImplementation();
		s.store.beginAttempt.mockImplementationOnce(async (input) => {
			clock = predecessorConnectedAt;
			if (!originalBeginAttempt) throw new Error("missing beginAttempt fake");
			return originalBeginAttempt(input);
		});

		const run = s.supervisor.run();
		await tick();
		expect(spawned).toHaveLength(1);
		expect(await s.sleeps.release()).toBe(1);
		expect(s.attempts[0]?.observations).toEqual([
			{ status: "CONNECTED", accepted: false },
		]);
		expect(s.attempts[0]).toMatchObject({
			id: "attempt-1",
			startedAt: new Date(intentAt).toISOString(),
			processSpawnedAt: new Date(processSpawnedAt).toISOString(),
			evidenceNotBefore: new Date(processSpawnedAt).toISOString(),
			pid: 7000,
		});
		expect(await s.sleeps.release()).toBe(1);
		expect(s.attempts[0]?.observations).toEqual([
			{ status: "CONNECTED", accepted: false },
			{ status: "CONNECTED", accepted: true },
		]);

		s.supervisor.requestStop();
		spawned[0]?.exit(null, "SIGTERM");
		await expect(run).resolves.toEqual({ outcome: "STOPPED" });
	});

	it("fails closed and kills the process when its spawn boundary cannot be persisted", async () => {
		const probe = vi.fn(async () => observed("CONNECTED"));
		const afterSpawnPersisted = vi.fn(async () => {});
		const s = setup({ mayKeepPushing: probe, afterSpawnPersisted });
		s.store.attachAttemptProcess.mockRejectedValueOnce(new Error("db blip"));

		const run = s.supervisor.run();
		await tick();
		const proc = s.spawned[0];
		if (!proc) throw new Error("no spawn");
		expect(proc.killed).toEqual(["SIGTERM"]);
		expect(afterSpawnPersisted).toHaveBeenCalledWith(false);
		expect(probe).not.toHaveBeenCalled();
		expect(s.attempts[0]).toMatchObject({
			id: "attempt-1",
			startedAt: NOW,
		});
		expect(s.attempts[0]?.processSpawnedAt).toBeUndefined();
		expect(s.attempts[0]?.evidenceNotBefore).toBeUndefined();

		expect(await s.sleeps.release()).toBe(5000);
		expect(proc.killed).toEqual(["SIGTERM", "SIGKILL"]);
		proc.exit(null, "SIGKILL");
		await expect(run).resolves.toMatchObject({
			outcome: "ERROR",
			error: expect.stringMatching(/actual spawn boundary: db blip/),
		});
		expect(s.attempts[0]?.observations).toEqual([]);
	});

	it("accepts only a post-start CONNECTED sample and records that exact attempt", async () => {
		const probe = vi
			.fn()
			.mockResolvedValueOnce(
				observed("UNKNOWN", new Date(Date.parse(NOW) + 1).toISOString()),
			)
			.mockResolvedValueOnce(
				observed("CONNECTED", new Date(Date.parse(NOW) + 2).toISOString()),
			);
		const s = setup({
			mayKeepPushing: probe,
			bindProbeIntervalMs: 30_000,
			bindTimeoutMs: 90_000,
		});
		const run = s.supervisor.run();
		await tick();
		expect(await s.sleeps.release()).toBe(30_000);
		expect(await s.sleeps.release()).toBe(30_000);
		expect(s.spawned[0]?.killed).toEqual([]);
		expect(s.attempts[0]?.observations).toEqual([
			{ status: "UNKNOWN", accepted: false },
			{ status: "CONNECTED", accepted: true },
		]);
		s.supervisor.requestStop();
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(run).resolves.toEqual({ outcome: "STOPPED" });
	});

	it("requires an attempt-fenced DISCONNECTED sample to advance before ending the attempt", async () => {
		const probe = vi
			.fn()
			.mockResolvedValueOnce(
				observed("DISCONNECTED", new Date(Date.parse(NOW) + 1).toISOString()),
			)
			.mockResolvedValueOnce(
				observed("DISCONNECTED", new Date(Date.parse(NOW) + 2).toISOString()),
			);
		const s = setup({
			mayKeepPushing: probe,
			bindProbeIntervalMs: 30_000,
			bindTimeoutMs: 90_000,
		});
		const run = s.supervisor.run();
		await tick();
		expect(await s.sleeps.release()).toBe(30_000);
		expect(probe).toHaveBeenCalledTimes(1);
		expect(s.spawned[0]?.killed).toEqual([]);
		expect(await s.sleeps.release()).toBe(30_000);
		expect(probe).toHaveBeenCalledTimes(2);
		expect(s.spawned[0]?.killed).toContain("SIGTERM");
		expect(s.attempts[0]?.observations).toEqual([
			{ status: "DISCONNECTED", accepted: false },
			{ status: "DISCONNECTED", accepted: false },
		]);
		s.spawned[0]?.exit(null, "SIGTERM");
		await s.sleeps.release(); // kill grace
		await s.sleeps.release(); // restart backoff
		s.supervisor.requestStop();
		s.spawned[1]?.exit(null, "SIGTERM");
		await expect(run).resolves.toEqual({ outcome: "STOPPED" });
	});

	it("does not let a repeated predecessor DISCONNECTED sample short-circuit the attempt deadline", async () => {
		let probeSequence = 0;
		const predecessorSample = new Date(Date.parse(NOW) - 1).toISOString();
		const probe = vi.fn(async () =>
			observed(
				"DISCONNECTED",
				predecessorSample,
				new Date(Date.parse(NOW) + ++probeSequence).toISOString(),
			),
		);
		const s = setup({
			mayKeepPushing: probe,
			bindProbeIntervalMs: 30_000,
			bindTimeoutMs: 60_000,
			maxBindKills: 1,
		});
		const run = s.supervisor.run();
		await tick();

		expect(await s.sleeps.release()).toBe(30_000);
		expect(s.spawned[0]?.killed).toEqual([]);
		expect(await s.sleeps.release()).toBe(30_000);
		expect(probe).toHaveBeenCalledTimes(2);
		expect(s.spawned[0]?.killed).toContain("SIGTERM");
		expect(s.attempts[0]?.observations).toEqual([
			{ status: "DISCONNECTED", accepted: false },
			{ status: "DISCONNECTED", accepted: false },
		]);

		s.spawned[0]?.exit(null, "SIGTERM");
		expect(await s.sleeps.release()).toBe(5000);
		await expect(run).resolves.toMatchObject({ outcome: "ERROR" });
	});

	it("a probe FAILURE is UNKNOWN: not an immediate kill, but bounded by the attempt deadline", async () => {
		const s = setup({
			mayKeepPushing: async () => {
				throw new Error("db blip");
			},
		});
		const run = s.supervisor.run();
		await tick();
		expect(await s.sleeps.release()).toBe(90_000);
		await tick();
		expect(s.spawned[0]?.killed).toContain("SIGTERM");
		s.spawned[0]?.exit(null, "SIGTERM");
		await s.sleeps.release(); // kill grace
		await s.sleeps.release(); // restart backoff
		s.supervisor.requestStop();
		s.spawned[1]?.exit(null, "SIGTERM");
		await expect(run).resolves.toEqual({ outcome: "STOPPED" });
	});
});

describe("createFeederSupervisor — defaults under the processor's call shape (ledger #46)", () => {
	/** Exactly `processor.ts`'s spread: the keys are present, the values are not. */
	function setupWithUndefinedKnobs() {
		return setup({
			maxRestarts: undefined,
			backoffBaseMs: undefined,
			backoffCapMs: undefined,
			killGraceMs: undefined,
			logTailSize: undefined,
			logFlushEveryLines: undefined,
		});
	}

	it("rejects NaN knobs too — a legal `number` the type checker cannot see", async () => {
		// review-213: `!== undefined` let NaN through, and NaN reproduces this
		// incident exactly (`attempt >= NaN` false, `sleep(NaN)` immediate).
		// Nothing env-parses these knobs today, but that is what they are for,
		// and `Number(process.env.X)` on an unset var IS NaN.
		const s = setup({
			maxRestarts: Number.NaN,
			backoffBaseMs: Number.NaN,
			backoffCapMs: Number.NaN,
			killGraceMs: Number.NaN,
			logTailSize: Number.NaN,
			logFlushEveryLines: Number.NaN,
		});
		const run = s.supervisor.run();
		await tick();

		s.spawned[0]?.exit(1);
		// The DEFAULT ladder, not NaN: a real delay, and a bounded budget.
		expect(await s.sleeps.release()).toBe(1000);
		s.spawned[1]?.exit(1);
		expect(await s.sleeps.release()).toBe(2000);

		s.supervisor.requestStop();
		s.spawned[2]?.exit(0);
		await run;
	});

	it("backs off on the default ladder instead of retrying instantly", async () => {
		const s = setupWithUndefinedKnobs();
		const run = s.supervisor.run();
		await tick();

		// The defect made every one of these NaN, and sleep(NaN) resolves at once.
		s.spawned[0]?.exit(1);
		expect(await s.sleeps.release()).toBe(1000);
		s.spawned[1]?.exit(1);
		expect(await s.sleeps.release()).toBe(2000);
		s.spawned[2]?.exit(1);
		expect(await s.sleeps.release()).toBe(4000);

		s.supervisor.requestStop();
		s.spawned[3]?.exit(0);
		await run;
	});

	it("exhausts the restart budget at the default 5 rather than never", async () => {
		const s = setupWithUndefinedKnobs();
		const run = s.supervisor.run();
		await tick();

		// Five restarts are granted; the sixth exit ends the session.
		for (let i = 0; i < 5; i += 1) {
			s.spawned[i]?.exit(1);
			await s.sleeps.release();
		}
		s.spawned[5]?.exit(1);

		const result = await run;
		expect(result.outcome).toBe("ERROR");
		expect(result.error).toMatch(/5 restart attempts are exhausted/);
		// `attempt >= undefined` is never true — the defect never reached this
		// branch at all, which is why the loop had no end.
		expect(result.error).not.toMatch(/undefined/);
		expect(s.spawned).toHaveLength(6);
	});

	it("waits the default 5s grace before SIGKILL", async () => {
		const s = setupWithUndefinedKnobs();
		const run = s.supervisor.run();
		await tick();
		const proc = s.spawned[0];
		if (!proc) {
			throw new Error("supervisor spawned nothing");
		}

		s.supervisor.requestStop();
		expect(proc.killed).toEqual(["SIGTERM"]);
		// The defect made this `sleep(undefined)` — no grace at all.
		expect(await s.sleeps.release()).toBe(5000);
		expect(proc.killed).toEqual(["SIGTERM", "SIGKILL"]);
		proc.exit(null, "SIGKILL");
		await expect(run).resolves.toEqual({ outcome: "STOPPED" });
	});

	it("batches log flushes at the default 25 lines, not one write per line", async () => {
		const s = setupWithUndefinedKnobs();
		const run = s.supervisor.run();
		await tick();
		const proc = s.spawned[0];
		if (!proc) {
			throw new Error("supervisor spawned nothing");
		}

		const before = s.store.flushLogTail.mock.calls.length;
		for (let i = 0; i < 50; i += 1) {
			proc.stderr(`line ${i}`);
		}
		const writes = s.store.flushLogTail.mock.calls.length - before;
		// 50 lines at a 25-line batch is 2 writes. The defect made
		// `unflushed < undefined` false, so every captured line wrote the row —
		// 17,148 of them on the real session that exposed this.
		expect(writes).toBe(2);
		expect(writes).toBeLessThan(50);

		s.supervisor.requestStop();
		proc.exit(null, "SIGTERM");
		await run;
	});

	it("trims the log ring to the default 200 lines", async () => {
		const s = setupWithUndefinedKnobs();
		const run = s.supervisor.run();
		await tick();

		const proc = s.spawned[0];
		if (!proc) {
			throw new Error("supervisor spawned nothing");
		}
		for (let i = 0; i < 500; i += 1) {
			proc.stderr(`line ${i}`);
		}
		s.supervisor.requestStop();
		proc.exit(0);
		await run;

		const lastFlush = s.tails.at(-1) ?? [];
		// EXACTLY the cap. `toBeLessThanOrEqual(200)` did not pin it: review-213
		// changed DEFAULTS.logTailSize to 50 and the test still passed, so the
		// assertion did not say what the test's name promises.
		expect(lastFlush).toHaveLength(200);
		// Trimming keeps the RECENT end — the diagnosis lives at the tail.
		expect(lastFlush.join("\n")).toContain("line 499");
		// The head is GONE. Asserted on the first entry rather than as a
		// substring: the previous form was `not.toContain("line 0 ")` with a
		// trailing space, and ring entries are `${now} ${line}` joined by "\n",
		// so "line 0" is always followed by a newline. The substring could not
		// occur and the assertion passed unconditionally (review-213 proved it
		// by inverting it with trimming disabled — it still failed to match).
		expect(lastFlush[0]).not.toContain("line 0");
		// The retained window is the RECENT one, asserted as a property rather
		// than a literal: with 500 lines captured and a cap of 200, the oldest
		// entry kept must be at least line 300. A literal would be brittle (the
		// spawn line occupies ring slots, so the head is actually 302) and a
		// substring match is what made the previous assertion vacuous.
		const head = Number(/line (\d+)/.exec(lastFlush[0] ?? "")?.[1]);
		expect(head).toBeGreaterThanOrEqual(300);
	});
});
