import assert from "node:assert/strict";
import { expect } from "@playwright/test";

const publishedBase = "https://kazuhide.github.io/bitovp/";
const japanesePdf =
	"https://github.com/kazuhide/bitovp/raw/refs/heads/main/docs/user-guide/bitovp-user-guide-ja.pdf";
const locales = {
	en: { path: "", browserLocale: "en-US", title: "User guide" },
	ja: { path: "ja/", browserLocale: "ja-JP", title: "ユーザーガイド" },
};
const representativeChapters = ["vod-encoding", "quality", "appendix"];
const widths = [320, 768, 1024, 1440];

function guideUrl(base, locale, chapter = "") {
	return new URL(`${locales[locale].path}guide/${chapter}`, base).href;
}

async function visit(page, url, reload = false) {
	const response = reload
		? await page.reload({ waitUntil: "load" })
		: await page.goto(url, { waitUntil: "load" });
	assert(response, `${url}: navigation must return a document`);
	assert.equal(response.status(), 200, `${url}: document must return HTTP 200`);
	assert.equal(page.url(), url, `${url}: navigation must retain the deep URL`);
	assert.match(
		response.headers()["content-type"] ?? "",
		/text\/html/i,
		`${url}: the response must be HTML`,
	);
}

async function assertShell(page, base, locale, chapter, title) {
	const url = guideUrl(base, locale, chapter);
	const label = locales[locale].title;
	assert.equal(await page.locator("html").getAttribute("lang"), locale, url);
	assert.equal(await page.locator(".site-guide").count(), 1, url);
	assert.equal(
		await page.locator(".site-guide").getAttribute("lang"),
		locale,
		url,
	);
	assert.equal(await page.locator("h1").count(), 1, `${url}: one page heading`);
	assert.equal((await page.locator("h1").innerText()).trim(), title, url);
	const documentTitle = await page.title();
	for (const part of [title, label, "bitovp"])
		assert(documentTitle.includes(part), `${url}: title must identify ${part}`);
	const description = page.locator('meta[name="description"]');
	assert.equal(await description.count(), 1, `${url}: one description`);
	assert((await description.getAttribute("content"))?.trim(), url);
	if (locale === "ja")
		assert.match(documentTitle, /[\u3040-\u30ff\u4e00-\u9fff]/, url);
	assert.equal(
		await page.locator('link[rel="canonical"]').count(),
		1,
		`${url}: one canonical URL`,
	);
	assert.equal(
		await page.locator('link[rel="canonical"]').getAttribute("href"),
		guideUrl(publishedBase, locale, chapter),
		`${url}: canonical must identify this published page`,
	);
	const alternates = await page
		.locator('link[rel="alternate"][hreflang]')
		.evaluateAll((nodes) =>
			nodes.map((node) => [node.hreflang, node.getAttribute("href")]),
		);
	assert.deepEqual(
		alternates.sort(),
		[
			["en", guideUrl(publishedBase, "en", chapter)],
			["ja", guideUrl(publishedBase, "ja", chapter)],
			["x-default", guideUrl(publishedBase, "en", chapter)],
		].sort(),
		`${url}: alternate languages must identify the same chapter`,
	);
	assert.equal(await page.locator("script").count(), 0, `${url}: no scripts`);
	assert.equal(
		await page.locator('link[rel="modulepreload"], link[as="script"]').count(),
		0,
		`${url}: no script preloads`,
	);
	const ids = await page
		.locator("[id]")
		.evaluateAll((nodes) => nodes.map((node) => node.id));
	assert.equal(new Set(ids).size, ids.length, `${url}: IDs must be unique`);
	assert.equal(await page.locator(".guide-pdf").count(), 1, url);
	assert.equal(
		await page.locator(".guide-pdf").getAttribute("href"),
		japanesePdf,
		`${url}: PDF link must retain the published Japanese PDF`,
	);
	await assertGuideNavigation(page, base, locale);
	const languageLinks = page.locator(".landing-language-switch a[hreflang]");
	assert.equal(
		await languageLinks.count(),
		2,
		`${url}: both languages available`,
	);
	for (const candidate of Object.keys(locales)) {
		const link = page.locator(
			`.landing-language-switch a[hreflang="${candidate}"]`,
		);
		assert.equal(await link.count(), 1, url);
		assert.equal(
			new URL(await link.getAttribute("href"), url).href,
			guideUrl(base, candidate, chapter),
			`${url}: language switch must keep the chapter`,
		);
		assert.equal(
			await link.getAttribute("aria-current"),
			candidate === locale ? "page" : null,
			`${url}: current language must be identified`,
		);
	}
}

async function assertGuideNavigation(page, base, locale) {
	for (const selector of [".landing-header-nav", ".landing-footer nav"]) {
		const links = await page
			.locator(`${selector} a[href]`)
			.evaluateAll((nodes) =>
				nodes.map((node) => ({
					href: node.href,
					text: node.textContent?.trim(),
				})),
			);
		const guideLinks = links.filter(
			(link) => link.href === guideUrl(base, locale),
		);
		assert.equal(guideLinks.length, 1, `${page.url()}: ${selector} guide link`);
		assert(
			guideLinks[0].text,
			`${page.url()}: guide link needs a visible label`,
		);
	}
}

async function readDirectory(page, base, locale) {
	const url = guideUrl(base, locale);
	const entries = await page
		.locator(".guide-directory li a")
		.evaluateAll((nodes) =>
			nodes.map((node) => {
				const item = node.closest("li");
				const list = item?.parentElement;
				return {
					href: node.href,
					title: node.textContent?.trim(),
					number:
						list?.tagName === "OL"
							? list.start + [...list.children].indexOf(item)
							: null,
				};
			}),
		);
	assert.equal(entries.length, 18, `${url}: all 18 chapters must be listed`);
	assert.deepEqual(
		entries.map((entry) => entry.number),
		Array.from({ length: 18 }, (_, i) => i + 1),
		`${url}: chapters must be numbered in reading order`,
	);
	assert.equal(new Set(entries.map((entry) => entry.href)).size, 18, url);
	assert.equal(new Set(entries.map((entry) => entry.title)).size, 18, url);
	for (const entry of entries) {
		assert(entry.title, `${url}: every chapter needs a title`);
		assert(
			entry.href.startsWith(url),
			`${url}: chapter must stay in this guide`,
		);
		entry.chapter = entry.href.slice(url.length);
		assert.match(
			entry.chapter,
			/^[a-z][a-z0-9-]*\/$/,
			`${url}: each chapter needs a distinct static URL`,
		);
	}
	return entries;
}

async function assertChapter(page, base, locale, entries, index) {
	const entry = entries[index];
	const url = entry.href;
	assert.equal(await page.locator(".guide-prose").count(), 1, url);
	assert(
		(await page.locator(".guide-prose").innerText()).trim().length > 0,
		`${url}: a chapter must contain readable guide text without JavaScript`,
	);
	assert.equal(
		(await page.locator(".guide-title > p").first().innerText()).trim(),
		locale === "ja" ? `第${index + 1}章` : `Chapter ${index + 1}`,
		`${url}: chapter number must match the directory`,
	);
	const headings = await page
		.locator(".guide-prose :is(h1, h2, h3, h4, h5, h6)")
		.evaluateAll((nodes) =>
			nodes.map((node) => ({
				id: node.id,
				level: Number(node.tagName.slice(1)),
				title: node.textContent?.trim(),
			})),
		);
	assert(headings.length > 0, `${url}: chapter sections must be navigable`);
	assert.equal(headings[0].level, 2, `${url}: sections start at level two`);
	for (const [i, heading] of headings.entries()) {
		assert(
			heading.id && heading.title,
			`${url}: every section needs an ID and title`,
		);
		assert([2, 3].includes(heading.level), `${url}: section hierarchy`);
		assert(
			heading.level <= (headings[i - 1]?.level ?? 1) + 1,
			`${url}: heading levels must not be skipped`,
		);
	}
	for (const selector of [".guide-inline-toc nav", ".guide-page-toc nav"]) {
		const links = await page.locator(`${selector} a`).evaluateAll((nodes) =>
			nodes.map((node) => ({
				id: decodeURIComponent(new URL(node.href).hash.slice(1)),
				title: node.textContent?.trim(),
			})),
		);
		assert.deepEqual(
			links,
			headings
				.filter((heading) => heading.level === 2)
				.map(({ id, title }) => ({ id, title })),
			`${url}: ${selector} must link all chapter sections in order`,
		);
	}
	const brokenAnchors = await page
		.locator('a[href*="#"]')
		.evaluateAll((nodes) =>
			nodes.flatMap((node) => {
				const target = new URL(node.href);
				if (
					target.origin !== location.origin ||
					target.pathname !== location.pathname ||
					!target.hash
				)
					return [];
				return document.getElementById(decodeURIComponent(target.hash.slice(1)))
					? []
					: [node.getAttribute("href")];
			}),
		);
	assert.deepEqual(
		brokenAnchors,
		[],
		`${url}: all chapter anchors must resolve`,
	);
	const pagination = await page
		.locator(".guide-pagination a")
		.evaluateAll((nodes) =>
			nodes.map((node) => ({
				href: node.href,
				label: node.querySelector("span")?.textContent?.trim(),
				title: node.textContent?.trim(),
			})),
		);
	const neighbors = [
		index > 0 && {
			entry: entries[index - 1],
			label: locale === "ja" ? "前の章" : "Previous chapter",
		},
		index < entries.length - 1 && {
			entry: entries[index + 1],
			label: locale === "ja" ? "次の章" : "Next chapter",
		},
	].filter(Boolean);
	assert.deepEqual(
		pagination.map(({ href, label }) => ({ href, label })),
		neighbors.map((neighbor) => ({
			href: neighbor.entry.href,
			label: neighbor.label,
		})),
		`${url}: previous and next links must follow the directory`,
	);
	for (const [i, neighbor] of neighbors.entries())
		assert(
			pagination[i].title.includes(neighbor.entry.title),
			`${url}: adjacent chapter title`,
		);
	for (const selector of [".guide-sidebar", ".guide-mobile-chapters"]) {
		const current = page.locator(`${selector} a[aria-current="page"]`);
		assert.equal(
			await current.count(),
			1,
			`${url}: ${selector} current chapter`,
		);
		assert.equal(new URL(await current.getAttribute("href"), url).href, url);
	}
	const regions = await page
		.locator(".guide-table, .guide-prose pre")
		.evaluateAll((nodes) =>
			nodes.map((node) => ({
				code: node.tagName === "PRE",
				role: node.getAttribute("role"),
				label: node.getAttribute("aria-label")?.trim(),
				tabIndex: node.tabIndex,
			})),
		);
	for (const region of regions) {
		assert.equal(
			region.tabIndex,
			0,
			`${url}: tables and code must be keyboard reachable`,
		);
		assert(region.label, `${url}: tables and code need an accessible label`);
		if (!region.code)
			assert.equal(region.role, "region", `${url}: table scroll region`);
	}
	const images = await page
		.locator(".guide-prose img")
		.evaluateAll(async (nodes) => {
			for (const node of nodes) node.loading = "eager";
			return Promise.all(
				nodes.map(async (node) => {
					let decodeError = null;
					try {
						await node.decode();
					} catch (error) {
						decodeError = String(error);
					}
					return {
						src: node.src,
						alt: node.alt.trim(),
						complete: node.complete,
						width: node.naturalWidth,
						height: node.naturalHeight,
						decodeError,
						caption: node
							.closest("figure")
							?.querySelector("figcaption")
							?.textContent?.trim(),
					};
				}),
			);
		});
	for (const image of images) {
		const source = new URL(image.src);
		assert.equal(
			source.origin,
			new URL(url).origin,
			`${url}: local screenshots`,
		);
		assert(
			source.pathname.startsWith(
				new URL(`screenshots/${locale}/`, base).pathname,
			),
			`${url}: screenshot must use the ${locale} GUI`,
		);
		assert(
			image.complete && image.width > 0 && image.height > 0,
			`${url}: screenshot must load`,
		);
		assert.equal(image.decodeError, null, `${url}: screenshot must decode`);
		assert(
			image.alt && image.caption,
			`${url}: screenshot needs alt text and a caption`,
		);
	}
	return { headings, images: images.map((image) => image.src) };
}

async function assertLanguageSwitch(page, base, locale, chapter, title) {
	const other = locale === "en" ? "ja" : "en";
	for (const candidate of [other, locale]) {
		const target = guideUrl(base, candidate, chapter);
		await page
			.locator(`.landing-language-switch a[hreflang="${candidate}"]`)
			.click();
		await page.waitForURL(target);
		assert.equal(
			await page.locator("html").getAttribute("lang"),
			candidate,
			target,
		);
		assert.equal(
			await page.locator("script").count(),
			0,
			`${target}: no scripts after language switch`,
		);
		assert.equal(
			await page.locator('link[rel="canonical"]').getAttribute("href"),
			guideUrl(publishedBase, candidate, chapter),
			target,
		);
	}
	assert.equal((await page.locator("h1").innerText()).trim(), title);
}

async function assertResponsive(page, entry, locale) {
	for (const width of widths) {
		await page.setViewportSize({ width, height: 960 });
		// A fresh document keeps the keyboard check independent of earlier anchors.
		await page.goto("about:blank");
		await visit(page, entry.href);
		await page.evaluate(() => document.fonts.ready);
		const overflow = await page.evaluate(() => {
			const problems = [];
			if (document.documentElement.scrollWidth > innerWidth)
				problems.push(
					`document: ${document.documentElement.scrollWidth}px > ${innerWidth}px`,
				);
			for (const node of document.querySelectorAll(".site-guide *")) {
				const box = node.getBoundingClientRect();
				if (!node.getClientRects().length || !box.width || !box.height)
					continue;
				const region = node.closest(".guide-table, .guide-prose pre");
				if (region && region !== node) continue;
				const name = `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}${node.className ? `.${String(node.className).trim().replace(/\s+/g, ".")}` : ""}`;
				if (box.left < -1 || box.right > innerWidth + 1)
					problems.push(
						`${name}: outside viewport (${box.left}, ${box.right})`,
					);
				if (
					node.clientWidth &&
					node.scrollWidth > node.clientWidth + 1 &&
					!region
				)
					problems.push(
						`${name}: horizontal overflow (${node.scrollWidth}px > ${node.clientWidth}px)`,
					);
			}
			return problems;
		});
		assert.deepEqual(
			overflow,
			[],
			`${entry.href}: ${width}px; only table and code regions may scroll horizontally`,
		);
		await page.keyboard.press("Tab");
		const skip = page.locator(".landing-skip");
		assert(
			await skip.evaluate((node) => node === document.activeElement),
			`${entry.href}: skip link must be the first keyboard stop at ${width}px`,
		);
		assert(
			await skip.evaluate((node) => {
				const box = node.getBoundingClientRect();
				return (
					box.top >= 0 &&
					box.left >= 0 &&
					box.right <= innerWidth &&
					box.bottom <= innerHeight
				);
			}),
			`${entry.href}: focused skip link must be visible at ${width}px`,
		);
		await page.keyboard.press("Enter");
		// Page-side RAF/timer polling does not advance with JavaScript disabled.
		// Poll native browser behavior from Node, retaining the same strict checks.
		await expect
			.poll(() => page.evaluate(() => document.activeElement?.id), {
				timeout: 15_000,
				message: `${entry.href}: skip link must focus the main content`,
			})
			.toBe("guide-main");
		assert.equal(new URL(page.url()).hash, "#guide-main");
		const mobile = page.locator(".guide-mobile-chapters");
		if (width <= 768) {
			assert(
				await mobile.isVisible(),
				`${entry.href}: mobile chapter directory`,
			);
			assert.equal(await mobile.getAttribute("open"), null);
			await mobile.locator("summary").focus();
			await page.keyboard.press("Enter");
			assert.notEqual(await mobile.getAttribute("open"), null);
			assert.equal(await mobile.locator("nav a:visible").count(), 18);
			await page.keyboard.press("Enter");
			assert.equal(await mobile.getAttribute("open"), null);
			await mobile.locator("summary").click();
			assert.notEqual(await mobile.getAttribute("open"), null);
			await mobile.locator("summary").click();
			assert.equal(await mobile.getAttribute("open"), null);
		}
		const inline = page.locator(".guide-inline-toc");
		let sections;
		if (await inline.isVisible()) {
			await inline.locator("summary").focus();
			await page.keyboard.press("Enter");
			assert.notEqual(await inline.getAttribute("open"), null);
			sections = inline.locator("nav a");
		} else {
			sections = page.locator(".guide-page-toc nav a");
		}
		const anchor = sections.last();
		assert(
			await anchor.isVisible(),
			`${entry.href}: visible section navigation`,
		);
		const fragment = await anchor.getAttribute("href");
		assert(fragment?.startsWith("#"), `${entry.href}: a chapter anchor`);
		await anchor.click();
		await page.waitForURL(`${entry.href}${fragment}`);
		const id = decodeURIComponent(fragment.slice(1));
		await expect
			.poll(
				() =>
					page.evaluate((target) => {
						const node = document.getElementById(target);
						const box = node?.getBoundingClientRect();
						return Boolean(
							node === document.activeElement &&
								box &&
								box.top >= 0 &&
								box.top < innerHeight,
						);
					}, id),
				{
					timeout: 15_000,
					message: `${entry.href}: section ${id} must be focused and visible`,
				},
			)
			.toBe(true);
		for (const region of await page
			.locator(".guide-table, .guide-prose pre")
			.all()) {
			if (
				!(await region.evaluate(
					(node) => node.scrollWidth > node.clientWidth + 1,
				))
			)
				continue;
			await region.focus();
			assert(
				await region.evaluate((node) => node === document.activeElement),
				`${entry.href}: horizontal scroll region must accept keyboard focus`,
			);
			await page.keyboard.press("ArrowRight");
			const description = await region.evaluate(
				(node) =>
					`${node.tagName} ${node.getAttribute("aria-label")} (${node.scrollWidth}px / ${node.clientWidth}px)`,
			);
			await expect
				.poll(() => region.evaluate((node) => node.scrollLeft), {
					timeout: 15_000,
					message: `${entry.href}: ${description} must scroll with ArrowRight at ${width}px`,
				})
				.toBeGreaterThan(0);
			await region.evaluate((node) => {
				node.scrollLeft = 0;
			});
		}
		console.log(
			`PASS (${locale}): ${entry.chapter} at ${width}px; keyboard, section links, and layout.`,
		);
	}
}

/** Uses the caller's guarded browser contexts; never starts a browser or server. */
export async function runGuideSmoke({ createContext, base, unexpected }) {
	assert.equal(typeof createContext, "function");
	assert(Array.isArray(unexpected));
	assert(new URL(base).pathname.endsWith("/"), "The site base must end in /");
	const diagnosticsStart = unexpected.length;
	const scriptRequests = [];
	const results = {};
	for (const [locale, copy] of Object.entries(locales)) {
		const context = await createContext({
			javaScriptEnabled: false,
			locale: copy.browserLocale,
		});
		try {
			context.on("request", (request) => {
				if (request.resourceType() === "script")
					scriptRequests.push(request.url());
			});
			const page = await context.newPage();
			page.setDefaultTimeout(15_000);
			page.setDefaultNavigationTimeout(15_000);
			page.on("pageerror", (error) =>
				unexpected.push(`Guide: ${error.message}`),
			);
			page.on("console", (message) => {
				if (message.type() === "error")
					unexpected.push(`Guide: ${message.text()}`);
			});
			await visit(page, new URL(copy.path, base).href);
			await assertGuideNavigation(page, base, locale);
			await visit(page, guideUrl(base, locale));
			await assertShell(page, base, locale, "", copy.title);
			const entries = await readDirectory(page, base, locale);
			await assertLanguageSwitch(page, base, locale, "", copy.title);
			const chapters = [];
			const screenshots = [];
			for (const [index, entry] of entries.entries()) {
				await visit(page, entry.href);
				await assertShell(page, base, locale, entry.chapter, entry.title);
				const result = await assertChapter(page, base, locale, entries, index);
				chapters.push({ chapter: entry.chapter, headings: result.headings });
				screenshots.push(...result.images);
				await assertLanguageSwitch(
					page,
					base,
					locale,
					entry.chapter,
					entry.title,
				);
				await visit(page, entry.href, true);
				await assertShell(page, base, locale, entry.chapter, entry.title);
				assert(
					(await page.locator(".guide-prose").innerText()).trim(),
					`${entry.href}: body must survive a deep reload`,
				);
			}
			assert.equal(
				screenshots.length,
				6,
				`${locale}: all six documented screenshots`,
			);
			assert.equal(
				new Set(screenshots).size,
				6,
				`${locale}: six distinct screenshots`,
			);
			for (const chapter of representativeChapters) {
				const entry = entries.find(
					(candidate) => candidate.chapter === `${chapter}/`,
				);
				assert(entry, `${locale}: responsive coverage for ${chapter}`);
				await assertResponsive(page, entry, locale);
			}
			results[locale] = chapters;
			console.log(
				`PASS (${locale}): guide index and all 18 chapters work without JavaScript; six screenshots decode.`,
			);
		} finally {
			await context.close();
		}
	}
	assert.deepEqual(
		results.en.map((chapter) => ({
			chapter: chapter.chapter,
			headings: chapter.headings.map(({ id, level }) => ({ id, level })),
		})),
		results.ja.map((chapter) => ({
			chapter: chapter.chapter,
			headings: chapter.headings.map(({ id, level }) => ({ id, level })),
		})),
		"Both languages must retain the same chapter and section identities",
	);
	assert.deepEqual(
		scriptRequests,
		[],
		"Static guide browsing must request no scripts",
	);
	assert.deepEqual(
		unexpected.slice(diagnosticsStart),
		[],
		"Guide browsing must have no browser errors or external/API traffic",
	);
}
