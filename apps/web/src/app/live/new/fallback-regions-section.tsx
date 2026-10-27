"use client";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/context";
import type { LiveWizardState } from "./build-live-plan";

export function LiveFallbackRegions({
	state,
	onPatch,
}: {
	state: LiveWizardState;
	onPatch: (patch: Partial<LiveWizardState>) => void;
}) {
	const { t } = useT();
	const regions = state.fallbackCloudRegions ?? [];
	if (regions.length === 0) return null;
	return (
		<div
			role="alert"
			className="space-y-2 text-xs text-amber-300 sm:col-span-2"
		>
			<p>{t("liveProtection.fallbackUnsupported")}</p>
			<p className="break-words font-mono text-zinc-400">
				{regions.join(", ")}
			</p>
			<Button
				type="button"
				size="sm"
				variant="secondary"
				onClick={() => onPatch({ fallbackCloudRegions: [] })}
			>
				{t("liveProtection.clearFallbackRegions")}
			</Button>
		</div>
	);
}
