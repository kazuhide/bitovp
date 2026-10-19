import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Browser,
	type BrowserContext,
	expect,
	type Page,
	test,
} from "@playwright/test";
import { liveChannelPlanSchema } from "../../packages/core/src/live/schema";
import { encodingPlanSchema } from "../../packages/core/src/plan/schema";

const fixture = JSON.parse(
	readFileSync(process.env.BITOVP_GUI_SMOKE_FIXTURE as string, "utf8"),
);
const ACCOUNT = "33333333-3333-4333-8333-333333333333";
const CREDENTIAL = "44444444-4444-4444-8444-444444444444";
const JOB = "55555555-5555-4555-8555-555555555555";
const CHANNEL = "66666666-6666-4666-8666-666666666666";
let authenticated: Awaited<ReturnType<BrowserContext["storageState"]>>;
test.describe.configure({ mode: "serial" });

function only<T>(items: T[]): T {
	expect(items).toHaveLength(1);
	const first = items[0];
	if (!first) throw new Error("The expected submission was not captured");
	return first;
}

async function open(browser: Browser, signedIn = true, accounts = true) {
	const context = await browser.newContext({
		baseURL: fixture.baseURL,
		storageState: signedIn ? authenticated : undefined,
		viewport: { width: 1440, height: 1000 },
		locale: "en-US",
		serviceWorkers: "block",
	});
	const unexpected: string[] = [];
	await context.route("**/*", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (![fixture.baseURL, fixture.secondary.baseURL].includes(url.origin)) {
			unexpected.push(`${request.method()} external request`);
			return route.abort();
		}
		if (url.pathname === "/api/bitmovin-accounts")
			return route.fulfill({
				json: accounts ? [{ id: ACCOUNT, label: "Synthetic account" }] : [],
			});
		if (url.pathname === "/api/credentials")
			return route.fulfill({
				json: [
					{ id: CREDENTIAL, label: "Synthetic storage", provider: "AWS_S3" },
				],
			});
		if (url.pathname.endsWith("/storage/buckets"))
			return route.fulfill({ json: { buckets: [] } });
		if (url.pathname.endsWith("/storage/objects"))
			return route.fulfill({ json: { prefixes: [], objects: [] } });
		if (
			request.method() !== "GET" &&
			!url.pathname.startsWith("/api/auth/") &&
			url.pathname !== "/api/settings/live-heartbeat"
		) {
			unexpected.push(`${request.method()} ${url.pathname}`);
			return route.abort();
		}
		return route.continue();
	});
	const page = await context.newPage();
	page.on("pageerror", (error) => unexpected.push(error.message));
	return { context, page, unexpected };
}

const goTo = (page: Page, name: RegExp) =>
	page
		.getByRole("navigation", { name: /wizard steps/i })
		.getByRole("button", { name })
		.click();
const closePicker = (page: Page) =>
	page
		.getByRole("dialog")
		.getByRole("button", { name: "Close", exact: true })
		.click();

test("first administrator setup", async ({ browser, request }) => {
	const blocked = await request.get("/api/encoding-jobs");
	expect(blocked.status()).toBe(503);
	expect((await blocked.json()).error).toContain("setup");
	const { context, page, unexpected } = await open(browser, false, false);
	try {
		await page.goto("/vod/new");
		await expect(page).toHaveURL(/\/setup$/);
		await page.locator("#setup-code").fill(fixture.code);
		await page.locator("#setup-email").fill(fixture.email);
		await page
			.locator("#setup-display-name")
			.fill("Browser test administrator");
		await page.locator("#setup-password").fill(fixture.password);
		const created = page.waitForResponse(
			(response) =>
				response.url().endsWith("/api/auth/setup") &&
				response.request().method() === "POST",
		);
		await page
			.getByRole("button", { name: /create.*administrator|create.*admin/i })
			.click();
		expect((await created).status()).toBe(201);
		await expect(page).toHaveURL(`${fixture.baseURL}/`);
		const session = await context.request.get("/api/auth/session");
		expect((await session.json()).role).toBe("ADMIN");
		expect(unexpected).toEqual([]);
	} finally {
		await context.close();
	}
});

test("sign in and reject unauthenticated access", async ({
	browser,
	request,
}) => {
	expect((await request.get("/api/encoding-jobs")).status()).toBe(401);
	const { context, page, unexpected } = await open(browser, false, false);
	try {
		await page.goto("/vod/new");
		await expect(page).toHaveURL(/\/login\?next=/);
		await page.locator("#email").fill(fixture.email);
		await page.locator("#password").fill(fixture.password);
		await page.getByRole("button", { name: "Sign in", exact: true }).click();
		await expect(page).toHaveURL(`${fixture.baseURL}/vod/new`);
		await expect(page.locator("#wz-name")).toBeVisible();
		authenticated = await context.storageState();
		expect(unexpected).toEqual([]);
	} finally {
		await context.close();
	}
});

test("configure and submit VOD", async ({ browser }) => {
	const { context, page, unexpected } = await open(browser);
	const submitted: {
		plan: ReturnType<typeof encodingPlanSchema.parse>;
		key: string;
	}[] = [];
	await page.route("**/api/encoding-jobs", async (route) => {
		if (route.request().method() !== "POST") return route.fallback();
		submitted.push({
			plan: encodingPlanSchema.parse(route.request().postDataJSON().plan),
			key: route.request().headers()["idempotency-key"] ?? "",
		});
		return route.fulfill({ status: 201, json: { id: JOB } });
	});
	await page.route(`**/api/encoding-jobs/${JOB}`, (route) =>
		route.fulfill({
			json: {
				id: JOB,
				name: "Browser VOD smoke",
				labels: [],
				status: "QUEUED",
				region: "synthetic",
				doneSteps: 0,
				totalSteps: 1,
				error: null,
				bitmovinEncodingId: null,
				cancelRequested: false,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				plan: only(submitted).plan,
				stepLog: [],
			},
		}),
	);
	await page.route(`**/api/encoding-jobs/${JOB}/analysis`, (route) =>
		route.fulfill({ json: { enabled: false, source: null } }),
	);
	try {
		await page.goto("/vod/new");
		await page.locator("#wz-name").fill("Browser VOD smoke");
		await page.locator("#wz-account").selectOption(ACCOUNT);
		await goTo(page, /sources/i);
		await page.locator("#wz-in-0-cred").selectOption(CREDENTIAL);
		await closePicker(page);
		await page.locator("#wz-in-0-bucket").fill("synthetic-input");
		await page.locator("#wz-in-0-path").fill("bbb-10s.mp4");
		await goTo(page, /ladder/i);
		await page.locator("#wz-v-0-height").fill("720");
		await page.locator("#wz-v-0-bitrate").fill("1500000");
		await goTo(page, /^4\. Output$/);
		await page.locator("#wz-out-cred").selectOption(CREDENTIAL);
		await closePicker(page);
		await page.locator("#wz-out-bucket").fill("synthetic-output");
		await page
			.getByRole("button", { name: "Show summary", exact: true })
			.click();
		await page
			.getByRole("button", { name: "Enter manually", exact: true })
			.click();
		await page.locator("#wz-out-path").fill("browser-smoke");
		for (const step of [
			/^5\. Packaging$/,
			/^6\. Encoding$/,
			/^7\. Manifests$/,
			/^8\. Review$/,
		])
			await goTo(page, step);
		await expect(
			page.getByRole("button", { name: "Plan JSON", exact: true }),
		).toBeVisible();
		await page
			.getByRole("button", { name: "Start encoding", exact: true })
			.click();
		await expect(page).toHaveURL(`${fixture.baseURL}/vod/jobs/${JOB}`);
		await expect(
			page.getByRole("heading", { name: "Browser VOD smoke", exact: true }),
		).toBeVisible();
		const creation = only(submitted);
		expect(creation.key).toMatch(/^[a-f0-9]{64}$/);
		expect(creation.plan.name).toBe("Browser VOD smoke");
		expect(creation.plan.bitmovin.accountId).toBe(ACCOUNT);
		expect(creation.plan.inputs[0]).toMatchObject({
			bucket: "synthetic-input",
			credentialId: CREDENTIAL,
		});
		expect(creation.plan.renditions[0]).toMatchObject({
			height: 720,
			bitrate: 1_500_000,
		});
		expect(unexpected).toEqual([]);
	} finally {
		await context.close();
	}
});

test("configure and submit Live and inspect heartbeat", async ({ browser }) => {
	const { context, page, unexpected } = await open(browser);
	const submitted: {
		plan: ReturnType<typeof liveChannelPlanSchema.parse>;
		key: string;
	}[] = [];
	await page.route("**/api/live-channels", async (route) => {
		if (route.request().method() !== "POST") return route.fallback();
		submitted.push({
			plan: liveChannelPlanSchema.parse(route.request().postDataJSON().plan),
			key: route.request().headers()["idempotency-key"] ?? "",
		});
		return route.fulfill({ status: 201, json: { id: CHANNEL } });
	});
	const plan = JSON.parse(
		readFileSync(
			join(
				import.meta.dirname,
				"../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
			),
			"utf8",
		),
	);
	let heartbeatAgeMs = 0;
	await page.route(`**/api/live-channels/${CHANNEL}`, (route) =>
		route.fulfill({
			json: {
				id: CHANNEL,
				name: "Browser Live smoke",
				status: "RUNNING",
				plan,
				stepLog: [],
				streamKey: "synthetic",
				encoderIp: "203.0.113.9",
				programStartAt: null,
				programEndAt: null,
				liveToVod: null,
				playbackLinks: [],
				maxRunMinutes: null,
				bitmovinEncodingId: null,
				bitmovinAccountId: null,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				currentRun: null,
				lastHeartbeat: {
					at: new Date(Date.now() - heartbeatAgeMs).toISOString(),
					raw: {
						ingest: {
							status: "CONNECTED",
							healthy: true,
							streams: [
								{
									streamId: "0",
									mediaType: "video",
									codec: "h264",
									width: 1280,
									height: 720,
									rate: 30,
									bitrate: 1_500_000,
									keyFrameIntervalAvg: 2000,
									keyFrameIntervalMax: 2400,
									keyFrameIntervalAvgLastMinute: 2000,
									keyFrameIntervalMaxLastMinute: 2400,
								},
							],
						},
						events: [
							{
								time: new Date().toISOString(),
								details: {
									eventType: "FIRST_CONNECT",
									message: "Synthetic input connected",
								},
							},
						],
					},
					deltas: {},
				},
			},
		}),
	);
	await page.route(`**/api/live-channels/${CHANNEL}/**`, (route) => {
		const path = new URL(route.request().url()).pathname;
		return route.fulfill({
			json: path.endsWith("/alerts")
				? { open: [], history: [] }
				: path.endsWith("/runs")
					? { runs: [] }
					: [],
		});
	});
	try {
		await page.goto("/live/new");
		await page.locator("#lw-name").fill("Browser Live smoke");
		await page.locator("#lw-account").selectOption(ACCOUNT);
		await goTo(page, /input/i);
		await page.locator("#lw-input-kind").selectOption("RTMP");
		await goTo(page, /^\d+\. Video and audio encodes$/);
		await page.locator("#lw-v-0-width").fill("1280");
		await page.locator("#lw-v-0-height").fill("720");
		await page.locator("#lw-v-0-bitrate").fill("1500000");
		await page.locator("#lw-seglen").fill("2");
		await goTo(page, /destinations/i);
		await page.locator("#lw-out-cred").selectOption(CREDENTIAL);
		await closePicker(page);
		await page.locator("#lw-out-bucket").fill("synthetic-output");
		await page.locator("#lw-out-base").fill("browser-live");
		await goTo(page, /output groups and manifests/i);
		await expect(page.locator("#lw-hls-enabled")).toBeChecked();
		await goTo(page, /start/i);
		await page.locator("#lw-streamkey").fill("browserStream");
		await goTo(page, /review/i);
		await page
			.getByRole("button", { name: "Create live channel", exact: true })
			.click();
		await expect(page).toHaveURL(`${fixture.baseURL}/live/${CHANNEL}`);
		const creation = only(submitted);
		expect(creation.key).toMatch(/^[a-f0-9]{64}$/);
		expect(creation.plan.liveInput.kind).toBe("RTMP");
		expect(creation.plan.renditions[0]).toMatchObject({
			width: 1280,
			height: 720,
			bitrate: 1_500_000,
		});
		expect(creation.plan.muxings[0]).toMatchObject({ segmentLength: 2 });
		await page.locator("#sec-heartbeat > summary").click();
		await expect(
			page.getByText("Keyframe avg (ms)", { exact: true }),
		).toBeVisible();
		await expect(
			page.getByText("Synthetic input connected", { exact: true }),
		).toBeVisible();
		heartbeatAgeMs = 600_000;
		await page.reload();
		await page.locator("#sec-heartbeat > summary").click();
		await expect(page.getByText(/No heartbeat sample yet/)).toBeVisible();
		expect(unexpected).toEqual([]);
	} finally {
		await context.close();
	}
});

test("persist and reset heartbeat cadence", async ({ browser }) => {
	const { context, page, unexpected } = await open(browser, true, false);
	try {
		await page.goto("/settings/live");
		const section = page.locator('section[aria-labelledby="hb-cadence-title"]');
		await expect(section.getByTestId("hb-effective")).toBeVisible();
		const original = await page.locator("#hb-interval").inputValue();
		await page.locator("#hb-interval").fill("7");
		const saved = page.waitForResponse(
			(response) =>
				response.url().endsWith("/api/settings/live-heartbeat") &&
				response.request().method() === "PUT",
		);
		await section.getByRole("button", { name: "Save", exact: true }).click();
		expect((await saved).status()).toBe(200);
		await expect(section.getByTestId("hb-effective")).toContainText("7 s");
		await page.reload();
		await expect(page.locator("#hb-interval")).toHaveValue("7");
		const removed = page.waitForResponse(
			(response) =>
				response.url().endsWith("/api/settings/live-heartbeat") &&
				response.request().method() === "DELETE",
		);
		await section.getByRole("button", { name: /revert|reset/i }).click();
		expect((await removed).status()).toBe(200);
		await page.reload();
		await expect(page.locator("#hb-interval")).toHaveValue(original);
		expect(unexpected).toEqual([]);
	} finally {
		await context.close();
	}
});

test("keep independent installation sessions isolated", async ({ browser }) => {
	const { context, page, unexpected } = await open(browser, false, false);
	const secondary = await context.newPage();
	secondary.on("pageerror", (error) => unexpected.push(error.message));
	try {
		await page.goto(`${fixture.baseURL}/login`);
		await page.locator("#email").fill(fixture.email);
		await page.locator("#password").fill(fixture.password);
		await page.getByRole("button", { name: "Sign in", exact: true }).click();
		await expect(page).toHaveURL(`${fixture.baseURL}/`);
		await page.goto(`${fixture.baseURL}/vod/new`);
		await expect(page.locator("#wz-name")).toBeVisible();

		await secondary.goto(`${fixture.secondary.baseURL}/setup`);
		await secondary.locator("#setup-code").fill(fixture.secondary.code);
		await secondary.locator("#setup-email").fill(fixture.secondary.email);
		await secondary
			.locator("#setup-display-name")
			.fill("Independent test administrator");
		await secondary.locator("#setup-password").fill(fixture.secondary.password);
		await secondary
			.getByRole("button", { name: "Create admin and sign in", exact: true })
			.click();
		await expect(secondary).toHaveURL(`${fixture.secondary.baseURL}/`);
		await secondary
			.getByRole("button", { name: "Sign out", exact: true })
			.click();
		await expect(secondary).toHaveURL(`${fixture.secondary.baseURL}/login`);
		await secondary.locator("#email").fill(fixture.secondary.email);
		await secondary.locator("#password").fill(fixture.secondary.password);
		await secondary
			.getByRole("button", { name: "Sign in", exact: true })
			.click();
		await expect(secondary).toHaveURL(`${fixture.secondary.baseURL}/`);
		await secondary.goto(`${fixture.secondary.baseURL}/vod/new`);
		await expect(secondary.locator("#wz-name")).toBeVisible();
		await page.reload();
		await secondary.reload();
		await expect(page.locator("#wz-name")).toBeVisible();
		await expect(secondary.locator("#wz-name")).toBeVisible();
		const cookies = (await context.cookies()).filter(
			(cookie) => cookie.name === "bitovp_session",
		);
		expect(cookies.map((cookie) => cookie.domain).sort()).toEqual([
			"127.0.0.1",
			"localhost",
		]);
		expect(new Set(cookies.map((cookie) => cookie.value)).size).toBe(2);
		expect(
			(
				await (
					await context.request.get(`${fixture.baseURL}/api/auth/session`)
				).json()
			).email,
		).toBe(fixture.email);
		expect(
			(
				await (
					await context.request.get(
						`${fixture.secondary.baseURL}/api/auth/session`,
					)
				).json()
			).email,
		).toBe(fixture.secondary.email);
		await page.getByRole("button", { name: "Sign out", exact: true }).click();
		await expect(page).toHaveURL(`${fixture.baseURL}/login`);
		await secondary.reload();
		await expect(secondary.locator("#wz-name")).toBeVisible();
		expect(
			(
				await (
					await context.request.get(`${fixture.baseURL}/api/auth/session`)
				).json()
			).authenticated,
		).toBe(false);
		expect(
			(
				await (
					await context.request.get(
						`${fixture.secondary.baseURL}/api/auth/session`,
					)
				).json()
			).email,
		).toBe(fixture.secondary.email);
		expect(unexpected).toEqual([]);
	} finally {
		await context.close();
	}
});
