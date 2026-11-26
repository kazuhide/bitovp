import type { LocalVmafExecution } from "@bitovp/core";
import { useT } from "@/lib/i18n/context";

/** Show actual decoding and scoring separately, including CPU fallbacks. */
export function LocalExecutionSummary({
	execution,
}: {
	execution?: LocalVmafExecution;
}) {
	const { t } = useT();
	if (
		!execution ||
		(!execution.selection &&
			execution.requestedDecode === "cpu" &&
			execution.scoring.backend === "cpu")
	)
		return null;
	const selectionReason = (() => {
		switch (execution.selection?.reason) {
			case "GPU_NOT_AVAILABLE":
				return t("qc.gpuNotAvailable");
			case "GPU_RUNTIME_UNAVAILABLE":
				return t("qc.gpuRuntimeUnavailable");
			case "GPU_MODEL_UNSUPPORTED":
				return t("qc.gpuModelUnsupported");
			case "GPU_GATE_CPU_ONLY":
				return t("qc.gpuGateCpuOnly");
			// A pair that GPU scoring does not take, scored on the CPU in its
			// place (`VMAF_GPU_PAIR_REASONS`); the other pairs of the measurement
			// keep the GPU.
			case "GPU_PAIR_PIXEL_FORMAT":
				return t("qc.gpuPairPixelFormat");
			case "GPU_PAIR_COLOR_RANGE":
				return t("qc.gpuPairColorRange");
			case "GPU_PAIR_COLOR_MATRIX":
				return t("qc.gpuPairColorMatrix");
			case "GPU_PAIR_FRAME_TIMES":
				return t("qc.gpuPairFrameTimes");
			case "GPU_PAIR_INPUT":
				return t("qc.gpuPairInput");
			default:
				return execution.selection?.reason;
		}
	})();
	const decoder = (backend: "cpu" | "cuda") =>
		backend === "cuda" ? "GPU (NVDEC)" : "CPU";
	const fallback = [
		...new Set(
			[
				execution.fallbackReason,
				execution.decode.reference.reason,
				execution.decode.distorted.reason,
			].filter((reason): reason is string => Boolean(reason)),
		),
	].join(", ");
	return (
		<div className="mt-1 max-w-xs space-y-1 text-zinc-400">
			{execution.selection ? (
				<p>
					{t("qc.executionSelection")}:{" "}
					{t(
						execution.selection.requested === "AUTO"
							? "qc.executionLocalAuto"
							: "qc.executionLocalCpu",
					)}
				</p>
			) : null}
			{selectionReason ? (
				<p className="break-words">
					{t("qc.executionSelectionReason")}: {selectionReason}
				</p>
			) : null}
			<p>
				{t("qc.scoreProcessor")}:{" "}
				{execution.scoring.backend === "cpu"
					? "CPU (libvmaf)"
					: execution.scoring.implementation === "bitovp-owned"
						? t("qc.ownedGpuScoring", {
								backend:
									execution.scoring.backend === "cuda" ? "CUDA" : "Vulkan",
							})
						: t("qc.experimentalGpuScoring")}
			</p>
			<p>
				{t("qc.decodeProcessors", {
					reference: decoder(execution.decode.reference.backend),
					distorted: decoder(execution.decode.distorted.backend),
				})}
			</p>
			{fallback ? (
				<p>
					{t("qc.cpuDecodeFallback")}{" "}
					<span className="font-mono break-all">{fallback}</span>
				</p>
			) : null}
		</div>
	);
}
