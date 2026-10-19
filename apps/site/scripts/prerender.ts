import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { LandingPage } from "../src/landing";
import {
	localePath,
	SITE_LOCALES,
	SITE_METADATA,
	SITE_ORIGIN,
} from "../src/site-config";

const output = new URL("../dist/index.html", import.meta.url);
const html = await readFile(output, "utf8");
if (!html.includes("<!--landing-->"))
	throw new Error("Landing placeholder is missing.");

function escapeAttribute(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

const alternates = [...SITE_LOCALES, "x-default" as const]
	.map((language) => {
		const path = localePath(language === "x-default" ? "en" : language);
		return `<link rel="alternate" hreflang="${language}" href="${SITE_ORIGIN}${path}" />`;
	})
	.join("\n");

for (const locale of SITE_LOCALES) {
	const metadata = SITE_METADATA[locale];
	const markup = renderToString(createElement(LandingPage, { locale }));
	const page = html
		.replace('<html lang="en"', `<html lang="${locale}"`)
		.replace(
			/<title>[^<]*<\/title>/,
			() => `<title>${escapeAttribute(metadata.title)}</title>`,
		)
		.replace(
			/<meta name="description" content="[^"]*"\s*\/?>/,
			() =>
				`<meta name="description" content="${escapeAttribute(metadata.description)}" />`,
		)
		.replace(
			/<link rel="canonical" href="[^"]*"\s*\/?>/,
			() =>
				`<link rel="canonical" href="${SITE_ORIGIN}${localePath(locale)}" />\n${alternates}`,
		)
		.replace("<!--landing-->", () => markup);
	const path = locale === "ja" ? new URL("ja/index.html", output) : output;
	await mkdir(new URL(".", path), { recursive: true });
	await writeFile(path, page);
}
console.log(
	"Pre-rendered the English and Japanese feature guides for visitors without JavaScript.",
);
