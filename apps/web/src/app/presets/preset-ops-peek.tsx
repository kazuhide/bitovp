"use client";

import { compilePlan, encodingPlanSchema } from "@bitovp/core";
import { useQuery } from "@tanstack/react-query";
import { OpPayloadPopover } from "@/components/op-payload-popover";
import { DetailPopover } from "@/components/ui/detail-popover";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";

/**
 *  item 13: the gallery card's "{count} ops" badge was a bare
 * count — the operation list it counts is one fetch away. The popover
 * fetches the preset's plan (the existing per-preset endpoint; the 56
 * embedded plans stay out of the client bundle (56, not 66: only the
 * encoding examples-backed fixtures are presets — preset-copy.test.tsx pins it)) and compiles it with the
 * SAME `compilePlan` whose output length core pins `opCount` to
 * (sample-presets.test.ts), so the list shown always matches the badge.
 * The fetch runs when the popover CONTENT mounts — on open, not per card.
 */

function PresetOpsList({ name }: { name: string }) {
	const { t } = useT();
	const plan = useQuery({
		queryKey: ["sample-preset-ops", name],
		// Presets are immutable per build (the route serves max-age=3600).
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
		queryFn: () =>
			apiFetch<unknown>(`/api/sample-presets/${encodeURIComponent(name)}`),
	});
	if (plan.isPending) {
		return <p className="text-xs text-zinc-500">{t("common.loading")}</p>;
	}
	const parsed = plan.isError ? null : encodingPlanSchema.safeParse(plan.data);
	if (!parsed?.success) {
		return <p className="text-xs text-red-400">{t("uiX.opsListFailed")}</p>;
	}
	const ops = compilePlan(parsed.data);
	return (
		<ol className="max-w-96 space-y-0.5 text-xs">
			{ops.map((op, index) => (
				<li key={op.step} className="flex items-baseline gap-2">
					<span className="text-zinc-600 tabular-nums">{index + 1}.</span>
					{/* #80 S4 (the peek reproduced it by design): kind opens payload. */}
					<OpPayloadPopover op={op} />
					<span className="select-all break-all font-mono text-zinc-400">
						{op.step}
					</span>
				</li>
			))}
		</ol>
	);
}

export function PresetOpsPeek({
	name,
	opCount,
}: {
	name: string;
	opCount: number;
}) {
	const { t } = useT();
	return (
		<DetailPopover
			summary={t("uiX.opsCount", { count: opCount })}
			label={t("uiX.opsListLabel", { name })}
		>
			<PresetOpsList name={name} />
		</DetailPopover>
	);
}
