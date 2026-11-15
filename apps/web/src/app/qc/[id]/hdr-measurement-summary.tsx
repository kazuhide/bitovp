"use client";

import { hdrMeasurementOf } from "@bitovp/core";
import { useT } from "@/lib/i18n/context";

export function HdrMeasurementSummary({
	results,
}: {
	results: readonly { hdrMeasurement?: unknown }[];
}) {
	const { t } = useT();
	const measured = results.flatMap((result) => {
		const evidence = hdrMeasurementOf(result);
		return evidence ? [evidence] : [];
	});
	if (!measured.length) return null;
	const domains = [
		...new Set(
			measured.map((evidence) => (evidence.hlgReferenceDisplay ? "HLG" : "PQ")),
		),
	];
	const models = [...new Set(measured.map((evidence) => evidence.model))];
	return (
		<details className="mt-3 rounded-md border border-zinc-800 px-3 py-2 text-xs">
			<summary className="cursor-pointer text-zinc-200 focus-visible:outline-2 focus-visible:outline-emerald-500">
				{domains.map((domain) => (
					<span key={domain} className="mr-3">
						{t(domain === "HLG" ? "qc.hdrHlgContext" : "qc.hdrPqContext")}
					</span>
				))}
				{models.map((model) => (
					<span key={model} className="mr-3 break-all font-mono text-zinc-400">
						{model}
					</span>
				))}
				<span className="text-zinc-400">{t("qc.hdrBaseLayerScope")}</span>
			</summary>
			<pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all text-zinc-400">
				{JSON.stringify(measured, null, 2)}
			</pre>
		</details>
	);
}
