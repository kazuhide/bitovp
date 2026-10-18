"use client";

import { Languages } from "lucide-react";
import { useId } from "react";
import { LOCALES, type Locale } from "@/lib/i18n";
import { persistLocale, useT } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { SelectNative } from "./ui/input";

/**
 * Writes the preference cookie, then does a full `location.reload`.
 *
 * A router refresh would be lighter, and it is the wrong tool: the locale enters
 * the tree as a prop from the ROOT layout, and `<html lang>` is part of the
 * server-rendered document. A soft refresh re-renders the route segment while
 * leaving the layout's already-resolved locale and the `lang` attribute in
 * place, so half the page would switch language. Reloading is honest about the
 * fact that the whole document depends on this.
 *
 * Markup: `<fieldset>` + `<legend>` rather than a div with `role="group"` and an
 * `aria-label` — the legend IS the group's accessible name, so the visible text
 * and the announced text cannot drift apart. The options are buttons with
 * `aria-pressed`, not radios, because each click commits immediately with a
 * reload; that is a button's semantics, not a form field's.
 */
export function LocaleSwitcher({ select = false }: { select?: boolean }) {
	const id = useId();
	const { locale, t } = useT();

	function choose(next: Locale) {
		if (next === locale) {
			return;
		}
		persistLocale(next);
		window.location.reload();
	}

	if (select) {
		return (
			<div className="max-w-sm">
				<label htmlFor={id} className="block text-xs text-zinc-400">
					{t("locale.label")}
				</label>
				<SelectNative
					id={id}
					className="mt-2"
					value={locale}
					onChange={(event) => choose(event.target.value as Locale)}
				>
					{LOCALES.map((candidate) => (
						<option key={candidate} value={candidate} lang={candidate}>
							{t(`locale.${candidate}`)}
						</option>
					))}
				</SelectNative>
			</div>
		);
	}

	return (
		<fieldset className="border-0 p-0">
			<legend className="mb-1 flex items-center gap-1.5 text-[11px] text-zinc-600">
				<Languages aria-hidden className="h-3 w-3" />
				{t("locale.label")}
			</legend>
			<div className="flex gap-1">
				{LOCALES.map((candidate) => {
					const active = candidate === locale;
					return (
						<button
							key={candidate}
							type="button"
							aria-pressed={active}
							lang={candidate}
							onClick={() => choose(candidate)}
							className={cn(
								"rounded px-1.5 py-0.5 text-[11px] transition-colors",
								active
									? "bg-zinc-800 text-zinc-100"
									: "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300",
							)}
						>
							{t(`locale.${candidate}`)}
						</button>
					);
				})}
			</div>
		</fieldset>
	);
}
