"use client";

import {
	type CompiledOperation,
	compilePlan,
	type EncodingPlan,
	encodingPlanSchema,
	encodingTemplateExportUnavailableReason,
	type PlanIssue,
	type PlanValidationOptions,
	planToEncodingTemplateYaml,
	validatePlan,
} from "@bitovp/core";
import { Check, Copy } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { OpPayloadPopover } from "@/components/op-payload-popover";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Translator } from "@/lib/i18n/context";
import { useT } from "@/lib/i18n/context";
import { zodIssueMessage } from "@/lib/i18n/zod-issue-message";
import type { WizardState } from "./build-plan";
import { buildPlan, WizardCodecError } from "./build-plan";

export type PlanEvaluation =
	| { ok: false; zodMessage: string }
	| {
			ok: true;
			plan: EncodingPlan;
			issues: PlanIssue[];
			opCount: number;
			/** The ordered Bitmovin calls the plan compiles to — the rail is
			    titled "what will be sent", and it showed only their COUNT while
			    the live sibling rendered the list (ux inventory #80-1). */
			ops: CompiledOperation[];
	  };

/** Client-side evaluation — the same core code the server runs. */
export function evaluateWizardState(
	state: WizardState,
	translate?: Translator,
	options: PlanValidationOptions = {},
): PlanEvaluation {
	try {
		return evaluatePlanDocument(buildPlan(state), translate, options);
	} catch (error) {
		if (error instanceof WizardCodecError)
			return {
				ok: false,
				zodMessage: translate ? translate("hevcV2.mixed") : error.message,
			};
		throw error;
	}
}

/** Revalidate the original imported document; never rebuild it through form state. */
export function evaluatePlanDocument(
	raw: unknown,
	translate?: Translator,
	options: PlanValidationOptions = {},
): PlanEvaluation {
	const parsed = encodingPlanSchema.safeParse(raw);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		return {
			ok: false,
			// Empty = no zod detail to show. The fallback copy is localized where it
			// is rendered: this is a plain function, not a component, so it has no
			// translator, and every one of its dozen test call sites would have had
			// to pass one.
			zodMessage: first
				? `${first.path.join(".")}: ${translate ? zodIssueMessage(first, translate) : first.message}`
				: "",
		};
	}
	const issues = validatePlan(parsed.data, options);
	const ops = issues.some((i) => i.level === "error")
		? []
		: compilePlan(parsed.data);
	return { ok: true, plan: parsed.data, issues, opCount: ops.length, ops };
}

/** Plan-internal codes translated for ladder editors. */
function friendlyIssueMessage(issue: PlanIssue, t: Translator): string {
	if (issue.code === "PLAN_ENCODING_MODE_PRESET_CONFLICT")
		return t("wizard.encodingModePresetConflict");
	if (issue.code === "PLAN_ENCODING_MODE_UNPINNED_FOR_MIXED_CODECS")
		return t("wizard.mixedEncodingModeGuidance");
	if (issue.code === "PLAN_DASH_ONDEMAND_CLEAR_DRM")
		return t("wizard.onDemandClearDrmGuidance");
	if (
		issue.code === "PLAN_DUPLICATE_KEY" &&
		(issue.path === "renditions" || issue.path === "muxings")
	) {
		return "Two renditions resolve to the same identity (same height AND bitrate, or same audio bitrate AND sample rate) — change one of them.";
	}
	return issue.message;
}

function CopyButton({ value }: { value: string }) {
	const { t } = useT();
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current) {
				clearTimeout(timer.current);
			}
		},
		[],
	);
	return (
		<Button
			variant="ghost"
			size="sm"
			aria-label={t("wizard.copyPreview")}
			onClick={async () => {
				try {
					await navigator.clipboard.writeText(value);
				} catch {
					return; // clipboard denied (permissions/insecure context)
				}
				setCopied(true);
				if (timer.current) {
					clearTimeout(timer.current);
				}
				timer.current = setTimeout(() => setCopied(false), 1500);
			}}
		>
			{copied ? (
				<Check aria-hidden className="h-3.5 w-3.5 text-emerald-400" />
			) : (
				<Copy aria-hidden className="h-3.5 w-3.5" />
			)}
		</Button>
	);
}

/**
 * Live "what will be sent" drawer (UI-DESIGN §4) + validation rail.
 * Default view is the Bitmovin Encoding Template YAML (draft subset —
 * header comments in the output explain the caveats); the Plan JSON tab
 * shows the canonical document the orchestrator executes.
 */
export function PlanPreview({ evaluation }: { evaluation: PlanEvaluation }) {
	const { t } = useT();
	const [tab, setTab] = useState<"yaml" | "json" | "ops">("yaml");
	const json = useMemo(
		() => (evaluation.ok ? JSON.stringify(evaluation.plan, null, 2) : null),
		[evaluation],
	);
	const internalProfile = evaluation.ok && !!evaluation.plan.internal?.hevcV2;
	const templateUnavailable = evaluation.ok
		? encodingTemplateExportUnavailableReason(evaluation.plan)
		: undefined;
	const templateUnavailableMessage =
		templateUnavailable === "SPEKE"
			? t("wizard.spekeTemplateUnavailable")
			: templateUnavailable === "DASH_ON_DEMAND_MP4_DRM"
				? t("wizard.onDemandDrmTemplateUnavailable")
				: undefined;
	const currentTab = templateUnavailable && tab === "yaml" ? "json" : tab;
	const yaml = useMemo(
		() =>
			evaluation.ok && !evaluation.plan.internal?.hevcV2 && !templateUnavailable
				? planToEncodingTemplateYaml(evaluation.plan)
				: null,
		[evaluation, templateUnavailable],
	);
	const blocked =
		evaluation.ok && evaluation.issues.some((i) => i.level === "error");
	// Template YAML is an exportable artifact — never offer one for a plan
	// that semantic validation rejects. Plan JSON stays up for debugging.
	const active =
		currentTab === "yaml"
			? blocked
				? null
				: yaml
			: currentTab === "json"
				? json
				: null;

	return (
		<aside className="flex min-h-0 flex-col gap-3">
			<div className="flex items-center gap-2">
				<h2 className="font-medium text-sm text-zinc-200">
					{t("wizard.planPreview")}
				</h2>
				{!evaluation.ok ? (
					<Badge tone="error">{t("wizard.incomplete")}</Badge>
				) : blocked ? (
					<Badge tone="error">{t("wizard.blocked")}</Badge>
				) : (
					<Badge tone="ok">
						{t("wizardX.operationsCount", { count: evaluation.opCount })}
					</Badge>
				)}
				<div className="ml-auto flex items-center gap-1">
					<button
						type="button"
						disabled={internalProfile || !!templateUnavailable}
						title={templateUnavailableMessage}
						aria-pressed={currentTab === "yaml"}
						className={`rounded px-2 py-1 text-xs ${
							currentTab === "yaml"
								? "bg-zinc-800 text-zinc-100"
								: "text-zinc-500 hover:text-zinc-300"
						}`}
						onClick={() => setTab("yaml")}
					>
						{t("wizard.templateYaml")}
					</button>
					<button
						type="button"
						aria-pressed={currentTab === "json"}
						className={`rounded px-2 py-1 text-xs ${
							currentTab === "json"
								? "bg-zinc-800 text-zinc-100"
								: "text-zinc-500 hover:text-zinc-300"
						}`}
						onClick={() => setTab("json")}
					>
						{t("wizard.planJson")}
					</button>
					<button
						type="button"
						aria-pressed={currentTab === "ops"}
						className={`rounded px-2 py-1 text-xs ${
							currentTab === "ops"
								? "bg-zinc-800 text-zinc-100"
								: "text-zinc-500 hover:text-zinc-300"
						}`}
						onClick={() => setTab("ops")}
					>
						{t("ui.operations")}
					</button>
					{active ? <CopyButton value={active} /> : null}
				</div>
			</div>
			{templateUnavailableMessage ? (
				<p className="text-amber-400 text-xs">{templateUnavailableMessage}</p>
			) : null}
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
							[{issue.code}] {friendlyIssueMessage(issue, t)}
						</li>
					))}
				</ul>
			) : null}
			{currentTab === "ops" ? (
				<div
					data-testid="plan-ops"
					className="min-h-0 flex-1 overflow-auto rounded-md border border-zinc-800 bg-zinc-900 p-3"
				>
					{/* The live sibling's presentation, verbatim in spirit: the rail
					    says "what will be sent" — this IS what will be sent, in
					    order (ux inventory #80-1; the count badge above was the only
					    trace of it before). */}
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
									{/* #80 S4: the kind opens the op's payload — the list
									    otherwise summarizes content it never showed. */}
									<span className="ml-auto shrink-0 text-zinc-600">
										<OpPayloadPopover op={op} />
									</span>
								</li>
							))}
						</ol>
					)}
				</div>
			) : (
				<pre
					data-testid={currentTab === "yaml" ? "plan-yaml" : "plan-json"}
					className="min-h-0 flex-1 overflow-auto rounded-md border border-zinc-800 bg-zinc-900 p-3 text-[11px] text-zinc-300 leading-relaxed"
				>
					{active ??
						(currentTab === "yaml" && internalProfile
							? t("hevcV2.jsonOnly")
							: currentTab === "yaml" && blocked
								? t("uiX.fixValidationForTemplateYaml")
								: t("ui.completeTheRequiredFields"))}
				</pre>
			)}
		</aside>
	);
}
