"use client";

import type { VmafExecution } from "@bitovp/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { VmafComputeProfileSummary } from "@/app/qc/vmaf-shared";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";

export function useVmafExecutionValidation(
	execution: VmafExecution | undefined,
	enabled: boolean,
) {
	const profiles = useQuery({
		queryKey: ["vmaf-compute-profiles"],
		queryFn: () =>
			apiFetch<{ items: VmafComputeProfileSummary[] }>(
				"/api/vmaf-compute-profiles",
			),
		enabled,
	});
	const cloud = execution?.backend === "CLOUD" ? execution : undefined;
	const missingProfile = Boolean(
		cloud &&
			!profiles.data?.items.some((profile) => profile.id === cloud.profileId),
	);
	const invalidBudget = Boolean(
		cloud &&
			(!Number.isFinite(cloud.budgetUsd) ||
				cloud.budgetUsd <= 0 ||
				cloud.budgetUsd > 100000),
	);
	return {
		profiles,
		missingProfile,
		invalidBudget,
		invalid: Boolean(
			enabled &&
				cloud &&
				(profiles.isFetching ||
					profiles.isError ||
					missingProfile ||
					invalidBudget),
		),
	};
}

export function VmafExecutionSettings({
	execution,
	onChange,
}: {
	execution?: VmafExecution;
	onChange: (execution: VmafExecution) => void;
}) {
	const { t } = useT();
	const { profiles, missingProfile, invalidBudget } =
		useVmafExecutionValidation(execution, true);
	const cloud = execution?.backend === "CLOUD" ? execution : undefined;
	const profileId = cloud?.profileId ?? "";
	const [budgetInput, setBudgetInput] = useState<{
		profileId: string;
		budget: number;
		text: string;
	} | null>(null);
	// Preserve decimal input while typing, but external draft/preset changes win.
	const budgetText = cloud
		? budgetInput?.profileId === profileId &&
			budgetInput.budget === cloud.budgetUsd
			? budgetInput.text
			: Number.isFinite(cloud.budgetUsd) && cloud.budgetUsd !== 0
				? String(cloud.budgetUsd)
				: ""
		: "";
	return (
		<div className="space-y-2">
			<div className="grid gap-3 sm:grid-cols-2">
				<Field label={t("qc.executionTarget")} htmlFor="wz-qc-execution">
					<SelectNative
						id="wz-qc-execution"
						value={profileId}
						onChange={(event) => {
							setBudgetInput(null);
							onChange(
								event.target.value === ""
									? { backend: "LOCAL" }
									: {
											backend: "CLOUD",
											profileId: event.target.value,
											budgetUsd: 0,
										},
							);
						}}
					>
						<option value="">{t("qc.executionLocal")}</option>
						{missingProfile ? (
							<option value={profileId} disabled>
								{profiles.isPending ? profileId : t("qc.measureProfileMissing")}
							</option>
						) : null}
						{(profiles.data?.items ?? []).map((profile) => (
							<option key={profile.id} value={profile.id}>
								{profile.label} · {profile.region}
							</option>
						))}
					</SelectNative>
				</Field>
				{cloud ? (
					<Field label={t("qc.executionBudget")} htmlFor="wz-qc-budget">
						<Input
							id="wz-qc-budget"
							type="number"
							min="0.01"
							max="100000"
							step="0.01"
							required
							value={budgetText}
							aria-invalid={invalidBudget}
							aria-describedby="wz-qc-budget-hint"
							onChange={(event) => {
								const text = event.target.value;
								const parsed = Number(text);
								// 0 is explicit, schema-invalid and safe in JSON drafts.
								const budget = Number.isFinite(parsed) ? parsed : 0;
								setBudgetInput({ profileId, budget, text });
								onChange({ ...cloud, budgetUsd: budget });
							}}
						/>
					</Field>
				) : null}
			</div>
			{profiles.isPending ? (
				<p className="text-xs text-zinc-500">{t("common.loading")}</p>
			) : profiles.isError ? (
				<div
					role="status"
					className="flex flex-wrap items-center gap-2 text-xs text-zinc-500"
				>
					{t("qc.executionProfilesUnavailable")}
					<Button
						size="sm"
						variant="secondary"
						disabled={profiles.isFetching}
						onClick={() => profiles.refetch()}
					>
						{t("common.retry")}
					</Button>
				</div>
			) : missingProfile ? (
				<p role="alert" className="text-xs text-amber-400">
					{t("qc.measureProfileMissing")}
				</p>
			) : !profiles.data?.items.length ? (
				<p className="text-xs text-zinc-500">{t("qc.executionLocalOnly")}</p>
			) : null}
			{cloud ? (
				<>
					{invalidBudget ? (
						<p role="alert" className="text-xs text-amber-400">
							{t("qc.executionBudgetInvalid")}
						</p>
					) : null}
					<p id="wz-qc-budget-hint" className="text-xs text-zinc-500">
						{t("qc.executionBudgetHint")}
					</p>
				</>
			) : null}
		</div>
	);
}
