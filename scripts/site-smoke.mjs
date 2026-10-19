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
		const file = await realpath(resolve(dist, relative || "index.html"));
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
const unexpected = [];
const browser = await chromium.launch({ headless: true });
let page;

try {
	const context = await browser.newContext({
		viewport: { width: 1680, height: 1120 },
		reducedMotion: "reduce",
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
		await page.goto(`${base}#/demo${path === "/" ? "" : path}`);
		await page.locator("main h1").first().waitFor();
		await page
			.getByText("This demo screen could not be loaded.", { exact: true })
			.waitFor({ state: "hidden" });
	};
	const step = (name) =>
		page
			.getByRole("navigation", { name: /wizard steps/i })
			.getByRole("button", { name })
			.click();
	const closePicker = async () => {
		const dialog = page.getByRole("dialog");
		await dialog.waitFor();
		await dialog.getByRole("button", { name: "Close", exact: true }).click();
	};
	const screenshot = async (name) => {
		if (!capture) return;
		await page.mouse.move(0, 0);
		await page.evaluate(() => {
			if (document.activeElement instanceof HTMLElement)
				document.activeElement.blur();
		});
		await page.evaluate(() => document.fonts.ready);
		await page.screenshot({
			path: resolve(images, name),
			animations: "disabled",
		});
	};
	if (capture) await mkdir(images, { recursive: true });

	if (!capture) {
		await page.goto(base);
		await page.getByRole("heading", { level: 1 }).waitFor();
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
		for (const width of [320, 768, 1024, 1440]) {
			await page.setViewportSize({ width, height: 960 });
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				`Landing overflows at ${width}px`,
			);
		}
		await page.keyboard.press("Tab");
		assert(
			await page
				.locator("a[href='#landing-main']")
				.evaluate((node) => node === document.activeElement),
			"Skip navigation is keyboard reachable",
		);
		const noJs = await browser.newContext({ javaScriptEnabled: false });
		const plainPage = await noJs.newPage();
		await plainPage.goto(base);
		await plainPage
			.getByRole("heading", {
				name: "Configure VOD and Live encoding in your browser.",
			})
			.waitFor();
		await noJs.close();
		console.log(
			"PASS: Six screenshots, responsive landing, keyboard navigation, and pre-rendered HTML.",
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
	assert.match(await page.locator(".demo-notice").innerText(), /runtime caps/i);

	await visit(`/vod/jobs/${jobId}`);
	await page.getByText("FINISHED", { exact: true }).first().waitFor();
	await screenshot("vod-job.png");
	await page.reload();
	await page.locator("main h1").first().waitFor();
	assert(page.url().includes(jobId), "A detail link survives reload");

	await visit(`/vod/new?from=${jobId}`);
	await step(/ladder/i);
	await page
		.getByText("inputs.0.credentialId: Invalid input", { exact: true })
		.waitFor({ state: "hidden" });
	await page.getByText("Advanced (H264)", { exact: true }).first().click();
	await screenshot("vod-settings.png");

	await visit(`/live/${channelId}`);
	await page.getByText("RUNNING", { exact: true }).first().waitFor();
	await screenshot("live-monitoring.png");
	await visit(`/live/new?from=${channelId}`);
	await step(/video and audio encodes/i);
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
	await page.locator("#wz-name").fill("My demo VOD encoding");
	await page.locator("#wz-account").selectOption(accountId);
	await step(/sources/i);
	await page.locator("#wz-in-0-cred").selectOption(credentialId);
	await closePicker();
	await page.locator("#wz-in-0-bucket").fill("demo-media");
	await page.locator("#wz-in-0-path").fill("bbb-10s.mp4");
	await step(/ladder/i);
	await page.locator("#wz-v-0-height").fill("720");
	await page.locator("#wz-v-0-bitrate").fill("1500000");
	await step(/^4\. Output$/);
	await page.locator("#wz-out-cred").selectOption(credentialId);
	await closePicker();
	await page.locator("#wz-out-bucket").fill("demo-media");
	await page.getByRole("button", { name: "Show summary", exact: true }).click();
	await page
		.getByRole("button", { name: "Enter manually", exact: true })
		.click();
	await page.locator("#wz-out-path").fill("my-demo-vod");
	await step(/review/i);
	await page
		.getByRole("button", { name: "Create demo job", exact: true })
		.click();
	await page
		.getByRole("heading", { name: "My demo VOD encoding", exact: true })
		.waitFor();
	const createdVodUrl = page.url();
	assert(createdVodUrl.includes("#/demo/vod/jobs/"));
	await page.reload();
	await page
		.getByRole("heading", { name: "My demo VOD encoding", exact: true })
		.waitFor();
	console.log(
		"PASS: VOD form creates a browser-local job; detail survives reload.",
	);

	await visit("/live/new");
	await page.locator("#lw-name").fill("My demo Live channel");
	await page.locator("#lw-account").selectOption(accountId);
	await step(/input/i);
	await page.locator("#lw-input-kind").selectOption("RTMP");
	await step(/video and audio encodes/i);
	await page.locator("#lw-v-0-width").fill("1280");
	await page.locator("#lw-v-0-height").fill("720");
	await page.locator("#lw-v-0-bitrate").fill("1500000");
	await page.locator("#lw-seglen").fill("2");
	await step(/destinations/i);
	await page.locator("#lw-out-cred").selectOption(credentialId);
	await closePicker();
	await page.locator("#lw-out-bucket").fill("demo-media");
	await page.locator("#lw-out-base").fill("my-demo-live");
	await step(/start/i);
	await page.locator("#lw-streamkey").fill("demoStream");
	await step(/review/i);
	await page
		.getByRole("button", { name: "Create demo channel", exact: true })
		.click();
	await page
		.getByRole("heading", { name: "My demo Live channel", exact: true })
		.waitFor();
	assert(page.url().includes("#/demo/live/"));
	console.log(
		"PASS: Live form creates a simulated channel without provider requests.",
	);
	await page.evaluate(async () => {
		const identity = await (await fetch("/api/auth/session")).json();
		localStorage.setItem(
			`bitovp.wizard-draft:${JSON.stringify([identity.organizationId, identity.effectiveUserId, "vod", "new"])}`,
			"{}",
		);
		localStorage.setItem("unrelated-demo-smoke-marker", "preserve");
	});
	await page.getByRole("button", { name: "Reset demo", exact: true }).click();
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
		"PASS: Report downloads stay local; resetting does not remove unrelated browser data.",
	);

	assert.deepEqual(
		unexpected,
		[],
		"No browser errors or real API requests are allowed",
	);
	console.log(
		capture
			? "Captured six screenshots from the reused application screens."
			: "PASS: Production site smoke; no cloud API traffic.",
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
