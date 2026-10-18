"use client";

import type { LiveChannelPlan } from "@bitovp/core";
import { useMutation } from "@tanstack/react-query";
import { useId, useState } from "react";
import type { LiveChannelStatus } from "@/app/live/live-shared";
import { LiveCostEstimate } from "@/components/live-cost-estimate";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { localizedCustomerError } from "@/lib/customer-error";
import { useT } from "@/lib/i18n/context";

/**
 * The runtime cap and the cost estimate it feeds.
 *
 * Extracted from `SchedulePanel`. It used to sit BETWEEN the arm
 * form and the upcoming list, so the panel read
 * `arm form → cap → cost → upcoming → history`: three configuration surfaces
 * before the operator could see what was actually going to fire
. Neither control answers "what happens next" — a cap is a billing
 * guard-rail you set once and an estimate is a planning tool — so §5.7 puts
 * both in the Advanced layer, and Programme now opens with the timeline and the
 * upcoming rows.
 *
 * It is a PATCH on the channel, not on a schedule row, which is why it can move
 * out of the schedule panel without dragging any of that panel's state with it.
 */
export function RuntimeCapPanel({
	channelId,
	status,
	maxRunMinutes,
	plan,
	bitmovinAccountId,
	onChannelChanged,
}: {
	channelId: string;
	status: LiveChannelStatus;
	maxRunMinutes: number | null;
	/** Parsed channel plan — the estimate's ladder source (null = no line). */
	plan: LiveChannelPlan | null;
	bitmovinAccountId: string | null;
	onChannelChanged: () => void;
}) {
	const { t } = useT();
	const capId = useId();
	const [capValue, setCapValue] = useState(
		maxRunMinutes === null ? "" : String(maxRunMinutes),
	);
	const [issue, setIssue] = useState<string | null>(null);

	const saveCap = useMutation({
		mutationFn: (value: number | null) =>
			apiFetch<{ id: string; maxRunMinutes: number | null }>(
				`/api/live-channels/${channelId}`,
				{
					method: "PATCH",
					body: JSON.stringify({ maxRunMinutes: value }),
				},
			),
		onSuccess: onChannelChanged,
	});

	const submitCap = () => {
		if (capValue === "") {
			setIssue(null);
			saveCap.mutate(null);
			return;
		}
		const value = Number(capValue);
		if (!Number.isInteger(value) || value < 1 || value > 10_080) {
			setIssue(t("schedule.capInvalid"));
			return;
		}
		setIssue(null);
		saveCap.mutate(value);
	};

	return (
		<div className="mt-2 space-y-4">
			<RoleAccess control="live.channel.runtime-cap">
				<div className="rounded-md border border-zinc-800 p-3">
					<p className="text-xs text-zinc-400">{t("schedule.capTitle")}</p>
					<p className="mt-1 text-xs text-zinc-500">
						{t("schedule.capExplainer")}
					</p>
					<div className="mt-2 flex flex-wrap items-start gap-2">
						<div className="w-64">
							<Field
								label={t("schedule.capLabel")}
								htmlFor={capId}
								trailing={
									<Button
										type="button"
										variant="secondary"
										onClick={submitCap}
										disabled={saveCap.isPending}
									>
										{t("schedule.capSave")}
									</Button>
								}
							>
								<Input
									id={capId}
									type="number"
									min={1}
									max={10080}
									value={capValue}
									onChange={(e) => setCapValue(e.target.value)}
									placeholder={t("schedule.capNonePlaceholder")}
								/>
							</Field>
						</div>
						{status === "RUNNING" && maxRunMinutes !== null ? (
							<span className="text-xs text-zinc-500">
								{t("schedule.capActiveNote")}
							</span>
						) : null}
					</div>
					{issue ? (
						<p role="alert" className="mt-2 text-red-400 text-xs">
							{issue}
						</p>
					) : null}
					{saveCap.isError ? (
						<p role="alert" className="mt-2 text-red-400 text-xs">
							{localizedCustomerError(
								t,
								saveCap.error,
								"schedule.capSaveFailed",
							)}
						</p>
					) : null}
				</div>
			</RoleAccess>

			<div className="rounded-md border border-zinc-800 p-3">
				<p className="text-xs text-zinc-400">{t("estimate.title")}</p>
				<div className="mt-2">
					<LiveCostEstimate
						// review-84b N1: the minutes box seeds from useState, which
						// ignores later prop changes — remount on a cap change so
						// "default minutes = the cap" stays true after saving one.
						key={maxRunMinutes ?? "no-cap"}
						plan={plan}
						bitmovinAccountId={bitmovinAccountId}
						defaultMinutes={maxRunMinutes ?? 60}
					/>
				</div>
			</div>
		</div>
	);
}
