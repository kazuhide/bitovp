import { encodingPlanSchema, VMAF_SCORING_VERSION } from "@bitovp/core";
import { buildPlan, tryImportPresetIntoWizard } from "@bitovp/core/wizard";
import { describe, expect, it, vi } from "vitest";
import {
	DEMO_ACCOUNT_ID,
	DEMO_LIVE_CHANNEL_ID,
	DEMO_STORAGE_ID,
	DEMO_VMAF_JOB_ID,
	DEMO_VOD_JOB_ID,
	demoLivePlan,
	demoVodPlan,
} from "./fixtures";
import { createDemoTransport, DEMO_STORAGE_KEY } from "./transport";

function memoryStorage(initial?: string) {
	const entries = new Map<string, string>();
	if (initial !== undefined) entries.set(DEMO_STORAGE_KEY, initial);
	return {
		getItem: (key: string) => entries.get(key) ?? null,
		setItem: (key: string, value: string) => {
			entries.set(key, value);
		},
		removeItem: (key: string) => {
			entries.delete(key);
		},
	};
}

const origin = "https://example.github.io";
const initialTime = Date.parse("2026-10-19T06:00:00.000Z");

function fixture(initial?: string) {
	let time = initialTime;
	const storage = memoryStorage(initial);
	const assetFetch = vi
		.fn<typeof fetch>()
		.mockResolvedValue(new Response("asset"));
	const options = {
		storage,
		now: () => time,
		origin,
		assetBase: "/bitovp/",
		assetFetch,
	};
	return {
		storage,
		assetFetch,
		options,
		transport: createDemoTransport(options),
		advance(milliseconds: number) {
			time += milliseconds;
		},
	};
}

const post = (value: unknown, requestKey?: string): RequestInit => ({
	method: "POST",
	body: JSON.stringify(value),
	headers: requestKey ? { "Idempotency-Key": requestKey } : undefined,
});

describe("isolated demo transport", () => {
	it("keeps the sample's account and storage selectable through the real copy mapper", async () => {
		const { transport } = fixture();
		const row = await (
			await transport.fetch(`/api/encoding-jobs/${DEMO_VOD_JOB_ID}`)
		).json();
		const mapped = tryImportPresetIntoWizard(row.plan);
		expect(mapped.ok).toBe(true);
		if (!mapped.ok)
			throw new Error("The demo sample must open in the production copy form");
		expect(mapped.state.accountId).toBe(DEMO_ACCOUNT_ID);
		expect(mapped.state.inputFiles[0]?.credentialId).toBe(DEMO_STORAGE_ID);
		expect(mapped.state.output.credentialId).toBe(DEMO_STORAGE_ID);
		expect(encodingPlanSchema.parse(buildPlan(mapped.state))).toEqual(row.plan);
		const created = await transport.fetch(
			"/api/encoding-jobs",
			post({ plan: buildPlan(mapped.state) }),
		);
		expect(created.status).toBe(201);
	});
	it("serves populated production-shaped sample screens without a network request", async () => {
		const { transport, assetFetch } = fixture();
		const session = await (await transport.fetch("/api/auth/session")).json();
		expect(session).toMatchObject({
			authenticated: true,
			role: "OPERATOR",
			displayName: "Demo user",
		});
		const job = await (
			await transport.fetch(`/api/encoding-jobs/${DEMO_VOD_JOB_ID}`)
		).json();
		expect(job).toMatchObject({
			id: DEMO_VOD_JOB_ID,
			status: "FINISHED",
			bitmovinEncodingId: null,
		});
		expect(job.plan.renditions.length).toBeGreaterThan(1);
		expect(job.stepLog.length).toBeGreaterThan(10);
		const channel = await (
			await transport.fetch(`/api/live-channels/${DEMO_LIVE_CHANNEL_ID}`)
		).json();
		expect(channel.heartbeatReception).toMatchObject({
			state: "available",
			configuredIntervalS: 20,
		});
		expect(channel.bitmovinEncodingId).toMatch(/^demo-encoding-/);
		const health = await (
			await transport.fetch(
				`/api/live-channels/${DEMO_LIVE_CHANNEL_ID}/runs/${channel.currentRun.id}/health`,
			)
		).json();
		expect(health.latest).toMatchObject({
			ingest: true,
			encoder: true,
			output: true,
		});
		const usage = await (
			await transport.fetch(
				"/api/dashboard/usage?from=2026-10-01&to=2026-10-19",
			)
		).json();
		expect(usage.days).toHaveLength(19);
		expect(usage.totals.VOD.bytesEncoded).toBeGreaterThan(0);
		expect(assetFetch).not.toHaveBeenCalled();
	});

	it("rejects unknown APIs, external origins, and non-assets without fallback", async () => {
		const { transport, assetFetch } = fixture();
		for (const path of [
			"/api/settings/startup-probes/run",
			"/api/encodings",
			"/api/missing",
			"https://api.bitmovin.com/v1/encoding/encodings",
			"https://storage.example.com/clip.mp4",
			"/bitovp/account/export",
			"/other/application.json",
		]) {
			const response = await transport.fetch(path, post({}));
			expect(response.ok).toBe(false);
			expect((await response.json()).error).toMatch(/demo|simulated/i);
		}
		expect(assetFetch).not.toHaveBeenCalled();
		const allowed = await transport.fetch("/bitovp/assets/screenshot.png");
		expect(await allowed.text()).toBe("asset");
		expect(assetFetch).toHaveBeenCalledTimes(1);
	});

	it("creates, progresses, replays, and reloads a VOD job entirely in local storage", async () => {
		const context = fixture();
		const plan = demoVodPlan();
		const first = await (
			await context.transport.fetch(
				"/api/encoding-jobs",
				post({ plan }, "same-intent"),
			)
		).json();
		expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(
			(
				await (
					await context.transport.fetch(`/api/encoding-jobs/${first.id}`)
				).json()
			).status,
		).toBe("QUEUED");
		context.advance(2_000);
		expect(
			(
				await (
					await context.transport.fetch(`/api/encoding-jobs/${first.id}`)
				).json()
			).status,
		).toBe("RUNNING");
		context.advance(7_000);
		const reloaded = createDemoTransport(context.options);
		expect(
			(await (await reloaded.fetch(`/api/encoding-jobs/${first.id}`)).json())
				.status,
		).toBe("FINISHED");
		const replay = await (
			await reloaded.fetch("/api/encoding-jobs", post({ plan }, "same-intent"))
		).json();
		expect(replay.id).toBe(first.id);
		const changed = await reloaded.fetch(
			"/api/encoding-jobs",
			post({ plan: { ...plan, name: "Changed intent" } }, "same-intent"),
		);
		expect(changed.status).toBe(409);
		expect(context.assetFetch).not.toHaveBeenCalled();
	});

	it("simulates Live create, stop, restart, and deletion without provisioning", async () => {
		const context = fixture();
		const created = await (
			await context.transport.fetch(
				"/api/live-channels",
				post({ plan: demoLivePlan() }),
			)
		).json();
		context.advance(2_000);
		const active = await (
			await context.transport.fetch(`/api/live-channels/${created.id}`)
		).json();
		expect(active.status).toBe("RUNNING");
		expect(active.bitmovinEncodingId).toMatch(/^demo-encoding-/);
		expect(
			(
				await context.transport.fetch(`/api/live-channels/${created.id}`, {
					method: "DELETE",
				})
			).status,
		).toBe(409);
		await context.transport.fetch(
			`/api/live-channels/${created.id}/actions`,
			post({ action: "stop" }),
		);
		expect(
			(
				await (
					await context.transport.fetch(`/api/live-channels/${created.id}`)
				).json()
			).status,
		).toBe("STOPPED");
		await context.transport.fetch(
			`/api/live-channels/${created.id}/actions`,
			post({ action: "restart" }),
		);
		expect(
			(
				await (
					await context.transport.fetch(`/api/live-channels/${created.id}`)
				).json()
			).status,
		).toBe("RUNNING");
		await context.transport.fetch(
			`/api/live-channels/${created.id}/actions`,
			post({ action: "stop" }),
		);
		expect(
			(
				await context.transport.fetch(`/api/live-channels/${created.id}`, {
					method: "DELETE",
				})
			).status,
		).toBe(204);
		expect(
			(await context.transport.fetch(`/api/live-channels/${created.id}`))
				.status,
		).toBe(404);
		expect(context.assetFetch).not.toHaveBeenCalled();
	});

	it("does not accept or persist credentials, malformed JSON, or oversized plans", async () => {
		const { transport, storage } = fixture();
		const attempts = [
			post({ plan: { ...demoVodPlan(), apiKey: "test-private-value" } }),
			post({
				plan: {
					...demoVodPlan(),
					notes: "https://example.com/asset?X-Amz-Signature=private",
				},
			}),
			post({ plan: { name: "Not a plan" } }),
			post({ plan: { ...demoVodPlan(), name: "x".repeat(170_000) } }),
			{ method: "POST", body: "{invalid" },
		];
		for (const attempt of attempts)
			expect((await transport.fetch("/api/encoding-jobs", attempt)).ok).toBe(
				false,
			);
		expect(storage.getItem(DEMO_STORAGE_KEY)).toBeNull();
	});

	it("rejects runtime cap edits rather than confirming an unenforced limit", async () => {
		const { transport, assetFetch } = fixture();
		const response = await transport.fetch(
			`/api/live-channels/${DEMO_LIVE_CHANNEL_ID}`,
			{
				method: "PATCH",
				body: JSON.stringify({ maxRunMinutes: 5 }),
			},
		);
		expect(response.status).toBe(501);
		expect((await response.json()).error).toMatch(/runtime|cap|limit/i);
		const channel = await (
			await transport.fetch(`/api/live-channels/${DEMO_LIVE_CHANNEL_ID}`)
		).json();
		expect(channel.maxRunMinutes).toBeNull();
		expect(assetFetch).not.toHaveBeenCalled();
	});

	it("rejects schedule mutations and keeps the Live schedule list safe to render", async () => {
		const { transport, assetFetch } = fixture();
		const path = `/api/live-channels/${DEMO_LIVE_CHANNEL_ID}/schedules`;
		const responses = [];
		for (const autoLeadTime of [30, 60]) {
			responses.push(
				await transport.fetch(path, post({ action: "START", autoLeadTime })),
			);
		}
		expect(responses.map((response) => response.status)).toEqual([501, 501]);
		for (const response of responses)
			expect((await response.json()).error).toMatch(/schedul/i);
		expect(await (await transport.fetch(path)).json()).toEqual([]);
		const deleted = await transport.fetch(`${path}/demo-schedule`, {
			method: "DELETE",
		});
		expect(deleted.status).toBe(501);
		expect(assetFetch).not.toHaveBeenCalled();
	});

	it("rejects scheduled Live creation without creating a channel or ignoring the schedule", async () => {
		const { transport, storage, assetFetch } = fixture();
		const before = await (await transport.fetch("/api/live-channels")).json();
		const response = await transport.fetch(
			"/api/live-channels",
			post({
				plan: demoLivePlan(),
				schedule: { streamUpAt: "2026-10-20T06:00:00.000Z" },
			}),
		);
		expect(response.status).toBe(501);
		expect((await response.json()).error).toMatch(/Schedule actions/);
		const after = await (await transport.fetch("/api/live-channels")).json();
		expect(after.items.map((row: { id: string }) => row.id)).toEqual(
			before.items.map((row: { id: string }) => row.id),
		);
		expect(storage.getItem(DEMO_STORAGE_KEY)).toBeNull();
		expect(assetFetch).not.toHaveBeenCalled();
	});

	it.each([
		"not-json",
		JSON.stringify({ version: 99, entries: [] }),
		"x".repeat(800_001),
	])("discards invalid persisted state instead of rendering it", async (raw) => {
		const { transport, storage } = fixture(raw);
		const list = await (await transport.fetch("/api/encoding-jobs")).json();
		expect(list.items).toHaveLength(3);
		expect(storage.getItem(DEMO_STORAGE_KEY)).toBeNull();
	});

	it("revalidates stored plans, rejects future/duplicate entries, and caps new records", async () => {
		const context = fixture();
		await context.transport.fetch(
			"/api/encoding-jobs",
			post({ plan: demoVodPlan() }),
		);
		const goodState = JSON.parse(
			context.storage.getItem(DEMO_STORAGE_KEY) ?? "{}",
		);
		for (const mutate of [
			(state: typeof goodState) => {
				state.entries[0].plan.apiKey = "private";
			},
			(state: typeof goodState) => {
				state.entries[0].createdAt = initialTime + 120_000;
			},
			(state: typeof goodState) => {
				state.entries[1].id = state.entries[0].id;
			},
		]) {
			const invalid = structuredClone(goodState);
			mutate(invalid);
			context.storage.setItem(DEMO_STORAGE_KEY, JSON.stringify(invalid));
			const recovered = createDemoTransport(context.options);
			expect(
				(await (await recovered.fetch("/api/encoding-jobs")).json()).items,
			).toHaveLength(3);
		}
		const bounded = createDemoTransport(context.options);
		for (let index = 0; index < 20; index += 1)
			expect(
				(
					await bounded.fetch(
						"/api/encoding-jobs",
						post({ plan: demoVodPlan() }),
					)
				).status,
			).toBe(201);
		expect(
			(await bounded.fetch("/api/encoding-jobs", post({ plan: demoVodPlan() })))
				.status,
		).toBe(409);
		bounded.reset();
		expect(
			(await (await bounded.fetch("/api/encoding-jobs")).json()).items,
		).toHaveLength(3);
		expect(context.storage.getItem(DEMO_STORAGE_KEY)).toBeNull();
	});

	it("still supports exploration when browser storage is unavailable", async () => {
		const denied = () => {
			throw new DOMException("Storage unavailable", "SecurityError");
		};
		const transport = createDemoTransport({
			origin,
			now: () => initialTime,
			storage: { getItem: denied, setItem: denied, removeItem: denied },
		});
		const created = await transport.fetch(
			"/api/encoding-jobs",
			post({ plan: demoVodPlan() }),
		);
		expect(created.status).toBe(201);
		transport.reset();
		expect(
			(await (await transport.fetch("/api/encoding-jobs")).json()).items,
		).toHaveLength(3);
	});

	it("exports only clearly illustrative quality scores", async () => {
		const { transport, assetFetch } = fixture();
		const report = await (
			await transport.fetch(`/api/vmaf-jobs/${DEMO_VMAF_JOB_ID}`)
		).json();
		expect(report.encodingName).toMatch(/Illustrative/);
		expect(report.scoringVersion).toBe(VMAF_SCORING_VERSION);
		expect(report.results).toHaveLength(3);
		const exported = await (
			await transport.fetch(
				`/api/vmaf-jobs/${DEMO_VMAF_JOB_ID}/export?format=json`,
			)
		).json();
		expect(exported.illustrative).toBe(true);
		expect(
			await (
				await transport.fetch(
					`/api/vmaf-jobs/${DEMO_VMAF_JOB_ID}/export?format=csv`,
				)
			).text(),
		).toMatch(/not measured results/);
		expect(assetFetch).not.toHaveBeenCalled();
	});
});
