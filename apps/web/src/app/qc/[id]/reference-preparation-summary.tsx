"use client";

import { referencePreparationOf } from "@bitovp/core";
import { useT } from "@/lib/i18n/context";
import { renditionLabel, type VmafResultDetail } from "../vmaf-shared";

/** A compact disclosure, backed by validated per-result verification evidence. */
export function ReferencePreparationSummary({
	results,
}: {
	results: readonly Pick<
		VmafResultDetail,
		"id" | "renditionRef" | "referencePreparation"
	>[];
}) {
	const { t } = useT();
	const prepared = results.flatMap((result, index) => {
		const evidence = referencePreparationOf(result);
		return evidence
			? [
					{
						id: result.id,
						label: renditionLabel(result.renditionRef, index),
						evidence,
					},
				]
			: [];
	});
	if (prepared.length === 0) return null;
	return (
		<details className="mt-6 rounded-md border border-zinc-800 px-3 py-2">
			<summary className="cursor-pointer text-amber-200 text-sm focus-visible:outline-2 focus-visible:outline-emerald-500">
				{t("qc.referencePreparationSummary")}
			</summary>
			<p className="mt-2 text-xs text-zinc-400">
				{t("qc.referencePreparationDescription")}
			</p>
			{prepared.map(({ id, label, evidence }) => (
				<div key={id} className="mt-3">
					<p className="text-xs text-zinc-300">{label}</p>
					<pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs text-zinc-400">
						{JSON.stringify(evidence, null, 2)}
					</pre>
				</div>
			))}
		</details>
	);
}
