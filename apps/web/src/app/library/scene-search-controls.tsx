"use client";

import { useId } from "react";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import type {
	LibraryBrowseState,
	LibrarySceneMatch,
	LibrarySceneSort,
} from "./library-view-preference";

function languageLabel(code: string, uiLocale: string) {
	try {
		const name = new Intl.DisplayNames([uiLocale], { type: "language" }).of(
			code,
		);
		return name && name !== code ? `${name} (${code})` : code;
	} catch {
		return code;
	}
}

export function SceneSearchControls({
	match,
	sort,
	locale,
	locales,
	loading,
	failed,
	onChange,
	onRetry,
}: {
	match: LibrarySceneMatch;
	sort: LibrarySceneSort;
	locale: string;
	locales: string[];
	loading: boolean;
	failed: boolean;
	onChange(next: Partial<LibraryBrowseState>): void;
	onRetry(): void;
}) {
	const { t, locale: uiLocale } = useT();
	const id = useId();
	const choices = [...new Set([...locales, ...(locale ? [locale] : [])])];
	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
				<div className="flex items-center gap-2">
					<label htmlFor={`${id}-match`} className="text-xs text-zinc-400">
						{t("library.sceneMatch")}
					</label>
					<SelectNative
						id={`${id}-match`}
						className="h-8 w-auto max-w-full py-1 text-xs"
						value={match}
						onChange={(event) =>
							onChange({ match: event.target.value === "any" ? "any" : "all" })
						}
					>
						<option value="all">{t("library.sceneMatchAll")}</option>
						<option value="any">{t("library.sceneMatchAny")}</option>
					</SelectNative>
					<InfoHint
						text={t("library.sceneMatchHelp")}
						labelFor={t("library.sceneMatch")}
					/>
				</div>
				<div className="flex items-center gap-2">
					<label htmlFor={`${id}-sort`} className="text-xs text-zinc-400">
						{t("library.sceneSort")}
					</label>
					<SelectNative
						id={`${id}-sort`}
						className="h-8 w-auto max-w-full py-1 text-xs"
						value={sort}
						onChange={(event) =>
							onChange({
								sort: event.target.value === "recent" ? "recent" : "relevance",
							})
						}
					>
						<option value="relevance">{t("library.sceneSortRelevance")}</option>
						<option value="recent">{t("library.sceneSortRecent")}</option>
					</SelectNative>
					<InfoHint
						text={t("library.sceneSortHelp")}
						labelFor={t("library.sceneSort")}
					/>
				</div>
				<div className="flex max-w-full items-center gap-2">
					<label htmlFor={`${id}-locale`} className="text-xs text-zinc-400">
						{t("library.sceneLanguage")}
					</label>
					<SelectNative
						id={`${id}-locale`}
						className="h-8 w-auto min-w-0 max-w-48 py-1 text-xs"
						value={locale}
						aria-busy={loading}
						onChange={(event) => onChange({ locale: event.target.value })}
					>
						<option value="">{t("library.sceneLanguageAll")}</option>
						{choices.map((code) => (
							<option key={code} value={code}>
								{languageLabel(code, uiLocale)}
							</option>
						))}
					</SelectNative>
					<InfoHint
						text={t("library.sceneLanguageHelp")}
						labelFor={t("library.sceneLanguage")}
					/>
				</div>
			</div>
			{loading && choices.length === 0 && (
				<p role="status" className="text-xs text-zinc-400">
					{t("library.sceneLanguagesLoading")}
				</p>
			)}
			{failed && (
				<div role="alert" className="flex flex-wrap items-center gap-2 text-xs">
					<span>{t("library.sceneLanguagesFailed")}</span>
					<Button
						variant="ghost"
						size="sm"
						aria-label={t("library.sceneLanguagesRetry")}
						disabled={loading}
						onClick={onRetry}
					>
						{t("library.refresh")}
					</Button>
				</div>
			)}
		</div>
	);
}
