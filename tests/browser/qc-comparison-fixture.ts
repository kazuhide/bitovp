import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
	type Browser,
	type BrowserContext,
	expect,
	type Locator,
	type Page,
	type TestInfo,
} from "@playwright/test";

const JOBS = [
	"11111111-1111-4111-8111-111111111101",
	"22222222-2222-4222-8222-222222222202",
] as const;
const FPS = 30;
const FRAME_COUNT = 90;
const BANDING_JOBS = [
	"77777777-7777-4777-8777-777777777701",
	"88888888-8888-4888-8888-888888888802",
] as const;
const EXTRA_BANDING_JOBS = [
	"99999999-9999-4999-8999-999999999901",
	"99999999-9999-4999-8999-999999999902",
	"99999999-9999-4999-8999-999999999903",
	"99999999-9999-4999-8999-999999999904",
	"99999999-9999-4999-8999-999999999905",
] as const;
const MEDIA_SHA256 =
	"8f6d6e262b56e40348b9a5ea6f9266bacdb95ed97fe2b5212422921d24dda13e";
const CAMBI_MEDIA = [
	{
		file: "qc-comparison-origin-0.5.mp4",
		sha256: "8950501ccf16de44afe92373523c1d5bc246eee18f5e770e374d13b465345ce5",
		origin: 0.5,
	},
	{
		file: "qc-comparison-origin-1.mp4",
		sha256: "8400c570d35ca03e5da64ebbf410386bf4bec1846000231dcff35f202f309eea",
		origin: 1,
	},
] as const;

/** These scores exercise the UI; they are not VMAF measurement evidence. */
function result(
	jobId: string,
	id: string,
	label: string,
	bitrate: number,
	scores: number[],
	measurementStride = 1,
	missingDistribution = false,
) {
	const min = Math.min(...scores);
	const max = Math.max(...scores);
	const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
	const bins = Array.from({ length: min === max ? 1 : 64 }, (_, index) => ({
		score: min === max ? min : min + ((index + 0.5) * (max - min)) / 64,
		count: 0,
	}));
	for (const score of scores) {
		const bin =
			min === max
				? 0
				: Math.min(63, Math.floor(((score - min) / (max - min)) * 64));
		const entry = bins[bin];
		if (!entry) throw new Error("Synthetic distribution bin is missing");
		entry.count++;
	}
	const measured = scores.map((vmaf, index) => ({
		frameNum: index * measurementStride,
		vmaf,
	}));
	const sorted = [...scores].sort((a, b) => a - b);
	const percentile = (fraction: number) =>
		sorted[Math.floor((sorted.length - 1) * fraction)];
	return {
		id,
		renditionRef: { label, height: 90, bitrate },
		frameCount: scores.length,
		// The full report has 90 measured scores but only 18 chart points.
		frames: measured.filter(
			(_, index) => measurementStride > 1 || index % 5 === 0,
		),
		pooled: {
			mean,
			min,
			max,
			harmonicMean: mean,
			worstFrame: measured.find((frame) => frame.vmaf === min),
			percentiles: {
				p1: percentile(0.01),
				p5: percentile(0.05),
				p10: percentile(0.1),
				p25: percentile(0.25),
				p50: percentile(0.5),
			},
			low1Percent: percentile(0.01),
		},
		distribution: missingDistribution
			? null
			: {
					frameCount: scores.length,
					min,
					max,
					mean,
					binWidth: (max - min) / bins.length,
					bins,
				},
		preview: { url: `/api/qc-browser-fixture/${jobId}/${id}.mp4` },
	};
}

function syntheticReports() {
	const scores = Array.from({ length: FRAME_COUNT }, (_, index) =>
		index === 45 ? -5 : index < 30 ? 92 : index < 60 ? 98 : 108,
	);
	const sparse = Array.from(
		{ length: FRAME_COUNT / 5 },
		(_, index) => 75 + index,
	);
	return JOBS.map((id, index) => ({
		id,
		encodingJobId: null,
		encodingName: index
			? "SYNTHETIC HEVC UI fixture"
			: "SYNTHETIC H264 UI fixture",
		execution: { backend: "LOCAL" },
		computeTasks: [],
		mode: "VOD",
		model: "vmaf_v1.0.16_3d0h",
		scoringVersion: 3,
		subsample: index ? 5 : null,
		status: "FINISHED",
		error: null,
		totalUnits: 2,
		doneUnits: 2,
		cores: 4,
		threads: 2,
		concurrency: 1,
		createdAt: "2026-11-13T00:00:00Z",
		updatedAt: "2026-11-13T00:00:00Z",
		reference: { width: 160, height: 90, fps: FPS },
		results: index
			? [
					result(id, "sparse", "90p main", 60_000, sparse, 5),
					result(
						id,
						"unknown",
						"90p unavailable distribution",
						30_000,
						sparse,
						5,
						true,
					),
				]
			: [
					result(id, "main", "90p main", 65_000, scores),
					result(
						id,
						"flat",
						"90p constant 110",
						40_000,
						Array(FRAME_COUNT).fill(110),
					),
				],
	}));
}

/** Deliberately model-free and variable-rate: CAMBI follows measured seconds. */
export function syntheticBandingReports() {
	const timestamps = [0, 0.125, 0.5, 1.125, 1.8];
	const durations = [0.125, 0.375, 0.625, 0.675, 0.2];
	return [...BANDING_JOBS, ...EXTRA_BANDING_JOBS].map((id, index) => ({
		id,
		kind: "BANDING",
		detector: "CAMBI",
		encodingJobId: null,
		encodingName: `SYNTHETIC CAMBI ${String.fromCharCode(65 + index)}`,
		execution: { backend: "LOCAL" },
		computeTasks: [],
		mode: "VOD",
		model: null,
		reference: null,
		subsample: null,
		scoringVersion: 3,
		status: "FINISHED",
		error: null,
		totalUnits: 3,
		doneUnits: 3,
		cores: 1,
		threads: 1,
		concurrency: 1,
		createdAt: "2026-11-14T00:00:00Z",
		updatedAt: "2026-11-14T00:00:00Z",
		results: ["primary", "secondary", "alternate"].map((name, slot) => {
			const scores = slot === 1 ? [2, 5, 8, 11, 6, 1] : [1, 4, 12, 23, 7, 3];
			return {
				id: name,
				renditionRef: {
					label: `CAMBI ${String.fromCharCode(65 + index)} ${name}`,
					height: 90,
					bitrate: 60_000 + slot * 10_000,
				},
				pooled: {
					banding: {
						mean: scores.reduce((sum, score) => sum + score, 0) / scores.length,
						min: Math.min(...scores),
						max: Math.max(...scores),
						frameCount: scores.length,
						durationSeconds: 3,
					},
				},
				bandingExecution: {
					version: 1,
					metric: "CAMBI_NR",
					backend: "cpu",
					implementation: "libvmaf",
					decisionSource: "CPU_REFERENCE",
					coverage: {
						complete: true,
						frameCount: scores.length,
						durationSeconds: 3,
						startTimeSeconds: 0,
						endTimeSeconds: 3,
						timingSource: "PRESENTATION_TIMESTAMPS_AND_FRAME_DURATION",
					},
				},
				bandingFrameCount: scores.length,
				// The retained full coverage extends beyond the last chart sample.
				bandingFrames: scores.slice(0, -1).map((cambi, point) => ({
					frameNum: point,
					timestampSeconds: timestamps[point],
					durationSeconds: durations[point],
					cambi,
				})),
				bandingPreview: {
					url: `/api/qc-browser-fixture/${id}/${name}.mp4?metric=banding`,
				},
			};
		}),
	}));
}

function syntheticQcIndex() {
	return [...syntheticReports(), ...syntheticBandingReports()].map(
		(report) => ({
			id: report.id,
			encodingJobId: null,
			encodingName: report.encodingName,
			mode: report.mode,
			model: report.model,
			scoringVersion: report.scoringVersion,
			status: report.status,
			error: report.error,
			createdAt: report.createdAt,
			...("detector" in report
				? {
						kind: report.kind,
						detector: report.detector,
						renditionMeans: [],
						renditionBanding: report.results.map((row) => ({
							label: row.renditionRef.label,
							mean: row.pooled.banding.mean,
							max: row.pooled.banding.max,
						})),
					}
				: {
						renditionMeans: report.results.map((row) => ({
							label: row.renditionRef.label,
							mean: row.pooled.mean,
						})),
					}),
		}),
	);
}

const videoState = (page: Page) =>
	page.locator("video").evaluateAll((videos) =>
		videos.map((video) => {
			if (!(video instanceof HTMLVideoElement))
				throw new Error("Expected a video element");
			return {
				source: video.currentSrc,
				time: video.currentTime,
				paused: video.paused,
				seeking: video.seeking,
				ready: video.readyState,
				width: video.videoWidth,
				height: video.videoHeight,
				duration: video.duration,
				decoded: video.getVideoPlaybackQuality().totalVideoFrames,
			};
		}),
	);

async function selectRendition(selector: Locator, label: string) {
	const options = await selector.locator("option").evaluateAll((options) =>
		options.map((option) => ({
			value: option.getAttribute("value"),
			label: option.textContent ?? "",
		})),
	);
	const selected = options.filter((option) => option.label.includes(label));
	expect(selected).toHaveLength(1);
	const value = selected[0]?.value;
	if (!value) throw new Error("Expected one CAMBI preview rendition");
	await selector.selectOption(value);
}

type NativeTimingObservation = {
	kind: string;
	source: string;
	time: number;
	duration: number;
	mediaTime?: number;
	presentedFrames?: number;
};

const nativeTimings = (page: Page) =>
	page.evaluate(
		() =>
			(
				window as Window & {
					qcCambiNativeTiming?: NativeTimingObservation[];
				}
			).qcCambiNativeTiming ?? [],
	);

/** Shared with focused runtime QA; all report/media responses remain synthetic. */
export async function verifyCambiComparisonBrowser(
	page: Page,
	context: BrowserContext,
	info: TestInfo,
) {
	// Observe real native events without replacing the decoder, clocks or callbacks.
	await context.addInitScript(() => {
		const observations: NativeTimingObservation[] = [];
		Object.assign(window, { qcCambiNativeTiming: observations });
		const seen = new WeakSet<HTMLVideoElement>();
		const track = (video: HTMLVideoElement) => {
			if (seen.has(video)) return;
			seen.add(video);
			const record = (
				kind: string,
				extra: Partial<NativeTimingObservation> = {},
			) =>
				observations.push({
					kind,
					source: video.currentSrc || video.src,
					time: video.currentTime,
					duration: video.duration,
					...extra,
				});
			for (const kind of ["loadedmetadata", "durationchange", "seeked"])
				video.addEventListener(kind, () => record(kind));
			video.requestVideoFrameCallback((_now, metadata) =>
				record("first-presented", {
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
	await context.addCookies([
		{ name: "ovp-locale", value: "en", url: page.url() },
	]);
	await page.setViewportSize({ width: 1440, height: 1000 });
	for (const mode of ["detail", "comparison"] as const) {
		await page.goto(
			mode === "detail"
				? `/qc/${BANDING_JOBS[0]}`
				: `/qc/compare?jobs=${BANDING_JOBS.join(",")}`,
		);
		await page
			.getByRole("button", { name: "Open comparison preview", exact: true })
			.click();
		const preview = page.getByRole("region", {
			name: "Open comparison preview",
			exact: true,
		});
		await selectRendition(
			page.getByRole("combobox", { name: "Rendition A", exact: true }),
			"CAMBI A primary",
		);
		await selectRendition(
			page.getByRole("combobox", { name: "Rendition B", exact: true }),
			`CAMBI ${mode === "detail" ? "A" : "B"} secondary`,
		);
		await expect(page.locator("video")).toHaveCount(2);
		await expect
			.poll(async () =>
				(await videoState(page)).every(
					(video) =>
						video.ready >= 2 &&
						video.width === 160 &&
						video.height === 90 &&
						video.decoded > 0 &&
						new URL(video.source).searchParams.get("metric") === "banding",
				),
			)
			.toBe(true);
		await expect(preview).toContainText("CAMBI");
		await expect(preview).not.toContainText(/VMAF|\bfps\b/);
		await expect(
			page.getByRole("spinbutton", { name: "Selected frame", exact: true }),
		).toHaveCount(0);
		const time = page.getByRole("spinbutton", {
			name: "Presentation time (s)",
			exact: true,
		});
		const captions = preview.locator("figcaption");
		await expect(captions).toHaveCount(2);
		const origins = CAMBI_MEDIA.map((media) => media.origin);
		const initial = await videoState(page);
		await expect
			.poll(async () => {
				const observations = await nativeTimings(page);
				return initial.every((video, index) =>
					observations.some(
						(observation) =>
							observation.source === video.source &&
							observation.kind === "first-presented" &&
							observation.presentedFrames === 1 &&
							observation.mediaTime === origins[index],
					),
				);
			})
			.toBe(true);
		const seek = async (seconds: number) => {
			await time.fill(String(seconds));
			await time.press("Tab");
			await expect
				.poll(async () => Number(await time.inputValue()))
				.toBeCloseTo(seconds, 3);
			await expect
				.poll(async () =>
					(await videoState(page)).every(
						(video, index) =>
							video.ready >= 2 &&
							!video.seeking &&
							Math.abs(video.time - (origins[index] ?? 0) - seconds) < 0.04,
					),
				)
				.toBe(true);
		};
		// Neither the last displayed sample (2s) nor the MP4's initially advertised
		// duration may truncate the complete 3s presentation-time coverage.
		expect(Number(await time.getAttribute("max"))).toBeGreaterThanOrEqual(3);
		await seek(2.85);
		for (let index = 0; index < initial.length; index++) {
			const video = initial[index];
			const target = (origins[index] ?? 0) + 2.85;
			if (video && video.duration < target - 0.04)
				await expect
					.poll(async () =>
						(await nativeTimings(page)).some(
							(observation) =>
								observation.source === video.source &&
								observation.kind === "durationchange" &&
								observation.duration >= target,
						),
					)
					.toBe(true);
		}
		for (const caption of await captions.all())
			await expect(caption).toContainText("Not in the displayed score sample");
		await expect(
			page.getByRole("button", { name: "Next measured point", exact: true }),
		).toBeDisabled();
		await seek(1.26);
		await expect(captions.nth(0)).toContainText("CAMBI 23.0");
		await expect(captions.nth(1)).toContainText("CAMBI 11.0");
		await page
			.getByRole("button", { name: "Next measured point", exact: true })
			.click();
		await expect
			.poll(async () => Number(await time.inputValue()))
			.toBeCloseTo(1.8, 3);
		await expect(captions.nth(0)).toContainText("CAMBI 7.0");
		await expect(captions.nth(1)).toContainText("CAMBI 6.0");
		await page
			.getByRole("button", { name: "Previous measured point", exact: true })
			.click();
		await expect
			.poll(async () => Number(await time.inputValue()))
			.toBeCloseTo(1.125, 3);
		await seek(1.26);
		await page.getByRole("button", { name: "Play both", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "Pause both", exact: true }),
		).toBeVisible();
		await expect
			.poll(async () => {
				const videos = await videoState(page);
				const relative = videos.map(
					(video, index) => video.time - (origins[index] ?? 0),
				);
				return (
					videos.every(
						(video, index) => !video.paused && (relative[index] ?? 0) > 1.46,
					) && Math.abs((relative[0] ?? 0) - (relative[1] ?? 0)) < 0.15
				);
			})
			.toBe(true);
		await page.getByRole("button", { name: "Pause both", exact: true }).click();
		await expect
			.poll(async () => (await videoState(page)).every((video) => video.paused))
			.toBe(true);
		const playbackPosition = Number(await time.inputValue());
		const afterPlay = await videoState(page);
		expect(
			Math.abs(
				playbackPosition - ((afterPlay[0]?.time ?? 0) - (origins[0] ?? 0)),
			),
		).toBeLessThan(0.15);
		const expectedResults = syntheticBandingReports()[0]?.results.slice(0, 2);
		expect(expectedResults).toHaveLength(2);
		for (const [index, result] of (expectedResults ?? []).entries()) {
			const score = result.bandingFrames.find(
				(frame) =>
					playbackPosition >= (frame.timestampSeconds ?? Number.NaN) &&
					playbackPosition <
						(frame.timestampSeconds ?? Number.NaN) +
							(frame.durationSeconds ?? Number.NaN),
			)?.cambi;
			await expect(captions.nth(index)).toContainText(
				score === undefined
					? "Not in the displayed score sample"
					: `CAMBI ${score.toFixed(1)}`,
			);
		}
		const chart = page
			.getByRole("img", { name: /CAMBI by presentation time/ })
			.first();
		await chart.locator(".recharts-scatter-symbol").nth(3).click();
		await expect
			.poll(async () => Number(await time.inputValue()))
			.toBeCloseTo(1.125, 3);
		await expect
			.poll(async () =>
				(await videoState(page)).every(
					(video, index) =>
						Math.abs(video.time - (origins[index] ?? 0) - 1.125) < 0.04,
				),
			)
			.toBe(true);
		const oldVideo = await page.locator("video").first().elementHandle();
		expect(oldVideo).not.toBeNull();
		await selectRendition(
			page.getByRole("combobox", { name: "Rendition A", exact: true }),
			"CAMBI A alternate",
		);
		await expect
			.poll(async () =>
				(await videoState(page)).every(
					(video) => video.ready >= 2 && video.decoded > 0,
				),
			)
			.toBe(true);
		expect(
			await oldVideo?.evaluate((video) => {
				if (!(video instanceof HTMLVideoElement))
					throw new Error("Expected a video element");
				return {
					connected: video.isConnected,
					paused: video.paused,
					src: video.getAttribute("src"),
				};
			}),
		).toEqual({ connected: false, paused: true, src: null });
		await oldVideo?.dispose();
		await page.screenshot({
			path: info.outputPath(`cambi-${mode}-1440.png`),
			fullPage: true,
		});
		writeFileSync(
			info.outputPath(`cambi-${mode}-native-timing.json`),
			JSON.stringify(
				{
					evidenceScope: "Generated MP4 bytes and synthetic CAMBI scores",
					origins,
					initial,
					observations: await nativeTimings(page),
				},
				null,
				2,
			),
		);
		const closing = await page.locator("video").elementHandles();
		await page
			.getByRole("button", { name: "Close comparison preview", exact: true })
			.click();
		await expect(page.locator("video")).toHaveCount(0);
		for (const video of closing) {
			expect(
				await video.evaluate((element) => {
					if (!(element instanceof HTMLVideoElement))
						throw new Error("Expected a video element");
					return {
						connected: element.isConnected,
						paused: element.paused,
						src: element.getAttribute("src"),
					};
				}),
			).toEqual({ connected: false, paused: true, src: null });
			await video.dispose();
		}
	}
	await page.goto("/qc");
	await page
		.getByRole("checkbox", {
			name: "Select report SYNTHETIC CAMBI A",
			exact: true,
		})
		.check();
	await page
		.getByRole("checkbox", {
			name: "Select report SYNTHETIC CAMBI B",
			exact: true,
		})
		.check();
	const compare = page.getByRole("button", {
		name: "Compare selected",
		exact: true,
	});
	await expect(compare).toBeEnabled();
	for (const letter of ["C", "D", "E", "F"]) {
		await page
			.getByRole("checkbox", {
				name: `Select report SYNTHETIC CAMBI ${letter}`,
				exact: true,
			})
			.check();
	}
	await expect(compare).toBeEnabled();
	await page
		.getByRole("checkbox", {
			name: "Select report SYNTHETIC CAMBI G",
			exact: true,
		})
		.check();
	await expect(compare).toBeDisabled();
	for (const letter of ["C", "D", "E", "F", "G"]) {
		await page
			.getByRole("checkbox", {
				name: `Select report SYNTHETIC CAMBI ${letter}`,
				exact: true,
			})
			.uncheck();
	}
	await expect(compare).toBeEnabled();
	const vmaf = page.getByRole("checkbox", {
		name: "Select report SYNTHETIC H264 UI fixture",
		exact: true,
	});
	await vmaf.check();
	await expect(compare).toBeDisabled();
	await vmaf.uncheck();
	await expect(compare).toBeEnabled();
	await compare.click();
	await expect(page).toHaveURL(
		new RegExp(`/qc/compare\\?jobs=${BANDING_JOBS.join(",")}$`),
	);
	await page.goto(`/qc/compare?jobs=${JOBS[0]},${BANDING_JOBS[0]}`);
	await expect(page.getByRole("alert")).toContainText(
		"Compare VMAF reports together, or CAMBI-only reports together.",
	);
	await expect(
		page.getByRole("button", { name: "Open comparison preview", exact: true }),
	).toHaveCount(0);
	await expect(page.locator(".recharts-wrapper")).toHaveCount(0);
	await context.addCookies([
		{ name: "ovp-locale", value: "ja", url: page.url() },
	]);
	await page.setViewportSize({ width: 320, height: 1000 });
	for (const mode of ["detail", "comparison"] as const) {
		await page.goto(
			mode === "detail"
				? `/qc/${BANDING_JOBS[0]}`
				: `/qc/compare?jobs=${BANDING_JOBS.join(",")}`,
		);
		await page
			.getByRole("button", { name: "比較プレビューを開く", exact: true })
			.click();
		await expect(
			page.getByRole("spinbutton", { name: "再生位置（秒）", exact: true }),
		).toBeVisible();
		await expect(page.locator("video")).toHaveCount(2);
		await expect
			.poll(async () =>
				(await videoState(page)).every(
					(video) => video.ready >= 2 && video.decoded > 0,
				),
			)
			.toBe(true);
		await page.evaluate(() => document.fonts.ready);
		await expect
			.poll(() =>
				page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
			)
			.toBe(true);
		await page.screenshot({
			path: info.outputPath(`cambi-${mode}-ja-320.png`),
			fullPage: true,
		});
	}
}

/** Measure rendered plots, rather than accepting layout class names as proof. */
export async function verifyQcChartLayout(
	page: Page,
	viewportWidth: number,
	locale: "en" | "ja",
) {
	await expect(page.locator(".recharts-wrapper")).toHaveCount(2);
	await page.evaluate(() => document.fonts.ready);
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
	const figure = page.getByRole("figure", {
		name: locale === "ja" ? "VMAF 分布" : "VMAF distribution",
		exact: true,
	});
	const geometry = await figure.evaluate((figure) => {
		const rect = (element: Element) => {
			const { x, y, width, height, right, bottom } =
				element.getBoundingClientRect();
			return { x, y, width, height, right, bottom };
		};
		const charts = document.querySelectorAll(".recharts-wrapper");
		const frame = charts[0],
			ladder = charts[1];
		const svg = figure.querySelector('svg[role="img"]');
		const panel = Array.from(figure.children).find(
			(child) => child instanceof HTMLElement && child.contains(svg),
		);
		const axis = svg?.querySelector("text");
		const preview = Array.from(
			document.querySelectorAll("section[aria-label]"),
		).find((section) => section.querySelector("video"));
		if (
			!frame ||
			!ladder ||
			!svg ||
			!axis ||
			!preview ||
			!(panel instanceof HTMLElement)
		)
			throw new Error("QC chart geometry is unavailable");
		const padding = getComputedStyle(panel);
		return {
			frame: rect(frame),
			violin: rect(figure),
			ladder: rect(ladder),
			preview: rect(preview),
			svg: rect(svg),
			axisTextHeight: rect(axis).height,
			plotWidth:
				panel.clientWidth -
				parseFloat(padding.paddingLeft) -
				parseFloat(padding.paddingRight),
			documentWidth: document.documentElement.scrollWidth,
			frameBeforeViolin: Boolean(
				frame.compareDocumentPosition(figure) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			),
			violinBeforeLadder: Boolean(
				figure.compareDocumentPosition(ladder) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			),
		};
	});
	const controls = await page
		.getByRole("button", {
			name:
				locale === "ja" ? "比較プレビューを閉じる" : "Close comparison preview",
			exact: true,
		})
		.evaluate((button) => {
			if (!button.parentElement)
				throw new Error("QC preview controls are unavailable");
			const { x, right, bottom } = button.parentElement.getBoundingClientRect();
			return { x, right, bottom };
		});
	expect(geometry.documentWidth).toBeLessThanOrEqual(viewportWidth);
	// A min-width plot may scroll inside its viewport; it must never leave unused
	// visible width, as the previous fixed568px/312px centred SVGs did.
	expect(geometry.plotWidth - geometry.svg.width).toBeLessThanOrEqual(2);
	expect(geometry.axisTextHeight).toBeGreaterThan(8);
	expect(geometry.axisTextHeight).toBeLessThan(20);
	expect(geometry.frameBeforeViolin).toBe(true);
	expect(geometry.violinBeforeLadder).toBe(true);
	const left = Math.min(geometry.frame.x, geometry.violin.x);
	const right = Math.max(geometry.frame.right, geometry.violin.right);
	expect(geometry.preview.x).toBeLessThanOrEqual(left);
	expect(geometry.preview.right).toBeGreaterThanOrEqual(right);
	expect(controls.x).toBeLessThanOrEqual(left);
	expect(controls.right).toBeGreaterThanOrEqual(right);
	expect(geometry.preview.bottom).toBeLessThanOrEqual(
		Math.min(geometry.frame.y, geometry.violin.y),
	);
	expect(controls.bottom).toBeLessThanOrEqual(geometry.preview.y);
	if (viewportWidth >= 1280) {
		expect(geometry.frame.right).toBeLessThanOrEqual(geometry.violin.x);
		expect(geometry.ladder.right).toBeLessThanOrEqual(geometry.violin.x);
		expect(geometry.ladder.y).toBeGreaterThanOrEqual(geometry.frame.bottom);
		const overlap =
			Math.min(geometry.frame.bottom, geometry.violin.bottom) -
			Math.max(geometry.frame.y, geometry.violin.y);
		expect(overlap).toBeGreaterThan(
			Math.min(geometry.frame.height, geometry.violin.height) / 2,
		);
	} else {
		expect(geometry.violin.y).toBeGreaterThanOrEqual(geometry.frame.bottom);
		expect(geometry.ladder.y).toBeGreaterThanOrEqual(geometry.violin.bottom);
	}
	return geometry;
}

export async function verifyQcComparisonBrowser(
	browser: Browser,
	baseURL: string,
	storageState: Awaited<ReturnType<BrowserContext["storageState"]>>,
	info: TestInfo,
) {
	const bytes = readFileSync(
		new URL("./fixtures/qc-comparison-synthetic.mp4", import.meta.url),
	);
	expect(bytes.length).toBeLessThanOrEqual(50_000);
	expect(createHash("sha256").update(bytes).digest("hex")).toBe(MEDIA_SHA256);
	const cambiBytes = CAMBI_MEDIA.map((media) => {
		const bytes = readFileSync(
			new URL(`./fixtures/${media.file}`, import.meta.url),
		);
		expect(bytes.length).toBeLessThanOrEqual(50_000);
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(media.sha256);
		return bytes;
	});
	const reports = [...syntheticReports(), ...syntheticBandingReports()];
	const mediaPaths = new Map(
		reports.flatMap((report) =>
			report.results.map((row) => {
				const data =
					"preview" in row ? bytes : cambiBytes[row.id === "secondary" ? 1 : 0];
				if (!data) throw new Error("Synthetic CAMBI media is missing");
				return [
					"preview" in row ? row.preview.url : row.bandingPreview.url,
					data,
				] as const;
			}),
		),
	);
	const context = await browser.newContext({
		baseURL,
		storageState,
		viewport: { width: 1440, height: 1000 },
		locale: "en-US",
		serviceWorkers: "block",
	});
	const unexpected: string[] = [];
	const receivedMedia = new Set<string>();
	await context.addCookies([{ name: "ovp-locale", value: "en", url: baseURL }]);
	await context.route("**/*", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (url.origin !== baseURL || !["GET", "HEAD"].includes(request.method())) {
			unexpected.push("Unexpected browser mutation or external request");
			return route.abort();
		}
		const report = reports.find(
			(row) => url.pathname === `/api/vmaf-jobs/${row.id}`,
		);
		if (report && !url.search) return route.fulfill({ json: report });
		if (url.pathname === "/api/vmaf-jobs" && !url.search)
			return route.fulfill({ json: { items: syntheticQcIndex() } });
		const bytes = mediaPaths.get(`${url.pathname}${url.search}`);
		if (bytes) {
			const range = request.headers().range;
			const match =
				range === undefined ? null : /^bytes=(\d+)-(\d*)$/.exec(range);
			const start = match ? Number(match[1]) : 0;
			const end = match?.[2]
				? Math.min(Number(match[2]), bytes.length - 1)
				: bytes.length - 1;
			if (
				(range !== undefined && !match) ||
				start > end ||
				start >= bytes.length
			) {
				unexpected.push("Unexpected synthetic media Range request");
				return route.fulfill({
					status: 416,
					headers: { "content-range": `bytes */${bytes.length}` },
				});
			}
			receivedMedia.add(url.pathname);
			return route.fulfill({
				status: range === undefined ? 200 : 206,
				contentType: "video/mp4",
				headers: {
					"accept-ranges": "bytes",
					"content-length": String(end - start + 1),
					"cache-control": "no-store",
					...(range === undefined
						? {}
						: { "content-range": `bytes ${start}-${end}/${bytes.length}` }),
				},
				body: bytes.subarray(start, end + 1),
			});
		}
		if (
			url.pathname.startsWith("/api/vmaf-jobs/") ||
			url.pathname.startsWith("/api/qc-browser-fixture/")
		) {
			unexpected.push("Unexpected QC fixture request");
			return route.abort();
		}
		return route.continue();
	});
	const page = await context.newPage();
	page.on("pageerror", () => unexpected.push("Browser page error"));
	page.on("console", (message) => {
		if (["warning", "error"].includes(message.type()))
			unexpected.push("Browser console issue");
	});
	let priorQcVmaf: boolean | undefined;
	try {
		const flags = await context.request.get("/api/settings/features");
		expect(flags.status()).toBe(200);
		priorQcVmaf = (await flags.json()).qcVmaf;
		expect(typeof priorQcVmaf).toBe("boolean");
		const enabled = await context.request.patch("/api/settings/features", {
			headers: { origin: baseURL },
			data: { qcVmaf: true },
		});
		expect(enabled.status()).toBe(200);
		expect((await enabled.json()).qcVmaf).toBe(true);
		info.annotations.push({
			type: "evidence-scope",
			description:
				"Synthetic report scores and generated local media; no provider encoding or VMAF measurement",
		});
		const comparePath = `/qc/compare?jobs=${JOBS.join(",")}`;
		await page.goto(comparePath);
		const figure = page.getByRole("figure", {
			name: "VMAF distribution",
			exact: true,
		});
		await expect(figure).toBeVisible();
		await expect(
			figure.getByText("Distribution unavailable", { exact: true }),
		).toBeVisible();
		await expect(
			figure.getByText("90 measured frames", { exact: true }),
		).toHaveCount(2);
		await expect(
			figure.getByText("18 measured samples (every 5 frames)", { exact: true }),
		).toBeVisible();
		await expect(figure.getByText("-5.0", { exact: true })).toBeVisible();
		await expect(figure.getByText("110.0", { exact: true })).toBeVisible();
		await expect(figure.locator("path[data-violin]")).toHaveCount(2);
		for (const d of await figure
			.locator("path[data-violin]")
			.evaluateAll((paths) => paths.map((path) => path.getAttribute("d")))) {
			expect(d).not.toMatch(/NaN|Infinity/);
		}
		const help = figure.getByRole("button", { name: /VMAF distribution/ });
		await help.focus();
		await help.press("Enter");
		await expect(page.getByRole("tooltip")).toContainText("Gaussian");
		await help.press("Escape");
		await expect(help).toHaveAttribute("aria-expanded", "false");
		const toggles = page.locator(
			'input[type="checkbox"][aria-label^="Toggle "]',
		);
		await expect(toggles).toHaveCount(4);
		await toggles.first().uncheck();
		await expect(figure.locator("path[data-violin]")).toHaveCount(1);
		await toggles.first().check();
		await expect(figure.locator("path[data-violin]")).toHaveCount(2);
		await page
			.getByRole("button", { name: "Open comparison preview", exact: true })
			.click();
		await expect(page.locator("video")).toHaveCount(2);
		await expect
			.poll(async () =>
				(await videoState(page)).every(
					(video) =>
						video.ready >= 2 &&
						video.width === 160 &&
						video.height === 90 &&
						video.decoded > 0 &&
						Math.abs(video.duration - 3) < 0.05,
				),
			)
			.toBe(true);
		await verifyQcChartLayout(page, 1440, "en");
		const frame = page.getByRole("spinbutton", {
			name: "Selected frame",
			exact: true,
		});
		await frame.fill("30");
		await frame.press("Tab");
		await expect(frame).toHaveValue("30");
		await expect
			.poll(async () =>
				(await videoState(page)).every(
					(video) => Math.abs(video.time - 30.5 / FPS) < 0.04,
				),
			)
			.toBe(true);
		await page.getByRole("button", { name: "Play both", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "Pause both", exact: true }),
		).toBeVisible();
		await expect
			.poll(async () => {
				const videos = await videoState(page);
				return (
					videos.every(
						(video) => !video.paused && video.time > 30.5 / FPS + 0.2,
					) && Math.abs((videos[0]?.time ?? 0) - (videos[1]?.time ?? 0)) < 0.15
				);
			})
			.toBe(true);
		await page.getByRole("button", { name: "Pause both", exact: true }).click();
		await expect
			.poll(async () => (await videoState(page)).every((video) => video.paused))
			.toBe(true);
		const chart = page.locator(".recharts-wrapper").first();
		await chart.scrollIntoViewIfNeeded();
		const box = await chart.boundingBox();
		expect(box).not.toBeNull();
		if (!box) throw new Error("Comparison chart has no geometry");
		const position = { x: box.width * 0.55, y: box.height * 0.45 };
		await chart.hover({ position });
		await page.evaluate(
			() =>
				new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				),
		);
		const hovered = /^frame (\d+)$/.exec(
			await chart.locator(".recharts-tooltip-label").innerText(),
		);
		expect(hovered).not.toBeNull();
		const selectedFrame = Number(hovered?.[1]);
		expect(Number.isInteger(selectedFrame)).toBe(true);
		await chart.click({ position });
		await expect(frame).toHaveValue(String(selectedFrame));
		await expect
			.poll(async () =>
				(await videoState(page)).every(
					(video) =>
						video.ready >= 2 &&
						Math.abs(video.time - (selectedFrame + 0.5) / FPS) < 0.04,
				),
			)
			.toBe(true);
		const oldVideo = await page.locator("video").first().elementHandle();
		expect(oldVideo).not.toBeNull();
		await page
			.getByRole("combobox", { name: "Rendition A", exact: true })
			.selectOption(`${JOBS[0]}:flat`);
		await expect
			.poll(async () =>
				(await videoState(page)).every(
					(video) => video.ready >= 2 && video.decoded > 0,
				),
			)
			.toBe(true);
		expect(
			await oldVideo?.evaluate((video) => {
				if (!(video instanceof HTMLVideoElement))
					throw new Error("Expected a video element");
				return {
					connected: video.isConnected,
					paused: video.paused,
					src: video.getAttribute("src"),
				};
			}),
		).toEqual({ connected: false, paused: true, src: null });
		await oldVideo?.dispose();
		await page.screenshot({
			path: info.outputPath("qc-comparison-1440.png"),
			fullPage: true,
		});
		await page
			.getByRole("button", { name: "Close comparison preview", exact: true })
			.click();
		await expect(page.locator("video")).toHaveCount(0);
		expect(receivedMedia.size).toBeGreaterThanOrEqual(3);
		await context.addCookies([
			{ name: "ovp-locale", value: "ja", url: baseURL },
		]);
		for (const width of [320, 768, 1024, 1440]) {
			await page.setViewportSize({ width, height: 1000 });
			for (const mode of ["comparison", "detail"] as const) {
				await page.goto(mode === "comparison" ? comparePath : `/qc/${JOBS[0]}`);
				await expect(
					page.getByRole("figure", { name: "VMAF 分布", exact: true }),
				).toBeVisible();
				await page
					.getByRole("button", { name: "比較プレビューを開く", exact: true })
					.click();
				await expect
					.poll(async () =>
						(await videoState(page)).every(
							(video) => video.ready >= 2 && video.decoded > 0,
						),
					)
					.toBe(true);
				await page.evaluate(() => document.fonts.ready);
				await expect
					.poll(() =>
						page.evaluate(
							() => document.documentElement.scrollWidth <= innerWidth,
						),
					)
					.toBe(true);
				await verifyQcChartLayout(page, width, "ja");
				if (width === 320 || width === 1440) {
					await page.screenshot({
						path: info.outputPath(`qc-${mode}-ja-${width}.png`),
						fullPage: true,
					});
				}
			}
		}
		await verifyCambiComparisonBrowser(page, context, info);
		expect(unexpected).toEqual([]);
	} finally {
		try {
			if (priorQcVmaf !== undefined) {
				const restored = await context.request.patch("/api/settings/features", {
					headers: { origin: baseURL },
					data: { qcVmaf: priorQcVmaf },
				});
				expect(restored.status()).toBe(200);
				expect((await restored.json()).qcVmaf).toBe(priorQcVmaf);
			}
		} finally {
			await context.close();
		}
	}
}
