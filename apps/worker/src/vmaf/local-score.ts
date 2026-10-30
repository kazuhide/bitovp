import { readFile, rm } from "node:fs/promises";
import {
	buildVmafCommand,
	type LocalVmafExecution,
	type VmafCommandOptions,
} from "@bitovp/core";
import type { ProcessRunner } from "../feeder/supervisor";
import {
	type DecodePolicy,
	type DecodeSelection,
	hardwareDecodeFailureReason,
	selectHardwareDecode,
} from "./hardware-decode";
import { prepareVmafxModel, verifyVmafxReceipt } from "./vmafx-contract";

type InputExecution = { backend: "cpu" | "cuda"; reason?: string };

export type { LocalVmafExecution } from "@bitovp/core";

type LocalScoreDeps = {
	runner: ProcessRunner;
	ffmpegPath: string;
	ffprobePath: string;
	decodePolicy?: DecodePolicy;
};

export async function runLocalVmafScore(
	deps: LocalScoreDeps,
	options: VmafCommandOptions,
	context: {
		signal?: AbortSignal;
		referenceProbe?: string;
		distortedProbe?: string;
	} = {},
): Promise<{
	run: { code: number | null; stderr: string };
	execution: LocalVmafExecution;
	/** Parsed once; the processor reuses it instead of loading a large log twice. */
	log?: unknown;
}> {
	const { signal } = context;
	const policy = deps.decodePolicy ?? { backend: "cpu", device: 0 };
	const softwareDecodeOptions = { ...options, decode: undefined };
	const execution: LocalVmafExecution = {
		version: 1,
		requestedDecode: policy.backend,
		...(policy.backend !== "cpu" || options.scoring
			? { device: options.scoring?.device ?? policy.device }
			: {}),
		decode: { reference: { backend: "cpu" }, distorted: { backend: "cpu" } },
		scoring: {
			backend: "cpu",
			implementation: "libvmaf",
			model: options.model,
		},
		attempts: 1,
	};
	const score = (scoringOptions: VmafCommandOptions) => {
		signal?.throwIfAborted();
		return deps.runner.run(deps.ffmpegPath, buildVmafCommand(scoringOptions), {
			signal,
			abortKillAfterMs: 250,
		});
	};
	// Validate before launching any input probes. A different scorer is always
	// explicit, and never falls back to libvmaf or another VMAF model.
	buildVmafCommand(softwareDecodeOptions);
	const model = options.scoring ? await prepareVmafxModel(options) : undefined;
	const expected =
		model && options.scaleToReference && options.distortedOriginal
			? {
					model: options.model,
					modelSha256: model.modelSha256,
					width: options.scaleToReference.width,
					height: options.scaleToReference.height,
					psnr:
						options.psnr === true ||
						options.features?.includes("psnr") === true,
					distortedOriginal: options.distortedOriginal,
				}
			: undefined;
	if (options.scoring && !expected)
		throw new Error("VMAFX_REQUIRES_COMPARISON_GEOMETRY");
	const finish = async (run: { code: number | null; stderr: string }) => {
		signal?.throwIfAborted();
		if (run.code !== 0 || !expected) return { run, execution };
		const log: unknown = JSON.parse(await readFile(options.logPath, "utf8"));
		signal?.throwIfAborted();
		execution.scoring = verifyVmafxReceipt(log, expected);
		return { run, execution, log };
	};
	const qualifyScoring = async (scoringOptions: VmafCommandOptions) => {
		if (!expected) return;
		const checkLog = `${options.logPath}.gpu-check.json`;
		const timeout = new AbortController();
		const timer = setTimeout(() => timeout.abort(), 30_000);
		timer.unref();
		try {
			await rm(checkLog, { force: true });
			const args = buildVmafCommand({ ...scoringOptions, logPath: checkLog });
			args.splice(args.length - 3, 0, "-frames:v", "8");
			const run = await deps.runner.run(deps.ffmpegPath, args, {
				signal: signal
					? AbortSignal.any([signal, timeout.signal])
					: timeout.signal,
				abortKillAfterMs: 250,
			});
			signal?.throwIfAborted();
			if (timeout.signal.aborted)
				throw new Error("VMAFX_GPU_QUALIFICATION_TIMEOUT");
			if (run.code !== 0) throw new Error("VMAFX_GPU_QUALIFICATION_FAILED");
			verifyVmafxReceipt(
				JSON.parse(await readFile(checkLog, "utf8")),
				expected,
			);
		} finally {
			clearTimeout(timer);
			await rm(checkLog, { force: true });
		}
	};
	if (policy.backend === "cpu") {
		await qualifyScoring(softwareDecodeOptions);
		return finish(await score(softwareDecodeOptions));
	}
	// This method is separately validated by the cloud worker. Do not silently
	// give a local hardware attempt the same measurement label.
	if (options.measurementMethod)
		throw new Error("GPU_DECODE_NOT_QUALIFIED_FOR_FRAME_INDEX_METHOD");

	const select = async (path: string, existingProbe: string | undefined) => {
		signal?.throwIfAborted();
		let probe = existingProbe;
		if (probe === undefined) {
			const result = await deps.runner.run(
				deps.ffprobePath,
				["-v", "error", "-show_streams", "-of", "json", path],
				{ signal, abortKillAfterMs: 250 },
			);
			signal?.throwIfAborted();
			if (result.code !== 0)
				throw new Error("Cannot probe VMAF input for hardware decoding");
			probe = result.stdout;
		}
		return selectHardwareDecode({
			policy,
			probe,
			path,
			runner: deps.runner,
			ffmpegPath: deps.ffmpegPath,
			signal,
		});
	};
	// Probes are short and sequential; memory admission remains held for the
	// entire attempt and any CPU retry by the caller's resource session.
	const distorted = await select(options.distortedPath, context.distortedProbe);
	const reference = await select(options.referencePath, context.referenceProbe);
	const describe = (selection: DecodeSelection): InputExecution => ({
		backend: selection.cuda ? "cuda" : "cpu",
		...(selection.reason ? { reason: selection.reason } : {}),
	});
	execution.decode = {
		reference: describe(reference),
		distorted: describe(distorted),
	};
	const usesCuda = Boolean(reference.cuda || distorted.cuda);
	const selectedOptions = {
		...softwareDecodeOptions,
		decode: { reference: reference.cuda, distorted: distorted.cuda },
	};
	await qualifyScoring(selectedOptions);
	const run = await score(selectedOptions);
	signal?.throwIfAborted();
	const reason =
		run.code !== 0 && usesCuda
			? hardwareDecodeFailureReason(run.stderr)
			: undefined;
	if (policy.backend !== "auto" || !reason) return finish(run);

	// The runner resolves only after child close. Discard a partial GPU log
	// before one CPU retry so an unsuccessful retry cannot reuse stale scores.
	await rm(options.logPath, { force: true });
	signal?.throwIfAborted();
	execution.attempts = 2;
	execution.fallbackReason = reason;
	for (const input of ["reference", "distorted"] as const) {
		if (execution.decode[input].backend === "cuda")
			execution.decode[input] = { backend: "cpu", reason };
	}
	return finish(await score(softwareDecodeOptions));
}
