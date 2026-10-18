"use client";

import {
	diffPlans,
	type EncodingPlan,
	encodingPlanSchema,
	type PlanDiffEntry,
	type PlanIssue,
} from "@bitovp/core";
import { SAMPLE_PRESETS } from "@bitovp/core/presets";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import { presetTitleKey } from "@/lib/preset-copy";
import type { PlanEvaluation } from "./plan-preview";

type PlanPresetSummary = {
	id: string;
	name: string;
	description: string | null;
	createdAt: string;
};

/** One value for the baseline <select> — a sample fixture or a user preset. */
type Baseline =
	| { kind: "sample"; name: string }
	| { kind: "user"; id: string; name: string };

const BASELINE_SEP = "::";

/** Serialize/parse the <select> value so the two preset kinds share one control. */
function encodeBaseline(b: Baseline): string {
	return b.kind === "sample"
		? `sample${BASELINE_SEP}${b.name}`
		: `user${BASELINE_SEP}${b.id}${BASELINE_SEP}${b.name}`;
}
function decodeBaseline(value: string): Baseline | null {
	// Names may themselves contain the separator, so rejoin the trailing
	// segments rather than positionally destructuring. The id is a UUID and the
	// sample key is a controlled identifier, so neither contains BASELINE_SEP.
	const parts = value.split(BASELINE_SEP);
	const [kind, a] = parts;
	if (kind === "sample" && a) {
		return { kind: "sample", name: parts.slice(1).join(BASELINE_SEP) };
	}
	if (kind === "user" && a && parts.length >= 3) {
		return { kind: "user", id: a, name: parts.slice(2).join(BASELINE_SEP) };
	}
	return null;
}

/**
 * Parse a baseline preset body (a sample fixture or a saved user preset — both
 * secret-free EncodingPlan JSON) into the canonical, defaults-filled form so a
 * diff against the wizard's already-parsed built plan compares like with like
 * (the wizard's plan came through the same `encodingPlanSchema`). Falls back to
 * the raw body if it somehow does not parse, so the diff still renders.
 */
function canonicalize(body: unknown): unknown {
	const parsed = encodingPlanSchema.safeParse(body);
	return parsed.success ? parsed.data : body;
}

function DiffRow({ entry }: { entry: PlanDiffEntry }) {
	const { t } = useT();
	const tone =
		entry.change === "added"
			? "text-emerald-300"
			: entry.change === "removed"
				? "text-red-300"
				: "text-amber-300";
	const sign =
		entry.change === "added" ? "+" : entry.change === "removed" ? "−" : "~";
	return (
		<li className="border-zinc-800 border-b py-1.5 last:border-b-0">
			<div className="flex items-baseline gap-2">
				<span className={`font-mono text-xs ${tone}`}>{sign}</span>
				<code className="break-all font-mono text-[11px] text-zinc-300">
					{entry.path || "(root)"}
				</code>
				<span className={`ml-auto text-[10px] uppercase ${tone}`}>
					{entry.change}
				</span>
			</div>
			{entry.change !== "added" ? (
				<div className="mt-0.5 pl-5">
					<span className="text-[10px] text-zinc-500">
						{t("wizard.preset")}{" "}
					</span>
					<code className="break-all font-mono text-[11px] text-red-300/80">
						{JSON.stringify(entry.before)}
					</code>
				</div>
			) : null}
			{entry.change !== "removed" ? (
				<div className="mt-0.5 pl-5">
					<span className="text-[10px] text-zinc-500">
						{t("wizard.current")}{" "}
					</span>
					<code className="break-all font-mono text-[11px] text-emerald-300/80">
						{JSON.stringify(entry.after)}
					</code>
				</div>
			) : null}
		</li>
	);
}

/**
 * Save-as-preset + diff-vs-preset + an explicit validate summary for the
 * wizard's Review step. The current built plan arrives via `evaluation` (the
 * same live core evaluation the preview rail uses — the "Validate-only"
 * substance is that result; we just surface it as a clear pass/fail line).
 *
 * The plan body is secret-free (credentialId refs only — same JSON as the 56
 * samples and the raw-JSON import), so POSTing it to /api/presets and diffing
 * returned preset bodies is safe.
 */
export function PlanPresetsPanel({
	evaluation,
}: {
	evaluation: PlanEvaluation;
}) {
	const { t } = useT();
	const queryClient = useQueryClient();
	const nameId = useId();
	const descId = useId();
	const baselineId = useId();

	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [baselineValue, setBaselineValue] = useState("");

	// The validation rail already computes this — read it, don't recompute.
	const blockingIssues = evaluation.ok
		? evaluation.issues.filter((i: PlanIssue) => i.level === "error")
		: [];
	const planValid = evaluation.ok && blockingIssues.length === 0;
	const currentPlan: EncodingPlan | null = planValid ? evaluation.plan : null;

	const userPresets = useQuery({
		queryKey: ["plan-presets"],
		queryFn: () => apiFetch<PlanPresetSummary[]>("/api/presets"),
	});

	const save = useMutation({
		mutationFn: () =>
			apiFetch<PlanPresetSummary>("/api/presets", {
				method: "POST",
				body: JSON.stringify({
					name: name.trim(),
					description: description.trim() || undefined,
					plan: currentPlan,
				}),
			}),
		onSuccess: () => {
			setName("");
			setDescription("");
			queryClient.invalidateQueries({ queryKey: ["plan-presets"] });
		},
	});

	const baseline = decodeBaseline(baselineValue);
	const baselineBody = useQuery({
		queryKey: ["preset-baseline", baselineValue],
		enabled: baseline !== null,
		retry: false,
		queryFn: async () => {
			if (!baseline) {
				return null;
			}
			if (baseline.kind === "sample") {
				return apiFetch<Record<string, unknown>>(
					`/api/sample-presets/${encodeURIComponent(baseline.name)}`,
				);
			}
			const full = await apiFetch<{ body: unknown }>(
				`/api/presets/${baseline.id}`,
			);
			return full.body as Record<string, unknown>;
		},
	});

	const diff: PlanDiffEntry[] | null = useMemo(() => {
		if (!currentPlan || !baseline || !baselineBody.data) {
			return null;
		}
		return diffPlans(canonicalize(baselineBody.data), currentPlan);
	}, [currentPlan, baseline, baselineBody.data]);

	return (
		<section className="space-y-5 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
			<div className="flex items-center gap-2">
				<h2 className="font-medium text-sm text-zinc-200">
					{t("ui.validateSaveAmpCompare")}
				</h2>
				{evaluation.ok ? (
					planValid ? (
						<Badge tone="ok">{t("wizard.valid")}</Badge>
					) : (
						<Badge tone="error">
							{t(
								blockingIssues.length === 1
									? "wizardX.issueCountOne"
									: "wizardX.issueCountOther",
								{ count: blockingIssues.length },
							)}
						</Badge>
					)
				) : (
					<Badge tone="error">{t("wizard.incomplete")}</Badge>
				)}
			</div>

			{/* --- Save as preset --- */}
			<div className="space-y-2">
				<h3 className="font-medium text-xs text-zinc-400">
					{t("wizard.saveAsPreset")}
				</h3>
				<Field label={t("wizard.presetName")} htmlFor={nameId}>
					<Input
						id={nameId}
						value={name}
						placeholder="my-h264-ladder"
						onChange={(e) => setName(e.target.value)}
					/>
				</Field>
				<Field
					label={t("wizard.description")}
					htmlFor={descId}
					help={t("wizard.optionalShownInThePresetGallery")}
				>
					<Input
						id={descId}
						value={description}
						placeholder={t("wizard.k2RungH264AacJitHls")}
						onChange={(e) => setDescription(e.target.value)}
					/>
				</Field>
				{!planValid ? (
					<p className="text-amber-400 text-xs">
						{t("wizard.fixTheValidationIssuesAboveBeforeSaving")}
					</p>
				) : null}
				{save.isError ? (
					<p role="alert" className="text-red-400 text-xs">
						{save.error instanceof ApiError && save.error.status === 409
							? t("wizard.aPresetWithThatNameAlreadyExists")
							: save.error instanceof ApiError
								? save.error.message
								: t("wizard.couldNotSaveThePreset")}
					</p>
				) : null}
				{save.isSuccess ? (
					<p role="status" className="text-emerald-400 text-xs">
						{t("wizard.savedItIsNowInThePreset")}
					</p>
				) : null}
				<Button
					size="sm"
					disabled={!planValid || name.trim() === "" || save.isPending}
					onClick={() => save.mutate()}
				>
					{save.isPending ? t("wizard.saving") : t("wizard.saveAsPreset")}
				</Button>
			</div>

			{/* --- Diff vs preset --- */}
			<div className="space-y-2">
				<h3 className="font-medium text-xs text-zinc-400">
					{t("wizard.diffVsPreset")}
				</h3>
				<Field
					label={t("wizard.baselinePreset")}
					htmlFor={baselineId}
					help={t("wizard.compareYourBuiltPlanAgainstASample")}
				>
					<SelectNative
						id={baselineId}
						value={baselineValue}
						onChange={(e) => setBaselineValue(e.target.value)}
					>
						<option value="">{t("wizard.selectABaseline")}</option>
						{(userPresets.data ?? []).length > 0 ? (
							<optgroup label={t("wizard.myPresets")}>
								{(userPresets.data ?? []).map((p) => (
									<option
										key={p.id}
										value={encodeBaseline({
											kind: "user",
											id: p.id,
											name: p.name,
										})}
									>
										{p.name}
									</option>
								))}
							</optgroup>
						) : null}
						<optgroup label={t("wizard.samples")}>
							{SAMPLE_PRESETS.map((p) => (
								<option
									key={p.name}
									value={encodeBaseline({ kind: "sample", name: p.name })}
								>
									{t(presetTitleKey(p.name))}
								</option>
							))}
						</optgroup>
					</SelectNative>
				</Field>

				{!planValid && baseline ? (
					<p className="text-amber-400 text-xs">
						{t("wizardX.completeValidPlanToDiff", { name: baseline.name })}
					</p>
				) : null}
				{baseline && baselineBody.isPending ? (
					<p className="text-xs text-zinc-500">
						{t("wizardX.loadingNamed", { name: baseline.name })}
					</p>
				) : null}
				{baseline && baselineBody.isError ? (
					<p role="alert" className="text-red-400 text-xs">
						{t("wizardX.couldNotLoadPresetNamed", { name: baseline.name })}
					</p>
				) : null}
				{diff && diff.length === 0 ? (
					<p
						role="status"
						className="rounded-md border border-emerald-900 bg-emerald-950/30 px-3 py-2 text-emerald-300 text-xs"
					>
						{t("wizardX.identicalToNamed", { name: baseline?.name ?? "" })}
					</p>
				) : null}
				{diff && diff.length > 0 ? (
					<div className="space-y-2">
						<p className="text-xs text-zinc-500">
							{t(
								diff.length === 1
									? "wizardX.fieldsDifferOne"
									: "wizardX.fieldsDifferOther",
								{ count: diff.length, name: baseline?.name ?? "" },
							)}
						</p>
						<ul
							data-testid="preset-diff"
							className="max-h-72 overflow-auto rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1"
						>
							{diff.map((entry) => (
								<DiffRow key={`${entry.change}:${entry.path}`} entry={entry} />
							))}
						</ul>
					</div>
				) : null}
			</div>
		</section>
	);
}
