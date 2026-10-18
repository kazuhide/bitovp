"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { useT } from "@/lib/i18n/context";
import {
	type ImportedPlan,
	parseImportedPlan,
	summarizePlanSections,
} from "./plan-import";

/**
 * Paste/upload a full EncodingPlan JSON. The caller maps lossless plans into
 * its wizard; otherwise this editor preserves the original JSON for review.
 */
export function PlanImportSection({
	imported,
	onLoad,
	onDiscard,
	allowEdit = false,
}: {
	imported: ImportedPlan | null;
	onLoad(imported: ImportedPlan): void;
	onDiscard(): void;
	allowEdit?: boolean;
}) {
	const { t } = useT();
	const [text, setText] = useState("");
	const [error, setError] = useState<string | null>(null);
	const textareaId = useId();
	const fileId = useId();

	function load(source: string) {
		const result = parseImportedPlan(source, t);
		if (!result.ok) {
			setError(
				t(result.errorKey, {
					...(result.errorDetail === undefined
						? {}
						: { detail: result.errorDetail ?? t("wizardX.importParseError") }),
				}),
			);
			return;
		}
		setError(null);
		onLoad(result.imported);
	}

	if (imported) {
		const evaluation = imported.evaluation;
		return (
			<div className="space-y-3 rounded-lg border border-emerald-900 bg-zinc-950 p-4">
				<div className="flex items-center justify-between">
					<h2 className="font-medium text-sm text-zinc-200">
						{t("wizardX.importedPlan")}{" "}
						<span className="text-zinc-500">
							{typeof imported.raw.name === "string" ? imported.raw.name : ""}
						</span>
					</h2>
					{allowEdit ? (
						<Button
							variant="secondary"
							size="sm"
							onClick={() => {
								setText(JSON.stringify(imported.raw, null, 2));
								onDiscard();
							}}
						>
							{t("wizardX.importEditJson")}
						</Button>
					) : null}
					<Button variant="secondary" size="sm" onClick={onDiscard}>
						{t("wizard.discardImport")}
					</Button>
				</div>
				{!evaluation.ok ? (
					<p role="alert" className="text-red-400 text-sm">
						{t("wizardX.schemaColon")}{" "}
						{evaluation.zodMessage || t("wizard.planIsIncomplete")}
					</p>
				) : null}
				<p className="text-xs text-zinc-500">
					{t("wizard.thePlanIsSubmittedAsImportedThe")}
				</p>
				<ul className="grid grid-cols-2 gap-1 md:grid-cols-3">
					{summarizePlanSections(imported.raw).map((section) => (
						<li key={section.label}>
							<details className="rounded-md bg-zinc-900/60 px-2 py-1">
								<summary className="cursor-pointer text-xs text-zinc-300">
									{section.label}{" "}
									<span className="text-zinc-500">×{section.count}</span>
								</summary>
								<pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[10px] text-zinc-400">
									{section.json}
								</pre>
							</details>
						</li>
					))}
				</ul>
			</div>
		);
	}

	return (
		<div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
			<div className="flex items-center gap-2">
				<label
					htmlFor={textareaId}
					className="block font-medium text-sm text-zinc-200"
				>
					{t("wizard.importPlanJsonExpert")}
				</label>
				<HelpOverlay labelFor={t("wizard.importPlanJsonExpert")}>
					{t("wizard.pasteAFullEncodingplanEverySdkField")}
				</HelpOverlay>
			</div>

			<textarea
				id={textareaId}
				className="h-40 w-full rounded-md border border-zinc-800 bg-zinc-900 p-2 font-mono text-xs text-zinc-200"
				placeholder='{"planVersion": 1, "name": "…", …}'
				value={text}
				onChange={(e) => setText(e.target.value)}
			/>
			{error ? (
				<p role="alert" className="text-red-400 text-sm">
					{error}
				</p>
			) : null}
			<div className="flex items-center gap-2">
				<Button
					size="sm"
					disabled={text.trim() === ""}
					onClick={() => load(text)}
				>
					{t("ui.validateAmpLoad")}
				</Button>
				<label
					htmlFor={fileId}
					className="cursor-pointer rounded-md border border-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900 focus-within:ring-2 focus-within:ring-zinc-500"
				>
					{t("wizard.loadFile")}
					<input
						id={fileId}
						type="file"
						accept="application/json,.json"
						className="sr-only"
						onChange={async (e) => {
							const file = e.target.files?.[0];
							if (!file) {
								return;
							}
							try {
								const content = await file.text();
								setText(content);
								load(content);
							} catch {
								setError(t("wizard.couldNotReadTheSelectedFile"));
							} finally {
								e.target.value = "";
							}
						}}
					/>
				</label>
			</div>
		</div>
	);
}
