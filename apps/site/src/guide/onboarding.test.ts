import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LandingPage } from "../landing";
import { loadGuides } from "./content";
import { renderGuidePage } from "./page";
import { GUIDE_CHAPTERS, guidePath } from "./routes";

const guides = loadGuides();
const installationSections = [
	"getting-the-app",
	"encryption-keys-and-authentication",
	"preparing-the-database",
	"startup-and-first-sign-in",
];

describe("the first-installation guide path", () => {
	it("puts installation ahead of the overview and basic operations without adding routes", () => {
		expect(GUIDE_CHAPTERS).toHaveLength(18);
		expect(GUIDE_CHAPTERS.slice(0, 4)).toEqual([
			"getting-started",
			"overview",
			"basic-operations",
			"vod-encoding",
		]);
	});

	for (const locale of ["en", "ja"] as const) {
		it(`offers installation as the primary ${locale} landing action`, () => {
			const html = renderToStaticMarkup(createElement(LandingPage, { locale }));
			const actions = html.match(
				/class="landing-actions">([\s\S]*?)<\/div>/,
			)?.[1];
			expect(actions).toMatch(
				new RegExp(
					`^<a class="landing-button" href="${guidePath(locale, "getting-started")}"`,
				),
			);
			expect(actions).toContain('href="#/demo"');
			expect(html).not.toContain(guidePath(locale, "appendix"));
		});

		it(`shows a direct setup link and puts it first in the ${locale} chapter navigation`, () => {
			const html = renderGuidePage(locale, guides[locale]);
			expect(
				html.includes(
					`class="landing-button guide-start-link" href="${guidePath(locale, "getting-started")}"`,
				),
			).toBe(true);
			const sidebar = html.match(
				/class="guide-sidebar">([\s\S]*?)<\/aside>/,
			)?.[1];
			expect(
				sidebar?.indexOf(guidePath(locale, "getting-started")),
			).toBeLessThan(sidebar?.indexOf(guidePath(locale, "overview")) ?? -1);
			const first = renderGuidePage(locale, guides[locale], "getting-started");
			const pagination = first.match(
				/class="guide-pagination"[\s\S]*?<\/nav>/,
			)?.[0];
			expect(pagination).toContain(guidePath(locale, "overview"));
			expect(pagination).not.toContain(guidePath(locale, "basic-operations"));
			const overview = renderGuidePage(locale, guides[locale], "overview");
			expect(
				overview.match(/class="guide-pagination"[\s\S]*?<\/nav>/)?.[0],
			).toContain(guidePath(locale, "getting-started"));
		});

		it(`walks from Docker through the first encoding in the ${locale} first chapter`, () => {
			const first = guides[locale][0];
			expect(first?.id).toBe("getting-started");
			const headings = first?.headings.map((heading) => heading.id) ?? [];
			const ordered = [
				...installationSections,
				"registering-a-bitmovin-account",
				"input-and-output-credentials",
				"before-your-first-run",
			];
			const positions = ordered.map((id) => headings.indexOf(id));
			expect(positions.every((index) => index >= 0)).toBe(true);
			expect(positions).toEqual([...positions].sort((a, b) => a - b));
			expect(first?.html).toContain("docker compose logs web");
			expect(first?.html).toContain("/settings/bitmovin");
			expect(first?.html).toContain("/settings/credentials");
			expect(first?.html).toContain("AWS S3");
			expect(first?.html).toContain(guidePath(locale, "vod-encoding"));
			expect(first?.html).toContain(guidePath(locale, "live-encoding"));
			expect(first?.html).not.toContain("docker compose down");
		});

		it(`retains the ${locale} appendix installation bookmarks as links to the moved steps`, () => {
			const appendix = guides[locale].find(
				(chapter) => chapter.id === "appendix",
			);
			expect(appendix).toBeDefined();
			for (const id of [
				"installation-and-first-sign-in",
				...installationSections,
			]) {
				expect(appendix?.html).toContain(`id="${id}"`);
				expect(
					appendix?.html.includes(
						`${guidePath(locale, "getting-started")}#${id}`,
					),
				).toBe(true);
			}
			expect(appendix?.html).not.toContain(
				"docker compose build migrate worker web",
			);
			expect(appendix?.html).toContain("docker compose down");
		});
	}

	it("starts the repository's documentation links with installation and first-run guidance", () => {
		const readme = readFileSync(
			fileURLToPath(new URL("../../../../README.md", import.meta.url)),
			"utf8",
		);
		expect(readme).toContain(
			"https://kazuhide.github.io/bitovp/guide/getting-started/",
		);
		expect(readme).toContain(
			"https://kazuhide.github.io/bitovp/ja/guide/getting-started/",
		);
	});
});
