import {
	type BrowserContext,
	type ElementHandle,
	expect,
	type Page,
	type TestInfo,
} from "@playwright/test";
import type {
	syntheticBandingReports,
	syntheticReports,
} from "./qc-comparison-fixture";

const JOBS = [
	"55555555-5555-4555-8555-555555555501",
	"66666666-6666-4666-8666-666666666602",
] as const;
const FPS = 30;

/** Synthetic scores reuse the independent VMAF and CAMBI clocks, never map them. */
export function syntheticCombinedReports(
	vmaf: ReturnType<typeof syntheticReports>,
	banding: ReturnType<typeof syntheticBandingReports>,
) {
	return JOBS.map((id, index) => {
		const source = vmaf[index];
		const bands = banding[index];
		if (!source || !bands) throw new Error("Combined synthetic report missing");
		return {
			...source,
			id,
			encodingName: `SYNTHETIC COMBINED ${index === 0 ? "A" : "B"}`,
			banding: true,
			results: source.results.map((row, slot) => {
				const band = bands.results[slot];
				if (!band) throw new Error("Combined synthetic banding result missing");
				const resultId = slot === 0 ? "primary" : "secondary";
				return {
					...row,
					id: resultId,
					renditionRef: {
						...row.renditionRef,
						label: `SYNTHETIC COMBINED ${index === 0 ? "A" : "B"} ${resultId}`,
					},
					pooled: { ...row.pooled, banding: band.pooled.banding },
					bandingFrameCount: band.bandingFrameCount,
					bandingFrames: band.bandingFrames,
					preview: { url: `/api/qc-browser-fixture/${id}/${resultId}.mp4` },
					bandingPreview: {
						url: `/api/qc-browser-fixture/${id}/${resultId}.mp4?metric=banding`,
					},
				};
			}),
		};
	});
}

type Timing = {
	token: number;
	source: string;
	mediaTime: number;
	presentedFrames: number;
};
declare global {
	interface Window {
		qcCombinedTiming?: {
			ids: WeakMap<HTMLVideoElement, number>;
			observations: Timing[];
		};
	}
}
const states = (page: Page) =>
	page.locator("video").evaluateAll((videos) =>
		videos.map((video) => {
			if (!(video instanceof HTMLVideoElement))
				throw new Error("Expected native combined preview video");
			const token = window.qcCombinedTiming?.ids.get(video);
			const first = window.qcCombinedTiming?.observations.find(
				(item) => item.token === token,
			);
			return {
				source: video.currentSrc,
				time: video.currentTime,
				paused: video.paused,
				seeking: video.seeking,
				ready: video.readyState,
				width: video.videoWidth,
				height: video.videoHeight,
				decoded: video.getVideoPlaybackQuality().totalVideoFrames,
				first,
			};
		}),
	);

async function released(handles: ElementHandle<Node>[]) {
	for (const handle of handles) {
		expect(
			await handle.evaluate((video) => {
				if (!(video instanceof HTMLVideoElement))
					throw new Error("Expected released native video");
				return {
					connected: video.isConnected,
					paused: video.paused,
					src: video.getAttribute("src"),
				};
			}),
		).toEqual({ connected: false, paused: true, src: null });
		await handle.dispose();
	}
}

/** Appended to mandatory case twelve; synthetic responses and actual MP4 decoding. */
export async function verifyCombinedQcBrowser(
	page: Page,
	context: BrowserContext,
	info: TestInfo,
	reports: ReturnType<typeof syntheticCombinedReports>,
) {
	await context.addInitScript(() => {
		const ids = new WeakMap<HTMLVideoElement, number>();
		const observations: Timing[] = [];
		let serial = 0;
		window.qcCombinedTiming = { ids, observations };
		const track = (video: HTMLVideoElement) => {
			if (ids.has(video)) return;
			const token = ++serial;
			ids.set(video, token);
			video.requestVideoFrameCallback((_now, metadata) =>
				observations.push({
					token,
					source: video.currentSrc,
					mediaTime: metadata.mediaTime,
					presentedFrames: metadata.presentedFrames,
				}),
			);
		};
		new MutationObserver((records) => {
			for (const record of records)
				for (const node of Array.from(record.addedNodes)) {
					if (node instanceof HTMLVideoElement) track(node);
					else if (node instanceof Element)
						for (const video of Array.from(node.querySelectorAll("video")))
							track(video);
				}
		}).observe(document, { childList: true, subtree: true });
	});
	const baseURL = new URL(page.url()).origin;
	const modes = [
		{ name: "detail", path: `/qc/${JOBS[0]}`, reports: reports.slice(0, 1) },
		{
			name: "comparison",
			path: `/qc/compare?jobs=${JOBS.join(",")}`,
			reports,
		},
	];
	const labels = {
		en: {
			metric: "Quality metric",
			open: "Open comparison preview",
			close: "Close comparison preview",
			frame: "Selected frame",
			time: "Presentation time (s)",
			play: "Play both",
			pause: "Pause both",
			b: "Rendition B",
			violin: "VMAF distribution",
			banding: "Banding detection",
		},
		ja: {
			metric: "画質指標",
			open: "比較プレビューを開く",
			close: "比較プレビューを閉じる",
			frame: "選択フレーム",
			time: "再生位置（秒）",
			play: "同時再生",
			pause: "同時停止",
			b: "レンディション B",
			violin: "VMAF 分布",
			banding: "バンディング検出",
		},
	};
	for (const [locale, widths] of [
		["en", [1440]],
		["ja", [320, 768, 1024, 1440]],
	] as const) {
		const name = labels[locale];
		await context.addCookies([
			{ name: "ovp-locale", value: locale, url: `${baseURL}/` },
		]);
		for (const width of widths) {
			await page.setViewportSize({ width, height: 1000 });
			for (const mode of modes) {
				await page.goto(mode.path);
				const tabs = page.getByRole("tablist", {
					name: name.metric,
					exact: true,
				});
				await expect(tabs).toBeVisible();
				const vmaf = tabs.getByRole("tab", { name: "VMAF", exact: true });
				const cambi = tabs.getByRole("tab", { name: "CAMBI", exact: true });
				await expect(tabs.getByRole("tab")).toHaveText(["VMAF", "CAMBI"]);
				await expect(vmaf).toHaveAttribute("aria-selected", "true");
				await expect(cambi).toHaveAttribute("aria-selected", "false");
				await expect(page.getByRole("tabpanel")).toHaveCount(1);
				await expect(
					page.getByRole("tabpanel", { name: "VMAF", exact: true }),
				).toBeVisible();
				const figure = page.getByRole("figure", {
					name: name.violin,
					exact: true,
				});
				await expect(figure).toBeVisible();
				const distributions = mode.reports.flatMap((report) =>
					report.results.flatMap((row) =>
						row.distribution ? [row.distribution] : [],
					),
				);
				await expect(figure.locator("path[data-violin]")).toHaveCount(
					distributions.filter(
						(distribution) => distribution.min !== distribution.max,
					).length,
				);
				const constantLines = figure.locator('line[stroke-width="5"]');
				await expect(constantLines).toHaveCount(
					distributions.filter(
						(distribution) => distribution.min === distribution.max,
					).length,
				);
				expect(
					await constantLines.evaluateAll((lines) =>
						lines.every((line) => {
							const x1 = Number(line.getAttribute("x1"));
							const x2 = Number(line.getAttribute("x2"));
							const y1 = Number(line.getAttribute("y1"));
							const y2 = Number(line.getAttribute("y2"));
							return (
								[x1, x2, y1, y2].every(Number.isFinite) && x2 > x1 && y1 === y2
							);
						}),
					),
				).toBe(true);
				for (const path of await figure
					.locator("path[data-violin]")
					.evaluateAll((paths) => paths.map((path) => path.getAttribute("d"))))
					expect(path).not.toMatch(/NaN|Infinity/);
				await expect(page.getByRole("img", { name: /CAMBI/ })).toHaveCount(0);
				if (mode.name === "detail") {
					const summary = page
						.locator("details")
						.filter({ has: page.locator("table") });
					await expect(summary).toHaveCount(1);
					await expect(summary.locator("table")).toBeHidden();
					await summary.locator("summary").click();
					await expect(summary.locator("table")).toBeVisible();
					await summary.locator("summary").click();
					await expect(summary.locator("table")).toBeHidden();
				}
				await page
					.getByRole("button", { name: name.open, exact: true })
					.click();
				await expect(page.locator("video")).toHaveCount(2);
				await expect
					.poll(async () =>
						(await states(page)).every(
							(state) =>
								state.ready >= 2 &&
								state.decoded > 0 &&
								state.width === 160 &&
								state.height === 90,
						),
					)
					.toBe(true);
				const frame = page.getByRole("spinbutton", {
					name: name.frame,
					exact: true,
				});
				await frame.fill("30");
				await frame.press("Tab");
				await expect
					.poll(async () =>
						(await states(page)).every(
							(state) => Math.abs(state.time - 30.5 / FPS) < 0.04,
						),
					)
					.toBe(true);
				await page
					.getByRole("button", { name: name.play, exact: true })
					.click();
				await expect(
					page.getByRole("button", { name: name.pause, exact: true }),
				).toBeVisible();
				await expect
					.poll(async () => {
						const videos = await states(page);
						return (
							videos.every(
								(video) => !video.paused && video.time > 30.5 / FPS + 0.2,
							) &&
							Math.abs((videos[0]?.time ?? 0) - (videos[1]?.time ?? 0)) < 0.15
						);
					})
					.toBe(true);
				const oldVmaf = await page.locator("video").elementHandles();
				await vmaf.focus();
				await vmaf.press("ArrowRight");
				await expect(cambi).toBeFocused();
				await expect(cambi).toHaveAttribute("aria-selected", "true");
				await expect(page.getByRole("tabpanel")).toHaveCount(1);
				await expect(
					page.getByRole("tabpanel", { name: "CAMBI", exact: true }),
				).toBeVisible();
				await expect(figure).toHaveCount(0);
				await expect(page.locator("video")).toHaveCount(2);
				await released(oldVmaf);
				await expect(
					page.getByRole("spinbutton", { name: name.frame, exact: true }),
				).toHaveCount(0);
				const b = page.getByRole("combobox", { name: name.b, exact: true });
				await b.selectOption(
					mode.name === "detail" ? "secondary" : `${JOBS[1]}:secondary`,
				);
				await expect(
					page.getByRole("button", { name: name.close, exact: true }),
				).toBeVisible();
				await expect(page.locator("video")).toHaveCount(2);
				await expect
					.poll(async () =>
						(await states(page)).every(
							(state) =>
								state.ready >= 2 &&
								state.decoded > 0 &&
								state.first?.presentedFrames === 1,
						),
					)
					.toBe(true);
				const initial = await states(page);
				expect(initial.map((state) => state.first?.mediaTime)).toEqual([
					0.5, 1,
				]);
				const time = page.getByRole("spinbutton", {
					name: name.time,
					exact: true,
				});
				await expect(time).toHaveValue("0");
				expect(
					initial.every(
						(state, i) =>
							state.paused &&
							Math.abs(
								state.time - (initial[i]?.first?.mediaTime ?? Number.NaN),
							) < 0.04,
					),
				).toBe(true);
				await time.fill("1.26");
				await time.press("Tab");
				await expect
					.poll(async () =>
						(await states(page)).every(
							(state, i) =>
								!state.seeking &&
								Math.abs(
									state.time -
										(initial[i]?.first?.mediaTime ?? Number.NaN) -
										1.26,
								) < 0.04,
						),
					)
					.toBe(true);
				const captions = page
					.getByRole("region", { name: name.open, exact: true })
					.locator("figcaption");
				await expect(captions).toHaveCount(2);
				await expect(captions.nth(0)).toContainText("CAMBI 23.0");
				await expect(captions.nth(1)).toContainText("CAMBI 11.0");
				await expect(
					page
						.getByRole("combobox", { name: name.b, exact: true })
						.locator("option"),
				).toHaveCount(mode.name === "detail" ? 3 : 5);
				const cards = page.getByRole("region", {
					name: new RegExp(`^${name.banding} —`),
				});
				await expect(cards).toHaveCount(mode.name === "detail" ? 2 : 4);
				const geometry = await cards.evaluateAll((elements) =>
					elements.map((element) => {
						const rect = element.getBoundingClientRect();
						return {
							x: rect.x,
							y: rect.y,
							right: rect.right,
							bottom: rect.bottom,
						};
					}),
				);
				const first = geometry[0],
					second = geometry[1];
				expect(first).toBeDefined();
				expect(second).toBeDefined();
				if (!first || !second)
					throw new Error("Combined CAMBI card geometry missing");
				if (width >= 1280) {
					expect(Math.abs(first.y - second.y)).toBeLessThan(2);
					expect(first.right).toBeLessThanOrEqual(second.x);
				} else expect(second.y).toBeGreaterThanOrEqual(first.bottom);
				await page.evaluate(() => document.fonts.ready);
				expect(
					await page.evaluate(() => document.documentElement.scrollWidth),
				).toBeLessThanOrEqual(width);
				if (width === 320 || width === 1440)
					await page.screenshot({
						path: info.outputPath(
							`combined-${mode.name}-${locale}-${width}.png`,
						),
						fullPage: true,
					});
				const oldCambi = await page.locator("video").elementHandles();
				await time.fill("2.85");
				const timeElement = await time.elementHandle(),
					vmafElement = await vmaf.elementHandle();
				expect(timeElement).not.toBeNull();
				expect(vmafElement).not.toBeNull();
				const pending = await page.evaluate(
					({ input, tab }) => {
						if (
							!(input instanceof HTMLInputElement) ||
							!(tab instanceof HTMLElement)
						)
							throw new Error("Combined tab transition controls missing");
						input.blur();
						const seeking = Array.from(document.querySelectorAll("video")).some(
							(video) => video.seeking,
						);
						tab.click();
						return seeking;
					},
					{ input: timeElement, tab: vmafElement },
				);
				expect(pending).toBe(true);
				await timeElement?.dispose();
				await vmafElement?.dispose();
				await expect(vmaf).toHaveAttribute("aria-selected", "true");
				await expect(page.locator("video")).toHaveCount(2);
				await released(oldCambi);
				await expect(
					page.getByRole("button", { name: name.close, exact: true }),
				).toBeVisible();
				await expect(page.locator("video")).toHaveCount(2);
				await expect(frame).toHaveValue("0");
				await expect
					.poll(async () =>
						(await states(page)).every(
							(state) =>
								state.ready >= 2 && Math.abs(state.time - 0.5 / FPS) < 0.04,
						),
					)
					.toBe(true);
				const closing = await page.locator("video").elementHandles();
				await page
					.getByRole("button", { name: name.close, exact: true })
					.click();
				await expect(page.locator("video")).toHaveCount(0);
				await released(closing);
				await vmaf.focus();
				await vmaf.press("End");
				await expect(cambi).toBeFocused();
				await expect(cambi).toHaveAttribute("aria-selected", "true");
				await expect(page.locator("video")).toHaveCount(0);
				await expect(
					page.getByRole("button", { name: name.open, exact: true }),
				).toBeVisible();
				await cambi.press("Home");
				await expect(vmaf).toBeFocused();
				await expect(vmaf).toHaveAttribute("aria-selected", "true");
				await vmaf.press("ArrowLeft");
				await expect(cambi).toBeFocused();
				await expect(cambi).toHaveAttribute("aria-selected", "true");
				await cambi.press("ArrowLeft");
				await expect(vmaf).toBeFocused();
				await expect(vmaf).toHaveAttribute("aria-selected", "true");
				await expect(figure).toBeVisible();
			}
		}
	}
}
