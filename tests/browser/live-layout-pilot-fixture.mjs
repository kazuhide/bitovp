import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const channelId = "45365e7e-1343-4cf3-bd9d-1500ad917c44";
const runId = "cc418dc6-d248-429b-8230-8a73d6430031";
const encodingId = "46bea0bd-4e0d-4b57-9c96-10b332cad54d";
const organizationId = "00000000-0000-4000-8000-000000000001";
const credentialId = "b9397eb7-79f8-4074-9df8-ff70b8cc611b";
const userId = "f33b2230-1f22-40f7-a635-e414575ae48a";
const sessionId = "6082871f-1d44-476a-816d-29992eec1f7b";
const channelApi = `/api/live-channels/${channelId}`;
const runApi = `${channelApi}/runs/${runId}`;
const planFile = new URL(
	"../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
	import.meta.url,
);

function savedHistory(startedAt, endedAt) {
	const samples = Array.from({ length: 8 }, (_, index) => ({
		elapsedMs: (index + 1) * 1_000,
		latencyMs: 800 + (index % 3) * 110,
		fps: 23 + (index % 4),
		bufferSeconds: 0.5 + (index % 5) * 0.05,
		bufferSource: "player",
		renderingSource: "canvas",
		droppedFrames: null,
		decodedFrames: null,
		presentedFrames: null,
		totalFrames: null,
		resolution: { width: 640, height: 360 },
	}));
	return {
		runId,
		sessions: [
			{
				id: sessionId,
				startedAt,
				endedAt,
				createdAt: startedAt,
				updatedAt: endedAt,
				samples,
				events: [
					{ elapsedMs: 0, type: "started" },
					{ elapsedMs: 500, type: "first-frame" },
					{ elapsedMs: 15_000, type: "ended" },
				],
				archive: null,
			},
		],
		heartbeat: {
			source: "live-encoder-heartbeat",
			points: [],
			truncated: false,
		},
	};
}

async function liveData(phase, title) {
	const now = Date.now();
	const stopped = phase === "STOPPED";
	const startedMs = stopped ? Date.UTC(2026, 10, 19, 6) : now - 60_000;
	const startedAt = new Date(startedMs).toISOString();
	const archiveEnded = new Date(startedMs + 15_000).toISOString();
	const endedAt = stopped ? new Date(startedMs + 60_000).toISOString() : null;
	const moq = {
		kind: "MOQ",
		credentialId,
		trackNamespace: ["live-layout-pilot"],
		draftVersion: "DRAFT_18",
	};
	const plan = JSON.parse(await readFile(planFile, "utf8"));
	plan.outputs = [{ key: "origin", ...moq }];
	plan.start = { ...plan.start, encodingOption: "CUSTOM" };
	plan.liveManifests = [];
	const stepLog = [
		{
			step: "output:moq",
			kind: "CREATE_OUTPUT_MOQ",
			status: "DONE",
			refs: {},
			payload: {
				credentialId,
				trackNamespace: moq.trackNamespace,
				draftVersion: moq.draftVersion,
			},
		},
	];
	const run = {
		id: runId,
		seq: 1,
		status: phase,
		bitmovinEncodingId: encodingId,
		createdAt: startedAt,
		runningSince: startedAt,
		endedAt,
		encoderIp: null,
		streamKey: null,
		outputPrefix: "live-layout-pilot",
		programStartAt: null,
		programEndAt: null,
		error: null,
		lastHeartbeat: null,
		lastHeartbeatAt: null,
		stepLog,
		liveToVod: null,
		originObservation: null,
		providerStatus: stopped ? "FINISHED" : "RUNNING",
		providerStatusObservedAt: endedAt ?? new Date(now).toISOString(),
		providerUnknownSince: null,
		providerTerminalAt: endedAt,
	};
	const channel = {
		id: channelId,
		name: title,
		status: phase,
		labels: [],
		region: "AWS_AP_NORTHEAST_1",
		protocol: "RTMP",
		plan,
		stepLog,
		bitmovinEncodingId: encodingId,
		createdAt: startedAt,
		updatedAt: endedAt ?? startedAt,
		streamKey: null,
		encoderIp: null,
		programStartAt: null,
		programEndAt: null,
		lastHeartbeat: null,
		liveToVod: null,
		error: null,
		playbackLinks: [],
		currentRun: run,
	};
	const health = {
		points: [],
		lanes: { ingest: [], encoder: [], output: [] },
		run,
		truncated: false,
		outputObservable: false,
		timeline: {
			window: stopped
				? { startMs: startedMs, endMs: Date.parse(endedAt) }
				: { startMs: startedMs },
			events: [{ kind: "ENCODER_RUNNING", atMs: startedMs }],
		},
	};
	return {
		channel,
		run,
		health,
		history: savedHistory(startedAt, archiveEnded),
	};
}

function loopbackOrigin(baseURL) {
	const url = new URL(baseURL);
	assert.equal(url.protocol, "http:");
	assert.ok(
		["127.0.0.1", "[::1]", "localhost"].includes(url.hostname),
		"Live layout pilot requires loopback HTTP",
	);
	assert.ok(
		!url.username && !url.password,
		"Live layout pilot does not use authenticated URLs",
	);
	return url;
}

/** Open the actual Japanese Live screen with per-page, read-only synthetic API data. */
export async function openLiveLayoutFixture({
	context,
	baseURL,
	role,
	phase,
	title = "MoQ ライブ配信 レイアウト検証",
}) {
	assert.ok(
		role === "OPERATOR" || role === "VIEWER",
		`Invalid fixture role: ${role}`,
	);
	assert.ok(
		phase === "STOPPED" || phase === "RUNNING",
		`Invalid fixture phase: ${phase}`,
	);
	assert.ok(
		typeof title === "string" && title.trim(),
		"Live layout fixture title must be nonempty",
	);
	const url = loopbackOrigin(baseURL);
	const data = await liveData(phase, title);
	const deniedRequests = [];
	const displayName = "ローカル検証";
	const session = {
		mode: "users",
		configured: true,
		authenticated: true,
		loginKind: "password-form",
		displayName,
		role,
		mustChangePassword: false,
		organizationId,
		organizationName: "Main",
		organizations: [{ id: organizationId, name: "Main", slug: "main", role }],
		actorUserId: userId,
		effectiveUserId: userId,
		isImpersonating: false,
	};
	const payloads = new Map([
		["/api/auth/session", session],
		[channelApi, data.channel],
		[`${channelApi}/alerts`, { open: [], history: [] }],
		[`${channelApi}/schedules`, []],
		[`${channelApi}/runs`, { items: [data.run] }],
		[`${channelApi}/moq-readiness`, { status: "ready", issues: [] }],
		[`${runApi}/health`, data.health],
		[
			`${runApi}/moq-observations`,
			role === "OPERATOR" ? data.history : { ...data.history, sessions: [] },
		],
	]);
	await context.addCookies([
		{ name: "ovp-locale", value: "ja", url: url.origin },
	]);
	const page = await context.newPage();
	try {
		await page.route("**/*", async (route) => {
			const request = route.request();
			const target = new URL(request.url());
			const method = request.method();
			const kind =
				target.origin !== url.origin
					? "external"
					: method !== "GET" && method !== "HEAD"
						? "mutation"
						: null;
			if (kind) {
				deniedRequests.push({ method, pathname: target.pathname, kind });
				return route.abort();
			}
			if (!target.pathname.startsWith("/api/")) return route.continue();
			return route.fulfill({
				status: 200,
				json: payloads.get(target.pathname) ?? { items: [] },
			});
		});
		await page.routeWebSocket("**/*", (socket) => {
			const target = new URL(socket.url());
			if (
				target.protocol === "ws:" &&
				target.host === url.host &&
				["/_next/hmr", "/_next/webpack-hmr"].includes(target.pathname)
			) {
				socket.connectToServer();
				return;
			}
			deniedRequests.push({
				method: "WEBSOCKET",
				pathname: target.pathname,
				kind: "external",
			});
			socket.close();
		});
		const response = await page.goto(`${url.origin}/live/${channelId}`, {
			waitUntil: "domcontentloaded",
		});
		assert.equal(response?.status(), 200, "Live source page did not load");
		await page.getByRole("heading", { name: title, exact: true }).waitFor();
		await page
			.getByText(`${displayName} · ${role}`, { exact: true })
			.first()
			.waitFor({ state: "attached" });
		const status = phase === "STOPPED" ? "停止済み" : "RUNNING";
		await page
			.locator("main")
			.getByText(status, { exact: true })
			.first()
			.waitFor();
		const copySettings = page.getByRole("button", {
			name: "設定をコピーして編集",
			exact: true,
		});
		const lifecycleAction = page.locator("#sec-actions").getByRole("button", {
			name: phase === "STOPPED" ? "新しい配信を開始" : "チャンネルを停止",
			exact: true,
		});
		if (role === "OPERATOR") {
			await copySettings.waitFor();
			await lifecycleAction.waitFor();
			if (phase === "STOPPED") {
				const history = page.locator("[data-moq-history]");
				await history.locator('[data-moq-chart="latencyMs"]').waitFor();
				await history.getByText("その他の観測情報", { exact: true }).waitFor();
				await page.locator("#sec-alerts > summary").waitFor();
			}
		} else {
			await copySettings.waitFor({ state: "detached" });
			await lifecycleAction.waitFor({ state: "detached" });
		}
		await page.evaluate(async () => {
			await document.fonts.ready;
			await new Promise((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(resolve)),
			);
		});
		return { page, channelId, deniedRequests };
	} catch (error) {
		await page.close();
		throw error;
	}
}
