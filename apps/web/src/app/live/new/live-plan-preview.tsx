"use client";

import {
	type CompiledOperation,
	type CredentialSummaryWire,
	compileLiveChannel,
	type LiveChannelPlan,
	liveChannelPlanSchema,
	type PlanIssue,
	type PlanValidationOptions,
	validateLiveChannel,
} from "@bitovp/core";
import { useMemo, useState } from "react";
import { CustomLiveNotice } from "@/app/live/custom-live-notice";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { codecControlIssueMessage } from "@/lib/i18n/codec-control";
import type { Translator } from "@/lib/i18n/context";
import { useT } from "@/lib/i18n/context";
import { zodIssueMessage } from "@/lib/i18n/zod-issue-message";
import type { LiveWizardState } from "./build-live-plan";
import { buildLiveChannelPlan } from "./build-live-plan";
import { liveMirrorProblem } from "./mirror-model";

export type LivePlanEvaluation =
	| { ok: false; zodMessage: string }
	| {
			ok: true;
			plan: LiveChannelPlan;
			issues: PlanIssue[];
			ops: CompiledOperation[];
	  };

/** Client-side evaluation — the same core code the server runs at POST. */
export function evaluateLiveWizardState(
	state: LiveWizardState,
	translate?: Translator,
	credentials?: Pick<CredentialSummaryWire, "id" | "provider">[],
	options: PlanValidationOptions = {},
): LivePlanEvaluation {
	const mirrorProblem = liveMirrorProblem(state, credentials);
	if (mirrorProblem)
		return {
			ok: false,
			zodMessage: translate ? translate(mirrorProblem) : mirrorProblem,
		};
	return evaluateLivePlanDocument(
		buildLiveChannelPlan(state),
		translate,
		options,
	);
}

/** Raw imports retain all fields; profile and credential metadata are current. */
export function evaluateLivePlanDocument(
	raw: unknown,
	translate?: Translator,
	options: PlanValidationOptions = {},
): LivePlanEvaluation {
	const parsed = liveChannelPlanSchema.safeParse(raw);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		return {
			ok: false,
			// Empty = no zod detail. The optional translator ((c)) is the
			// FORM layer's: client callers pass t and the zod sentence localizes;
			// server/test callers omit it and keep English by the standing policy.
			zodMessage: first
				? `${first.path.join(".")}: ${translate ? zodIssueMessage(first, translate) : first.message}`
				: "",
		};
	}
	const issues = validateLiveChannel(parsed.data, options);
	const ops = issues.some((i) => i.level === "error")
		? []
		: compileLiveChannel(parsed.data);
	return { ok: true, plan: parsed.data, issues, ops };
}

/**
 * Live "what will be provisioned" rail — the VOD PlanPreview adapted for
 * compileLiveChannel: an Operations tab (the exact ordered step list the
 * live-channel worker replays) and the canonical Plan JSON tab. NO
 * Template YAML tab: Bitmovin Encoding Templates do not cover live
 * (COVERAGE P3 batch 1 — "no template.yaml").
 */
export function LivePlanPreview({
	evaluation,
}: {
	evaluation: LivePlanEvaluation;
}) {
	const { t } = useT();
	const [tab, setTab] = useState<"ops" | "json">("ops");
	const json = useMemo(
		() => (evaluation.ok ? JSON.stringify(evaluation.plan, null, 2) : null),
		[evaluation],
	);
	const blocked =
		evaluation.ok && evaluation.issues.some((i) => i.level === "error");

	return (
		<aside className="flex min-h-0 flex-col gap-3">
			{evaluation.ok ? <CustomLiveNotice plan={evaluation.plan} /> : null}
			<div className="flex items-center gap-2">
				<h2 className="font-medium text-sm text-zinc-200">
					{t("wizard.planPreview")}
				</h2>
				{!evaluation.ok ? (
					<Badge tone="error">{t("ui.incomplete")}</Badge>
				) : blocked ? (
					<Badge tone="error">{t("ui.blocked")}</Badge>
				) : (
					<Badge tone="ok">
						{t("wizardX.operationsCount", { count: evaluation.ops.length })}
					</Badge>
				)}
				<div className="ml-auto flex items-center gap-1">
					<button
						type="button"
						aria-pressed={tab === "ops"}
						className={`rounded px-2 py-1 text-xs ${
							tab === "ops"
								? "bg-zinc-800 text-zinc-100"
								: "text-zinc-500 hover:text-zinc-300"
						}`}
						onClick={() => setTab("ops")}
					>
						{t("ui.operations")}
					</button>
					<button
						type="button"
						aria-pressed={tab === "json"}
						className={`rounded px-2 py-1 text-xs ${
							tab === "json"
								? "bg-zinc-800 text-zinc-100"
								: "text-zinc-500 hover:text-zinc-300"
						}`}
						onClick={() => setTab("json")}
					>
						{t("ui.planJson")}
					</button>
					{tab === "json" && json ? (
						<CopyButton value={json} label={t("ui.copyPlanJson")} />
					) : null}
				</div>
			</div>
			{!evaluation.ok ? (
				<p role="alert" className="text-amber-400 text-xs">
					{evaluation.zodMessage || t("wizard.planIsIncomplete")}
				</p>
			) : null}
			{evaluation.ok && evaluation.issues.length > 0 ? (
				<ul aria-live="polite" className="space-y-1">
					{evaluation.issues.map((issue, index) => (
						<li
							key={`${issue.code}:${issue.path}:${index}`}
							role="alert"
							className={
								issue.level === "error"
									? "text-red-400 text-xs"
									: "text-amber-400 text-xs"
							}
						>
							[{issue.code}]{" "}
							{codecControlIssueMessage(issue.code, t) ?? issue.message}
						</li>
					))}
				</ul>
			) : null}
			{tab === "ops" ? (
				<div
					data-testid="live-plan-ops"
					className="min-h-0 flex-1 overflow-auto rounded-md border border-zinc-800 bg-zinc-900 p-3"
				>
					{!evaluation.ok ? (
						<p className="text-[11px] text-zinc-500">
							{t("ui.completeTheRequiredFields")}
						</p>
					) : evaluation.ops.length === 0 ? (
						<p className="text-[11px] text-zinc-500">
							{t("ui.fixTheValidationErrorsAboveToCompile")}
						</p>
					) : (
						<ol className="space-y-1">
							{evaluation.ops.map((op, index) => (
								<li
									key={op.step}
									className="flex items-baseline gap-2 text-[11px] leading-relaxed"
								>
									<span className="w-6 shrink-0 text-right font-mono text-zinc-600">
										{index + 1}
									</span>
									<span className="font-mono text-zinc-300">{op.step}</span>
									<span className="ml-auto shrink-0 text-zinc-600">
										{op.kind}
									</span>
								</li>
							))}
						</ol>
					)}
				</div>
			) : (
				<pre
					data-testid="live-plan-json"
					className="min-h-0 flex-1 overflow-auto rounded-md border border-zinc-800 bg-zinc-900 p-3 text-[11px] text-zinc-300 leading-relaxed"
				>
					{json ?? t("ui.completeTheRequiredFields")}
				</pre>
			)}
		</aside>
	);
}
