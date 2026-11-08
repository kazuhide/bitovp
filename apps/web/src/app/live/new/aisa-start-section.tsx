"use client";

import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import { EMPTY_AISA_LIVE_SETTINGS } from "./aisa-settings-model";
import type { LiveWizardState } from "./build-live-plan";

export function AisaStartSection({
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
			<p className="text-sm text-zinc-400">{t("aisaLive.managedStartHint")}</p>
			{state.inputKind === "RTMP" ? (
				<Field
					label={t("ui.streamKey")}
					htmlFor="lw-streamkey"
					help={t("aisaLive.streamKeyHint")}
				>
					<Input
						id="lw-streamkey"
						value={state.start.streamKey}
						onChange={(event) =>
							onPatch({
								start: { ...state.start, streamKey: event.target.value },
							})
						}
					/>
				</Field>
			) : null}
			<p className="text-xs text-zinc-400">
				{t("aisaLive.componentVersionsHint")}
			</p>
			<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
				{(["esVersion", "aicaVersion"] as const).map((key) => (
					<Field
						key={key}
						label={t(`aisaLive.${key}`)}
						htmlFor={`lw-aisa-${key}`}
					>
						<Input
							id={`lw-aisa-${key}`}
							value={settings[key]}
							onChange={(event) =>
								onPatch({
									aisaLive: { ...settings, [key]: event.target.value },
								})
							}
						/>
					</Field>
				))}
			</div>
		</div>
	);
}
