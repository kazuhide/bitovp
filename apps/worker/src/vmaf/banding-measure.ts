import type { QcGate } from "@bitovp/core";
import {
	assessBandingFrames,
	BANDING_DECISION_PRECISION,
	BANDING_SCORING_VERSION,
	type BandingFrame,
	computeBandingPooled,
} from "@bitovp/core/banding";
import type { ProcessRunner } from "../feeder/supervisor";
import { officialCambiOptions, runNativeBandingScore } from "./banding-native";
import {
	assertBandingGpuGeometry,
	bandingInputFromProbe,
	runCpuBandingScore,
} from "./banding-score";
import type { LocalSelection, NativeLocalSelection } from "./local-selection";
import type { LocalResourcePlan } from "./resource-plan";

export type BandingRun = { selection: LocalSelection; gate?: QcGate };

export function bandingThresholdsFor(
	gate: QcGate | undefined,
	rendition: string,
) {
	let warningThreshold: number | undefined;
	let failureThreshold: number | undefined;
	for (const rule of gate?.rules ?? []) {
		if (
			rule.metric !== "CAMBI_MAX" ||
			(rule.renditions && !rule.renditions.includes(rendition))
		)
			continue;
		if (rule.severity === "WARN")
			warningThreshold = Math.min(warningThreshold ?? rule.lte, rule.lte);
		else failureThreshold = Math.min(failureThreshold ?? rule.lte, rule.lte);
	}
	return {
		...(warningThreshold !== undefined ? { warningThreshold } : {}),
		...(failureThreshold !== undefined ? { failureThreshold } : {}),
	};
}

export async function measureBanding(
	deps: {
		runner: ProcessRunner;
		ffmpegPath: string;
		ffprobePath: string;
		nativePath?: string;
	},
	request: {
		input: string;
		logPath: string;
		inputSha256: string;
		probe: string;
		run: BandingRun;
		rendition: string;
		signal: AbortSignal;
		allocation?: LocalResourcePlan;
		assertOwned?: () => Promise<void>;
	},
) {
	const { signal, allocation, assertOwned, run } = request;
	signal.throwIfAborted();
	const input = bandingInputFromProbe(request.probe);
	const selection = run.selection;
	let result: {
		frames: BandingFrame[];
		execution: {
			version: 1;
			metric: "CAMBI_NR";
			scoringVersion: number;
			backend: "cpu" | "cuda" | "vulkan";
			implementation: "libvmaf" | "bitovp-owned";
			decisionSource: "CPU_REFERENCE";
		} & Record<string, unknown>;
	};
	if (selection.backend !== "cpu") {
		assertBandingGpuGeometry(input);
		if (
			!deps.nativePath ||
			!assertOwned ||
			!allocation?.gpu ||
			allocation.nativeDevice !== selection.device
		)
			throw new Error("BANDING_GPU_ADMISSION_REQUIRED");
		await assertOwned();
		const selected: NativeLocalSelection = {
			backend: selection.backend,
			device: selection.device,
			identity: selection.identity,
		};
		result = await runNativeBandingScore(
			{ ...deps, nativePath: deps.nativePath },
			request.input,
			`${request.logPath}.native.json`,
			{
				...input,
				inputSha256: request.inputSha256,
				selected,
				threads: allocation.threads,
				decodeThreads: allocation.decoderThreads ?? 1,
			},
			signal,
		);
	} else {
		const cpu = await runCpuBandingScore(
			deps,
			request.input,
			request.logPath,
			signal,
			allocation?.threads ?? 1,
			request.probe,
		);
		result = {
			frames: cpu.frames,
			execution: {
				version: 1,
				metric: "CAMBI_NR",
				scoringVersion: BANDING_SCORING_VERSION,
				backend: "cpu",
				decodeBackend: "cpu",
				implementation: "libvmaf",
				libvmafVersion: cpu.libvmafVersion,
				decisionSource: "CPU_REFERENCE",
				extractor: {
					name: "cambi",
					featureName: cpu.featureName,
					options: officialCambiOptions(input),
				},
			},
		};
	}
	signal.throwIfAborted();
	await assertOwned?.();
	const pooled = computeBandingPooled(result.frames);
	const thresholds = bandingThresholdsFor(run.gate, request.rendition);
	const assessment = {
		...assessBandingFrames(result.frames, thresholds),
		...thresholds,
	};
	const first = result.frames[0],
		last = result.frames.at(-1);
	const execution = {
		...result.execution,
		decisionPrecision: BANDING_DECISION_PRECISION,
		selection: {
			requested: selection.requested,
			...("reason" in selection ? { reason: selection.reason } : {}),
		},
		coverage: {
			complete: true,
			frameCount: pooled.frameCount,
			durationSeconds: pooled.durationSeconds,
			startTimeSeconds: first?.timestampSeconds,
			endTimeSeconds: last
				? last.timestampSeconds + last.durationSeconds
				: undefined,
			timingSource: "PRESENTATION_TIMESTAMPS_AND_FRAME_DURATION",
		},
	};
	return { frames: result.frames, pooled, assessment, execution };
}
