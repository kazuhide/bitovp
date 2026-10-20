import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { loadGuides } from "../src/guide/content";
import { renderGuidePage } from "../src/guide/page";
import { guidePath } from "../src/guide/routes";
import { LandingPage } from "../src/landing";
import {
	localePath,
	SITE_BASE,
	SITE_LOCALES,
	SITE_METADATA,
	SITE_ORIGIN,
	type SiteLocale,
} from "../src/site-config";
import { prepareStaticHtml } from "../src/static-html";

const output = new URL("../dist/index.html", import.meta.url);
const template = await readFile(output, "utf8");
if (!template.includes("<!--landing-->"))
	throw new Error("Landing placeholder is missing");

function escapeAttribute(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function document(
	locale: SiteLocale,
	paths: Record<SiteLocale, string>,
	title: string,
	description: string,
	markup: string,
	interactive: boolean,
) {
	const alternates = [...SITE_LOCALES, "x-default" as const]
		.map((language) => {
			const path = paths[language === "x-default" ? "en" : language];
			return `<link rel="alternate" hreflang="${language}" href="${SITE_ORIGIN}${path}" />`;
		})
		.join("\n");
	const html = template
		.replace('<html lang="en"', `<html lang="${locale}"`)
		.replace(
			/<title>[^<]*<\/title>/,
			() => `<title>${escapeAttribute(title)}</title>`,
		)
		.replace(
			/<meta name="description" content="[^"]*"\s*\/?>/,
			() =>
				`<meta name="description" content="${escapeAttribute(description)}" />`,
		)
		.replace(
			/<link rel="canonical" href="[^"]*"\s*\/?>/,
			() =>
				`<link rel="canonical" href="${SITE_ORIGIN}${paths[locale]}" />\n${alternates}`,
		)
		.replace("<!--landing-->", () => markup);
	return prepareStaticHtml(html, interactive);
}

async function writePage(path: string, html: string) {
	if (!path.startsWith(SITE_BASE) || !path.endsWith("/"))
		throw new Error("Invalid static site path");
	const target = new URL(`${path.slice(SITE_BASE.length)}index.html`, output);
	await mkdir(new URL(".", target), { recursive: true });
	await writeFile(target, html);
}

const guides = loadGuides();
for (const locale of SITE_LOCALES) {
	const metadata = SITE_METADATA[locale];
	const landingPaths = { en: localePath("en"), ja: localePath("ja") };
	await writePage(
		landingPaths[locale],
		document(
			locale,
			landingPaths,
			metadata.title,
			metadata.description,
			renderToString(createElement(LandingPage, { locale })),
			true,
		),
	);
	const chapters = guides[locale];
	const guideTitle = locale === "ja" ? "ユーザーガイド" : "User guide";
	const description =
		locale === "ja"
			? "bitovpのVOD・Liveエンコード、画質測定、コンテンツ管理、共通設定とトラブル対応の操作手順。"
			: "Instructions for bitovp VOD and Live encoding, quality measurement, content management, settings, and troubleshooting.";
	const indexPaths = { en: guidePath("en"), ja: guidePath("ja") };
	await writePage(
		indexPaths[locale],
		document(
			locale,
			indexPaths,
			`${guideTitle} | bitovp`,
			description,
			renderGuidePage(locale, chapters),
			false,
		),
	);
	for (const chapter of chapters) {
		const paths = {
			en: guidePath("en", chapter.id),
			ja: guidePath("ja", chapter.id),
		};
		await writePage(
			paths[locale],
			document(
				locale,
				paths,
				`${chapter.title} | ${guideTitle} | bitovp`,
				description,
				renderGuidePage(locale, chapters, chapter.id),
				false,
			),
		);
	}
}
console.log(
	"Pre-rendered both landing pages and 38 bilingual guide pages; guide pages need no JavaScript.",
);
