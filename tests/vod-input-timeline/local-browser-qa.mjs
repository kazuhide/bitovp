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

async function stableTimelineScale(editor, report) {
	const first = editor.getByRole("button", { name: "クリップ 1, a.mp4", exact: true });
	const second = editor.getByRole("button", { name: "クリップ 2, b.mp4", exact: true });
	const geometry = async () => {
		const a = await first.boundingBox(), b = await second.boundingBox();
		assert.ok(a && b);
		return { firstWidth: a.width, secondWidth: b.width, secondOffset: b.x - a.x };
	};
	await first.click();
	const before = await geometry();
	assert.ok(Math.abs(before.firstWidth - 120) < 1, "Default timeline must use a stable 40 pixels/second scale");
	assert.equal(await editor.getByText("タイムラインの操作", { exact: true }).count(), 0);
	const trim = async (end) => {
		const input = editor.getByRole("spinbutton", { name: "終了（秒）" });
		await input.fill(String(end));
		await input.press("Tab");
	};
	await trim(4);
	await expect.poll(async () => (await geometry()).firstWidth).toBeCloseTo(80, 0);
	const afterTrim = await geometry();
	assert.ok(Math.abs(afterTrim.secondWidth - before.secondWidth) < 1, "Trimming must not rescale another clip");
	assert.ok(Math.abs(before.secondOffset - afterTrim.secondOffset - 40) < 1, "One second of trim must visibly remove one second at the existing scale");
	await editor.getByRole("button", { name: "元に戻す", exact: true }).click();
	await expect.poll(async () => (await geometry()).firstWidth).toBeCloseTo(before.firstWidth, 0);
	await editor.getByRole("button", { name: "全体", exact: true }).click();
	const fittedViewport = await editor.getByTestId("input-timeline-track").evaluate((element) => ({ width: element.parentElement.clientWidth, scrollWidth: element.parentElement.scrollWidth }));
	assert.ok(fittedViewport.scrollWidth <= fittedViewport.width + 1, "Fit must contain both the sequence and ruler labels without a redundant scrollbar");
	const fitted = await geometry();
	await trim(4);
	await expect.poll(async () => (await geometry()).firstWidth).toBeCloseTo(fitted.firstWidth * 2 / 3, 0);
	const afterFitTrim = await geometry();
	assert.ok(Math.abs(afterFitTrim.secondWidth - fitted.secondWidth) < 1, "Explicit Fit must also keep its scale while trimming");
	await editor.getByRole("button", { name: "元に戻す", exact: true }).click();
	await editor.getByRole("combobox", { name: "タイムラインのズーム" }).selectOption("1");
	await expect.poll(async () => (await geometry()).firstWidth).toBeCloseTo(before.firstWidth, 0);
	await editor.getByRole("button", { name: "クリップ 3, a.mp4", exact: true }).click();
	await mediaReady(editor, 9);
	report.timelineScale = { before, afterTrim, fitted, fittedViewport, afterFitTrim };
}

async function rightEdgeTrim(page, editor, report) {
	await editor.getByRole("combobox", { name: "タイムラインのズーム" }).selectOption("4");
	await editor.getByRole("button", { name: "クリップ 3, a.mp4", exact: true }).click();
	const track = editor.getByTestId("input-timeline-track");
	await track.evaluate((element) => { element.parentElement.scrollLeft = element.parentElement.scrollWidth; });
	const geometry = () => track.evaluate((element) => ({ width: element.getBoundingClientRect().width, left: element.getBoundingClientRect().left, scrollLeft: element.parentElement.scrollLeft, viewport: element.parentElement.clientWidth, scrollWidth: element.parentElement.scrollWidth }));
	await expect.poll(async () => (await geometry()).scrollLeft).toBeGreaterThan(0);
	const before = await geometry();
	const handle = editor.getByRole("slider", { name: "終了を調整, a.mp4, クリップ 3", exact: true });
	const bounds = await handle.boundingBox(); assert.ok(bounds);
	const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x - 64, y);
	await expect(handle).toHaveAttribute("aria-valuenow", "6600");
	const during = await geometry();
	await page.mouse.up();
	const committedOutMs = Number(await editor.getByRole("spinbutton", { name: "終了（秒）" }).inputValue()) * 1000;
	report.rightEdgeTrim = { before, during, after: await geometry(), draggedPixels: 64, expectedOutMs: 6600, committedOutMs };
	assert.equal(committedOutMs, 6600, "Native scroll clamping must not count as extra trim on pointer release");
	assert.ok(during.width >= before.width - 1, "Shrinking gestures must retain the initial scrollable extent");
	await editor.getByRole("button", { name: "元に戻す", exact: true }).click();
	await editor.getByRole("combobox", { name: "タイムラインのズーム" }).selectOption("1");
	await editor.getByRole("button", { name: "クリップ 3, a.mp4", exact: true }).click();
	await mediaReady(editor, 9);
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


async function mediaState(video) {
 return video.evaluate(element => ({
  currentTime: element.currentTime, duration: element.duration,
  readyState: element.readyState, networkState: element.networkState,
  paused: element.paused, seeking: element.seeking,
  decodedFrames: element.getVideoPlaybackQuality().totalVideoFrames,
  buffered: Array.from({length: element.buffered.length}, (_, index) => [element.buffered.start(index), element.buffered.end(index)]),
 }));
}

async function playDecodedFrames(editor, video) {
 const before = await mediaState(video);
 await editor.getByRole("button", {name: content.play, exact: true}).click();
 await expect.poll(() => video.evaluate((element, frames) =>
  !element.paused && element.readyState >= 3 &&
  element.currentTime > 0.3 && element.getVideoPlaybackQuality().totalVideoFrames >= frames + 3,
 before.decodedFrames), {timeout: 5000}).toBe(true);
 return {before, playing: await mediaState(video)};
}

async function assertActiveSeek(video, position, fraction, expectedSeconds) {
 const bounds = await position.boundingBox(); assert.ok(bounds);
 const before = await mediaState(video);
 const started = Date.now();
 await position.click({position: {x: bounds.width * fraction, y: bounds.height / 2}});
 const requestedSeconds = Number(await position.inputValue()) / 1000;
 assert.ok(Math.abs(requestedSeconds - expectedSeconds) < 0.3, "Ruler requested the wrong target");
 await expect.poll(() => video.evaluate((element, target) =>
  Math.abs(element.currentTime - target) < 0.25 && !element.seeking && !element.paused,
 requestedSeconds), {timeout: 1000, intervals: [25, 50, 100]}).toBe(true);
 const elapsedMs = Date.now() - started;
 assert.ok(elapsedMs < 1000, "Active seek exceeded one second");
 return {requestedSeconds, elapsedMs, before, after: await mediaState(video)};
}

async function playbackInteractions(editor, report) {
 const video = await mediaReady(editor, 9);
 const position = editor.getByRole("slider", {name: content.position, exact: true});
 await position.press("Home");
 report.playback.push({mode: "sequence", ...await playDecodedFrames(editor, video)});
 const before = await mediaState(video);
 assert.ok(before.currentTime < 2, "Begin the ruler seek near the sequence start");
 report.activeSeeks.push({mode: "sequence", ...await assertActiveSeek(video, position, 7000 / 8999, 7)});
 await editor.getByRole("button", {name: content.play, exact: true}).click();
 await editor.getByRole("button", {name: "a.mp4をプレビュー", exact: true}).click();
 const source = await mediaReady(editor, 8);
 report.playback.push({mode: "source", ...await playDecodedFrames(editor, source)});
 const sourcePosition = editor.getByRole("slider", {name: "素材の再生位置", exact: true});
 report.activeSeeks.push({mode: "source", ...await assertActiveSeek(source, sourcePosition, 0.65, 5.2)});
 await editor.getByRole("button", {name: content.play, exact: true}).click();
 await editor.getByRole("button", {name: "シーケンス", exact: true}).click();
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

  // A real first play settles native controls; never hide or replace the media element for QA.
  const video = await mediaReady(editor, 9);
  await editor.getByRole("slider", {name: content.position, exact: true}).press("Home");
  const playback = await playDecodedFrames(editor, video);
  await editor.getByRole("button", {name: content.play, exact: true}).click();
  await expect.poll(() => video.evaluate(element => element.paused && !element.seeking && element.readyState >= 3), {timeout: 3000}).toBe(true);
  report.visualMedia.push({theme, ...playback, paused: await mediaState(video)});

		await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
		for (const width of [320, 768, 1024, 1440]) {
			await page.setViewportSize({ width, height: 1000 });
			await page.evaluate(async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
			await video.hover();
			await editor.screenshot({ path: resolve(output, `${theme}-${width}.png`), animations: "allow" });
			const layout = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth }));
			const editorWidth = (await editor.boundingBox())?.width;
			report.layouts.push({ theme, width, ...layout, editorWidth });
			assert.ok(layout.page <= layout.viewport + 1, `Page overflows horizontally at ${theme}/${width}`);
		}
	}
}

export async function runBrowserQa(options) {
	await mkdir(options.output, { recursive: true });
	const report = { baseURL: options.baseURL, startedAt: new Date().toISOString(), blocked: [], consoleErrors: [], httpErrors: [], requests: [], tasks: [], layouts: [], playback: [], activeSeeks: [], visualMedia: [], status: "RUNNING" };
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
		assert.equal(await page.getByText("ファイル出力", { exact: true }).count(), 0, "Input editing must not introduce a packaging selector");
		const editor = page.getByRole("region", { name: content.editor, exact: true });
		console.log("QA: selecting real S3 sources and building A/B/A");
		await buildSequence(page, editor);
		console.log("QA: checking stable default scale and explicit Fit while trimming");
		await stableTimelineScale(editor, report);
		console.log("QA: checking native scroll clamping during a rightmost out trim");
		await rightEdgeTrim(page, editor, report);
		console.log("QA: exercising edit, history, pointer and keyboard controls");
		await editingInteractions(page, editor);
		console.log("QA: verifying actual MP4 playback and active seeks");
		await playbackInteractions(editor, report);
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
