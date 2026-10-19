import {
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type GuideHeading,
	guideLink,
	loadGuides,
	parseChapters,
	readGuideSource,
	renderChapter,
} from "./content";
import { GUIDE_CHAPTERS, guidePath } from "./routes";

const ROOT = realpathSync(
	fileURLToPath(new URL("../../../../", import.meta.url)),
);
const SOURCE = resolve(ROOT, "docs/user-guide/USER-GUIDE.en.md");
const EN_IMAGE = "../../apps/site/public/screenshots/en/vod-settings.png";
const JA_IMAGE = "../../apps/site/public/screenshots/ja/vod-settings.png";

function completeGuide(firstChapter = "A public chapter.") {
	return Array.from(
		{ length: 18 },
		(_, i) =>
			`## ${i + 1}. Chapter ${i + 1}\n\n${i === 0 ? firstChapter : "Chapter content."}`,
	).join("\n\n");
}

function withSourceFixture(
	run: (fixture: { published: string; outside: string }) => void,
) {
	const published = mkdtempSync(
		join(ROOT, "docs/user-guide/.guide-boundary-test-"),
	);
	let outside: string | undefined;
	try {
		outside = mkdtempSync(join(tmpdir(), "bitovp-guide-boundary-test-"));
		run({ published, outside });
	} finally {
		try {
			rmSync(published, { recursive: true, force: true });
		} finally {
			if (outside) rmSync(outside, { recursive: true, force: true });
		}
	}
}

describe("guide source publication boundary", () => {
	it("reads a published Markdown source, including an alias that stays in docs", () => {
		withSourceFixture(({ published }) => {
			const source = join(published, "published.md");
			const alias = join(published, "alias.md");
			const text = "## 1. Public fixture\n\nOnly self-created test content.\n";
			writeFileSync(source, text);
			symlinkSync(source, alias);
			expect(readGuideSource(source)).toBe(text);
			expect(readGuideSource(alias)).toBe(text);
		});
	});

	it("rejects non-Markdown sources even when they are inside docs", () => {
		withSourceFixture(({ published }) => {
			const source = join(published, "not-markdown.txt");
			writeFileSync(source, "Not a Markdown source.");
			expect(() => readGuideSource(source)).toThrow(
				/Guide sources must be published Markdown documents/,
			);
		});
	});

	it.each([
		"source",
		"document link",
	] as const)("rejects a %s symlink in docs that targets a self-created file outside the repository", (kind) => {
		withSourceFixture(({ published, outside }) => {
			const external = join(outside, "outside.md");
			const alias = join(published, "alias.md");
			writeFileSync(external, "Must not be published through this alias.");
			symlinkSync(external, alias);
			expect(() =>
				kind === "source"
					? readGuideSource(alias)
					: guideLink(relative(dirname(SOURCE), alias), SOURCE),
			).toThrow(/published Markdown documents/);
		});
	});

	it.each([
		"source",
		"document link",
	] as const)("rejects a %s below a symlinked directory that escapes docs", (kind) => {
		withSourceFixture(({ published, outside }) => {
			writeFileSync(
				join(outside, "outside.md"),
				"Self-created outside fixture.",
			);
			const aliasDirectory = join(published, "linked-directory");
			symlinkSync(outside, aliasDirectory, "dir");
			const source = join(aliasDirectory, "outside.md");
			expect(() =>
				kind === "source"
					? readGuideSource(source)
					: guideLink(relative(dirname(SOURCE), source), SOURCE),
			).toThrow(/published Markdown documents/);
		});
	});

	it("checks the resolved source extension rather than trusting an alias ending in .md", () => {
		withSourceFixture(({ published }) => {
			const target = join(published, "not-markdown.txt");
			const alias = join(published, "disguised.md");
			writeFileSync(target, "Not a published Markdown document.");
			symlinkSync(target, alias);
			expect(() => readGuideSource(alias)).toThrow(
				/Guide sources must be published Markdown documents/,
			);
		});
	});

	it("rejects lexical escapes before filesystem lookup, including nonexistent outside paths", () => {
		withSourceFixture(({ outside }) => {
			const absentDocument = join(outside, "absent.md");
			const absentImage = join(outside, "absent.png");
			expect(() => readGuideSource(absentDocument)).toThrow(
				/Guide sources must be published Markdown documents/,
			);
			expect(() =>
				guideLink(relative(dirname(SOURCE), absentDocument), SOURCE),
			).toThrow(/Guide links must reference published Markdown documents/);
			expect(() =>
				renderChapter(`![Outside fixture](${absentImage})`, SOURCE, "en", []),
			).toThrow(/Guide images must use the matching public GUI screenshots/);
		});
	});
});

describe("guide routes", () => {
	it("keeps English and Japanese guide indexes and chapter URLs distinct", () => {
		expect(guidePath("en")).toBe("/bitovp/guide/");
		expect(guidePath("ja")).toBe("/bitovp/ja/guide/");
		expect(guidePath("en", "vod-encoding")).toBe("/bitovp/guide/vod-encoding/");
		expect(guidePath("ja", "vod-encoding")).toBe(
			"/bitovp/ja/guide/vod-encoding/",
		);
	});
});

describe("guide chapter parsing", () => {
	it("keeps all 18 numbered chapters and the order of nested sections", () => {
		const chapters = parseChapters(
			completeGuide("### Setup *and* `CLI`\n\nInstructions.\n\n#### Options"),
		);
		expect(chapters.map((chapter) => chapter.number)).toEqual(
			Array.from({ length: 18 }, (_, i) => i + 1),
		);
		expect(chapters[0]).toMatchObject({
			title: "Chapter 1",
			headings: [
				{ title: "Setup and CLI", level: 2 },
				{ title: "Options", level: 3 },
			],
		});
		expect(chapters[0]?.markdown).not.toContain("## 2. Chapter 2");
		expect(chapters[17]?.title).toBe("Chapter 18");
	});

	it.each([
		[
			"missing chapter",
			completeGuide().replace("## 18. Chapter 18", "Last chapter"),
		],
		[
			"duplicate number",
			completeGuide().replace("## 18. Chapter 18", "## 17. Chapter 18"),
		],
		[
			"out-of-order number",
			completeGuide().replace("## 2. Chapter 2", "## 3. Chapter 2"),
		],
		[
			"unnumbered chapter",
			completeGuide().replace("## 1. Chapter 1", "## Overview"),
		],
		["extra chapter", `${completeGuide()}\n\n## 19. Unexpected`],
	])("rejects a %s rather than publishing an incomplete guide", (_name, markdown) => {
		expect(() => parseChapters(markdown)).toThrow();
	});

	it.each([
		"# A second document title",
		"##### A skipped section level",
	])("rejects unsupported section structure: %s", (heading) => {
		expect(() => parseChapters(completeGuide(heading))).toThrow(
			/level-three or level-four/,
		);
	});

	it.each([
		"```",
		"~~~",
	])("does not interpret headings inside a %s code fence as chapters or sections", (fence) => {
		const code = `${fence}md\n## 19. Not a chapter\n### Not a section\n![not an image](https://example.com/tracker.png)\n${fence}`;
		const chapters = parseChapters(
			completeGuide(`${code}\n\n### Actual section\n\nActual instructions.`),
		);
		expect(chapters).toHaveLength(18);
		expect(chapters[0]?.headings).toEqual([
			{ title: "Actual section", level: 2 },
		]);
		expect(chapters[0]?.markdown).toContain(code);
	});

	it("does not treat indented code or inline code as guide headings", () => {
		const chapters = parseChapters(
			completeGuide(
				"    ## 19. Indented example\n\nUse `### example` literally.",
			),
		);
		expect(chapters).toHaveLength(18);
		expect(chapters[0]?.headings).toEqual([]);
	});
});

describe("guide public links", () => {
	it.each([
		"en",
		"ja",
	] as const)("preserves detailed task-document destinations from the %s guide", (locale) => {
		const source = SOURCE.replace(".en.md", `.${locale}.md`);
		for (const name of [
			"VOD.md",
			"INSTALLATION.md",
			"QUALITY-AND-MONITORING.md",
		])
			expect(guideLink(`./${name}`, source)).toBe(
				`https://github.com/kazuhide/bitovp/blob/main/docs/user-guide/${name}`,
			);
	});

	it.each([
		"en",
		"ja",
	] as const)("preserves the explicitly linked guide language from the %s interface", (locale) => {
		const source = SOURCE.replace(".en.md", `.${locale}.md`);
		expect(guideLink("../USER-GUIDE.md", source)).toBe(guidePath("en"));
		expect(guideLink("./USER-GUIDE.en.md", source)).toBe(guidePath("en"));
		expect(guideLink("./USER-GUIDE.ja.md", source)).toBe(guidePath("ja"));
	});

	it("keeps local section links and public HTTP(S) destinations", () => {
		for (const href of [
			"#first-run",
			"https://example.com/guide?topic=vod#output",
			"http://localhost:3100/vod/new",
		]) {
			expect(guideLink(href, SOURCE)).toBe(href);
		}
	});

	it("keeps fragments on public Markdown links that cannot map to a chapter", () => {
		expect(guideLink("./VOD.md#per-title", SOURCE)).toBe(
			"https://github.com/kazuhide/bitovp/blob/main/docs/user-guide/VOD.md#per-title",
		);
	});

	it.each([
		"javascript:alert(1)",
		"data:text/html,example",
		"file:///not-a-public-document.md",
		"mailto:reader@example.com",
		"https://user:password@example.com/guide",
		"https://user@example.com/guide",
		"//example.com/guide",
		"/api/credentials",
		"./VOD.md?token=example",
		"../../README.md",
		"./bitovp-user-guide-ja.pdf",
	])("rejects non-public or unsupported link %s", (href) => {
		expect(() => guideLink(href, SOURCE)).toThrow();
	});
});

describe("guide HTML rendering", () => {
	it("escapes raw scripts, frames, images, and event handlers as text", () => {
		const html = renderChapter(
			'<script>alert(1)</script>\n\n<iframe src="https://example.com"></iframe>\n\n<img src="x" onerror="alert(1)">',
			SOURCE,
			"en",
			[],
		);
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain("&lt;iframe");
		expect(html).toContain("&lt;img");
		expect(html).not.toMatch(/<(?:script|iframe|img)\b/i);
	});

	it.each([
		"[unsafe](javascript:alert%281%29)",
		"[unsafe](JaVaScRiPt:alert%281%29)",
		"[unsafe](vbscript:example)",
		"[unsafe](data:text/html;base64,PHNjcmlwdD4=)",
	])("does not turn an unsafe Markdown URL into a live link: %s", (markdown) => {
		const html = renderChapter(markdown, SOURCE, "en", []);
		expect(html).toContain("unsafe");
		expect(html).not.toContain("<a ");
		expect(html).not.toMatch(/<(?:script|iframe)\b/i);
	});

	it("escapes URL attributes and link text without dropping a valid link", () => {
		const html = renderChapter(
			"[A < B](https://example.com/?a=1&b=2)",
			SOURCE,
			"en",
			[],
		);
		expect(html).toContain('href="https://example.com/?a=1&amp;b=2"');
		expect(html).toContain("A &lt; B</a>");
	});

	it("keeps Markdown, unsafe URLs, and raw HTML inside code inert", () => {
		const markdown = [
			"```md",
			"## 19. Not a chapter",
			"![private](../../not-a-public-image.png)",
			"[unsafe](javascript:alert(1))",
			"<script>alert(1)</script>",
			"```",
			"",
			"Use `[guide](../../not-a-public-document.md)` literally.",
		].join("\n");
		const html = renderChapter(markdown, SOURCE, "en", []);
		expect(html).toContain('<pre tabindex="0" aria-label="Code sample">');
		expect(html).toContain("## 19. Not a chapter");
		expect(html).toContain("![private](../../not-a-public-image.png)");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain(
			"<code>[guide](../../not-a-public-document.md)</code>",
		);
		expect(html).not.toMatch(/<(?:h2|img|a|script)\b/i);
	});

	it("uses the shared heading IDs and levels without adding a second chapter heading", () => {
		const headings: GuideHeading[] = [
			{ id: "first-run", title: "First run", level: 2 },
			{ id: "options", title: "Options", level: 3 },
		];
		const html = renderChapter(
			"### First *run*\n\n#### Options\n\n[Go back](#first-run)",
			SOURCE,
			"en",
			headings,
		);
		expect(html).toContain(
			'<h2 id="first-run" tabindex="-1">First <em>run</em></h2>',
		);
		expect(html).toContain('<h3 id="options" tabindex="-1">Options</h3>');
		expect(html).toContain('href="#first-run"');
		expect(html).not.toContain("<h1");
	});

	it("refuses missing or surplus heading identities instead of drifting bilingual anchors", () => {
		expect(() => renderChapter("### A section", SOURCE, "en", [])).toThrow(
			/Missing bilingual heading identity/,
		);
		expect(() =>
			renderChapter("No headings.", SOURCE, "en", [
				{ id: "unexpected", title: "Unexpected", level: 2 },
			]),
		).toThrow(/Unused bilingual heading identities/);
	});

	it("renders table headers and cells inside a keyboard-accessible region", () => {
		const html = renderChapter(
			"| Setting | Value |\n|---|---|\n| Bitrate | `2000000` |",
			SOURCE,
			"en",
			[],
		);
		expect(html).toMatch(/<div[^>]*role="region"[^>]*tabindex="0"><table>/);
		expect(html).toContain("<th>Setting</th>");
		expect(html).toContain("<td><code>2000000</code></td>");
		expect(html).toContain("</table></div>");
	});

	it.each([
		[
			"en",
			EN_IMAGE,
			"Figure 4-1. Sample settings, not measured results.",
			"Full-size image",
		],
		[
			"ja",
			JA_IMAGE,
			"図4-1　設定の表示例。実測値ではありません。",
			"原寸の画像",
		],
	] as const)("keeps the %s caption and full-size link inside the image figure", (locale, image, caption, linkLabel) => {
		const html = renderChapter(
			`![Configuration example](${image})\n\n${caption}\n\nFollowing instructions.`,
			SOURCE,
			locale,
			[],
		);
		const figure = html.match(/<figure\b[^>]*>[\s\S]*?<\/figure>/)?.[0];
		const publicImage = `/bitovp/screenshots/${locale}/vod-settings.png`;
		expect(figure).toBeDefined();
		expect(figure).toContain(`<img src="${publicImage}"`);
		expect(figure).toContain(`<figcaption>${caption}`);
		expect(figure).toContain(`>${linkLabel}</a></figcaption>`);
		expect(figure).toContain(
			`href="${publicImage}" target="_blank" rel="noopener noreferrer"`,
		);
		expect(html).toMatch(/<\/figure>\s*<p>Following instructions\.<\/p>/);
	});

	it("preserves independent captions when a chapter contains consecutive figures", () => {
		const html = renderChapter(
			`![First](${EN_IMAGE})\n\nFigure 1-1. First sample.\n\n![Second](../../apps/site/public/screenshots/en/vod-job.png)\n\nFigure 1-2. Second sample.`,
			SOURCE,
			"en",
			[],
		);
		const figures = html.match(/<figure\b[^>]*>[\s\S]*?<\/figure>/g) ?? [];
		expect(figures).toHaveLength(2);
		expect(figures[0]).toContain("Figure 1-1. First sample.");
		expect(figures[0]).not.toContain("Second sample");
		expect(figures[1]).toContain("Figure 1-2. Second sample.");
		expect(figures[1]).toContain('src="/bitovp/screenshots/en/vod-job.png"');
	});

	it.each([
		JA_IMAGE,
		"../../apps/site/public/screenshots/en/%2e%2e/ja/vod-settings.png",
		"https://example.com/tracker.png",
		"//example.com/tracker.png",
		"data:image/png;base64,aGVsbG8=",
		"./INSTALLATION.md",
		"../../README.md",
	])("rejects images outside the matching public PNG screenshots: %s", (image) => {
		expect(() =>
			renderChapter(`![Not publishable](${image})`, SOURCE, "en", []),
		).toThrow();
	});
});

describe("published bilingual guides", () => {
	it.each([
		"en",
		"ja",
	] as const)("keeps the %s appendix links to port examples and media reproduction commands", (locale) => {
		const appendix = loadGuides()[locale].find(
			(chapter) => chapter.id === "appendix",
		);
		expect(appendix).toBeDefined();
		for (const name of ["INSTALLATION.md", "QUALITY-AND-MONITORING.md"])
			expect(appendix?.html).toContain(
				`href="https://github.com/kazuhide/bitovp/blob/main/docs/user-guide/${name}"`,
			);
	});

	it("loads all 18 chapters in both languages with stable corresponding section IDs", () => {
		const guides = loadGuides();
		expect(GUIDE_CHAPTERS).toHaveLength(18);
		expect(new Set(GUIDE_CHAPTERS).size).toBe(18);
		for (const locale of ["en", "ja"] as const) {
			expect(guides[locale].map((chapter) => chapter.id)).toEqual(
				GUIDE_CHAPTERS,
			);
			expect(guides[locale].map((chapter) => chapter.number)).toEqual(
				Array.from({ length: 18 }, (_, i) => i + 1),
			);
			for (const chapter of guides[locale]) {
				expect(chapter.title.length).toBeGreaterThan(0);
				expect(
					new Set(chapter.headings.map((heading) => heading.id)).size,
				).toBe(chapter.headings.length);
				for (const heading of chapter.headings) {
					expect(chapter.html).toContain(`id="${heading.id}"`);
				}
			}
		}
		expect(
			guides.ja.map((chapter) =>
				chapter.headings.map(({ id, level }) => ({ id, level })),
			),
		).toEqual(
			guides.en.map((chapter) =>
				chapter.headings.map(({ id, level }) => ({ id, level })),
			),
		);
	});

	it.each([
		"en",
		"ja",
	] as const)("publishes exactly six local %s screenshots with captions and full-size links", (locale) => {
		const chapters = loadGuides()[locale];
		const html = chapters.map((chapter) => chapter.html).join("\n");
		const images = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map(
			(match) => match[1],
		);
		expect(images).toHaveLength(6);
		expect(new Set(images).size).toBe(6);
		for (const image of images) {
			expect(image).toMatch(
				new RegExp(`^/bitovp/screenshots/${locale}/[^/]+\\.png$`),
			);
			expect(html).toContain(
				`href="${image}" target="_blank" rel="noopener noreferrer"`,
			);
		}
		expect(html.match(/<figcaption>/g)).toHaveLength(6);
	});
});
