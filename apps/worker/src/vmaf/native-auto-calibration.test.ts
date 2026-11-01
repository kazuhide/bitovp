import { createHash } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createNativeAutoCalibration,
	type NativeCalibrationContext,
	type NativeCalibrationTemplate,
	type NativeCalibrationTrial,
	toPolicyCandidates,
} from "./native-auto-calibration";

const MiB = 1024 ** 2;
const key = "a".repeat(64);
const otherKey = "b".repeat(64);
const serial: NativeCalibrationTemplate = {
	concurrency: 1,
	cpuThreads: 1,
	decoderThreads: 1,
	inflightFrames: 1,
};
const parallel: NativeCalibrationTemplate = { ...serial, concurrency: 2 };
let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "bitovp-calibration-test-"));
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

function context(
	changes: Partial<NativeCalibrationContext> = {},
): NativeCalibrationContext {
	return {
		signal: new AbortController().signal,
		sampleFrames: 12,
		fixedWorkUnits: 4,
		budgetMs: 1000,
		cacheable: true,
		...changes,
	};
}
function trial(
	options: { sampleFrames: number; fixedWorkUnits: number },
	changes: Partial<NativeCalibrationTrial> = {},
): NativeCalibrationTrial {
	return {
		scope: "native-with-cpu-parity",
		cpuVerified: true,
		workFrames: options.sampleFrames * options.fixedWorkUnits,
		wallMs: 100,
		maxRssBytesPerComparison: 100 * MiB,
		gpuOwnedBytesPerComparison: 40 * MiB,
		resourceSnapshotScope: "before-result-serialization",
		...changes,
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function setup(
	run?: (
		template: NativeCalibrationTemplate,
		options: {
			sampleFrames: number;
			fixedWorkUnits: number;
			signal: AbortSignal;
		},
	) => Promise<NativeCalibrationTrial>,
	leaseSignal?: AbortSignal,
) {
	let clock = 0;
	const events: string[] = [];
	let tail: Promise<unknown> = Promise.resolve();
	const execute = vi.fn(
		async (
			template: NativeCalibrationTemplate,
			options: {
				sampleFrames: number;
				fixedWorkUnits: number;
				signal: AbortSignal;
			},
		) => {
			clock += 10;
			return run ? run(template, options) : trial(options);
		},
	);
	let exclusiveCount = 0;
	const exclusive = <T>(
		work: (signal: AbortSignal) => Promise<T>,
		signal: AbortSignal,
	): Promise<T> => {
		exclusiveCount++;
		const current = tail.then(async () => {
			signal.throwIfAborted();
			events.push("acquired");
			try {
				return await work(AbortSignal.any([signal, leaseSignal ?? signal]));
			} finally {
				events.push("released");
			}
		});
		tail = current.catch(() => undefined);
		return current;
	};
	const diagnostics: string[] = [];
	const cacheDirectory = join(directory, "cache");
	const engine = createNativeAutoCalibration({
		cacheDirectory,
		runTrial: execute,
		withExclusiveCalibration: exclusive,
		now: () => clock,
		onDiagnostic: (reason) => diagnostics.push(reason),
	});
	return {
		engine,
		execute,
		exclusiveCount: () => exclusiveCount,
		events,
		diagnostics,
		cacheDirectory,
	};
}
const memoryOptions = {
	hostMarginFactor: 1.25,
	hostPerFrameBytes: 4096,
	gpuPerProcessOverheadBytes: 256 * MiB,
	gpuMarginFactor: 1.25,
};

describe("budgeted native VMAF calibration", () => {
	it("measures a serial control first and keeps raw verified observations", async () => {
		const h = setup();
		const profile = await h.engine.obtain(key, [parallel, serial], context());
		expect(h.execute.mock.calls.map(([t]) => t.concurrency)).toEqual([
			1, 1, 1, 2, 2, 2,
		]);
		expect(profile).toMatchObject({
			version: 1,
			profileKey: key,
			sampleFrames: 12,
			fixedWorkUnits: 4,
		});
		expect(profile.candidatesRaw.map((c) => c.trials.length)).toEqual([3, 3]);
		expect(profile.candidatesRaw[0]?.trials[0]).toEqual(trial(context()));
		expect(h.events).toEqual(["acquired", "released"]);
	});

	it("retains partial observations but neither qualifies nor caches them", async () => {
		const h = setup();
		const profile = await h.engine.obtain(
			key,
			[serial, parallel],
			context({ budgetMs: 15 }),
		);
		expect(h.execute).toHaveBeenCalledTimes(2);
		expect(profile.candidatesRaw[0]?.trials).toHaveLength(2);
		expect(toPolicyCandidates(profile, 240, memoryOptions)).toEqual([]);
		expect(
			(await readdir(h.cacheDirectory)).filter((n) => n.endsWith(".json")),
		).toEqual([]);
	});

	it("finishes a running trial after the soft budget and starts no more", async () => {
		const h = setup();
		const profile = await h.engine.obtain(
			key,
			[serial, parallel],
			context({ budgetMs: 25 }),
		);
		expect(h.execute).toHaveBeenCalledTimes(3);
		expect(profile.candidatesRaw).toHaveLength(1);
		expect(profile.candidatesRaw[0]?.trials).toHaveLength(3);
	});

	it("fills missing templates from a partial cache without repeating completed trials", async () => {
		const h = setup();
		await h.engine.obtain(key, [serial, parallel], context({ budgetMs: 25 }));
		const filled = await h.engine.obtain(key, [serial, parallel], context());
		expect(h.execute).toHaveBeenCalledTimes(6);
		expect(filled.candidatesRaw).toHaveLength(2);
		await h.engine.obtain(key, [serial, parallel], context());
		expect(h.execute).toHaveBeenCalledTimes(6);
	});

	it("shares identical concurrent requests while retaining independent cancellation", async () => {
		const entered = deferred<void>();
		const release = deferred<void>();
		let firstSignal: AbortSignal | undefined;
		const h = setup(async (_t, options) => {
			firstSignal ??= options.signal;
			entered.resolve();
			await release.promise;
			return trial(options);
		});
		const cancelled = new AbortController();
		const first = h.engine.obtain(
			key,
			[serial],
			context({ signal: cancelled.signal }),
		);
		const second = h.engine.obtain(key, [serial], context());
		await entered.promise;
		const reason = new Error("first waiter cancelled");
		cancelled.abort(reason);
		await expect(first).rejects.toBe(reason);
		expect(firstSignal?.aborted).toBe(false);
		release.resolve();
		expect((await second).candidatesRaw).toHaveLength(1);
		expect(h.execute).toHaveBeenCalledTimes(3);
		expect(h.exclusiveCount()).toBe(1);
	});

	it("does not swallow a larger requested template set into a smaller flight", async () => {
		const entered = deferred<void>();
		const release = deferred<void>();
		const h = setup(async (_t, options) => {
			entered.resolve();
			await release.promise;
			return trial(options);
		});
		const small = h.engine.obtain(key, [serial], context());
		await entered.promise;
		const large = h.engine.obtain(key, [serial, parallel], context());
		release.resolve();
		expect((await small).candidatesRaw).toHaveLength(1);
		expect((await large).candidatesRaw).toHaveLength(2);
		expect(h.execute).toHaveBeenCalledTimes(6);
	});

	it("does not swallow a longer budget into a shorter flight", async () => {
		const entered = deferred<void>();
		const release = deferred<void>();
		const h = setup(async (_t, options) => {
			entered.resolve();
			await release.promise;
			return trial(options);
		});
		const short = h.engine.obtain(
			key,
			[serial, parallel],
			context({ budgetMs: 25 }),
		);
		await entered.promise;
		const long = h.engine.obtain(key, [serial, parallel], context());
		release.resolve();
		expect((await short).candidatesRaw).toHaveLength(1);
		expect((await long).candidatesRaw).toHaveLength(2);
		expect(h.execute).toHaveBeenCalledTimes(6);
	});

	it("snapshots options before asynchronous lease acquisition", async () => {
		const h = setup();
		const options = context();
		const obtain = h.engine.obtain;
		const pending = obtain(key, [serial], options);
		options.sampleFrames = 24;
		options.fixedWorkUnits = 8;
		const result = await pending;
		expect(result).toMatchObject({ sampleFrames: 12, fixedWorkUnits: 4 });
		expect(
			h.execute.mock.calls.every(
				([, c]) => c.sampleFrames === 12 && c.fixedWorkUnits === 4,
			),
		).toBe(true);
	});

	it("does not release the exclusive lease before an aborted trial drains", async () => {
		const entered = deferred<void>();
		const draining = deferred<void>();
		const abortObserved = deferred<void>();
		const h = setup(async (_t, options) => {
			entered.resolve();
			await new Promise<void>((_yes, no) => {
				options.signal.addEventListener(
					"abort",
					() => {
						abortObserved.resolve();
						draining.promise.then(() => no(options.signal.reason));
					},
					{ once: true },
				);
			});
			return trial(options);
		});
		const controller = new AbortController();
		const pending = h.engine.obtain(
			key,
			[serial],
			context({ signal: controller.signal }),
		);
		await entered.promise;
		controller.abort(new Error("cancelled"));
		await expect(pending).rejects.toThrow("cancelled");
		await abortObserved.promise;
		expect(h.events).toEqual(["acquired"]);
		draining.resolve();
		await vi.waitFor(() => expect(h.events).toEqual(["acquired", "released"]));
		expect(
			(await readdir(h.cacheDirectory)).filter((n) => n.endsWith(".json")),
		).toEqual([]);
	});

	it("lets a later caller retry only after an abandoned flight has drained", async () => {
		const entered = deferred<void>();
		const drain = deferred<void>();
		let calls = 0;
		const h = setup(async (_t, options) => {
			if (++calls === 1) {
				entered.resolve();
				await new Promise<void>((_yes, no) =>
					options.signal.addEventListener(
						"abort",
						() => {
							drain.promise.then(() => no(options.signal.reason));
						},
						{ once: true },
					),
				);
			}
			return trial(options);
		});
		const controller = new AbortController();
		const cancelled = h.engine.obtain(
			key,
			[serial],
			context({ signal: controller.signal }),
		);
		await entered.promise;
		controller.abort(new Error("abandon flight"));
		await expect(cancelled).rejects.toThrow("abandon flight");
		const next = h.engine.obtain(key, [serial], context());
		await Promise.resolve();
		expect(calls).toBe(1);
		drain.resolve();
		expect((await next).candidatesRaw[0]?.trials).toHaveLength(3);
		expect(calls).toBe(4);
		expect(h.events).toEqual(["acquired", "released", "acquired", "released"]);
	});

	it("bounds a trial timeout and does not qualify unfinished work", async () => {
		const h = setup(async (_t, options) => {
			await new Promise<void>((_yes, no) =>
				options.signal.addEventListener(
					"abort",
					() => no(options.signal.reason),
					{ once: true },
				),
			);
			return trial(options);
		});
		const profile = await h.engine.obtain(
			key,
			[serial],
			context({ trialTimeoutMs: 10 }),
		);
		expect(profile.candidatesRaw).toEqual([]);
		expect(h.execute).toHaveBeenCalledTimes(1);
		expect(h.diagnostics).toContain("trial-timeout");
		expect(h.events).toEqual(["acquired", "released"]);
	});

	it("propagates lease loss independently of the caller signal", async () => {
		const entered = deferred<void>();
		const lease = new AbortController();
		const caller = new AbortController();
		const h = setup(async (_template, options) => {
			entered.resolve();
			await new Promise<void>((_resolve, reject) =>
				options.signal.addEventListener(
					"abort",
					() => reject(options.signal.reason),
					{ once: true },
				),
			);
			return trial(options);
		}, lease.signal);
		const pending = h.engine.obtain(
			key,
			[serial],
			context({ signal: caller.signal }),
		);
		await entered.promise;
		const failure = new Error("GPU reservation lost");
		lease.abort(failure);
		await expect(pending).rejects.toBe(failure);
		expect(caller.signal.aborted).toBe(false);
		expect(h.events).toEqual(["acquired", "released"]);
		expect(await readdir(h.cacheDirectory)).toEqual([]);
	});

	it.each([
		{ scope: "engine-only" },
		{ cpuVerified: false },
		{ warmup: true },
		{ workFrames: 12 },
		{ wallMs: Number.NaN },
		{ resourceSnapshotScope: "unknown" },
	])("fails invalid proof instead of publishing advice: %j", async (changes) => {
		const h = setup(
			async (_t, options) =>
				({ ...trial(options), ...changes }) as NativeCalibrationTrial,
		);
		await expect(h.engine.obtain(key, [serial], context())).rejects.toThrow(
			"NATIVE_CALIBRATION_TRIAL_INVALID",
		);
		expect(
			(await readdir(h.cacheDirectory)).filter((n) => n.endsWith(".json")),
		).toEqual([]);
	});

	it("does not mask a parity failure that arrives after the timeout", async () => {
		const failure = new Error("NATIVE_PARITY_FAILURE");
		const h = setup(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			throw failure;
		});
		await expect(
			h.engine.obtain(key, [serial], context({ trialTimeoutMs: 5 })),
		).rejects.toBe(failure);
	});

	it("stores only private atomic metadata and preserves an old reader", async () => {
		const h = setup();
		await h.engine.obtain(key, [serial], context());
		const path = join(h.cacheDirectory, `${key}-12-4.json`);
		const old = await open(path, "r");
		try {
			await h.engine.obtain(key, [serial, parallel], context());
			expect(JSON.parse(await old.readFile("utf8")).candidatesRaw).toHaveLength(
				1,
			);
			expect(
				JSON.parse(await readFile(path, "utf8")).candidatesRaw,
			).toHaveLength(2);
		} finally {
			await old.close();
		}
		expect((await stat(h.cacheDirectory)).mode & 0o777).toBe(0o700);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect(await readdir(h.cacheDirectory)).toEqual([`${key}-12-4.json`]);
	});

	it("does not read or write persistent state without permission to cache", async () => {
		const h = setup();
		await h.engine.obtain(key, [serial], context());
		const path = join(h.cacheDirectory, `${key}-12-4.json`);
		const before = createHash("sha256")
			.update(await readFile(path))
			.digest("hex");
		await chmod(h.cacheDirectory, 0o755);
		await h.engine.obtain(key, [serial], context({ cacheable: false }));
		expect(h.execute).toHaveBeenCalledTimes(6);
		expect(
			createHash("sha256")
				.update(await readFile(path))
				.digest("hex"),
		).toBe(before);
		expect((await stat(h.cacheDirectory)).mode & 0o777).toBe(0o755);
	});

	it("does not reuse a different key or sampling protocol", async () => {
		const h = setup();
		await h.engine.obtain(key, [serial], context());
		await h.engine.obtain(otherKey, [serial], context());
		await h.engine.obtain(key, [serial], context({ sampleFrames: 24 }));
		await h.engine.obtain(key, [serial], context({ fixedWorkUnits: 8 }));
		expect(h.execute).toHaveBeenCalledTimes(12);
		expect(
			(await readdir(h.cacheDirectory)).filter((n) => n.endsWith(".json")),
		).toHaveLength(4);
	});

	it.each([
		(profile: Record<string, unknown>) => {
			profile.version = 2;
		},
		(profile: Record<string, unknown>) => {
			profile.profileKey = otherKey;
		},
		(profile: Record<string, unknown>) => {
			profile.sampleFrames = 24;
		},
		(profile: Record<string, unknown>) => {
			profile.frameFeatures = ["never persist media features"];
		},
		(profile: Record<string, unknown>) => {
			profile.candidatesRaw = Array(33).fill(null);
		},
	])("rejects corrupted or foreign cache metadata %s", async (change) => {
		const h = setup();
		await h.engine.obtain(key, [serial], context());
		const path = join(h.cacheDirectory, `${key}-12-4.json`);
		const raw = JSON.parse(await readFile(path, "utf8"));
		change(raw);
		await writeFile(path, JSON.stringify(raw));
		const recovered = await h.engine.obtain(key, [serial], context());
		expect(recovered.profileKey).toBe(key);
		expect(h.execute).toHaveBeenCalledTimes(6);
		expect(h.diagnostics).toContain("cache-invalid");
	});

	it("rejects cached incomplete or unverified trials", async () => {
		const h = setup();
		await h.engine.obtain(key, [serial], context());
		const path = join(h.cacheDirectory, `${key}-12-4.json`);
		const raw = JSON.parse(await readFile(path, "utf8"));
		raw.candidatesRaw[0].trials[0].cpuVerified = false;
		await writeFile(path, JSON.stringify(raw));
		await h.engine.obtain(key, [serial], context());
		expect(h.execute).toHaveBeenCalledTimes(6);
		const partial = JSON.parse(await readFile(path, "utf8"));
		partial.candidatesRaw[0].trials.pop();
		await writeFile(path, JSON.stringify(partial));
		await h.engine.obtain(key, [serial], context());
		expect(h.execute).toHaveBeenCalledTimes(9);
	});

	it("rejects oversized metadata before parsing it", async () => {
		const h = setup();
		await h.engine.obtain(key, [serial], context());
		const path = join(h.cacheDirectory, `${key}-12-4.json`);
		const valid = await readFile(path, "utf8");
		await writeFile(path, valid + " ".repeat(256 * 1024));
		await h.engine.obtain(key, [serial], context());
		expect(h.execute).toHaveBeenCalledTimes(6);
		expect(h.diagnostics).toContain("cache-invalid");
		expect(
			(await stat(join(h.cacheDirectory, `${key}-12-4.json`))).size,
		).toBeLessThan(256 * 1024);
	});

	it("replaces a public cache file with a private verified file", async () => {
		const h = setup();
		await h.engine.obtain(key, [serial], context());
		const path = join(h.cacheDirectory, `${key}-12-4.json`);
		await chmod(path, 0o644);
		await h.engine.obtain(key, [serial], context());
		expect(h.execute).toHaveBeenCalledTimes(6);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	it("does not follow a cache-file symlink or change its target", async () => {
		const h = setup();
		await h.engine.obtain(key, [serial], context());
		const target = join(directory, "foreign.json");
		const path = join(h.cacheDirectory, `${key}-12-4.json`);
		const valid = await readFile(path, "utf8");
		await writeFile(target, valid, { mode: 0o600 });
		await rm(path);
		await symlink(target, path);
		await h.engine.obtain(key, [serial], context());
		expect(await readFile(target, "utf8")).toBe(valid);
		expect(h.execute).toHaveBeenCalledTimes(6);
	});

	it("does not write through a cache-directory symlink", async () => {
		const h = setup();
		const target = join(directory, "foreign-directory");
		await mkdir(target, { mode: 0o755 });
		await symlink(target, h.cacheDirectory);
		await h.engine.obtain(key, [serial], context());
		expect(await readdir(target)).toEqual([]);
		expect((await stat(target)).mode & 0o777).toBe(0o755);
	});

	it("cleans its temporary file after an atomic rename fails", async () => {
		let count = 0;
		const h = setup(async (_t, options) => {
			if (++count === 3)
				await mkdir(join(h.cacheDirectory, `${key}-12-4.json`));
			return trial(options);
		});
		const profile = await h.engine.obtain(key, [serial], context());
		expect(profile.candidatesRaw[0]?.trials).toHaveLength(3);
		expect(await readdir(h.cacheDirectory)).toEqual([`${key}-12-4.json`]);
		expect(h.diagnostics).toContain("cache-write-unavailable");
	});

	it("does not publish a partial success after a later parity failure", async () => {
		const h = setup(async (template, options) => {
			if (template.concurrency === 2) throw new Error("NATIVE_PARITY_FAILURE");
			return trial(options);
		});
		await expect(
			h.engine.obtain(key, [serial, parallel], context()),
		).rejects.toThrow("NATIVE_PARITY_FAILURE");
		expect(await readdir(h.cacheDirectory)).toEqual([]);
	});

	it("recomputes full-length RAM and explicitly allows for opaque GPU memory", async () => {
		const h = setup();
		const raw = await h.engine.obtain(key, [serial], context());
		const short = toPolicyCandidates(raw, 240, memoryOptions)[0];
		const long = toPolicyCandidates(raw, 259200, memoryOptions)[0];
		expect(short?.hostBytesPerComparison).toBe(125 * MiB + 240 * 4096);
		expect(long?.hostBytesPerComparison).toBe(125 * MiB + 259200 * 4096);
		expect(short?.gpuBytesPerComparison).toBe(370 * MiB);
		expect(long?.gpuBytesPerComparison).toBe(short?.gpuBytesPerComparison);
		expect(short?.memoryEstimate).toMatchObject({
			source: "sample-rss-and-owned-gpu-plus-caller-overhead",
			fullFrameCount: 240,
		});
		expect(raw.candidatesRaw[0]?.trials[0]?.maxRssBytesPerComparison).toBe(
			100 * MiB,
		);
	});

	it("rejects invalid or overflowing full-result memory assumptions", async () => {
		const h = setup();
		const raw = await h.engine.obtain(key, [serial], context());
		for (const frames of [0, Number.NaN, Number.MAX_SAFE_INTEGER])
			expect(() => toPolicyCandidates(raw, frames, memoryOptions)).toThrow(
				"NATIVE_CALIBRATION_MEMORY_ESTIMATE_INVALID",
			);
		expect(() =>
			toPolicyCandidates(raw, 240, { ...memoryOptions, gpuMarginFactor: 0.5 }),
		).toThrow("NATIVE_CALIBRATION_MEMORY_ESTIMATE_INVALID");
	});
});
