import { renderToStaticMarkup } from "react-dom/server";
import { localePath, type SiteLocale } from "../site-config";
import { SiteFooter, SiteHeader } from "../site-layout";
import type { GuideChapter } from "./content";
import { type GuideChapterId, guidePath, JAPANESE_GUIDE_PDF } from "./routes";

const labels = {
	en: {
		title: "User guide",
		home: "Home",
		skip: "Skip to content",
		chapters: "Chapters",
		contents: "On this page",
		previous: "Previous chapter",
		next: "Next chapter",
		pdf: "Download the Japanese PDF",
		intro:
			"Instructions for configuring and running VOD and Live encodings, checking output, and managing the application.",
		start:
			"If you are using bitovp for the first time, start with Getting ready. Choose a chapter below for a specific task or setting.",
		groups: [
			"Getting started",
			"VOD encoding",
			"Live encoding",
			"Quality and usage",
			"Content and administration",
			"Troubleshooting and reference",
		],
	},
	ja: {
		title: "ユーザーガイド",
		home: "ホーム",
		skip: "本文へ移動",
		chapters: "章の目次",
		contents: "この章の項目",
		previous: "前の章",
		next: "次の章",
		pdf: "日本語ガイドをPDFで保存",
		intro:
			"VOD・Liveの設定と実行、出力の確認、アプリの管理について説明します。",
		start:
			"初めて使う場合は「利用準備」からお読みください。操作や設定を調べる場合は、次の目次から該当する章を選べます。",
		groups: [
			"使い始める前に",
			"VODエンコード",
			"Liveエンコード",
			"画質と利用状況",
			"コンテンツと管理設定",
			"困ったとき・参照情報",
		],
	},
};
const groups = [
	[0, 3],
	[3, 6],
	[6, 10],
	[10, 12],
	[12, 16],
	[16, 18],
] as const;

const BODY_SLOT = '<div class="guide-prose" id="guide-content"></div>';

function ChapterLinks({
	chapters,
	locale,
	current,
}: {
	chapters: GuideChapter[];
	locale: SiteLocale;
	current?: GuideChapterId;
}) {
	return (
		<ol>
			{chapters.map((chapter) => (
				<li key={chapter.id}>
					<a
						href={guidePath(locale, chapter.id)}
						aria-current={current === chapter.id ? "page" : undefined}
					>
						{chapter.title}
					</a>
				</li>
			))}
		</ol>
	);
}

function SectionLinks({ chapter }: { chapter: GuideChapter }) {
	return (
		<ul>
			{chapter.headings
				.filter((heading) => heading.level === 2)
				.map((heading) => (
					<li key={heading.id}>
						<a href={`#${heading.id}`}>{heading.title}</a>
					</li>
				))}
		</ul>
	);
}

export function renderGuidePage(
	locale: SiteLocale,
	chapters: GuideChapter[],
	id?: GuideChapterId,
) {
	const copy = labels[locale];
	const chapter = id
		? chapters.find((candidate) => candidate.id === id)
		: undefined;
	if (id && !chapter) throw new Error(`Unknown guide chapter: ${id}`);
	const index = chapter ? chapters.indexOf(chapter) : -1;
	const previous = chapters[index - 1];
	const next = chapters[index + 1];
	const html = renderToStaticMarkup(
		<div className="site-landing site-guide" lang={locale}>
			<a className="landing-skip" href="#guide-main">
				{copy.skip}
			</a>
			<SiteHeader locale={locale} guideChapter={id ?? null} />
			<div className="landing-container guide-layout">
				<aside className="guide-sidebar">
					<nav aria-label={copy.chapters}>
						<a className="guide-index-link" href={guidePath(locale)}>
							{copy.title}
						</a>
						<ChapterLinks chapters={chapters} locale={locale} current={id} />
					</nav>
				</aside>
				<main id="guide-main" className="guide-main" tabIndex={-1}>
					<nav
						aria-label={locale === "ja" ? "現在の位置" : "Breadcrumb"}
						className="guide-breadcrumb"
					>
						<ol>
							<li>
								<a href={localePath(locale)}>{copy.home}</a>
							</li>
							<li>
								{chapter ? (
									<a href={guidePath(locale)}>{copy.title}</a>
								) : (
									<span aria-current="page">{copy.title}</span>
								)}
							</li>
							{chapter ? (
								<li>
									<span aria-current="page">{chapter.title}</span>
								</li>
							) : null}
						</ol>
					</nav>
					<details className="guide-mobile-chapters">
						<summary>{copy.chapters}</summary>
						<nav aria-label={copy.chapters}>
							<ChapterLinks chapters={chapters} locale={locale} current={id} />
						</nav>
					</details>
					<header className="guide-title">
						{chapter ? (
							<p>
								{locale === "ja"
									? `第${chapter.number}章`
									: `Chapter ${chapter.number}`}
							</p>
						) : null}
						<h1>{chapter?.title ?? copy.title}</h1>
						{!chapter ? (
							<>
								<p>{copy.intro}</p>
								<p>{copy.start}</p>
							</>
						) : null}
						<a className="guide-pdf" href={JAPANESE_GUIDE_PDF}>
							{copy.pdf}
						</a>
					</header>
					{chapter ? (
						<>
							<details className="guide-inline-toc">
								<summary>{copy.contents}</summary>
								<nav aria-label={copy.contents}>
									<SectionLinks chapter={chapter} />
								</nav>
							</details>
							<div className="guide-prose" id="guide-content" />
							<nav
								className="guide-pagination"
								aria-label={locale === "ja" ? "前後の章" : "Chapter navigation"}
							>
								{previous ? (
									<a href={guidePath(locale, previous.id)}>
										<span>{copy.previous}</span>
										{previous.title}
									</a>
								) : (
									<span />
								)}
								{next ? (
									<a href={guidePath(locale, next.id)}>
										<span>{copy.next}</span>
										{next.title}
									</a>
								) : (
									<span />
								)}
							</nav>
						</>
					) : (
						<div className="guide-directory">
							{groups.map(([start, end], i) => (
								<section key={copy.groups[i]} aria-labelledby={`group-${i}`}>
									<h2 id={`group-${i}`}>{copy.groups[i]}</h2>
									<ol start={start + 1}>
										{chapters.slice(start, end).map((item) => (
											<li key={item.id}>
												<a href={guidePath(locale, item.id)}>{item.title}</a>
											</li>
										))}
									</ol>
								</section>
							))}
						</div>
					)}
				</main>
				{chapter ? (
					<aside className="guide-page-toc">
						<nav aria-label={copy.contents}>
							<h2>{copy.contents}</h2>
							<SectionLinks chapter={chapter} />
						</nav>
					</aside>
				) : null}
			</div>
			<SiteFooter locale={locale} />
		</div>,
	);
	if (!chapter) return html;
	if (!html.includes(BODY_SLOT))
		throw new Error("The static guide content slot is missing");
	// Only build-time Markdown output is inserted; raw HTML is disabled in its parser.
	return html.replace(
		BODY_SLOT,
		() => `<div class="guide-prose" id="guide-content">${chapter.html}</div>`,
	);
}
