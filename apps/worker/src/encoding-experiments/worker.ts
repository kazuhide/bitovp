import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	type ExperimentRuntime,
	experimentFrameCount,
	experimentRuntimeSchema,
	experimentTrialSchema,
} from "@bitovp/core/encoding-experiments";
import {
	experimentMediaPath,
	getExperimentRoot,
	hashExperimentMedia,
	readExperimentSource,
} from "@bitovp/core/encoding-experiments-files";
import {
	claimExperimentTrial,
	completeExperimentTrial,
	type ExperimentContext,
	getIdentityPrisma,
	getPrisma,
	getTenantPrisma,
	releaseExperimentTrial,
	renewExperimentTrial,
} from "@bitovp/db";
import { readMeasurement } from "./receipt";
import { ExperimentRunnerError, runExperimentProcess } from "./runner-process";

const leaseMs = 30_000;
const probeEveryMs = 30_000;
const measurementTimeoutMs = 750_000;
const secondaryScoringTimeoutMs = 300_000;
const localMedia = new Map<string, { stamp: string; digest: string }>();
type Claim = NonNullable<Awaited<ReturnType<typeof claimExperimentTrial>>>;

async function mediaStamp(path: string) {
	const info = await lstat(path, { bigint: true });
	if (!info.isFile()) throw new ExperimentRunnerError("SOURCE_UNAVAILABLE");
	return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

async function verifyMedia(path: string, expected: string) {
	const stamp = await mediaStamp(path);
	const cached = localMedia.get(path);
	const digest =
		cached?.stamp === stamp ? cached.digest : await hashExperimentMedia(path);
	if (digest !== expected || stamp !== (await mediaStamp(path)))
		throw new ExperimentRunnerError("SOURCE_CHANGED");
	if (localMedia.size >= 256 && !localMedia.has(path)) {
		const oldest = localMedia.keys().next().value;
		if (oldest !== undefined) localMedia.delete(oldest);
	}
	localMedia.set(path, { stamp, digest });
	return stamp;
}

async function organizationActive(id: string) {
	const row = await getIdentityPrisma().organization.findUnique({
		where: { id },
		select: { active: true },
	});
	return row?.active === true;
}

async function runTrial(
	root: string,
	runner: string,
	runtime: ExperimentRuntime,
	ctx: ExperimentContext,
	claim: Claim,
	stopping: AbortSignal,
) {
	const attempt = new AbortController();
	const signal = AbortSignal.any([stopping, attempt.signal]);
	let renewal: Promise<void> | undefined;
	const heartbeat = setInterval(() => {
		renewal ??= (async () => {
			if (
				!(await organizationActive(ctx.organizationId)) ||
				!(await renewExperimentTrial(ctx, claim, leaseMs))
			)
				attempt.abort();
		})()
			.catch(() => attempt.abort())
			.finally(() => {
				renewal = undefined;
			});
	}, 5_000);
	let scratch: string | undefined;
	let outcome:
		| Parameters<typeof completeExperimentTrial>[2]
		| "release"
		| undefined;
	try {
		const { replicateId: _, ...trial } = experimentTrialSchema.parse(
			claim.input,
		);
		const source = await readExperimentSource(
			root,
			ctx.organizationId,
			trial.sourceId,
		);
		if (source?.sha256 !== claim.sourceSha256)
			throw new ExperimentRunnerError("SOURCE_CHANGED");
		const sourcePath = experimentMediaPath(
			root,
			ctx.organizationId,
			trial.sourceId,
		);
		const stamp = await verifyMedia(sourcePath, source.sha256);
		scratch = await mkdtemp(join(root, "work", "trial-"));
		const request = join(scratch, "request.json");
		await writeFile(
			request,
			JSON.stringify({ schemaVersion: 1, sourcePath, trial }),
			{ mode: 0o600 },
		);
		const timeoutMs = trial.additionalScoringProfiles
			? measurementTimeoutMs + secondaryScoringTimeoutMs
			: measurementTimeoutMs;
		const output = await runExperimentProcess(
			"flock",
			[
				"--no-fork",
				"--exclusive",
				"--timeout",
				"30",
				"--conflict-exit-code",
				"75",
				join(root, `${runtime.gpuUuid}.lock`),
				"python3",
				runner,
				"measure",
				"--request-file",
				request,
			],
			{ timeoutMs, signal, tmpDir: scratch },
		);
		const current = await readExperimentSource(
			root,
			ctx.organizationId,
			trial.sourceId,
		);
		if (
			current?.sha256 !== source.sha256 ||
			stamp !== (await mediaStamp(sourcePath))
		)
			throw new ExperimentRunnerError("SOURCE_CHANGED");
		outcome = {
			result: readMeasurement(
				output,
				runtime,
				experimentFrameCount(trial.window),
				trial.additionalScoringProfiles,
			),
		};
	} catch (error) {
		if (!signal.aborted) {
			const code =
				error instanceof ExperimentRunnerError
					? error.code
					: "EXPERIMENT_INVALID_MEASUREMENT";
			// Contention never started this trial. Keep the claim fence and release the work.
			outcome = code === "GPU_BUSY" ? "release" : { failureCode: code };
		}
	} finally {
		clearInterval(heartbeat);
		await renewal;
		if (scratch) await rm(scratch, { recursive: true, force: true });
	}
	if (
		outcome &&
		!signal.aborted &&
		(await organizationActive(ctx.organizationId))
	) {
		if (outcome === "release") await releaseExperimentTrial(ctx, claim);
		else await completeExperimentTrial(ctx, claim, outcome);
	}
}

async function publishHealth(root: string, runtime: ExperimentRuntime) {
	const temp = join(root, `runtime-${randomUUID()}.json`);
	try {
		await writeFile(temp, JSON.stringify({ checkedAt: Date.now(), runtime }), {
			flag: "wx",
			mode: 0o640,
		});
		await rename(temp, join(root, "runtime.json"));
	} finally {
		await rm(temp, { force: true });
	}
}

async function main() {
	if (process.platform !== "linux")
		throw new Error("EXPERIMENT_WORKER_REQUIRES_LINUX");
	const root = getExperimentRoot();
	if (!root)
		throw new Error("BITOVP_EXPERIMENTS_ROOT must be an absolute managed path");
	const runner =
		process.env.BITOVP_NVENC_RUNNER ??
		resolve(
			import.meta.dirname,
			"../../../../native/nvenc-experiments/runner.py",
		);
	if (!isAbsolute(runner))
		throw new Error("BITOVP_NVENC_RUNNER must be absolute");
	const stop = new AbortController();
	process.once("SIGTERM", () => stop.abort());
	process.once("SIGINT", () => stop.abort());
	const signal = stop.signal;
	await mkdir(join(root, "work"), { recursive: true, mode: 0o700 });
	const runProbe = async () =>
		experimentRuntimeSchema.parse(
			await runExperimentProcess("python3", [runner, "probe"], {
				timeoutMs: 40_000,
				signal,
			}),
		);
	try {
		let runtime = await runProbe();
		let refresh: Promise<void> | undefined;
		let available = true;
		await publishHealth(root, runtime);
		const timer = setInterval(() => {
			refresh ??= (async () => {
				runtime = await runProbe();
				await publishHealth(root, runtime);
				available = true;
			})()
				.catch(() => {
					available = false;
					if (!signal.aborted)
						console.error("[encoding-experiments] GPU probe unavailable");
				})
				.finally(() => {
					refresh = undefined;
				});
		}, probeEveryMs);
		try {
			console.log("[encoding-experiments] worker ready");
			while (!signal.aborted) {
				let worked = false;
				const organizations = await getIdentityPrisma().organization.findMany({
					where: { active: true },
					select: { id: true },
					orderBy: { id: "asc" },
				});
				for (const { id } of organizations) {
					if (signal.aborted || !available) break;
					const ctx = { organizationId: id, prisma: getTenantPrisma(id) };
					const current = runtime;
					const claim = await claimExperimentTrial(
						ctx,
						current.runtimeId,
						leaseMs,
					);
					if (!claim) continue;
					worked = true;
					await runTrial(root, runner, current, ctx, claim, signal);
				}
				if (!worked) await sleep(2_000, undefined, { signal });
			}
		} finally {
			clearInterval(timer);
			stop.abort();
			await refresh;
		}
	} finally {
		await getPrisma().$disconnect();
	}
}

main().catch((error) => {
	if ((error as { name?: string }).name === "AbortError") return;
	console.error(
		"[encoding-experiments] worker stopped",
		error instanceof ExperimentRunnerError ? error.code : "WORKER_ERROR",
	);
	process.exitCode = 1;
});
