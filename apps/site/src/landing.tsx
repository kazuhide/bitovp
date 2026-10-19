import { Fragment } from "react";
import { guidePath } from "./guide/routes";
import {
	enCopy,
	FEATURE_IDS,
	type FeatureCopy,
	type FeatureId,
	type LandingCopy,
	type ScreenshotName,
} from "./landing-copy";
import { jaCopy } from "./landing-copy-ja";
import { SITE_BASE, type SiteLocale } from "./site-config";
import { SiteFooter, SiteHeader } from "./site-layout";

const repository = "https://github.com/kazuhide/bitovp";
const featureLinks = (locale: SiteLocale): Record<FeatureId, string> => ({
	vod: "#/demo/vod/new",
	live: "#/demo/live/new",
	monitoring: guidePath(locale, "live-operations"),
	jobs: "#/demo/vod/jobs",
	dashboard: "#/demo",
	quality: guidePath(locale, "quality"),
});
const featureScreenshots: Partial<Record<FeatureId, ScreenshotName>> = {
	live: "live-settings",
	monitoring: "live-monitoring",
	jobs: "vod-job",
	dashboard: "dashboard",
	quality: "quality",
};

function Screenshot({
	file,
	locale,
	copy,
	priority = false,
}: {
	file: ScreenshotName;
	locale: SiteLocale;
	copy: LandingCopy;
	priority?: boolean;
}) {
	const image = copy.screenshots[file];
	const src = `${SITE_BASE}screenshots/${locale}/${file}.png`;
	return (
		<figure
			className={
				priority
					? "landing-screenshot landing-hero-screenshot"
					: "landing-screenshot"
			}
		>
			<a
				href={src}
				target="_blank"
				rel="noopener noreferrer"
				aria-label={`${copy.imageLinks.open}: ${image.alt}`}
			>
				<img
					src={src}
					alt={image.alt}
					width="1680"
					height="1120"
					loading={priority ? "eager" : "lazy"}
					fetchPriority={priority ? "high" : "auto"}
					decoding="async"
				/>
			</a>
			<figcaption>
				<span>{image.caption}</span>
				<a href={src} target="_blank" rel="noopener noreferrer">
					{copy.imageLinks.fullSize}
					<span className="landing-sr-only">{copy.imageLinks.newTab}</span>
				</a>
			</figcaption>
		</figure>
	);
}

function FeatureTour({
	id,
	copy,
	locale,
}: {
	id: FeatureId;
	copy: FeatureCopy;
	locale: SiteLocale;
}) {
	return (
		<section className="landing-tour" aria-labelledby={id}>
			<div className="landing-tour-heading">
				<h2 id={id} tabIndex={-1}>
					{copy.title}
				</h2>
				<div className="landing-tour-copy">
					{copy.paragraphs.map((paragraph) => (
						<p key={paragraph}>{paragraph}</p>
					))}
					{copy.bullets ? (
						<ul>
							{copy.bullets.map((bullet) => (
								<li key={bullet}>{bullet}</li>
							))}
						</ul>
					) : null}
					{copy.note ? (
						<p className="landing-context-note">{copy.note}</p>
					) : null}
					<a className="landing-text-link" href={featureLinks(locale)[id]}>
						{copy.link}
					</a>
				</div>
			</div>
		</section>
	);
}

export function LandingPage({ locale = "en" }: { locale?: SiteLocale }) {
	const copy = locale === "ja" ? jaCopy : enCopy;
	return (
		<div className="site-landing" lang={locale}>
			<a className="landing-skip" href="#landing-main">
				{copy.skip}
			</a>
			<SiteHeader locale={locale} />
			<main id="landing-main" tabIndex={-1} className="landing-container">
				<div className="landing-intro">
					<h1>{copy.hero.title}</h1>
					<p className="landing-lead">{copy.hero.intro}</p>
					<div className="landing-actions">
						<a className="landing-button" href="#/demo">
							{copy.hero.demo}
						</a>
						<a
							className="landing-text-link"
							href={guidePath(locale, "appendix")}
						>
							{copy.hero.install}
						</a>
					</div>
					<p className="landing-intro-note">{copy.hero.note}</p>
				</div>
				<Screenshot file="vod-settings" locale={locale} copy={copy} priority />
				<nav
					aria-label={copy.navigation.tourLabel}
					className="landing-tour-nav"
				>
					{FEATURE_IDS.map((id) => (
						<a key={id} href={`#${id}`}>
							{copy.navigation.tour[id]}
						</a>
					))}
				</nav>
				{FEATURE_IDS.map((id) => (
					<Fragment key={id}>
						<FeatureTour id={id} copy={copy.features[id]} locale={locale} />
						{featureScreenshots[id] ? (
							<Screenshot
								file={featureScreenshots[id]}
								locale={locale}
								copy={copy}
							/>
						) : null}
					</Fragment>
				))}
				<section className="landing-more" aria-labelledby="more-features">
					<h2 id="more-features">{copy.more.title}</h2>
					<div className="landing-more-columns">
						{copy.more.columns.map((column) => (
							<div key={column.title}>
								<h3>{column.title}</h3>
								<p>{column.body}</p>
							</div>
						))}
					</div>
					<a
						className="landing-text-link"
						href={guidePath(locale, "content-and-storage")}
					>
						{copy.more.link}
					</a>
				</section>
				<section className="landing-demo-note" aria-labelledby="demo-scope">
					<div>
						<h2 id="demo-scope">{copy.demo.title}</h2>
						<p>{copy.demo.body}</p>
					</div>
					<a className="landing-button" href="#/demo">
						{copy.demo.link}
					</a>
				</section>
				<section className="landing-run" aria-labelledby="run-bitovp">
					<h2 id="run-bitovp">{copy.run.title}</h2>
					{copy.run.paragraphs.map((paragraph) => (
						<p key={paragraph}>{paragraph}</p>
					))}
					<div className="landing-actions">
						<a className="landing-button" href={guidePath(locale, "appendix")}>
							{copy.run.install}
						</a>
						<a
							className="landing-text-link"
							href={`${repository}/blob/main/docs/BITMOVIN-API-COVERAGE.md`}
						>
							{copy.run.coverage}
						</a>
					</div>
					<details>
						<summary>{copy.run.requirements}</summary>
						<p>{copy.run.requirementsBody}</p>
					</details>
				</section>
			</main>
			<SiteFooter locale={locale} />
		</div>
	);
}
