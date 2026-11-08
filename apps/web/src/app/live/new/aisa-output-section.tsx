"use client";

import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import { EMPTY_AISA_LIVE_SETTINGS } from "./aisa-settings-model";
import type { LiveWizardState } from "./build-live-plan";

export function AisaOutputSection({
	state,
	onPatch,
}: {
	state: LiveWizardState;
	onPatch: (partial: Partial<LiveWizardState>) => void;
}) {
	const { t } = useT();
	const settings = { ...EMPTY_AISA_LIVE_SETTINGS, ...state.aisaLive };
	return (
		<div className="space-y-4">
			<p className="text-sm text-zinc-400">{t("aisaLive.outputHint")}</p>
			{(
				[
					["outputId", "aisaLive.outputId"],
					["recordingPath", "aisaLive.recordingPath"],
					["analysisPath", "aisaLive.analysisPath"],
				] as const
			).map(([key, label]) => (
				<Field key={key} label={t(label)} htmlFor={`lw-aisa-${key}`}>
					<Input
						id={`lw-aisa-${key}`}
						value={settings[key]}
						required
						onChange={(event) =>
							onPatch({ aisaLive: { ...settings, [key]: event.target.value } })
						}
					/>
				</Field>
			))}
		</div>
	);
}
