"use client";

import { useId } from "react";
import { useT } from "@/lib/i18n/context";
import { resolveTheme, THEMES } from "@/lib/theme";
import { useTheme } from "./theme-provider";
import { InfoHint } from "./ui/info-hint";
import { SelectNative } from "./ui/input";

export function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
	const id = useId();
	const { t } = useT();
	const { theme, choose } = useTheme();
	return (
		<div className={compact ? "flex items-center gap-2" : "max-w-sm"}>
			<div className="flex items-center gap-1.5">
				<label htmlFor={id} className="shrink-0 text-xs text-zinc-400">
					{t("theme.label")}
				</label>
				<InfoHint text={t("theme.hint")} labelFor={t("theme.label")} />
			</div>
			<SelectNative
				id={id}
				value={theme}
				onChange={(event) => choose(resolveTheme(event.target.value))}
				className={compact ? "h-8 min-w-0 px-2 text-xs" : "mt-2"}
			>
				{THEMES.map((option) => (
					<option key={option} value={option}>
						{t(`theme.${option}`)}
					</option>
				))}
			</SelectNative>
		</div>
	);
}
