"use client";

import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/context";
import {
	clearAisaUnsupportedSettings,
	EMPTY_AISA_LIVE_SETTINGS,
	hasAisaUnsupportedSettings,
	setAisaLiveEnabled,
} from "./aisa-settings-model";
import type { LiveWizardState } from "./build-live-plan";

type Props = {
	state: LiveWizardState;
	onPatch: (partial: Partial<LiveWizardState>) => void;
};

export function AisaManagedGraphNotice({ state, onPatch }: Props) {
	const { t } = useT();
	return (
		<section className="space-y-3 rounded-md border border-zinc-700 bg-zinc-900/40 p-4">
			<h2 className="font-medium text-sm text-zinc-100">
				{t("aisaLive.managedPreset")}
			</h2>
			<p className="text-sm text-zinc-400">{t("aisaLive.managedGraphHelp")}</p>
			<label className="flex items-start gap-2 text-sm text-zinc-200">
				<input
					type="checkbox"
					className="mt-0.5 h-4 w-4 accent-emerald-600"
					checked={state.aisaLive?.useManagedGraph ?? false}
					onChange={(event) =>
						onPatch({
							aisaLive: {
								...EMPTY_AISA_LIVE_SETTINGS,
								...state.aisaLive,
								useManagedGraph: event.target.checked,
							},
						})
					}
				/>
				{t("aisaLive.acceptManagedGraph")}
			</label>
		</section>
	);
}

export function AisaSettingsSection({
	state,
	onPatch,
	enabled,
}: Props & { enabled: boolean }) {
	const { t } = useT();
	if (!enabled && !state.aisaLive?.enabled) return null;
	return (
		<div className="space-y-3">
			<label className="flex items-center gap-2 text-sm text-zinc-200">
				<input
					type="checkbox"
					className="h-4 w-4 accent-emerald-600"
					checked={state.aisaLive?.enabled ?? false}
					disabled={!enabled && !state.aisaLive?.enabled}
					onChange={(event) =>
						onPatch(setAisaLiveEnabled(state, event.target.checked))
					}
				/>
				{t("aisaLive.enableInLive")}
			</label>
			{state.aisaLive?.enabled ? (
				<>
					{!enabled ? (
						<p role="alert" className="text-sm text-amber-400">
							{t("aisaLive.previewUnavailable")}
						</p>
					) : null}
					<p className="text-sm text-zinc-400">{t("aisaLive.sports")}</p>
					<AisaManagedGraphNotice state={state} onPatch={onPatch} />
					{hasAisaUnsupportedSettings(state) ? (
						<div className="space-y-2">
							<p role="alert" className="text-sm text-amber-400">
								{t("aisaLive.unsupportedSettings")}
							</p>
							<Button
								variant="secondary"
								size="sm"
								onClick={() => onPatch(clearAisaUnsupportedSettings(state))}
							>
								{t("aisaLive.clearUnsupportedSettings")}
							</Button>
						</div>
					) : null}
				</>
			) : null}
		</div>
	);
}
