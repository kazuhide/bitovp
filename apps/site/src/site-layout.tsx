import { type GuideChapterId, guidePath } from "./guide/routes";
import { enCopy } from "./landing-copy";
import { jaCopy } from "./landing-copy-ja";
import {
	localePath,
	SITE_LOCALES,
	type SiteLocale,
	USER_GUIDE_URLS,
} from "./site-config";

const repository = "https://github.com/kazuhide/bitovp";

export function SiteHeader({
	locale,
	guideChapter,
}: {
	locale: SiteLocale;
	guideChapter?: GuideChapterId | null;
}) {
	const copy = locale === "ja" ? jaCopy : enCopy;
	const guide = USER_GUIDE_URLS[locale];
	return (
		<header className="landing-header">
			<div className="landing-container landing-header-inner">
				<a className="landing-brand" href={localePath(locale)}>
					bitovp
				</a>
				<div className="landing-header-links">
					<nav
						aria-label={copy.navigation.mainLabel}
						className="landing-header-nav"
					>
						<a
							href={
								guideChapter === undefined
									? "#vod"
									: `${localePath(locale)}#vod`
							}
						>
							{copy.navigation.features}
						</a>
						<a href={guide}>{copy.navigation.guide}</a>
						<a href={repository}>GitHub</a>
						<a
							className="landing-button landing-button-small"
							href={`${localePath(locale)}#/demo`}
						>
							{copy.navigation.demo}
						</a>
					</nav>
					<nav
						className="landing-language-switch"
						aria-label={copy.navigation.languageLabel}
					>
						{SITE_LOCALES.map((candidate) => (
							<a
								key={candidate}
								href={
									guideChapter === undefined
										? localePath(candidate)
										: guidePath(candidate, guideChapter ?? undefined)
								}
								lang={candidate}
								hrefLang={candidate}
								aria-current={candidate === locale ? "page" : undefined}
							>
								{candidate === "ja" ? "日本語" : "English"}
							</a>
						))}
					</nav>
				</div>
			</div>
		</header>
	);
}

export function SiteFooter({ locale }: { locale: SiteLocale }) {
	const copy = locale === "ja" ? jaCopy : enCopy;
	const guide = USER_GUIDE_URLS[locale];
	return (
		<footer className="landing-footer">
			<div className="landing-container landing-footer-inner">
				<p>{copy.footer.license}</p>
				<nav aria-label={copy.footer.navigationLabel}>
					<a href={repository}>{copy.footer.source}</a>
					<a href={guide}>{copy.footer.guide}</a>
					<a href={`${repository}/issues`}>{copy.footer.issues}</a>
				</nav>
			</div>
		</footer>
	);
}
