"use client";

import type { PerTitleCodec } from "@bitovp/core";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/context";
import type {
	PerTitleEncodingImportedConfiguration,
	PerTitleEncodingImportResponse,
} from "./per-title-encoding-import";
import { encodingImportCopy } from "./per-title-encoding-import-copy";

const simulatorInitialSteps = [
	["minBitrateStepSize", 1.5],
	["maxBitrateStepSize", 1.9],
] as const;

export function PerTitleEncodingImportResult({
	result,
	onCancel,
	onComplete,
}: {
	result: PerTitleEncodingImportResponse;
	onCancel: () => void;
	onComplete: (configurations: PerTitleEncodingImportedConfiguration[]) => void;
}) {
	const { locale } = useT();
	const copy = encodingImportCopy[locale];
	const [selected, setSelected] = useState(
		() =>
			new Set<PerTitleCodec>(result.configurations.map(({ codec }) => codec)),
	);
	const format = (value: number) =>
		new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(
			value / 1000,
		);
	function stepInitialValues(
		configuration: PerTitleEncodingImportedConfiguration,
	) {
		const missing = simulatorInitialSteps.filter(
			([key]) => configuration.reference.global[key] === undefined,
		);
		if (!missing.length) return null;
		const values = missing
			.map(([key, value]) => `${key}: ${value}`)
			.join(locale === "ja" ? "、" : ", ");
		return (
			<span className="mt-1 block text-xs text-zinc-400">
				{copy.stepInitialValues(values)}
			</span>
		);
	}
	return (
		<>
			<div className="space-y-3 border-t border-zinc-800 pt-3">
				{result.configurations.length ? (
					<fieldset className="space-y-2">
						<legend className="mb-2 text-xs font-medium text-zinc-300">
							{copy.select}
						</legend>
						{result.configurations.map((configuration) => (
							<label
								key={configuration.codec}
								className="flex items-start gap-3 text-sm text-zinc-300"
							>
								<input
									type="checkbox"
									className="mt-1 accent-blue-500"
									checked={selected.has(configuration.codec)}
									onChange={(event) =>
										setSelected((current) => {
											const next = new Set(current);
											if (event.target.checked) next.add(configuration.codec);
											else next.delete(configuration.codec);
											return next;
										})
									}
								/>
								<span>
									<span className="font-medium">{configuration.codec}</span>
									<span className="ml-2 text-xs text-zinc-400">
										{copy.streams(configuration.reference.streams.length)} ·{" "}
										{format(configuration.goal.minBitrate)}–
										{format(configuration.goal.maxBitrate)} kbps
									</span>
									{stepInitialValues(configuration)}
								</span>
							</label>
						))}
					</fieldset>
				) : (
					<p role="status" className="text-sm text-zinc-400">
						{copy.empty}
					</p>
				)}
				{result.issues.length ? (
					<ul className="space-y-1 text-xs text-amber-300">
						{result.issues.map((issue, index) => (
							<li key={`${issue.codec}-${issue.code}-${index}`}>
								{issue.codec ? `${issue.codec}: ` : ""}
								{copy.issues[issue.code]}
								{issue.fields?.length ? (
									<span className="ml-1 font-mono">
										({issue.fields.join(", ")})
									</span>
								) : null}
							</li>
						))}
					</ul>
				) : null}
				<p className="text-xs text-zinc-400">{copy.count}</p>
			</div>
			<div className="flex flex-wrap justify-end gap-2 border-t border-zinc-800 pt-3">
				<Button type="button" variant="ghost" onClick={onCancel}>
					{copy.cancel}
				</Button>
				<Button
					type="button"
					disabled={!selected.size}
					onClick={() =>
						onComplete(
							result.configurations.filter(({ codec }) => selected.has(codec)),
						)
					}
				>
					{copy.load}
				</Button>
			</div>
		</>
	);
}
