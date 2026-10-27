"use client";
import { BITMOVIN_CLOUD_REGIONS } from "@bitovp/core";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { SelectNative } from "@/components/ui/input";
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
	const provider = (
		state.cloudRegion === "AUTO"
			? (regions.find((region) => region !== "AUTO") ?? "AUTO")
			: state.cloudRegion
	).split("_")[0];
	const choices = BITMOVIN_CLOUD_REGIONS.filter(
		(r) =>
			r === "AUTO" ||
			(/^(AWS|GOOGLE|AZURE|AKAMAI|OCI)_/.test(r) &&
				(provider === "AUTO" || r.startsWith(`${provider}_`))),
	);
	return (
		<details className="rounded-md border border-zinc-800 p-3">
			<summary className="cursor-pointer text-sm">
				{t("liveProtection.fallbackRegions")}
			</summary>
			<p className="my-2 text-xs text-zinc-400">
				{t("liveProtection.fallbackHelp")}
			</p>
			{regions.map((region, index) => (
				<Field
					key={`${index}-${region}`}
					label={`${t("liveProtection.fallbackRegion")} ${index + 1}`}
					htmlFor={`lw-fallback-${index}`}
				>
					<div className="flex gap-2">
						<SelectNative
							id={`lw-fallback-${index}`}
							value={region}
							onChange={(e) =>
								onPatch({
									fallbackCloudRegions: regions.map((r, i) =>
										i === index ? e.target.value : r,
									),
								})
							}
						>
							{!choices.some((r) => r === region) ? (
								<option value={region}>{region}</option>
							) : null}
							{choices
								.filter((r) => r === region || !regions.includes(r))
								.map((r) => (
									<option key={r} value={r}>
										{r}
									</option>
								))}
						</SelectNative>
						<Button
							type="button"
							variant="secondary"
							onClick={() =>
								onPatch({
									fallbackCloudRegions: regions.filter((_, i) => i !== index),
								})
							}
						>
							{t("liveProtection.remove")}
						</Button>
					</div>
				</Field>
			))}
			<Button
				type="button"
				size="sm"
				variant="secondary"
				className="mt-2"
				disabled={regions.length >= 3 || !!state.infrastructure}
				onClick={() =>
					onPatch({
						fallbackCloudRegions: [
							...regions,
							choices.find((r) => !regions.includes(r)) ?? "AUTO",
						],
					})
				}
			>
				{t("liveProtection.add")}
			</Button>
		</details>
	);
}
