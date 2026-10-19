import { readFileSync, realpathSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt, { type Token } from "markdown-it";
import { SITE_BASE, type SiteLocale } from "../site-config";
import { GUIDE_CHAPTERS, type GuideChapterId, guidePath } from "./routes";

const ROOT = realpathSync(
	fileURLToPath(new URL("../../../../", import.meta.url)),
);
const DOCS = resolve(ROOT, "docs");
const SCREENSHOTS = resolve(ROOT, "apps/site/public/screenshots");
const parser = () =>
	new MarkdownIt({ html: false, linkify: false, typographer: false });
const sourceFiles = {
	en: resolve(DOCS, "user-guide/USER-GUIDE.en.md"),
	ja: resolve(DOCS, "user-guide/USER-GUIDE.ja.md"),
};

export interface GuideHeading {
	id: string;
	title: string;
	level: number;
}
export interface GuideChapter {
	id: GuideChapterId;
	number: number;
	title: string;
	html: string;
	headings: GuideHeading[];
}
interface ParsedChapter {
	number: number;
	title: string;
	markdown: string;
	headings: { title: string; level: number }[];
}

function required<T>(value: T | undefined, context: string): T {
	if (value === undefined) throw new Error(context);
	return value;
}

function plain(tokens: Token[] | null) {
	return (tokens ?? [])
		.map((token) => {
			if (["text", "code_inline"].includes(token.type)) return token.content;
			if (["softbreak", "hardbreak"].includes(token.type)) return " ";
			return "";
		})
		.join("");
}

export function parseChapters(text: string): ParsedChapter[] {
	const tokens = parser().parse(text, {});
	const lines = text.split("\n");
	const starts = tokens.flatMap((token, index) => {
		if (token.type !== "heading_open" || token.tag !== "h2") return [];
		const match = /^(\d+)\.\s+(.+)$/.exec(
			plain(tokens[index + 1]?.children ?? null),
		);
		if (!match?.[2] || !token.map)
			throw new Error("Guide chapters require numbered level-two headings");
		return [
			{
				number: Number(match[1]),
				title: match[2],
				start: token.map[0],
				body: token.map[1],
			},
		];
	});
	if (
		starts.length !== GUIDE_CHAPTERS.length ||
		starts.some((chapter, i) => chapter.number !== i + 1)
	)
		throw new Error("The guide must contain all 18 chapters in order");
	return starts.map((chapter, i) => {
		const markdown = lines
			.slice(chapter.body, starts[i + 1]?.start ?? lines.length)
			.join("\n");
		const body = parser().parse(markdown, {});
		const headings = body.flatMap((token, index) =>
			token.type === "heading_open"
				? [
						{
							title: plain(body[index + 1]?.children ?? null),
							level: Number(token.tag.slice(1)) - 1,
						},
					]
				: [],
		);
		if (headings.some((heading) => heading.level < 2 || heading.level > 3))
			throw new Error(
				"Guide sections must use level-three or level-four headings",
			);
		return { ...chapter, markdown, headings };
	});
}

function inside(path: string, root: string) {
	const rel = relative(root, path);
	return (
		rel === "" ||
		(!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep))
	);
}

function publishedPath(path: string, root: string, message: string) {
	if (!inside(path, root)) throw new Error(message);
	const actual = realpathSync(path);
	if (!inside(actual, root)) throw new Error(message);
	return actual;
}

export function readGuideSource(source: string) {
	const message = "Guide sources must be published Markdown documents";
	if (extname(source) !== ".md") throw new Error(message);
	const path = publishedPath(resolve(source), DOCS, message);
	if (extname(path) !== ".md") throw new Error(message);
	return readFileSync(path, "utf8");
}

export function guideLink(href: string, source: string) {
	if (href.startsWith("#")) return href;
	if (/^[a-z][a-z\d+.-]*:/i.test(href)) {
		const url = new URL(href);
		if (
			!["https:", "http:"].includes(url.protocol) ||
			url.username ||
			url.password
		)
			throw new Error("Unsupported or credential-bearing guide URL");
		return href;
	}
	if (href.startsWith("/") || href.includes("?"))
		throw new Error("Use a document link or an absolute public URL");
	const [name, fragment] = href.split("#", 2);
	const path = publishedPath(
		resolve(
			dirname(source),
			decodeURIComponent(required(name, "Missing guide link path")),
		),
		DOCS,
		"Guide links must reference published Markdown documents",
	);
	if (!inside(path, DOCS) || extname(path) !== ".md")
		throw new Error("Guide links must reference published Markdown documents");
	const basename = path.slice(path.lastIndexOf(sep) + 1);
	if (["USER-GUIDE.md", "USER-GUIDE.en.md"].includes(basename))
		return guidePath("en");
	if (basename === "USER-GUIDE.ja.md") return guidePath("ja");
	return `https://github.com/kazuhide/bitovp/blob/main/${relative(ROOT, path).split(sep).map(encodeURIComponent).join("/")}${fragment ? `#${encodeURIComponent(decodeURIComponent(fragment))}` : ""}`;
}

function screenshotPath(href: string, source: string, locale: SiteLocale) {
	const path = publishedPath(
		resolve(dirname(source), decodeURIComponent(href)),
		resolve(SCREENSHOTS, locale),
		"Guide images must use the matching public GUI screenshots",
	);
	if (!inside(path, resolve(SCREENSHOTS, locale)) || extname(path) !== ".png")
		throw new Error(
			"Guide images must use the matching public GUI screenshots",
		);
	return `${SITE_BASE}${relative(resolve(ROOT, "apps/site/public"), path).split(sep).map(encodeURIComponent).join("/")}`;
}

export function renderChapter(
	markdown: string,
	source: string,
	locale: SiteLocale,
	headings: GuideHeading[],
) {
	const md = parser();
	const tokens = md.parse(markdown, {});
	const captions = new Map<Token, string>();
	let headingIndex = 0;
	for (let i = 0; i < tokens.length; i++) {
		const token = required(tokens[i], "Missing Markdown token");
		if (token.type === "heading_open") {
			const heading = headings[headingIndex++];
			if (!heading) throw new Error("Missing bilingual heading identity");
			token.tag = `h${heading.level}`;
			token.attrSet("id", heading.id);
			token.attrSet("tabindex", "-1");
			if (tokens[i + 2]?.type !== "heading_close")
				throw new Error("Malformed guide heading");
			required(tokens[i + 2], "Missing heading closer").tag = token.tag;
		}
		const children = tokens[i + 1]?.children;
		if (
			token.type !== "paragraph_open" ||
			children?.length !== 1 ||
			children[0]?.type !== "image"
		)
			continue;
		const image = required(children[0], "Missing screenshot token");
		const imageSource = screenshotPath(
			String(image.attrGet("src") ?? ""),
			source,
			locale,
		);
		token.tag = "figure";
		token.attrSet("class", "guide-figure");
		const close = required(
			tokens[i + 2],
			"Missing screenshot paragraph closer",
		);
		close.tag = "figure";
		if (
			tokens[i + 3]?.type === "paragraph_open" &&
			/^(?:図|Figure\s)/.test(tokens[i + 4]?.content ?? "")
		) {
			required(tokens[i + 3], "Missing caption opener").tag = "figcaption";
			required(tokens[i + 5], "Missing caption closer").tag = "figcaption";
			captions.set(
				required(tokens[i + 5], "Missing caption closer"),
				imageSource,
			);
			tokens.splice(i + 2, 1);
			tokens.splice(i + 5, 0, close);
		}
	}
	if (headingIndex !== headings.length)
		throw new Error("Unused bilingual heading identities");
	const escapeHtml = md.utils.escapeHtml;
	md.renderer.rules.link_open = (items, i, options, _env, renderer) => {
		required(items[i], "Missing link token").attrSet(
			"href",
			guideLink(
				String(required(items[i], "Missing link token").attrGet("href") ?? ""),
				source,
			),
		);
		return renderer.renderToken(items, i, options);
	};
	md.renderer.rules.image = (items, i) => {
		const image = required(items[i], "Missing image token");
		const src = screenshotPath(
			String(image.attrGet("src") ?? ""),
			source,
			locale,
		);
		const alt = plain(image.children);
		const label = locale === "ja" ? "原寸の画像を開く" : "Open full-size image";
		return `<a href="${escapeHtml(src)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(`${label}: ${alt}`)}"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" width="1680" height="1120" loading="lazy" decoding="async"></a>`;
	};
	md.renderer.rules.paragraph_close = (items, i, options, _env, renderer) => {
		const src = captions.get(required(items[i], "Missing paragraph closer"));
		if (!src) return renderer.renderToken(items, i, options);
		return ` <a href="${escapeHtml(src)}" target="_blank" rel="noopener noreferrer">${locale === "ja" ? "原寸の画像" : "Full-size image"}</a></figcaption>\n`;
	};
	let table = 0;
	md.renderer.rules.table_open = () =>
		`<div class="guide-table" role="region" aria-label="${locale === "ja" ? "表" : "Table"} ${++table}" tabindex="0"><table>\n`;
	md.renderer.rules.table_close = () => "</table></div>\n";
	const fence = md.renderer.rules.fence;
	md.renderer.rules.fence = (items, i, options, env, renderer) => {
		if (!fence) throw new Error("Markdown code renderer is missing");
		return fence(items, i, options, env, renderer).replace(
			"<pre>",
			`<pre tabindex="0" aria-label="${locale === "ja" ? "コード例" : "Code sample"}">`,
		);
	};
	return md.renderer.render(tokens, md.options, {});
}

export function loadGuides(): Record<SiteLocale, GuideChapter[]> {
	const en = parseChapters(readGuideSource(sourceFiles.en));
	const ja = parseChapters(readGuideSource(sourceFiles.ja));
	const identities = en.map((chapter, index) => {
		const japanese = required(ja[index], "Missing Japanese chapter");
		if (
			chapter.headings.length !== japanese.headings.length ||
			chapter.headings.some(
				(heading, i) => heading.level !== japanese.headings[i]?.level,
			)
		)
			throw new Error(
				`Bilingual section structure differs in chapter ${index + 1}`,
			);
		const used = new Set<string>();
		return chapter.headings.map((heading) => {
			const base =
				heading.title
					.toLowerCase()
					.replace(/[^a-z\d]+/g, "-")
					.replace(/^-|-$/g, "") || "section";
			let id = base;
			for (let suffix = 2; used.has(id); suffix++) id = `${base}-${suffix}`;
			used.add(id);
			return id;
		});
	});
	const build = (
		locale: SiteLocale,
		chapters: ParsedChapter[],
	): GuideChapter[] =>
		chapters.map((chapter, i) => {
			const ids = required(identities[i], "Missing chapter section identities");
			const headings = chapter.headings.map((heading, j) => ({
				...heading,
				id: required(ids[j], "Missing section identity"),
			}));
			return {
				id: required(GUIDE_CHAPTERS[i], "Missing chapter identity"),
				number: chapter.number,
				title: chapter.title,
				headings,
				html: renderChapter(
					chapter.markdown,
					sourceFiles[locale],
					locale,
					headings,
				),
			};
		});
	return { en: build("en", en), ja: build("ja", ja) };
}
