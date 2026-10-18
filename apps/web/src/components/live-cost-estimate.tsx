"use client";

import {
	estimateLiveRunCost,
	type LiveChannelPlan,
	rateCardFromDefaults,
} from "@bitovp/core";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import type { MessageKey } from "@/lib/i18n/messages/en";

/**
 * Live run cost estimate line . Pure arithmetic over the
 * operator's rate card (Settings → Bitmovin); every unavailability is a
 * SENTENCE, never a fabricated number, and the assumptions render beside
 * the figure — an estimate whose caveats are hidden is a lie with extra
 * steps. Used on the channel detail (schedule panel) and the live wizard.
 */

const ASSUMPTION_KEY: Record<string, MessageKey> = {
	"encoding-minutes-only": "estimate.assumeEncodingOnly",
	"no-billing-increments": "estimate.assumeNoIncrements",
	"null-height-renditions-ignored": "estimate.assumeNullHeights",
};

export function LiveCostEstimate({
	plan,
	bitmovinAccountId,
	defaultMinutes,
}: {
	plan: LiveChannelPlan | null;
	bitmovinAccountId: string | null;
	defaultMinutes: number;
}) {
	const { t } = useT();
	const minutesId = useId();
	const [minutesRaw, setMinutesRaw] = useState(String(defaultMinutes));

	const account = useQuery({
		queryKey: ["bitmovin-account", bitmovinAccountId],
		enabled: bitmovinAccountId !== null,
		queryFn: () =>
			apiFetch<{ defaults?: unknown }>(
				`/api/bitmovin-accounts/${bitmovinAccountId}`,
			),
	});

	if (!plan || bitmovinAccountId === null) {
		return null;
	}
	if (account.isLoading) {
		return <p className="text-xs text-zinc-500">{t("common.loading")}</p>;
	}
	const card = rateCardFromDefaults(account.data?.defaults);
	if (!card) {
		return <p className="text-xs text-zinc-500">{t("estimate.noRateCard")}</p>;
	}

	const minutes = Number(minutesRaw);
	const valid = Number.isFinite(minutes) && minutes > 0 && minutes <= 100_000;
	const result = valid ? estimateLiveRunCost(plan, minutes, card) : null;

	return (
		<div className="space-y-2">
			<div className="flex items-start gap-3">
				<div className="w-32">
					<Field label={t("estimate.minutesLabel")} htmlFor={minutesId}>
						<Input
							id={minutesId}
							type="number"
							min={1}
							value={minutesRaw}
							onChange={(e) => setMinutesRaw(e.target.value)}
						/>
					</Field>
				</div>
				{result?.kind === "estimate" ? (
					<p className="pb-2 text-sm text-zinc-200">
						{t("estimate.line", {
							total: result.total.toLocaleString(),
							currency: result.currency,
							perHour: result.perHour.toLocaleString(),
							tier: result.tierMaxHeight,
						})}
					</p>
				) : null}
				{result?.kind === "unavailable" ? (
					<p className="pb-2 text-xs text-zinc-500">
						{result.reason === "invalid-duration"
							? t("estimate.invalidDuration")
							: result.reason === "no-video-ladder"
								? t("estimate.noVideoLadder")
								: t("estimate.exceedsTiers", {
										ladder: result.ladderHeight ?? 0,
										max: result.cardMaxHeight ?? 0,
									})}
					</p>
				) : null}
				{!result ? (
					<p className="pb-2 text-xs text-zinc-500">
						{t("estimate.invalidMinutes")}
					</p>
				) : null}
			</div>
			{result?.kind === "estimate" ? (
				<p className="text-[11px] text-zinc-600">
					{result.assumptions
						.map((assumption) => {
							const key = ASSUMPTION_KEY[assumption];
							return key ? t(key) : assumption;
						})
						.join(" · ")}
				</p>
			) : null}
		</div>
	);
}
