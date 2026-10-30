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
		(execution.requestedDecode === "cpu" && execution.scoring.backend === "cpu")
	)
		return null;
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
			<p>
				{t("qc.scoreProcessor")}:{" "}
				{execution.scoring.backend === "cuda"
					? t("qc.experimentalGpuScoring")
					: "CPU (libvmaf)"}
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
