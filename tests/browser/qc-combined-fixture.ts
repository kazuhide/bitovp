import {
	type Browser,
	type BrowserContext,
	type ElementHandle,
	expect,
	type Page,
	type TestInfo,
} from "@playwright/test";
import {
	HDR_LIBVMAF_REVISION,
	HDR_VMAF_MODELS,
	HDR_VMAF_SCORING_VERSION,
	hdrMeasurementSchema,
} from "../../packages/core/src/vmaf/hdr";
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

const HDR_JOBS = [
	"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01",
	"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02",
	"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03",
] as const;
const HDR_ENCODING = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01";

/** Metadata and scores only: these are not measured HDR or display evidence. */
function syntheticHdrReports(vmaf: ReturnType<typeof syntheticReports>) {
	const source = vmaf[0];
	if (!source) throw new Error("Synthetic HDR source report missing");
	return HDR_JOBS.map((id, index) => {
		const hlg = index === 1;
		const model = HDR_VMAF_MODELS[hlg ? 2 : 0];
		const input = {
			width: 3840,
			height: 2160,
			pixelFormat: "yuv420p10le",
			bitDepth: 10,
			range: "limited",
			primaries: "bt2020",
			transfer: "smpte2084",
			matrix: "bt2020nc",
			frameRate: hlg ? "60/1" : "24/1",
			attributeSource: "STREAM_METADATA",
		};
		// Direct core-module imports also keep Playwright collection independent
		// of the app's package-level barrel and its different module loader.
		const evidence = hdrMeasurementSchema.parse({
			version: 1,
			method: "HDR_VMAF_PQ_ICTCP_16",
			scope: "HDR_BASE_LAYER",
			dolbyRpuApplied: false,
			model: model.id,
			modelSha256: model.sha256,
			libvmafRevision: HDR_LIBVMAF_REVISION,
			normalization: "ZIMG_BT2020_PQ_YUV444_16",
			comparison: "LIMITED_BT2020_PQ_ICTCP420_16_DISPLAY2160",
			reference: input,
			distorted: { ...input, transfer: hlg ? "arib-std-b67" : "smpte2084" },
			frameCount: source.results[0]?.frameCount ?? 0,
			...(hlg
				? {
						hlgReferenceDisplay: {
							peakNits: 1000,
							blackNits: 0,
							systemGamma: 1.2,
							approximateGamma: false,
						},
					}
				: {}),
		});
		return {
			...source,
			id,
			encodingName: `SYNTHETIC HDR ${hlg ? "HLG HFR" : `PQ ${index + 1}`}`,
			model: model.id,
			scoringVersion: HDR_VMAF_SCORING_VERSION,
			reference: { width: 3840, height: 2160, fps: hlg ? 60 : 24 },
			results: source.results.slice(0, 1).map((row) => ({
				...row,
				renditionRef: { ...row.renditionRef, height: 2160 },
				// No generated SDR MP4 is represented as an HDR display preview.
				preview: null,
				hdrMeasurement: evidence,
			})),
		};
	});
}

async function captureHdrUi(
	page: Page,
	info: TestInfo,
	name: string,
	width: number,
) {
	await page.evaluate(() => document.fonts.ready);
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
	expect(
		await page.evaluate(() => document.documentElement.scrollWidth),
	).toBeLessThanOrEqual(width);
	const path = info.outputPath(name);
	await page.screenshot({ path, fullPage: true });
	await info.attach(name, { path, contentType: "image/png" });
}

/** Additional assertions in mandatory case twelve, isolated from media clocks. */
export async function verifyHdrQcBrowser(
	browser: Browser,
	baseURL: string,
	storageState: Awaited<ReturnType<BrowserContext["storageState"]>>,
	info: TestInfo,
	vmaf: ReturnType<typeof syntheticReports>,
) {
	const reports = syntheticHdrReports(vmaf);
	const sdr = vmaf[0];
	if (!sdr) throw new Error("Synthetic SDR control report missing");
	const context = await browser.newContext({
		baseURL,
		storageState,
		viewport: { width: 1440, height: 1000 },
		locale: "en-US",
		serviceWorkers: "block",
	});
	const submitted: unknown[] = [];
	const unexpected: string[] = [];
	await context.route("**/*", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (url.origin !== baseURL) {
			unexpected.push("External HDR fixture request");
			return route.abort();
		}
		if (
			request.method() === "POST" &&
			url.pathname === "/api/vmaf-jobs" &&
			!url.search
		) {
			submitted.push(request.postDataJSON());
			return route.fulfill({ status: 201, json: { id: HDR_JOBS[0] } });
		}
		if (!["GET", "HEAD"].includes(request.method())) {
			unexpected.push("Unexpected HDR fixture mutation");
			return route.abort();
		}
		if (url.pathname === "/api/vmaf-jobs" && !url.search)
			return route.fulfill({ json: { items: [] } });
		if (url.pathname === "/api/vmaf-compute-profiles" && !url.search)
			return route.fulfill({
				json: {
					items: [
						{ id: "synthetic-cloud", label: "SYNTHETIC", region: "none" },
					],
				},
			});
		if (
			url.pathname === "/api/encoding-jobs" &&
			url.search === "?status=FINISHED"
		)
			return route.fulfill({
				json: { items: [{ id: HDR_ENCODING, name: "SYNTHETIC HDR input" }] },
			});
		const report = [...reports, sdr].find(
			(row) => url.pathname === `/api/vmaf-jobs/${row.id}` && !url.search,
		);
		if (report) return route.fulfill({ json: report });
		if (
			url.pathname.startsWith("/api/vmaf-jobs/") ||
			url.pathname.startsWith("/api/qc-browser-fixture/")
		) {
			unexpected.push("Unexpected HDR report or preview request");
			return route.abort();
		}
		return route.continue();
	});
	const page = await context.newPage();
	page.on("pageerror", () => unexpected.push("HDR browser page error"));
	page.on("console", (message) => {
		if (["warning", "error"].includes(message.type()))
			unexpected.push("HDR browser console issue");
	});
	info.annotations.push({
		type: "evidence-scope",
		description:
			"HDR UI uses synthetic scores/provenance and intercepted submissions; no HDR measurement, display validation or provider job",
	});
	const labels = {
		en: {
			open: "Measure an existing job…",
			options: "Measurement options",
			run: "Measure",
			cpu: "Local CPU",
			pq: "HDR VMAF · PQ / ICtCp 16-bit",
			hlg: "HLG → PQ · 1000 nits",
			scope: "HDR base layer · RPU display mapping not measured",
			mixed:
				"HDR/SDR or HLG measurement conditions differ. Scores and charts are shown separately.",
			violin: "VMAF distribution",
		},
		ja: {
			open: "既存ジョブを計測…",
			options: "計測オプション",
			run: "計測",
			cpu: "ローカルCPU",
			pq: "HDR VMAF・PQ / ICtCp 16bit",
			hlg: "HLG → PQ・1000nit",
			scope: "HDRベース映像・RPUによる表示処理は評価対象外",
			mixed:
				"HDR/SDR または HLG の測定条件が異なるため、数値とグラフを分けて表示します。",
			violin: "VMAF 分布",
		},
	};
	try {
		for (const [locale, width] of [
			["en", 1440],
			["ja", 320],
		] as const) {
			const name = labels[locale];
			await context.addCookies([
				{ name: "ovp-locale", value: locale, url: `${baseURL}/` },
			]);
			await page.setViewportSize({ width, height: 1000 });
			await page.goto("/qc");
			await page.getByRole("button", { name: name.open, exact: true }).click();
			await page.getByText(name.options, { exact: true }).click();
			const job = page.locator("#lab-measure-job");
			const model = page.locator("#lab-measure-model");
			const execution = page.locator("#lab-measure-execution");
			const source = page.locator("#lab-measure-source");
			const color = page.locator("#lab-measure-hdr-reference");
			await expect(job.locator(`option[value="${HDR_ENCODING}"]`)).toHaveCount(
				1,
			);
			await expect(model.locator('option[value^="hdr_vmaf_"]')).toHaveText(
				HDR_VMAF_MODELS.map((entry) => entry.id),
			);
			for (const hdrModel of HDR_VMAF_MODELS) {
				await model.selectOption("vmaf_v0.6.1");
				await execution.selectOption(":auto");
				await source.selectOption("OUTPUT_MP4");
				await page.locator("#lab-measure-psnr").selectOption("true");
				await job.selectOption(HDR_ENCODING);
				await model.selectOption(hdrModel.id);
				await page.locator("#lab-measure-metric").selectOption("COMBINED");
				await expect(source).toHaveValue("OUTPUT_HLS");
				await expect(source).toBeDisabled();
				await expect(execution).toHaveValue("");
				await expect(execution).toBeDisabled();
				await expect(execution.locator("option:checked")).toHaveText(name.cpu);
				await expect(color).toHaveValue("");
				await color.selectOption("P3_D65_PQ_RGB_FULL");
				await expect(page.locator("#lab-measure-psnr")).toHaveCount(0);
				await expect(page.locator("#lab-measure-method")).toHaveCount(0);
				await expect(
					page.locator('#lab-measure-metric option[value="BANDING"]'),
				).toBeDisabled();
				const before = submitted.length;
				await page.getByRole("button", { name: name.run, exact: true }).click();
				await expect.poll(() => submitted.length).toBe(before + 1);
				expect(submitted[before]).toEqual({
					encodingJobId: HDR_ENCODING,
					model: hdrModel.id,
					banding: true,
					source: "OUTPUT_HLS",
					psnr: false,
					hdrReferenceColor: "P3_D65_PQ_RGB_FULL",
					execution: { backend: "LOCAL", localMode: "CPU" },
				});
				await expect(job).toHaveValue("");
			}
			await captureHdrUi(
				page,
				info,
				`hdr-controls-${locale}-${width}.png`,
				width,
			);
			for (const report of reports.slice(0, 2)) {
				await page.goto(`/qc/${report.id}`);
				const hlg = Boolean(
					report.results[0]?.hdrMeasurement.hlgReferenceDisplay,
				);
				const summary = page.locator("summary").filter({ hasText: name.scope });
				await expect(summary).toHaveCount(1);
				await expect(summary).toContainText(hlg ? name.hlg : name.pq);
				await expect(summary).toContainText(report.model);
				await expect(summary).toContainText(name.scope);
				await expect(
					page.getByText(hlg ? name.pq : name.hlg, { exact: true }),
				).toHaveCount(0);
				const proof = summary.locator("..").locator("pre");
				await expect(proof).toBeHidden();
				await summary.click();
				await expect(proof).toBeVisible();
				expect(JSON.parse(await proof.innerText())).toEqual(
					report.results.map((row) => row.hdrMeasurement),
				);
				await captureHdrUi(
					page,
					info,
					`hdr-${hlg ? "hlg-hfr" : "pq"}-${locale}-${width}.png`,
					width,
				);
			}
			for (const comparison of [
				{ ids: [sdr.id, HDR_JOBS[0]], name: "sdr-pq", mixed: true },
				{ ids: [HDR_JOBS[0], HDR_JOBS[1]], name: "pq-hlg", mixed: true },
				{ ids: [HDR_JOBS[0], HDR_JOBS[2]], name: "pq-pq", mixed: false },
			]) {
				await page.goto(`/qc/compare?jobs=${comparison.ids.join(",")}`);
				await expect(page.getByRole("checkbox")).toHaveCount(
					comparison.name === "sdr-pq" ? sdr.results.length + 1 : 2,
				);
				const figures = page.getByRole("figure", {
					name: name.violin,
					exact: true,
				});
				await expect(figures).toHaveCount(comparison.mixed ? 2 : 1);
				for (let i = 0; i < (await figures.count()); i++)
					await expect(figures.nth(i)).toBeVisible();
				const warning = page.getByRole("alert").filter({ hasText: name.mixed });
				const groups = page.locator(
					'section[aria-labelledby^="measurement-context-"]',
				);
				await expect(groups).toHaveCount(comparison.mixed ? 2 : 0);
				if (comparison.mixed) {
					await expect(warning).toBeVisible();
					for (let i = 0; i < (await groups.count()); i++)
						await expect(
							groups
								.nth(i)
								.getByRole("figure", { name: name.violin, exact: true }),
						).toHaveCount(1);
				} else await expect(warning).toHaveCount(0);
				await captureHdrUi(
					page,
					info,
					`hdr-compare-${comparison.name}-${locale}-${width}.png`,
					width,
				);
			}
		}
		expect(submitted).toHaveLength(HDR_VMAF_MODELS.length * 2);
		expect(unexpected).toEqual([]);
	} finally {
		await context.close();
	}
}
