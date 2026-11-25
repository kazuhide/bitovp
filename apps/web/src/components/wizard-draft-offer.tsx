"use client";
import { useT } from "@/lib/i18n/context";
import type { DraftValue } from "@/lib/wizard-draft";
import { Button } from "./ui/button";
import { InfoHint } from "./ui/info-hint";

export function WizardDraftOffer({
	available,
	restore,
	discard,
	legacySettings,
	retainedSettings,
	legacyVersion,
}: {
	available: boolean;
	restore: () => void;
	discard: () => void;
	legacySettings?: DraftValue;
	retainedSettings?: DraftValue;
	legacyVersion?: boolean;
}) {
	const { t } = useT();
	if (!available && !retainedSettings) return null;
	const settings = legacySettings ?? retainedSettings;
	return (
		<div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-zinc-700 px-3 py-2 text-xs text-zinc-300">
			<span>
				{!available
					? t("wizardDraft.retainedSettings")
					: legacySettings
						? t("wizardDraft.legacyRenditions")
						: legacyVersion
							? t("wizardDraft.legacyWatermarks")
							: t("wizardDraft.available")}
			</span>
			{available && !legacyVersion && (
				<InfoHint
					text={t("wizardDraft.help")}
					labelFor={t("wizardDraft.available")}
				/>
			)}
			{available && (
				<Button size="sm" variant="secondary" onClick={restore}>
					{legacySettings
						? t("wizardDraft.restoreMetadata")
						: t("wizardDraft.restore")}
				</Button>
			)}
			{settings ? (
				<a
					download="vod-draft-settings.json"
					href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(settings, null, 2))}`}
					className="rounded px-2 py-1 text-zinc-200 underline"
				>
					{t("wizardDraft.downloadSettings")}
				</a>
			) : null}
			{available && (
				<Button size="sm" variant="ghost" onClick={discard}>
					{t("wizardDraft.discard")}
				</Button>
			)}
		</div>
	);
}
