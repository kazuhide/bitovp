"use client";

import { InfoHint } from "@/components/ui/info-hint";

import { useT } from "@/lib/i18n/context";
import type { WebBuildInfo } from "@/lib/server/build-info";

export function BuildInfoPanel({ version, commit }: WebBuildInfo) {
	const { t } = useT();
	return (
		<section className="mt-8 border-t border-zinc-800 pt-5">
			<div className="flex items-center gap-2">
				<h2 className="font-medium text-sm text-zinc-300">
					{t("settingsBuild.title")}
				</h2>
				<InfoHint
					labelFor={t("settingsBuild.title")}
					text={t("settingsBuild.scope")}
				/>
			</div>
			<dl className="mt-3 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-[auto_1fr]">
				<dt className="text-zinc-500">{t("settingsBuild.version")}</dt>
				<dd className="text-zinc-300">{version}</dd>
				<dt className="text-zinc-500">{t("settingsBuild.commit")}</dt>
				<dd className="min-w-0 break-all font-mono text-zinc-300">
					{commit ?? t("settingsBuild.unknown")}
				</dd>
			</dl>
		</section>
	);
}
