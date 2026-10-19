import { ThemeSwitcher } from "@/components/theme-switcher";
import { useT } from "@/lib/i18n/context";
import { DEMO_TEXT } from "../demo/text";
import { localePath, SITE_LOCALES } from "../site-config";
import { demoLocaleHref } from "./navigation";

export function SessionMenu() {
	const { locale, t } = useT();
	const text = DEMO_TEXT[locale];
	return (
		<div className="space-y-3 text-xs text-zinc-400">
			<p>{text.workspace}</p>
			<div className="flex flex-wrap gap-2">
				<nav aria-label={t("locale.label")}>
					<p className="mb-1 text-[11px] text-zinc-600">{t("locale.label")}</p>
					<div className="flex gap-1">
						{SITE_LOCALES.map((candidate) => (
							<a
								key={candidate}
								href={demoLocaleHref(candidate, window.location)}
								lang={candidate}
								hrefLang={candidate}
								aria-current={candidate === locale ? "page" : undefined}
								className={`rounded px-1.5 py-0.5 text-[11px] transition-colors ${candidate === locale ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"}`}
							>
								{t(`locale.${candidate}`)}
							</a>
						))}
					</div>
				</nav>
				<ThemeSwitcher />
			</div>
			<a href={localePath(locale)} className="text-emerald-400 underline">
				{text.about}
			</a>
		</div>
	);
}
