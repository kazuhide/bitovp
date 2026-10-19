import assert from "node:assert/strict";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = resolve(root, "apps/site/dist");
const capture = process.argv.includes("--capture-screenshots");
const images = resolve(root, "apps/site/public/screenshots");
const mime = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".json": "application/json",
};

const server = createServer(async (request, response) => {
	try {
		const url = new URL(request.url, "http://localhost");
		if (!url.pathname.startsWith("/bitovp/")) throw new Error("Unknown path");
		const relative = decodeURIComponent(url.pathname.slice("/bitovp/".length));
		const file = await realpath(
			resolve(
				dist,
				relative.endsWith("/")
					? `${relative}index.html`
					: relative || "index.html",
			),
		);
		if (!file.startsWith(`${dist}${sep}`)) throw new Error("Outside site");
		const bytes = await readFile(file);
		response.writeHead(200, {
			"content-type": mime[extname(file)] ?? "application/octet-stream",
		});
		response.end(bytes);
	} catch {
		response.writeHead(404);
		response.end("Not found");
	}
});

await new Promise((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;
const base = `${origin}/bitovp/`;
const locales = {
	en: {
		path: "",
		browserLocale: "en-US",
		wizardSteps: "Wizard steps",
		sources: /^2\. Sources$/,
		ladder: /^3\. Ladder$/,
		output: /^4\. Output$/,
		review: /^8\. Review$/,
		advancedH264: "Advanced (H264)",
		close: "Close",
		summary: "Show summary",
		manual: "Enter manually",
		liveInput: /^2\. Input$/,
		liveEncodes: /^3\. Video and audio encodes$/,
		liveDestinations: /^4\. Destinations$/,
		liveRunSafety: /^6\. Automatic restart and stop$/,
		liveTimeline: "Broadcast timeline",
		createVod: "Create demo job",
		createLive: "Create demo channel",
		reset: "Reset demo",
		vodName: "My demo VOD encoding",
		liveName: "My demo Live channel",
	},
	ja: {
		path: "ja/",
		browserLocale: "ja-JP",
		wizardSteps: "ウィザードのステップ",
		sources: /^2\. ソース$/,
		ladder: /^3\. ラダー$/,
		output: /^4\. 出力$/,
		review: /^8\. 確認$/,
		advancedH264: "詳細設定(H264)",
		close: "閉じる",
		summary: "概要を表示",
		manual: "手入力する",
		liveInput: /^2\. 入力$/,
		liveEncodes: /^3\. 映像・音声エンコード$/,
		liveDestinations: /^4\. 出力先$/,
		liveRunSafety: /^6\. 自動再起動・自動停止$/,
		liveTimeline: "配信タイムライン",
		createVod: "デモジョブを作成",
		createLive: "デモチャンネルを作成",
		reset: "デモを初期状態に戻す",
		vodName: "日本語デモの VOD エンコード",
		liveName: "日本語デモの Live チャンネル",
	},
};
const unexpected = [];
const browser = await chromium.launch({ headless: true });
let page;

async function createContext(options) {
	const context = await browser.newContext({
		viewport: { width: 1680, height: 1120 },
		reducedMotion: "reduce",
		...options,
	});
	await context.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (url.origin !== origin || url.pathname.startsWith("/api/")) {
			unexpected.push(
				`Unexpected network request: ${url.origin}${url.pathname}`,
			);
			return route.abort();
		}
		return route.continue();
	});
	return context;
}

async function runLocale(locale, copy) {
	const localeBase = `${base}${copy.path}`;
	const context = await createContext({ locale: copy.browserLocale });
	page = await context.newPage();
	page.setDefaultTimeout(15_000);
	page.setDefaultNavigationTimeout(15_000);
	page.on("pageerror", (error) => unexpected.push(error.message));
	page.on("console", (message) => {
		if (
			message.type() === "error" &&
			!(capture && message.text().includes("404"))
		)
			unexpected.push(message.text());
	});
	const visit = async (path) => {
		await page.goto(`${localeBase}#/demo${path === "/" ? "" : path}`);
		await page.locator("main h1").first().waitFor();
		assert.equal(await page.locator("html").getAttribute("lang"), locale);
	};
	const step = (name) =>
		page
			.getByRole("navigation", { name: copy.wizardSteps, exact: true })
			.getByRole("button", { name })
			.click();
	const closePicker = async () => {
		const dialog = page.getByRole("dialog");
		await dialog.waitFor();
		await dialog.getByRole("button", { name: copy.close, exact: true }).click();
	};
	const switchLocales = async () => {
		const routeHash = new URL(page.url()).hash;
		for (const candidate of [locale === "en" ? "ja" : "en", locale]) {
			await page.locator(`a[hreflang="${candidate}"]`).first().click();
			await page.waitForURL(`${base}${locales[candidate].path}${routeHash}`);
			await page.locator("main h1").first().waitFor();
			assert.equal(await page.locator("html").getAttribute("lang"), candidate);
		}
	};
	const screenshot = async (name) => {
		await page.evaluate(() => document.fonts.ready);
		assert.equal(
			await page.locator(".demo-notice").count(),
			0,
			`Opening the ${locale} ${name} screen must not report an unsupported operation`,
		);
		if (!capture) return;
		await page.mouse.move(0, 0);
		await page.evaluate(() => {
			if (document.activeElement instanceof HTMLElement)
				document.activeElement.blur();
		});
		await page.screenshot({
			path: resolve(images, locale, name),
			animations: "disabled",
		});
	};
	if (capture) await mkdir(resolve(images, locale), { recursive: true });

	if (!capture) {
		await page.goto(localeBase);
		await page.getByRole("heading", { level: 1 }).waitFor();
		assert.equal(await page.locator("html").getAttribute("lang"), locale);
		assert.match(await page.title(), /^bitovp\b/);
		assert.equal(
			await page.locator('link[rel="canonical"]').getAttribute("href"),
			`https://kazuhide.github.io/bitovp/${copy.path}`,
		);
		for (const [candidate, target] of Object.entries(locales)) {
			assert.equal(
				await page
					.locator(`link[rel="alternate"][hreflang="${candidate}"]`)
					.getAttribute("href"),
				`https://kazuhide.github.io/bitovp/${target.path}`,
			);
		}
		const bodyText = await page.locator(".site-landing").innerText();
		assert(!bodyText.includes("Bitovp"), "Display branding is lowercase");
		if (locale === "ja") {
			assert.match(bodyText, /[\u3040-\u30ff\u4e00-\u9fff]/);
			assert.match(await page.title(), /[\u3040-\u30ff\u4e00-\u9fff]/);
		}
		const brokenImages = await page
			.locator(".site-landing img")
			.evaluateAll(async (nodes) => {
				for (const node of nodes) node.loading = "eager";
				await Promise.all(nodes.map((node) => node.decode().catch(() => {})));
				return nodes
					.filter((node) => !node.naturalWidth)
					.map((node) => node.getAttribute("src"));
			});
		assert.deepEqual(brokenImages, [], "All documented screenshots must load");
		assert.equal(await page.locator(".site-landing img").count(), 6);
		const imageSources = await page
			.locator(".site-landing img")
			.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("src")));
		for (const source of imageSources)
			assert(
				source.includes(`/screenshots/${locale}/`),
				`The ${locale} guide must use its own GUI screenshots`,
			);
		for (const width of [320, 768, 1024, 1440]) {
			await page.setViewportSize({ width, height: 960 });
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				`${locale} landing overflows at ${width}px`,
			);
		}
		await page.keyboard.press("Tab");
		assert(
			await page
				.locator("a[href='#landing-main']")
				.evaluate((node) => node === document.activeElement),
			"Skip navigation is keyboard reachable",
		);
		const otherLocale = locale === "en" ? "ja" : "en";
		await page
			.locator(`.site-landing a[hreflang="${otherLocale}"]`)
			.first()
			.click();
		await page.waitForURL(`${base}${locales[otherLocale].path}`);
		assert.equal(await page.locator("html").getAttribute("lang"), otherLocale);
		const noJs = await createContext({
			javaScriptEnabled: false,
			locale: copy.browserLocale,
		});
		const plainPage = await noJs.newPage();
		await plainPage.goto(localeBase);
		await plainPage.getByRole("heading", { level: 1 }).waitFor();
		assert.equal(await plainPage.locator("html").getAttribute("lang"), locale);
		assert.equal(
			await plainPage.locator(".site-landing").innerText(),
			bodyText,
			"The full guide is readable without JavaScript",
		);
		await noJs.close();
		console.log(
			`PASS (${locale}): Six localized screenshots, responsive landing, keyboard navigation, language links, and pre-rendered HTML.`,
		);
	}
	await page.setViewportSize({ width: 1680, height: 1120 });

	await visit("/");
	await page
		.getByText("Demo account (simulated)", { exact: true })
		.first()
		.waitFor();
	const samples = await page.evaluate(async () => {
		const get = async (path) => (await fetch(path)).json();
		return {
			jobs: await get("/api/encoding-jobs"),
			channels: await get("/api/live-channels"),
			quality: await get("/api/vmaf-jobs"),
			accounts: await get("/api/bitmovin-accounts"),
			credentials: await get("/api/credentials"),
		};
	});
	const first = (value) => (Array.isArray(value) ? value : value.items)[0];
	const jobId = first(samples.jobs).id;
	const channelId = first(samples.channels).id;
	const qualityId = first(samples.quality).id;
	const accountId = first(samples.accounts).id;
	const credentialId = first(samples.credentials).id;
	await page.locator(".recharts-surface").first().waitFor();
	await screenshot("dashboard.png");
	await page.locator("a[href='#page-content']").press("Enter");
	assert(
		page.url().endsWith("#/demo"),
		"The app skip link preserves the demo route",
	);
	assert(
		await page
			.locator("#page-content")
			.evaluate((node) => node === document.activeElement),
		"The app skip link focuses main content",
	);
	const unsupported = await page.evaluate(async (id) => {
		const response = await fetch(`/api/live-channels/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ maxRunMinutes: 30 }),
		});
		return response.status;
	}, channelId);
	assert.equal(unsupported, 501);
	await page.locator(".demo-notice").waitFor();
	assert.match(
		await page.locator(".demo-notice").innerText(),
		locale === "ja" ? /稼働時間の上限設定/ : /runtime caps/i,
	);

	await visit(`/vod/jobs/${jobId}`);
	await page.getByText("FINISHED", { exact: true }).first().waitFor();
	await screenshot("vod-job.png");
	await page.reload();
	await page.locator("main h1").first().waitFor();
	assert(page.url().includes(jobId), "A detail link survives reload");
	await switchLocales();

	await visit(`/vod/new?from=${jobId}`);
	await step(copy.ladder);
	await page
		.getByText("inputs.0.credentialId: Invalid input", { exact: true })
		.waitFor({ state: "hidden" });
	await page.getByText(copy.advancedH264, { exact: true }).first().click();
	await screenshot("vod-settings.png");
	await switchLocales();

	await visit(`/live/${channelId}`);
	await page.getByText("RUNNING", { exact: true }).first().waitFor();
	await page
		.getByRole("img", { name: copy.liveTimeline, exact: true })
		.locator(".recharts-surface")
		.waitFor();
	await screenshot("live-monitoring.png");
	await visit(`/live/new?from=${channelId}`);
	await step(copy.liveEncodes);
	await screenshot("live-settings.png");
	await visit(`/qc/${qualityId}`);
	await page.locator(".recharts-surface").first().waitFor();
	await screenshot("quality.png");
	for (const format of ["JSON", "CSV"]) {
		const result = page.waitForEvent("download");
		await page.getByRole("link", { name: format, exact: true }).first().click();
		const download = await result;
		assert.equal(
			download.suggestedFilename(),
			`demo-report.${format.toLowerCase()}`,
		);
		assert((await readFile(await download.path())).length > 0);
	}
	await visit("/qc");
	await page
		.getByText("Illustrative quality report · Big Buck Bunny", { exact: true })
		.first()
		.waitFor();

	await visit("/vod/new");
	await page.locator("#wz-name").fill(copy.vodName);
	await page.locator("#wz-account").selectOption(accountId);
	await step(copy.sources);
	await page.locator("#wz-in-0-cred").selectOption(credentialId);
	await closePicker();
	await page.locator("#wz-in-0-bucket").fill("demo-media");
	await page.locator("#wz-in-0-path").fill("bbb-10s.mp4");
	await step(copy.ladder);
	await page.locator("#wz-v-0-height").fill("720");
	await page.locator("#wz-v-0-bitrate").fill("1500000");
	await step(copy.output);
	await page.locator("#wz-out-cred").selectOption(credentialId);
	await closePicker();
	await page.locator("#wz-out-bucket").fill("demo-media");
	await page.getByRole("button", { name: copy.summary, exact: true }).click();
	await page.getByRole("button", { name: copy.manual, exact: true }).click();
	await page.locator("#wz-out-path").fill("my-demo-vod");
	await step(copy.review);
	await page.getByRole("button", { name: copy.createVod, exact: true }).click();
	await page
		.getByRole("heading", { name: copy.vodName, exact: true })
		.waitFor();
	const createdVodUrl = page.url();
	assert(createdVodUrl.includes("#/demo/vod/jobs/"));
	await page.reload();
	await page
		.getByRole("heading", { name: copy.vodName, exact: true })
		.waitFor();
	console.log(
		`PASS (${locale}): VOD form creates a browser-local job; detail survives reload.`,
	);

	await visit("/live/new");
	await page.locator("#lw-name").fill(copy.liveName);
	await page.locator("#lw-account").selectOption(accountId);
	await step(copy.liveInput);
	await page.locator("#lw-input-kind").selectOption("RTMP");
	await step(copy.liveEncodes);
	await page.locator("#lw-v-0-width").fill("1280");
	await page.locator("#lw-v-0-height").fill("720");
	await page.locator("#lw-v-0-bitrate").fill("1500000");
	await page.locator("#lw-seglen").fill("2");
	await step(copy.liveDestinations);
	await page.locator("#lw-out-cred").selectOption(credentialId);
	await closePicker();
	await page.locator("#lw-out-bucket").fill("demo-media");
	await page.locator("#lw-out-base").fill("my-demo-live");
	await step(copy.liveRunSafety);
	await page.locator("#lw-streamkey").fill("demoStream");
	await step(copy.review);
	await page
		.getByRole("button", { name: copy.createLive, exact: true })
		.click();
	await page
		.getByRole("heading", { name: copy.liveName, exact: true })
		.waitFor();
	assert(page.url().includes("#/demo/live/"));
	console.log(
		`PASS (${locale}): Live form creates a simulated channel without provider requests.`,
	);
	await page.evaluate(async () => {
		const identity = await (await fetch("/api/auth/session")).json();
		localStorage.setItem(
			`bitovp.wizard-draft:${JSON.stringify([identity.organizationId, identity.effectiveUserId, "vod", "new"])}`,
			"{}",
		);
		localStorage.setItem("unrelated-demo-smoke-marker", "preserve");
	});
	await page.getByRole("button", { name: copy.reset, exact: true }).click();
	await page
		.getByText("Demo account (simulated)", { exact: true })
		.first()
		.waitFor();
	assert(page.url().endsWith("#/demo"));
	assert(
		await page.evaluate(
			() =>
				localStorage.getItem("unrelated-demo-smoke-marker") === "preserve" &&
				!Object.keys(localStorage).some((key) =>
					key.startsWith("bitovp.wizard-draft:"),
				),
		),
		"Reset clears only demo drafts and returns to the dashboard",
	);
	console.log(
		`PASS (${locale}): Report downloads stay local; resetting does not remove unrelated browser data.`,
	);
	await context.close();
}

try {
	for (const [locale, copy] of Object.entries(locales))
		await runLocale(locale, copy);
	assert.deepEqual(
		unexpected,
		[],
		"No browser errors or real API requests are allowed",
	);
	console.log(
		capture
			? "Captured twelve localized screenshots from the reused application screens."
			: "PASS: English and Japanese production site smoke; no cloud API traffic.",
	);
} catch (error) {
	console.error("Browser diagnostics:", unexpected);
	if (page)
		console.error(
			(
				await page
					.locator("body")
					.innerText()
					.catch(() => "")
			).slice(-2500),
		);
	throw error;
} finally {
	await browser.close();
	await new Promise((done) => server.close(done));
}
