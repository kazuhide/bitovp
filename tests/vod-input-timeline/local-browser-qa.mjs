#!/usr/bin/env node
/** Actual local Web/Worker/S3 verification. No mocked responses or cloud jobs. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";

export function parseOptions(args) {
	const options = { baseURL: "http://127.0.0.1:3192", output: resolve("output/vod-input-timeline-qa") };
	for (let index = 0; index < args.length; index += 2) {
		const option = args[index], value = args[index + 1];
		if (!value || !["--base-url", "--output"].includes(option)) throw new Error("Use --base-url URL and --output DIRECTORY");
		if (option === "--base-url") options.baseURL = value;
		else options.output = resolve(value);
	}
	const url = new URL(options.baseURL);
	if (url.origin !== "http://127.0.0.1:3192" || url.pathname !== "/" || url.search || url.hash || url.username || url.password)
		throw new Error("Only the dedicated http://127.0.0.1:3192 installation may be tested");
	options.baseURL = url.origin;
	return options;
}

export function requestAllowed(url, method, origin) {
	const target = new URL(url);
	if (target.origin !== origin) return false;
	if (["GET", "HEAD", "OPTIONS"].includes(method)) return true;
	if (method === "POST" && target.pathname === "/api/vod/input-previews") return true;
	return method === "DELETE" && /^\/api\/vod\/input-previews\/[0-9a-f-]{36}$/.test(target.pathname);
}

const credential = "VOD timeline local S3 (synthetic only)";
const bucket = "bitovp-editing-preview";
const content = { editor: "入力タイムライン", position: "シーケンスの再生位置", video: "入力タイムラインのプレビュー", play: "再生・一時停止" };

async function addSource(page, editor, filename) {
	await editor.getByRole("button", { name: "素材を追加", exact: true }).click();
	const picker = page.getByRole("dialog", { name: "入力オブジェクトを選択" });
	await picker.locator("#picker-credential").selectOption({ label: credential });
	await picker.locator("#picker-bucket").selectOption(bucket);
	for (const folder of ["fixtures/", "vod-timeline/", "v1/"])
		await picker.getByRole("button", { name: folder, exact: true }).click();
	const row = picker.getByRole("row").filter({ has: page.getByText(filename, { exact: true }) });
	await row.getByRole("button", { name: "入力に使う", exact: true }).click();
	await expect(picker).toBeHidden();
	await expect(editor.getByRole("button", { name: `${filename}をタイムラインへ追加` })).toBeEnabled({ timeout: 120_000 });
}

async function trimSelected(editor, inSeconds, outSeconds) {
	const start = editor.getByRole("spinbutton", { name: "開始（秒）" });
	await start.fill(String(inSeconds));
	await start.press("Tab");
	const end = editor.getByRole("spinbutton", { name: "終了（秒）" });
	await end.fill(String(outSeconds));
	await end.press("Tab");
}

async function mediaReady(editor, duration) {
	await expect(editor.getByText("プレビュー準備完了", { exact: true })).toBeVisible({ timeout: 120_000 });
	const video = editor.getByLabel(content.video, { exact: true });
	await expect.poll(() => video.evaluate((element) => element.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
	if (duration !== undefined)
		assert.ok(Math.abs(await video.evaluate((element) => element.duration) - duration) < 0.12, "Actual MP4 duration differs from the edited sequence");
	return video;
}

async function buildSequence(page, editor) {
	await addSource(page, editor, "a.mp4");
	await editor.getByRole("button", { name: "a.mp4をタイムラインへ追加" }).click();
	await trimSelected(editor, 2, 5);
	await addSource(page, editor, "b.mp4");
	await editor.getByRole("button", { name: "b.mp4をタイムラインへ追加" }).click();
	await trimSelected(editor, 1, 4);
	await editor.getByRole("button", { name: "a.mp4をタイムラインへ追加" }).click();
	await trimSelected(editor, 4, 7);
	await mediaReady(editor, 9);
	await expect(editor.getByRole("button", { name: /^クリップ \d, / })).toHaveCount(3);
}

async function editingInteractions(page, editor) {
	const position = editor.getByRole("slider", { name: content.position, exact: true });
	const bounds = await position.boundingBox();
	assert.ok(bounds);
	await position.click({ position: { x: bounds.width / 9, y: bounds.height / 2 } });
	await editor.getByRole("button", { name: "再生位置で分割", exact: true }).click();
	await expect(editor.getByRole("button", { name: /^クリップ \d, / })).toHaveCount(4);
	await editor.getByRole("button", { name: "元に戻す", exact: true }).click();
	await expect(editor.getByRole("button", { name: /^クリップ \d, / })).toHaveCount(3);
	await editor.getByRole("button", { name: "前へ移動", exact: true }).click();
	await expect(editor.getByRole("button", { name: "クリップ 3, b.mp4", exact: true })).toBeVisible();
	await editor.getByRole("button", { name: "元に戻す", exact: true }).click();
	await editor.getByRole("button", { name: "クリップを削除", exact: true }).click();
	await expect(editor.getByRole("button", { name: /^クリップ \d, / })).toHaveCount(2);
	await editor.getByRole("button", { name: "元に戻す", exact: true }).click();
	await editor.getByRole("button", { name: "やり直す", exact: true }).click();
	await expect(editor.getByRole("button", { name: /^クリップ \d, / })).toHaveCount(2);
	await editor.getByRole("button", { name: "元に戻す", exact: true }).click();
	const third = editor.getByRole("button", { name: "クリップ 3, a.mp4", exact: true });
	await third.focus();
	await third.press("Alt+ArrowLeft");
	await expect(editor.getByRole("button", { name: "クリップ 3, b.mp4", exact: true })).toBeVisible();
	await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
	await expect(third).toBeVisible();
	await editor.getByRole("button", { name: "クリップ 1, a.mp4", exact: true }).click();
	const handle = editor.getByRole("slider", { name: "開始を調整, a.mp4, クリップ 1", exact: true });
	await handle.press("ArrowRight");
	await expect(editor.getByRole("spinbutton", { name: "開始（秒）" })).not.toHaveValue("2");
	await editor.getByRole("button", { name: "元に戻す", exact: true }).click();
	const trim = await handle.boundingBox();
	assert.ok(trim);
	await page.mouse.move(trim.x + trim.width / 2, trim.y + trim.height / 2);
	await page.mouse.down();
	await page.mouse.move(trim.x + trim.width / 2 + 20, trim.y + trim.height / 2, { steps: 5 });
	await page.mouse.up();
	await expect(editor.getByRole("spinbutton", { name: "開始（秒）" })).not.toHaveValue("2");
	await editor.getByRole("button", { name: "元に戻す", exact: true }).click();
	await expect(editor.getByRole("spinbutton", { name: "開始（秒）" })).toHaveValue("2");
	const last = editor.getByRole("button", { name: "クリップ 3, a.mp4", exact: true });
	const middle = editor.getByRole("button", { name: "クリップ 2, b.mp4", exact: true });
	const from = await last.boundingBox(), to = await middle.boundingBox();
	assert.ok(from && to);
	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(to.x + to.width * 0.3, to.y + to.height / 2, { steps: 6 });
	await page.mouse.up();
	await expect(editor.getByRole("button", { name: "クリップ 3, b.mp4", exact: true })).toBeVisible();
	await editor.getByRole("button", { name: "元に戻す", exact: true }).click();
	await editor.getByRole("combobox", { name: "タイムラインのズーム" }).selectOption("4");
	assert.ok(await editor.getByTestId("input-timeline-track").evaluate((element) => element.scrollWidth > element.parentElement.clientWidth));
	await editor.getByRole("combobox", { name: "タイムラインのズーム" }).selectOption("1");
	await mediaReady(editor, 9);
}

async function playbackInteractions(editor) {
	const video = await mediaReady(editor, 9);
	const position = editor.getByRole("slider", { name: content.position, exact: true });
	await position.press("Home");
	await editor.getByRole("button", { name: content.play, exact: true }).click();
	await expect.poll(() => video.evaluate((element) => element.currentTime), { timeout: 15_000 }).toBeGreaterThan(0.2);
	const second = editor.getByRole("button", { name: "クリップ 2, b.mp4", exact: true });
	await second.click();
	await expect.poll(() => video.evaluate((element) => element.currentTime), { timeout: 3000 }).toBeGreaterThan(3);
	assert.equal(await video.evaluate((element) => element.paused), false, "Timeline seeking stopped playback");
	await editor.getByRole("button", { name: content.play, exact: true }).click();
	await editor.getByRole("button", { name: "a.mp4をプレビュー", exact: true }).click();
	const source = await mediaReady(editor, 8);
	await editor.getByRole("button", { name: content.play, exact: true }).click();
	const seek = editor.getByRole("slider", { name: "素材の再生位置", exact: true });
	const bounds = await seek.boundingBox();
	assert.ok(bounds);
	await seek.click({ position: { x: bounds.width * 0.65, y: bounds.height / 2 } });
	await expect.poll(() => source.evaluate((element) => element.currentTime), { timeout: 3000 }).toBeGreaterThan(4.5);
	assert.equal(await source.evaluate((element) => element.paused), false, "Source seeking stopped playback");
	await editor.getByRole("button", { name: content.play, exact: true }).click();
	await editor.getByRole("button", { name: "シーケンス", exact: true }).click();
	await mediaReady(editor, 9);
}

async function screenshots(page, context, editor, output, report) {
	for (const theme of ["neon", "paper", "high-contrast"]) {
		if (theme !== "neon") {
			await context.addCookies([{ name: "bitovp-theme", value: theme, url: page.url() }]);
			await page.reload();
			await page.getByRole("button", { name: "復元", exact: true }).click();
			await expect(editor).toBeVisible();
			await mediaReady(editor, 9);
		}
		await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
		for (const width of [320, 768, 1024, 1440]) {
			await page.setViewportSize({ width, height: 1000 });
			await page.evaluate(() => document.fonts.ready);
			await editor.screenshot({ path: resolve(output, `${theme}-${width}.png`), animations: "disabled" });
			const layout = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth }));
			const editorWidth = (await editor.boundingBox())?.width;
			report.layouts.push({ theme, width, ...layout, editorWidth });
			assert.ok(layout.page <= layout.viewport + 1, `Page overflows horizontally at ${theme}/${width}`);
		}
	}
}

export async function runBrowserQa(options) {
	await mkdir(options.output, { recursive: true });
	const report = { baseURL: options.baseURL, startedAt: new Date().toISOString(), blocked: [], consoleErrors: [], httpErrors: [], requests: [], tasks: [], layouts: [], status: "RUNNING" };
	const browser = await chromium.launch({ headless: true });
	const context = await browser.newContext({ baseURL: options.baseURL, viewport: { width: 1440, height: 1000 }, locale: "ja-JP", serviceWorkers: "block" });
	const page = await context.newPage();
	await context.addCookies([{ name: "ovp-locale", value: "ja", url: options.baseURL }]);
	await context.route("**/*", async (route) => {
		const request = route.request();
		if (!requestAllowed(request.url(), request.method(), options.baseURL)) {
			report.blocked.push({ method: request.method(), pathname: new URL(request.url()).pathname });
			return route.abort();
		}
		if (request.method() === "POST") report.requests.push(JSON.parse(request.postData() ?? "null"));
		return route.continue();
	});
	page.on("pageerror", (error) => report.consoleErrors.push(error.message));
	page.on("console", (message) => { if (message.type() === "error") report.consoleErrors.push(message.text()); });
	page.on("response", async (response) => {
		const url = new URL(response.url());
		if (response.status() >= 400) {
			const entry = { path: url.pathname, status: response.status(), observedAt: Date.now(), range: response.request().headers().range ?? null };
			if ((response.headers()["content-type"] ?? "").includes("json")) entry.body = await response.json().catch(() => null);
			report.httpErrors.push(entry);
		}
		if (/^\/api\/vod\/input-previews(?:\/[0-9a-f-]{36})?$/.test(url.pathname) && response.ok()) {
			try { const value = await response.json(); if (value.task) report.tasks.push({ ...value.task, observedAt: Date.now() }); } catch { /* Empty cancellation response. */ }
		}
	});
	try {
		await page.goto("/vod/new");
		await page.getByRole("navigation", { name: "ウィザードのステップ" }).getByRole("button", { name: /^2\./ }).click();
		await page.getByRole("button", { name: "タイムラインで編集", exact: true }).click();
		const editor = page.getByRole("region", { name: content.editor, exact: true });
		console.log("QA: selecting real S3 sources and building A/B/A");
		await buildSequence(page, editor);
		console.log("QA: exercising edit, history, pointer and keyboard controls");
		await editingInteractions(page, editor);
		console.log("QA: verifying actual MP4 playback and active seeks");
		await playbackInteractions(editor);
		await writeFile(resolve(options.output, "accessibility.yaml"), await editor.ariaSnapshot());
		console.log("QA: checking draft restore, Japanese themes and responsive layouts");
		await screenshots(page, context, editor, options.output, report);
		assert.equal(report.blocked.length, 0, "The page attempted a forbidden request");
		assert.equal(report.consoleErrors.length, 0, "Browser console errors occurred");
		assert.equal(report.httpErrors.length, 0, "Unexpected HTTP failures occurred");
		report.status = "PASSED";
	} catch (error) {
		report.status = "FAILED";
		report.error = error instanceof Error ? error.message : String(error);
		await page.screenshot({ path: resolve(options.output, "failure.png"), fullPage: true }).catch(() => {});
		throw error;
	} finally {
		report.finishedAt = new Date().toISOString();
		await writeFile(resolve(options.output, "browser-receipt.json"), `${JSON.stringify(report, null, 2)}\n`);
		await context.close();
		await browser.close();
		console.log(JSON.stringify({ status: report.status, output: options.output, taskResults: report.tasks.length, screenshots: report.layouts.length, blockedRequests: report.blocked.length }));
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await runBrowserQa(parseOptions(process.argv.slice(2)));
}
