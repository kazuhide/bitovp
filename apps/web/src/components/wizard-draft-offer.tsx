"use client";
import { useT } from "@/lib/i18n/context";
import { Button } from "./ui/button";
import { InfoHint } from "./ui/info-hint";

export function WizardDraftOffer({
	available,
	restore,
	discard,
}: {
	available: boolean;
	restore: () => void;
	discard: () => void;
}) {
	const { t } = useT();
	if (!available) return null;
	return (
		<div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-zinc-700 px-3 py-2 text-xs text-zinc-300">
			<span>{t("wizardDraft.available")}</span>
			<InfoHint
				text={t("wizardDraft.help")}
				labelFor={t("wizardDraft.available")}
			/>
			<Button size="sm" variant="secondary" onClick={restore}>
				{t("wizardDraft.restore")}
			</Button>
			<Button size="sm" variant="ghost" onClick={discard}>
				{t("wizardDraft.discard")}
			</Button>
		</div>
	);
}
