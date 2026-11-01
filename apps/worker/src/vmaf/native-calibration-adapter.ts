import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { VmafCommandOptions } from "@bitovp/core";
import type { ProcessRunner } from "../feeder/supervisor";
import type { AutoExecutionCandidate } from "./auto-execution-policy";
import { parseFrameRate } from "./geometry";
import {
	createNativeAutoCalibration,
	type NativeCalibrationTemplate,
	type NativeCalibrationTrial,
	toPolicyCandidates,
} from "./native-auto-calibration";
import { runNativeVmafScore } from "./native-score";
import { resourceVideoFromProbe } from "./resource-plan";

const PROXY_BYTES = 32 * 1024 ** 2;
type MemoryPadding = Parameters<typeof toPolicyCandidates>[2];
export type NativeCalibrationRequest = {
	profileKey: string;
	cacheable: boolean;
	options: VmafCommandOptions;
	referenceProbe: string;
	distortedProbe: string;
	signal: AbortSignal;
	fullFrameCount: number;
	templates: readonly NativeCalibrationTemplate[];
	/** Stable fixed work, even when current memory headroom reduces tested C. */
	fixedWorkUnits?: number;
	sampleFrames?: number;
	budgetMs?: number;
	trialTimeoutMs?: number;
	memoryPadding: MemoryPadding;
	withExclusiveCalibration<T>(
		work: (leaseSignal: AbortSignal) => Promise<T>,
		signal: AbortSignal,
	): Promise<T>;
};

/** Search priority: highest supported depth at C1/2/3/4/6/boundary, T2,
 * lower-depth controls, decoder controls, then the remaining bounded grid.
 * This is a budgeted measured search, not a claim of a global optimum. */
export function nativeCalibrationTemplates(input: {
	cpuCapacity: number;
	maxConcurrency: number;
	supportedInflightFrames: readonly (1 | 2 | 4)[];
	manualThreads?: number;
}): NativeCalibrationTemplate[] {
	if (
		!Number.isFinite(input.cpuCapacity) ||
		input.cpuCapacity < 4 ||
		!Number.isSafeInteger(input.maxConcurrency) ||
		input.maxConcurrency < 1 ||
		!input.supportedInflightFrames.length ||
		input.supportedInflightFrames.some((d) => ![1, 2, 4].includes(d)) ||
		(input.manualThreads !== undefined &&
			![1, 2, 4].includes(input.manualThreads))
	)
		return [];
	const depths = [...new Set(input.supportedInflightFrames)].sort(
		(a, b) => b - a,
	);
	const primary = depths[0];
	if (primary === undefined) return [];
	const firstThreads = (input.manualThreads ?? 1) as 1 | 2 | 4;
	const limit = Math.min(
		32,
		input.maxConcurrency,
		Math.floor(input.cpuCapacity / (firstThreads + 3)),
	);
	if (limit < 1) return [];
	const priorities = [...new Set([1, 2, 3, 4, 6, limit])].filter(
		(c) => c <= limit,
	);
	const templates: NativeCalibrationTemplate[] = [];
	const seen = new Set<string>();
	const add = (
		concurrency: number,
		cpuThreads: 1 | 2 | 4,
		decoderThreads: 1 | 2,
		inflightFrames: 1 | 2 | 4,
	) => {
		const key = [concurrency, cpuThreads, decoderThreads, inflightFrames].join(
			":",
		);
		if (
			templates.length === 32 ||
			seen.has(key) ||
			concurrency * (cpuThreads + 2 * decoderThreads + 1) > input.cpuCapacity
		)
			return;
		seen.add(key);
		templates.push({ concurrency, cpuThreads, decoderThreads, inflightFrames });
	};
	for (const c of priorities) add(c, firstThreads, 1, primary);
	if (input.manualThreads === undefined)
		for (const c of priorities) add(c, 2, 1, primary);
	for (const depth of depths.slice(1))
		for (const c of priorities) add(c, firstThreads, 1, depth);
	for (const c of priorities) add(c, firstThreads, 2, primary);
	for (let c = 1; c <= limit; c++)
		for (const threads of input.manualThreads === undefined
			? ([1, 2, 4] as const)
			: [firstThreads])
			for (const depth of depths)
				for (const decoder of [1, 2] as const) add(c, threads, decoder, depth);
	return templates;
}

function metadata(text: string) {
	const parsed = JSON.parse(text) as { streams?: Record<string, unknown>[] };
	const videos = parsed.streams?.filter((s) => s.codec_type === "video");
	const stream = videos?.[0];
	if (videos?.length !== 1 || !stream)
		throw new Error("NATIVE_CALIBRATION_INPUT_METADATA_INVALID");
	const video = resourceVideoFromProbe(text);
	const fps =
		parseFrameRate(
			typeof stream.avg_frame_rate === "string"
				? stream.avg_frame_rate
				: undefined,
		) ??
		parseFrameRate(
			typeof stream.r_frame_rate === "string" ? stream.r_frame_rate : undefined,
		);
	if (!fps || fps <= 0 || !video.bitDepth || !video.codec)
		throw new Error("NATIVE_CALIBRATION_INPUT_METADATA_INVALID");
	return { ...video, fps };
}

type Proxies = {
	referencePath: string;
	distortedPath: string;
	referenceProbe: string;
	distortedProbe: string;
};
type Session = {
	request: NativeCalibrationRequest;
	signal: AbortSignal;
	directory?: string;
	proxies?: Promise<Proxies>;
	ordinal: number;
};
type Scope = { request: NativeCalibrationRequest; session?: Session };

/** Only disposable prefixes and raw timing metadata are produced here. Real
 * measurements still score the original full inputs through the normal path. */
export function createNativeCalibrationAdapter(deps: {
	runner: ProcessRunner;
	ffmpegPath: string;
	ffprobePath: string;
	nativePath: string;
	cacheDirectory: string;
	workDirectory: string;
	onDiagnostic?: (reason: string) => void;
}) {
	if (!isAbsolute(deps.workDirectory))
		throw new Error("NATIVE_CALIBRATION_WORK_PATH_INVALID");
	const local = new AsyncLocalStorage<Scope>();
	async function prepare(
		session: Session,
		sampleFrames: number,
		signal: AbortSignal,
	): Promise<Proxies> {
		signal.throwIfAborted();
		await mkdir(deps.workDirectory, { recursive: true, mode: 0o700 });
		const root = await lstat(deps.workDirectory);
		if (
			!root.isDirectory() ||
			(process.getuid && root.uid !== process.getuid())
		)
			throw new Error("NATIVE_CALIBRATION_WORK_PATH_INVALID");
		await chmod(deps.workDirectory, 0o700);
		signal.throwIfAborted();
		const directory = await mkdtemp(
			join(deps.workDirectory, "native-calibration-"),
		);
		session.directory = directory;
		await chmod(directory, 0o700);
		const copy = async (
			source: string,
			originalProbe: string,
			label: string,
		) => {
			const original = metadata(originalProbe);
			const path = join(directory, `${label}.mkv`);
			const duration = Math.min(30, (sampleFrames + 64) / original.fps + 1);
			if (sampleFrames / original.fps > 30)
				throw new Error("NATIVE_CALIBRATION_PROXY_DURATION_INVALID");
			signal.throwIfAborted();
			const copied = await deps.runner.run(
				deps.ffmpegPath,
				[
					"-hide_banner",
					"-loglevel",
					"error",
					"-nostdin",
					"-y",
					"-copyts",
					"-start_at_zero",
					"-i",
					source,
					"-map",
					"0:v:0",
					"-an",
					"-sn",
					"-dn",
					"-c:v",
					"copy",
					"-t",
					String(duration),
					"-frames:v",
					String(sampleFrames + 64),
					"-fs",
					String(PROXY_BYTES - 1024 ** 2),
					"-avoid_negative_ts",
					"disabled",
					"-f",
					"matroska",
					path,
				],
				{ signal, abortKillAfterMs: 250 },
			);
			signal.throwIfAborted();
			if (copied.code !== 0)
				throw new Error("NATIVE_CALIBRATION_PROXY_COPY_FAILED");
			const file = await lstat(path);
			if (!file.isFile() || !file.size || file.size > PROXY_BYTES)
				throw new Error("NATIVE_CALIBRATION_PROXY_SIZE_INVALID");
			await chmod(path, 0o600);
			const probed = await deps.runner.run(
				deps.ffprobePath,
				["-v", "error", "-show_streams", "-of", "json", path],
				{ signal, abortKillAfterMs: 250 },
			);
			signal.throwIfAborted();
			if (probed.code !== 0)
				throw new Error("NATIVE_CALIBRATION_PROXY_PROBE_FAILED");
			const proxy = metadata(probed.stdout);
			if (
				proxy.width !== original.width ||
				proxy.height !== original.height ||
				proxy.bitDepth !== original.bitDepth ||
				proxy.codec !== original.codec ||
				Math.abs(proxy.fps - original.fps) > 1e-6
			)
				throw new Error("NATIVE_CALIBRATION_PROXY_FORMAT_MISMATCH");
			return { path, probe: probed.stdout };
		};
		// Sequential preparation keeps the packet-copy stage inside the same small
		// CPU allowance; the verified native worker checks decoded PTS and count.
		const reference = await copy(
			session.request.options.referencePath,
			session.request.referenceProbe,
			"reference",
		);
		const distorted = await copy(
			session.request.options.distortedPath,
			session.request.distortedProbe,
			"distorted",
		);
		return {
			referencePath: reference.path,
			referenceProbe: reference.probe,
			distortedPath: distorted.path,
			distortedProbe: distorted.probe,
		};
	}
	// Share metadata across calls, never an in-flight job's original media.
	const createEngine = () =>
		createNativeAutoCalibration({
			cacheDirectory: deps.cacheDirectory,
			onDiagnostic: deps.onDiagnostic,
			async withExclusiveCalibration(work, internalSignal) {
				const scope = local.getStore();
				if (!scope) throw new Error("NATIVE_CALIBRATION_SCOPE_MISSING");
				return scope.request.withExclusiveCalibration(async (leaseSignal) => {
					const session: Session = {
						request: scope.request,
						signal: AbortSignal.any([internalSignal, leaseSignal]),
						ordinal: 0,
					};
					return local.run({ ...scope, session }, async () => {
						try {
							return await work(session.signal);
						} finally {
							await session.proxies?.catch(() => undefined);
							if (session.directory)
								await rm(session.directory, { recursive: true, force: true });
						}
					});
				}, internalSignal);
			},
			async runTrial(template, context): Promise<NativeCalibrationTrial> {
				const session = local.getStore()?.session;
				if (!session) throw new Error("NATIVE_CALIBRATION_SCOPE_MISSING");
				const failed = new AbortController();
				const signal = AbortSignal.any([
					context.signal,
					session.signal,
					failed.signal,
				]);
				signal.throwIfAborted();
				session.proxies ??= prepare(session, context.sampleFrames, signal);
				const proxies = await session.proxies;
				const directory = session.directory;
				if (!directory) throw new Error("NATIVE_CALIBRATION_SCOPE_MISSING");
				signal.throwIfAborted();
				const results: { rss: number; gpu: number }[] = [];
				let next = 0;
				let error: unknown;
				const started = performance.now();
				const workers = Array.from(
					{ length: Math.min(template.concurrency, context.fixedWorkUnits) },
					async () => {
						while (!signal.aborted) {
							if (next++ >= context.fixedWorkUnits) return;
							const logPath = join(
								directory,
								`trial-${++session.ordinal}.json`,
							);
							try {
								const scored = await runNativeVmafScore(
									deps,
									{
										...session.request.options,
										referencePath: proxies.referencePath,
										distortedPath: proxies.distortedPath,
										logPath,
										threads: template.cpuThreads,
										decoderThreads: template.decoderThreads,
									},
									{
										signal,
										referenceProbe: proxies.referenceProbe,
										distortedProbe: proxies.distortedProbe,
										nativeInflightFrames: template.inflightFrames,
										calibrationFrames: context.sampleFrames,
									},
								);
								signal.throwIfAborted();
								const scoring = scored.execution.scoring,
									memory = scored.resourceSnapshot;
								if (
									scoring.implementation !== "bitovp-owned" ||
									scoring.cpuParity.checked !== true ||
									scoring.cpuParity.scoreCount !== context.sampleFrames ||
									scored.log.frames.length !== context.sampleFrames ||
									!memory ||
									memory.scope !== "before-result-serialization" ||
									![memory.maxRssBytes, memory.gpuOwnedBytes].every(
										(n) => Number.isSafeInteger(n) && n > 0,
									)
								)
									throw new Error("NATIVE_CALIBRATION_RESULT_INVALID");
								results.push({
									rss: memory.maxRssBytes,
									gpu: memory.gpuOwnedBytes,
								});
							} catch (caught) {
								error ??= caught;
								failed.abort(caught);
								throw caught;
							}
						}
					},
				);
				// A failed child aborts its siblings, but the lease and files remain until
				// every native process has reaped its descendants and settled.
				await Promise.allSettled(workers);
				if (error !== undefined) throw error;
				signal.throwIfAborted();
				if (results.length !== context.fixedWorkUnits)
					throw new Error("NATIVE_CALIBRATION_RESULT_INVALID");
				return {
					scope: "native-with-cpu-parity",
					cpuVerified: true,
					workFrames: context.sampleFrames * context.fixedWorkUnits,
					wallMs: performance.now() - started,
					maxRssBytesPerComparison: Math.max(...results.map((r) => r.rss)),
					gpuOwnedBytesPerComparison: Math.max(...results.map((r) => r.gpu)),
					resourceSnapshotScope: "before-result-serialization",
				};
			},
		});
	return {
		async calibrate(
			input: NativeCalibrationRequest,
		): Promise<AutoExecutionCandidate[]> {
			input.signal.throwIfAborted();
			const request = {
				...input,
				options: structuredClone(input.options),
				templates: input.templates.map((t) => ({ ...t })),
				memoryPadding: { ...input.memoryPadding },
			};
			const sampleFrames =
				request.sampleFrames ?? Math.min(16, request.fullFrameCount);
			const fixedWorkUnits =
				request.fixedWorkUnits ??
				Math.max(1, ...request.templates.map((t) => t.concurrency));
			toPolicyCandidates(
				{
					version: 1,
					profileKey: request.profileKey,
					sampleFrames,
					fixedWorkUnits,
					candidatesRaw: [],
				},
				request.fullFrameCount,
				request.memoryPadding,
			);
			if (
				!isAbsolute(request.options.referencePath) ||
				!isAbsolute(request.options.distortedPath)
			)
				throw new Error("NATIVE_CALIBRATION_INPUT_PATH_INVALID");
			if (!request.templates.length) return [];
			return local.run({ request }, async () => {
				const raw = await createEngine().obtain(
					request.profileKey,
					request.templates,
					{
						signal: request.signal,
						sampleFrames,
						fixedWorkUnits,
						budgetMs: request.budgetMs ?? 15000,
						trialTimeoutMs: request.trialTimeoutMs,
						cacheable: request.cacheable,
					},
				);
				return toPolicyCandidates(
					raw,
					request.fullFrameCount,
					request.memoryPadding,
				).filter((candidate) =>
					request.templates.some(
						(t) =>
							t.concurrency === candidate.concurrency &&
							t.cpuThreads === candidate.cpuThreads &&
							t.decoderThreads === candidate.decoderThreads &&
							t.inflightFrames === candidate.inflightFrames,
					),
				);
			});
		},
	};
}
