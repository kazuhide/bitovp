import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	type BrowserContext,
	expect,
	type Locator,
	type Page,
	type Route,
	type TestInfo,
} from "@playwright/test";

const JOBS = [
	"55555555-5555-4555-8555-555555555501",
	"55555555-5555-4555-8555-555555555502",
	"55555555-5555-4555-8555-555555555503",
] as const;
const REPORTS = JOBS.map((id) => id.replace("55555555", "77777777"));
const PREFIX = "/api/qc-browser-fixture/output-comparison";
const FILES = {
	"index.m3u8": {
		type: "application/vnd.apple.mpegurl",
		sha256: "fe0d1507b7af8d2f3509e0bc05c502fe3676e743ab845d4c913a18a2bfec88fc",
	},
	"init.mp4": {
		type: "video/mp4",
		sha256: "f7cf88238eecfbc2ad051fc3b0cd38a19ebbae40d9d8d906eb2cdd3c2e3a2bbd",
	},
	"segment-000.m4s": {
		type: "video/mp4",
		sha256: "997a6cf8c515b54e8e8f1dee5cadb4ba720c32be1c161b63ad50975bf1550d99",
	},
} as const;

async function mediaState(videos: Locator) {
	return videos.evaluateAll((elements) =>
		elements.map((element) => {
			const video = element as HTMLVideoElement;
			return {
				time: video.currentTime,
				paused: video.paused,
				muted: video.muted,
				seeking: video.seeking,
				ready: video.readyState,
				width: video.videoWidth,
				decoded: video.getVideoPlaybackQuality().totalVideoFrames,
			};
		}),
	);
}

/** Help is available on demand without taking space away from the players. */
async function verifyCompactHelp(page: Page, trigger: Locator, text: RegExp) {
	const tooltipId = await trigger.getAttribute("aria-describedby");
	if (!tooltipId) throw new Error("Help description missing");
	const tooltip = page.locator(
		`[role="tooltip"][id=${JSON.stringify(tooltipId)}]`,
	);
	for (const description of await page.getByText(text).all())
		await expect(description).toBeHidden();
	await expect(tooltip).toBeHidden();
	const comparison = page.getByTestId("synchronized-outputs");
	const before = await comparison.boundingBox();
	await trigger.click();
	await expect(tooltip).toBeVisible();
	await expect(tooltip).toContainText(text);
	const after = await comparison.boundingBox();
	if (!before || !after) throw new Error("Output comparison bounds missing");
	expect(after.height).toBeCloseTo(before.height, 1);
	await page.keyboard.press("Escape");
	await expect(tooltip).toBeHidden();
}

async function verifyDemoNavigation(page: Page, info: TestInfo) {
	const comparison = page.getByTestId("synchronized-outputs");
	const videos = comparison.locator("video");
	const originals = await videos.elementHandles();
	const paused = await mediaState(videos);
	const expanded = await comparison.boundingBox();
	const boundary = page.getByRole("separator", {
		name: "Resize navigation",
		exact: true,
	});
	const box = await boundary.boundingBox();
	if (!expanded || !box) throw new Error("Navigation drag boundary missing");
	try {
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(10, box.y + box.height / 2, { steps: 3 });
		await page.mouse.up();
		await expect(boundary).toHaveAttribute("aria-valuenow", "0");
		await expect
			.poll(async () => (await comparison.boundingBox())?.width ?? 0)
			.toBeGreaterThanOrEqual(expanded.width + 200);
		const restore = page.getByRole("button", {
			name: "Show navigation",
			exact: true,
		});
		await expect(restore).toBeVisible();
		const path = info.outputPath("lab-navigation-collapsed-1440.png");
		await page.screenshot({ path, fullPage: true });
		await info.attach("lab-navigation-collapsed-1440", {
			path,
			contentType: "image/png",
		});
		await restore.click();
		await expect(boundary).toHaveAttribute("aria-valuenow", "240");
		await boundary.focus();
		await boundary.press("ArrowLeft");
		await expect(boundary).toHaveAttribute("aria-valuenow", "0");
		await boundary.press("ArrowRight");
		await expect(boundary).toHaveAttribute("aria-valuenow", "240");
		await expect(videos).toHaveCount(originals.length);
		for (const [index, original] of originals.entries())
			expect(
				await videos
					.nth(index)
					.evaluate((node, prior) => node === prior, original),
			).toBe(true);
		const restored = await mediaState(videos);
		restored.forEach((state, index) => {
			expect(state.paused).toBe(true);
			expect(
				Math.abs(state.time - (paused[index]?.time ?? -1)),
			).toBeLessThanOrEqual(0.03);
		});
	} finally {
		await page.mouse.up();
		await Promise.all(originals.map((original) => original.dispose()));
	}
}

/** Actual HLS decoding in mandatory case twelve, with synthetic video only.
 * Source: qc-comparison-synthetic.mp4, SHA256
 * 8f6d6e262b56e40348b9a5ea6f9266bacdb95ed97fe2b5212422921d24dda13e.
 * FFmpeg 9.0.2 remuxed three copies, without re-encoding, into 9 s / 270 frames.
 * The fixture is 160x90 H.264 with no audio; audio selection verifies mute state.
 * It supplies no encoding-quality, HDR or Dolby Vision display evidence. */
export async function verifyOutputComparisonBrowser(
	page: Page,
	context: BrowserContext,
	info: TestInfo,
	baseURL: string,
) {
	// Requested format metadata exercises the disclosure only. The media below
	// remains the same tiny SDR H.264 fixture, never claimed to prove DV playback.
	const hdrPlan = JSON.parse(
		readFileSync(
			new URL(
				"../../packages/core/src/plan/__fixtures__/av1-fmp4-dash-hls.plan.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	for (const rendition of hdrPlan.renditions) {
		if (rendition.codec === "AV1")
			rendition.dynamicRangeFormat = "DOLBY_VISION_PROFILE_10_1";
	}
	const files = new Map(
		Object.entries(FILES).map(([name, metadata]) => {
			const bytes = readFileSync(
				new URL(`./fixtures/output-comparison/${name}`, import.meta.url),
			);
			expect(bytes.length).toBeLessThanOrEqual(100_000);
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(
				metadata.sha256,
			);
			return [name, { ...metadata, bytes }] as const;
		}),
	);
	const priorUrl = page.url();
	const priorViewport = page.viewportSize();
	const priorLocale =
		(await page.locator("html").getAttribute("lang")) === "ja" ? "ja" : "en";
	const received = new Set<string>();
	const fetched = new Set<string>();
	const unexpected: string[] = [];
	const jobsPattern = "**/api/encoding-jobs/**";
	const mediaPattern = `**${PREFIX}/**`;
	const jobsHandler = async (route: Route) => {
		const request = route.request();
		const url = new URL(request.url());
		const id = JOBS.find((id) => url.pathname === `/api/encoding-jobs/${id}`);
		if (
			url.origin !== baseURL ||
			request.method() !== "GET" ||
			url.search ||
			!id
		) {
			unexpected.push("Unexpected output comparison job request");
			return route.abort();
		}
		const side = id === JOBS[0] ? "left" : id === JOBS[1] ? "right" : "center";
		fetched.add(id);
		return route.fulfill({
			json: {
				id,
				name: `SYNTHETIC synchronized ${side} output`,
				status: "FINISHED",
				plan: id === JOBS[0] ? hdrPlan : {},
				playbackLinks: [
					{
						key: "hls",
						kind: "HLS",
						label: "Synthetic HLS",
						url: `${baseURL}${PREFIX}/${side}/index.m3u8`,
						path: "index.m3u8",
						via: "publicBaseUrls",
					},
				],
			},
		});
	};
	const reportsPattern = new RegExp(`/api/vmaf-jobs/(${REPORTS.join("|")})$`);
	const reportsHandler = async (route: Route) => {
		const url = new URL(route.request().url());
		const index = REPORTS.findIndex(
			(id) => url.pathname === `/api/vmaf-jobs/${id}`,
		);
		if (
			url.origin !== baseURL ||
			route.request().method() !== "GET" ||
			index < 0
		)
			throw new Error("Unexpected three-way Lab report request");
		const score = [93, 100.171922, 97.363122][index] ?? 0;
		return route.fulfill({
			json: {
				id: REPORTS[index],
				encodingJobId: JOBS[index],
				encodingName: `SYNTHETIC LAB ${index + 1}`,
				mode: "VOD",
				status: "FINISHED",
				model:
					index === 0 ? "hdr_vmaf_v1.1.8_3d0h_2160" : "vmaf_v1.0.16_3d0h_2160",
				scoringVersion: 14,
				subsample: null,
				reference: { fps: 30, width: 160, height: 90 },
				results: [
					{
						id: "primary",
						renditionRef: { label: "90p", height: 90, bitrate: 300_000 },
						pooled: { mean: score },
						frames: [
							{ frameNum: 0, vmaf: score },
							{ frameNum: 1, vmaf: score },
						],
						frameCount: 2,
					},
				],
			},
		});
	};
	const mediaHandler = async (route: Route) => {
		const request = route.request();
		const url = new URL(request.url());
		const match =
			/^\/api\/qc-browser-fixture\/output-comparison\/(left|center|right)\/([^/]+)$/.exec(
				url.pathname,
			);
		const file = match?.[2] ? files.get(match[2]) : undefined;
		if (
			url.origin !== baseURL ||
			!["GET", "HEAD"].includes(request.method()) ||
			url.search ||
			!match ||
			!file
		) {
			unexpected.push("Unexpected output comparison media request");
			return route.abort();
		}
		const range = request.headers().range;
		const requested =
			range === undefined ? null : /^bytes=(\d+)-(\d*)$/.exec(range);
		const start = requested ? Number(requested[1]) : 0;
		const end = requested?.[2]
			? Math.min(Number(requested[2]), file.bytes.length - 1)
			: file.bytes.length - 1;
		if (
			(range !== undefined && !requested) ||
			start > end ||
			start >= file.bytes.length
		) {
			unexpected.push("Unexpected output comparison Range request");
			return route.fulfill({
				status: 416,
				headers: { "content-range": `bytes */${file.bytes.length}` },
			});
		}
		received.add(`${match[1]}/${match[2]}`);
		return route.fulfill({
			status: range === undefined ? 200 : 206,
			contentType: file.type,
			headers: {
				"cache-control": "no-store",
				"accept-ranges": "bytes",
				"content-length": String(end - start + 1),
				...(range === undefined
					? {}
					: { "content-range": `bytes ${start}-${end}/${file.bytes.length}` }),
			},
			body:
				request.method() === "HEAD"
					? Buffer.alloc(0)
					: file.bytes.subarray(start, end + 1),
		});
	};
	await context.route(jobsPattern, jobsHandler);
	await context.route(mediaPattern, mediaHandler);
	await context.route(reportsPattern, reportsHandler);
	try {
		await context.addCookies([
			{ name: "ovp-locale", value: "en", url: baseURL },
		]);
		await page.setViewportSize({ width: 1440, height: 1000 });
		await page.goto(`/vod/compare?jobs=${JOBS.slice(0, 2).join(",")}`);
		const comparison = page.getByTestId("synchronized-outputs");
		const videos = comparison.locator("video");
		await expect(videos).toHaveCount(2);
		await expect
			.poll(async () =>
				(await mediaState(videos)).every(
					(v) => v.ready >= 3 && v.width === 160,
				),
			)
			.toBe(true);
		expect([...fetched].sort()).toEqual([...JOBS.slice(0, 2)].sort());
		for (const side of ["left", "right"])
			for (const name of Object.keys(FILES))
				expect(received.has(`${side}/${name}`)).toBe(true);
		await verifyCompactHelp(
			page,
			comparison.getByRole("button", {
				name: "Compare outputs — more information",
				exact: true,
			}),
			/Playback time is synchronized/,
		);
		await verifyCompactHelp(
			page,
			comparison.getByRole("button", {
				name: "Output settings: AV1 · Dolby Vision 10.1 — more information",
				exact: true,
			}),
			/HDR \/ Dolby Vision output settings do not verify the display mode/,
		);

		const audio = comparison.getByRole("combobox", {
			name: "Audio",
			exact: true,
		});
		await expect
			.poll(async () => (await mediaState(videos)).map((v) => v.muted))
			.toEqual([false, true]);
		await audio.selectOption({ label: "Right" });
		await expect
			.poll(async () => (await mediaState(videos)).map((v) => v.muted))
			.toEqual([true, false]);
		await audio.selectOption({ label: "Muted" });
		await expect
			.poll(async () => (await mediaState(videos)).map((v) => v.muted))
			.toEqual([true, true]);
		await audio.selectOption({ label: "Left" });

		await comparison
			.getByRole("button", { name: "Play both", exact: true })
			.click();
		await expect
			.poll(async () =>
				(await mediaState(videos)).every(
					(v) => !v.paused && v.time > 0.2 && v.decoded > 0,
				),
			)
			.toBe(true);
		await comparison
			.getByRole("button", { name: "Pause both", exact: true })
			.click();
		await expect
			.poll(async () => (await mediaState(videos)).every((v) => v.paused))
			.toBe(true);
		const paused = await mediaState(videos);
		await page.waitForTimeout(150);
		const stopped = await mediaState(videos);
		stopped.forEach((v, index) => {
			expect(
				Math.abs(v.time - (paused[index]?.time ?? -1)),
			).toBeLessThanOrEqual(0.03);
		});

		await comparison
			.getByRole("slider", { name: "Playback position (seconds)", exact: true })
			.evaluate((element) => {
				const input = element as HTMLInputElement;
				const setter = Object.getOwnPropertyDescriptor(
					HTMLInputElement.prototype,
					"value",
				)?.set;
				if (!setter) throw new Error("Native range setter unavailable");
				setter.call(input, "1");
				input.dispatchEvent(new Event("input", { bubbles: true }));
				input.dispatchEvent(new Event("change", { bubbles: true }));
			});
		await expect
			.poll(async () =>
				(await mediaState(videos)).every(
					(v) => v.paused && !v.seeking && Math.abs(v.time - 1) <= 0.15,
				),
			)
			.toBe(true);
		await comparison
			.getByRole("button", { name: "Play both", exact: true })
			.click();
		await expect
			.poll(async () =>
				(await mediaState(videos)).every((v) => !v.paused && v.time > 1.2),
			)
			.toBe(true);
		await videos.nth(1).evaluate((element) => {
			(element as HTMLVideoElement).currentTime += 0.75;
		});
		await expect
			.poll(async () => {
				const [left, right] = await mediaState(videos);
				return (
					!!left &&
					!!right &&
					!left.paused &&
					!right.paused &&
					left.time > 1.2 &&
					Math.abs(left.time - right.time) <= 0.25
				);
			})
			.toBe(true);
		const synchronized = await mediaState(videos);
		await comparison
			.getByRole("button", { name: "Pause both", exact: true })
			.click();

		for (const width of [320, 768, 1024, 1440]) {
			await page.setViewportSize({ width, height: 1000 });
			await expect
				.poll(() => page.evaluate(() => document.documentElement.scrollWidth))
				.toBeLessThanOrEqual(width);
			const left = await page.getByTestId("output-left").boundingBox();
			const right = await page.getByTestId("output-right").boundingBox();
			if (!left || !right) throw new Error("Output comparison panes missing");
			if (width === 320)
				expect(right.y).toBeGreaterThan(left.y + left.height - 1);
			if (width === 1440) {
				expect(right.x).toBeGreaterThan(left.x + left.width - 1);
				expect(Math.abs(right.y - left.y)).toBeLessThanOrEqual(2);
			}
			if (width === 320 || width === 1440) {
				const path = info.outputPath(`output-comparison-${width}.png`);
				await page.screenshot({ path, fullPage: true });
				await info.attach(`output-comparison-${width}`, {
					path,
					contentType: "image/png",
				});
			}
		}

		await page.goto(`/qc/compare?jobs=${REPORTS.join(",")}`);
		await expect(videos).toHaveCount(3);
		await expect
			.poll(async () =>
				(await mediaState(videos)).every(
					(v) => v.ready >= 3 && v.width === 160,
				),
			)
			.toBe(true);
		expect([...fetched].sort()).toEqual([...JOBS].sort());
		await expect(
			page.getByRole("heading", { name: "Compare outputs", exact: true }),
		).toHaveCount(0);
		await verifyCompactHelp(
			page,
			page.getByRole("button", {
				name: "Compare reports — more information",
				exact: true,
			}),
			/measurement conditions differ/,
		);
		await verifyCompactHelp(
			page,
			page.getByRole("button", { name: "VMAF — more information" }).first(),
			/approximate anchors on a continuous scale/,
		);
		await expect(
			page.getByRole("region", {
				name: /SYNTHETIC LAB 1.*unverified measurement/,
			}),
		).toBeVisible();
		await expect(
			page.getByRole("region", { name: /SYNTHETIC LAB 2.*SDR/ }),
		).toBeVisible();
		await expect(
			page.getByRole("region", { name: /SYNTHETIC LAB 3.*SDR/ }),
		).toBeVisible();
		await audio.selectOption({ label: "Center" });
		await expect
			.poll(async () => (await mediaState(videos)).map((v) => v.muted))
			.toEqual([true, false, true]);
		await comparison
			.getByRole("button", { name: "Play together", exact: true })
			.click();
		await expect
			.poll(async () =>
				(await mediaState(videos)).every(
					(v) => !v.paused && v.time > 0.2 && v.decoded > 0,
				),
			)
			.toBe(true);
		await videos.nth(2).evaluate((element) => {
			(element as HTMLVideoElement).currentTime += 0.75;
		});
		await expect
			.poll(async () => {
				const states = await mediaState(videos);
				return states.every(
					(v) =>
						!v.paused && Math.abs(v.time - (states[0]?.time ?? -1)) <= 0.25,
				);
			})
			.toBe(true);
		await comparison
			.getByRole("button", { name: "Pause together", exact: true })
			.click();
		await expect
			.poll(async () => (await mediaState(videos)).every((v) => v.paused))
			.toBe(true);
		await verifyDemoNavigation(page, info);
		for (const width of [320, 768, 1024, 1440]) {
			await page.setViewportSize({ width, height: 1000 });
			await expect
				.poll(() => page.evaluate(() => document.documentElement.scrollWidth))
				.toBeLessThanOrEqual(width);
			const boxes = await Promise.all(
				["left", "center", "right"].map((side) =>
					page.getByTestId(`output-${side}`).boundingBox(),
				),
			);
			if (boxes.some((box) => !box))
				throw new Error("Three-way Lab panes missing");
			const [left, center, right] = boxes;
			if (!left || !center || !right)
				throw new Error("Three-way Lab panes missing");
			if (width === 320)
				expect(center.y).toBeGreaterThan(left.y + left.height - 1);
			if (width === 1440) {
				expect(center.x).toBeGreaterThan(left.x + left.width - 1);
				expect(right.x).toBeGreaterThan(center.x + center.width - 1);
				expect(Math.abs(right.y - left.y)).toBeLessThanOrEqual(2);
			}
			if (width === 320 || width === 1440) {
				const path = info.outputPath(`lab-three-way-${width}.png`);
				await page.screenshot({ path, fullPage: true });
				await info.attach(`lab-three-way-${width}`, {
					path,
					contentType: "image/png",
				});
			}
		}
		expect(unexpected).toEqual([]);
		await info.attach("synchronized-output-state", {
			body: Buffer.from(
				JSON.stringify(
					{
						media: FILES,
						received: [...received],
						synchronized,
						evidenceScope:
							"Synthetic H.264 video-only HLS decode and UI synchronization; mute state only; no provider, QC, HDR or DV display proof",
					},
					null,
					2,
				),
			),
			contentType: "application/json",
		});
	} finally {
		try {
			await context.addCookies([
				{ name: "ovp-locale", value: priorLocale, url: baseURL },
			]);
			await page.goto(priorUrl);
			if (priorViewport) await page.setViewportSize(priorViewport);
		} finally {
			await context.unroute(jobsPattern, jobsHandler);
			await context.unroute(mediaPattern, mediaHandler);
			await context.unroute(reportsPattern, reportsHandler);
		}
	}
}
