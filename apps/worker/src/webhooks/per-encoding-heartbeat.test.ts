import { describe, expect, it, vi } from "vitest";
import {
	type EncodingHeartbeatPayload,
	reconcilePerEncodingHeartbeats,
} from "./per-encoding-heartbeat";
import { fakeDb } from "./registrar-test-db";

const at = new Date("2026-09-16T10:00:00Z");
const runId = "00000000-0000-4000-8000-000000000001";
const channelId = "00000000-0000-4000-8000-000000000002";
function fixture() {
	const db = fakeDb();
	db.settings.set("live:heartbeat-per-encoding-rollout", {
		enabledAt: "2026-09-16T09:00:00Z",
	});
	db.channels.push({
		id: channelId,
		bitmovinAccountId: "account-1",
		plan: { bitmovin: { encoderVersion: "BETA" } },
	});
	db.runs.push({
		id: runId,
		liveChannelId: channelId,
		bitmovinEncodingId: "enc-1",
		status: "RUNNING",
		createdAt: at,
	});
	const hooks: {
		id: string;
		url: string;
		interval: number;
		customData: unknown;
		name: string;
	}[] = [];
	const api = {
		getHeartbeatEncodingVersion: vi.fn(async () => ({
			requested: "BETA",
			resolved: "2.285.0",
		})),
		listEncodingHeartbeats: vi.fn(async () => hooks),
		getEncodingHeartbeatCustomData: vi.fn(
			async (_enc: string, id: string) =>
				hooks.find((h) => h.id === id)?.customData,
		),
		createEncodingHeartbeat: vi.fn(
			async (_enc: string, payload: EncodingHeartbeatPayload) => {
				hooks.push({ ...payload, id: "hook-1" });
				return { id: "hook-1" };
			},
		),
		removeEncodingHeartbeat: vi.fn(async (_enc: string, id: string) => {
			hooks.splice(
				hooks.findIndex((h) => h.id === id),
				1,
			);
		}),
	};
	const stats = { registered: 0, skipped: 0, failed: 0, retired: 0 };
	const resetCleanupResult = vi.fn(async () => true);
	const tick = (
		time = at,
		heartbeat: {
			intervalS: number;
			mode?: "AUTO" | "LEGACY_ACCOUNT";
		} | null = { intervalS: 20 },
	) =>
		reconcilePerEncodingHeartbeats({
			prisma: db.prisma,
			at: time,
			heartbeat,
			ingressBase: "https://test.invalid",
			masterSecret: "master",
			keyId: "key",
			providerFor: async () => api,
			spend: () => true,
			stats,
			resetCleanupResult,
		});
	return { db, api, hooks, stats, tick, resetCleanupResult };
}

describe("per-encoding heartbeat reconciliation", () => {
	it.each([
		"discover",
		"version",
	])("acknowledges a reset that wins before CREATE at %s", async (phase) => {
		const f = fixture();
		let deletedId: unknown;
		const erase = () => {
			deletedId = f.db.registrations[0]?.id;
			f.db.registrations.splice(0);
		};
		if (phase === "discover")
			f.api.listEncodingHeartbeats.mockImplementation(async () => {
				erase();
				return [];
			});
		else
			f.api.getHeartbeatEncodingVersion.mockImplementation(async () => {
				erase();
				return { requested: "STABLE", resolved: "2.284.0" };
			});
		await f.tick();
		expect(f.api.createEncodingHeartbeat).not.toHaveBeenCalled();
		expect(f.db.registrations).toEqual([]);
		expect(f.resetCleanupResult).toHaveBeenCalledWith(
			deletedId,
			null,
			expect.any(String),
		);
	});
	it("journals a late heartbeat CREATE without recreating a reset row", async () => {
		const f = fixture();
		let deletedId: unknown;
		f.api.createEncodingHeartbeat.mockImplementation(async () => {
			deletedId = f.db.registrations[0]?.id;
			f.db.registrations.splice(0);
			return { id: "late-heartbeat" };
		});
		await f.tick();
		expect(f.db.registrations).toEqual([]);
		expect(f.resetCleanupResult).toHaveBeenCalledWith(
			deletedId,
			"late-heartbeat",
			expect.any(String),
		);
		expect(f.stats.registered).toBe(0);
	});
	it("uses Poll for a known old encoder without inheriting account cadence", async () => {
		const f = fixture();
		f.db.registrations.push({
			id: "account-hb",
			encodingId: "account:account-1",
			scope: "hb",
			kind: "liveEncodingHeartbeat",
			status: "ACTIVE",
			note: "interval 5s",
		});
		f.api.getHeartbeatEncodingVersion.mockResolvedValue({
			requested: "STABLE",
			resolved: "2.284.0",
		});
		await f.tick();
		expect(
			f.db.registrations.find((row) => row.encodingId === "enc-1"),
		).toMatchObject({
			configuration: { mode: "POLL_ONLY", intervalS: 20 },
		});
	});
	it("CAS fences concurrent reconcilers to one create", async () => {
		const f = fixture();
		await Promise.all([f.tick(), f.tick()]);
		expect(f.api.createEncodingHeartbeat).toHaveBeenCalledTimes(1);
	});
	it("rejects a stale snapshot even after another worker has completed and released its lease", async () => {
		const f = fixture();
		const delegate = f.db.prisma.webhookRegistration as unknown as {
			updateMany(
				args: Parameters<typeof f.db.prisma.webhookRegistration.updateMany>[0],
			): Promise<{ count: number }>;
		};
		const original = delegate.updateMany.bind(delegate);
		let signalSnapshot: () => void = () => {};
		let releaseStale: () => void = () => {};
		const snapshotRead = new Promise<void>((resolve) => {
			signalSnapshot = resolve;
		});
		const staleMayClaim = new Promise<void>((resolve) => {
			releaseStale = resolve;
		});
		let delayed = false;
		vi.spyOn(delegate, "updateMany").mockImplementation(async (args) => {
			if (!delayed && args.data.claimedUntil && !args.data.status) {
				delayed = true;
				signalSnapshot();
				await staleMayClaim;
			}
			return original(args);
		});
		const staleTick = f.tick();
		await snapshotRead;
		await f.tick();
		expect(f.db.registrations[0]).toMatchObject({
			status: "ACTIVE",
			claimedUntil: null,
		});
		releaseStale();
		await staleTick;
		expect(f.api.createEncodingHeartbeat).toHaveBeenCalledTimes(1);
		expect(f.hooks).toHaveLength(1);
		expect(f.db.registrations[0]?.url).toBe(f.hooks[0]?.url);
	});
	it("does not adopt or delete a lookalike with another run's customData", async () => {
		const f = fixture();
		await f.tick();
		(f.db.registrations[0] as Record<string, unknown>).status = "FAILED";
		(f.hooks[0] as { customData: unknown }).customData = {
			bitOvp: { v: 1, runId: "other" },
		};
		await f.tick(new Date(at.getTime() + 120_000));
		expect(f.api.createEncodingHeartbeat).toHaveBeenCalledTimes(1);
		expect(f.api.removeEncodingHeartbeat).not.toHaveBeenCalled();
		expect((f.db.registrations[0] as Record<string, unknown>).status).toBe(
			"FAILED",
		);
	});
	it("persists signed hb intent before the immediate provider delivery and creates once", async () => {
		const f = fixture();
		f.api.createEncodingHeartbeat.mockImplementationOnce(
			async (_enc, payload) => {
				expect(f.db.registrations[0]).toMatchObject({
					scope: "hb",
					tokenHash: expect.any(String),
					configuration: { createAttempted: true, runId, channelId },
				});
				expect(payload.url).toContain("/bitmovin/hb/");
				f.hooks.push({ ...payload, id: "hook-1" });
				return { id: "hook-1" };
			},
		);
		await f.tick();
		await f.tick();
		expect(f.api.createEncodingHeartbeat).toHaveBeenCalledTimes(1);
		expect(f.db.registrations[0]).toMatchObject({
			status: "ACTIVE",
			providerWebhookId: "hook-1",
		});
	});
	it("adopts an accepted create whose response was lost without a second POST", async () => {
		const f = fixture();
		f.api.createEncodingHeartbeat.mockImplementationOnce(
			async (_enc, payload) => {
				f.hooks.push({ ...payload, id: "lost-hook" });
				throw new Error("lost response SECRET");
			},
		);
		await f.tick();
		await f.tick(new Date(at.getTime() + 120_000));
		expect(f.api.createEncodingHeartbeat).toHaveBeenCalledTimes(1);
		expect(f.db.registrations[0]).toMatchObject({
			status: "ACTIVE",
			providerWebhookId: "lost-hook",
		});
		expect(JSON.stringify(f.db.registrations)).not.toContain("SECRET");
	});
	it("never re-POSTs an ambiguous create absent from list and cleans it after terminal", async () => {
		const f = fixture();
		f.api.createEncodingHeartbeat.mockRejectedValueOnce(new Error("unknown"));
		await f.tick();
		await f.tick(new Date(at.getTime() + 120_000));
		expect(f.api.createEncodingHeartbeat).toHaveBeenCalledTimes(1);
		const row = f.db.registrations[0];
		const config = row?.configuration as Record<string, unknown>;
		f.hooks.push({
			id: "late-hook",
			url: row?.url as string,
			name: `Bitmovin OVP ${config.registrationId}`,
			interval: 20,
			customData: {
				bitOvp: {
					v: 1,
					registrationId: config.registrationId,
					runId,
					channelId,
				},
			},
		});
		(f.db.runs[0] as Record<string, unknown>).status = "STOPPED";
		await f.tick(new Date(at.getTime() + 600_000));
		expect(f.api.removeEncodingHeartbeat).toHaveBeenCalledWith(
			"enc-1",
			"late-hook",
		);
		expect(f.db.registrations[0]?.status).toBe("DELETED");
	});
	it("retains existing runs and unresolved aliases without per-encoding registration", async () => {
		const f = fixture();
		(f.db.runs[0] as Record<string, unknown>).createdAt = new Date(
			"2026-09-01Z",
		);
		await f.tick();
		expect(f.db.registrations).toHaveLength(0);
		(f.db.runs[0] as Record<string, unknown>).createdAt = at;
		f.api.getHeartbeatEncodingVersion.mockResolvedValue({
			requested: "BETA",
			resolved: "BETA",
		});
		await f.tick();
		expect(f.api.createEncodingHeartbeat).not.toHaveBeenCalled();
		expect(f.db.registrations[0]).toMatchObject({
			configuration: { mode: "PENDING_VERSION" },
		});
	});
	it("freezes interval, honors OFF, and never deletes another application's full slots", async () => {
		const f = fixture();
		await f.tick();
		await f.tick(new Date(at.getTime() + 120_000), { intervalS: 1 });
		expect(f.api.createEncodingHeartbeat).toHaveBeenCalledTimes(1);
		await f.tick(new Date(at.getTime() + 240_000), null);
		expect(f.hooks).toHaveLength(0);
		const g = fixture();
		for (let i = 0; i < 5; i++)
			g.hooks.push({
				id: `foreign-${i}`,
				name: "foreign",
				url: "https://foreign.invalid",
				interval: 20,
				customData: {},
			});
		await g.tick();
		expect(g.api.createEncodingHeartbeat).not.toHaveBeenCalled();
		expect(g.api.removeEncodingHeartbeat).not.toHaveBeenCalled();
	});
});

describe("legacy intent history compatibility", () => {
	it("preserves a live legacy snapshot and leaves its existing receipts attributable", async () => {
		const f = fixture();
		f.api.getHeartbeatEncodingVersion.mockResolvedValueOnce({
			requested: "STABLE",
			resolved: "2.284.0",
		});
		await f.tick();
		const row = f.db.registrations[0];
		if (!row) throw new Error("missing registration");
		row.configuration = {
			...(row.configuration as object),
			mode: "LEGACY_ACCOUNT",
		};
		const original = structuredClone(row.configuration);
		f.api.getHeartbeatEncodingVersion.mockClear();
		await f.tick(new Date(at.getTime() + 120000), {
			intervalS: 2,
			mode: "LEGACY_ACCOUNT",
		});
		expect(f.api.createEncodingHeartbeat).not.toHaveBeenCalled();
		expect(f.api.getHeartbeatEncodingVersion).not.toHaveBeenCalled();
		expect(row.configuration).toEqual(original);
	});
	it("keeps ended legacy snapshot history unchanged", async () => {
		const f = fixture();
		f.api.getHeartbeatEncodingVersion.mockResolvedValueOnce({
			requested: "STABLE",
			resolved: "2.284.0",
		});
		await f.tick();
		const row = f.db.registrations[0];
		if (!row) throw new Error("missing registration");
		row.configuration = {
			...(row.configuration as object),
			mode: "LEGACY_ACCOUNT",
		};
		const config = structuredClone(row.configuration);
		const run = f.db.runs[0];
		if (!run) throw new Error("missing run");
		run.status = "STOPPED";
		await f.tick(new Date(at.getTime() + 120000));
		expect(row.configuration).toEqual(config);
		expect(f.api.createEncodingHeartbeat).not.toHaveBeenCalled();
	});
});
