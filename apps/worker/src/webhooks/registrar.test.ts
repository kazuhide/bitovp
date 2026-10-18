import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	AesGcmCipher,
	deriveWebhookKey,
	HEARTBEAT_EVENT_RETENTION_MS,
	HEARTBEAT_WEBHOOK_KIND,
	hashWebhookToken,
	heartbeatRegistrationKey,
	INGRESS_SETTING_KEY,
	REGISTRATION_TOMBSTONE_TTL_MS,
	tokenFromReceiverUrl,
	WEBHOOK_RECONCILE_REQUEST_KEY,
	WEBHOOK_REGISTRATION_KINDS,
	webhookKeyId,
} from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import {
	createWebhookRegistrar,
	REGISTRABLE_JOB_STATUSES,
	type RegistrarProviderApi,
	TERMINAL_JOB_STATUSES,
} from "./registrar";
import { fakeDb } from "./registrar-test-db";

const resetResult = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@bitovp/db", async (original) => ({
	...(await original<typeof import("@bitovp/db")>()),
	recordResetCleanupWebhookResult: resetResult,
}));

/**
 * WP-G G-2 registrar — the reconciler's contract, driven over an in-memory
 * Prisma double that honours the exact query shapes the registrar uses
 * (equality, `in`, `not: null`, `lte`/`lt`, `OR`, one nested relation
 * filter, the `encodingId_kind` upsert and the CAS updateMany). A fake that
 * ignored `where` would pass a registrar that double-registers; this one
 * does not.
 */

type Row = Record<string, unknown>;
const VOD_KINDS = ["finished", "error", "transferError"];

const T0 = new Date("2026-09-02T09:00:00.000Z");
const MASTER = "registrar-test-master";
const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
const ACCOUNT_B = "00000000-0000-4000-8000-0000000000b2";

function ingress(base: string | null) {
	return {
		v: 1,
		mode: "quick-tunnel",
		current: base
			? {
					baseUrl: base,
					source: "cloudflared-quicktunnel",
					observedAt: T0.toISOString(),
				}
			: null,
		checkedAt: T0.toISOString(),
		...(base ? {} : { reason: "sidecar down" }),
	};
}

function fakeProvider() {
	const created: {
		encodingId: string;
		kind: string;
		url: string;
		key: string;
	}[] = [];
	const removed: { encodingId: string; kind: string; webhookId: string }[] = [];
	let nextId = 0;
	const failCreate = new Set<string>();
	const failRemove = new Set<string>();
	const createHeartbeat = vi.fn(async () => ({
		id: "forbidden-account-create",
	}));
	const api: RegistrarProviderApi & {
		createHeartbeat: typeof createHeartbeat;
	} = {
		getHeartbeatEncodingVersion: vi.fn(async () => ({
			requested: null,
			resolved: null,
		})),
		listEncodingHeartbeats: vi.fn(async () => []),
		getEncodingHeartbeatCustomData: vi.fn(async () => ({})),
		createEncodingHeartbeat: vi.fn(async () => ({ id: "per-hb" })),
		removeEncodingHeartbeat: vi.fn(async () => {}),
		async create(encodingId, kind, payload) {
			if (failCreate.has(`${encodingId}/${kind}`)) {
				throw new Error("provider 503");
			}
			created.push({
				encodingId,
				kind,
				url: payload.url,
				key: payload.signature.key,
			});
			nextId += 1;
			return { id: `wh-${nextId}` };
		},
		async remove(encodingId, kind, webhookId) {
			if (failRemove.has(webhookId)) {
				throw new Error("provider 500");
			}
			removed.push({ encodingId, kind, webhookId });
		},
		createHeartbeat,
		async removeHeartbeat(webhookId) {
			if (failRemove.has(webhookId)) throw new Error("provider 500");
			removedHeartbeats.push(webhookId);
		},
	};
	const heartbeats = createHeartbeat.mock.calls;
	const removedHeartbeats: string[] = [];
	return {
		api,
		created,
		removed,
		failCreate,
		failRemove,
		heartbeats,
		removedHeartbeats,
	};
}

function harness(
	base: string | null = "https://a.trycloudflare.com",
	heartbeat?: { intervalS: number; idleMs: number },
) {
	const db = fakeDb();
	db.settings.set(INGRESS_SETTING_KEY, ingress(base));
	const provider = fakeProvider();
	const providerFor = vi.fn(async (_accountId: string) => provider.api);
	let clock = T0.getTime();
	const log = vi.fn();
	let hb: { intervalS: number; idleMs: number } | null = heartbeat ?? null;
	const registrar = createWebhookRegistrar({
		prisma: db.prisma,
		cipher: new AesGcmCipher(randomBytes(32)),
		envSecret: MASTER,
		providerFor,
		now: () => new Date(clock),
		log,
		heartbeat: async () => hb,
	});
	const advance = (ms: number) => {
		clock += ms;
	};
	const setIngress = (b: string | null) =>
		db.settings.set(INGRESS_SETTING_KEY, ingress(b));
	const setHeartbeat = (cfg: { intervalS: number; idleMs: number } | null) => {
		hb = cfg;
	};
	return {
		db,
		provider,
		providerFor,
		registrar,
		advance,
		setIngress,
		setHeartbeat,
		log,
	};
}

function job(
	db: ReturnType<typeof fakeDb>,
	id: string,
	encodingId: string | null,
	status: string,
	account = ACCOUNT,
) {
	db.jobs.push({
		id,
		bitmovinEncodingId: encodingId,
		bitmovinAccountId: account,
		status,
	});
}

describe("webhook registrar — register on start", () => {
	it.each([
		false,
		true,
	])("does not resurrect a reset registration after late CREATE (failure=%s)", async (failure) => {
		const h = harness();
		job(h.db, "job-reset", "encoding-reset", "RUNNING");
		let oldId: unknown;
		let observedAttempt: Row | undefined;
		const original = h.provider.api.create;
		h.provider.api.create = async (encodingId, kind, payload) => {
			if (!oldId) {
				const row = h.db.registrations.find((entry) => entry.kind === kind);
				oldId = row?.id;
				observedAttempt = row ? { ...row } : undefined;
				h.db.registrations.splice(0);
				if (failure) throw new Error("response lost after reset");
				return { id: "late-hook" };
			}
			return original(encodingId, kind, payload);
		};
		await h.registrar.tick();
		expect(observedAttempt).toMatchObject({
			url: expect.any(String),
			tokenHash: expect.any(String),
			configuration: { createAttempted: true },
			claimedUntil: expect.any(Date),
		});
		expect(h.db.registrations.some((row) => row.id === oldId)).toBe(false);
		expect(resetResult).toHaveBeenCalledWith(
			h.db.prisma,
			expect.anything(),
			oldId,
			failure ? null : "late-hook",
			expect.any(String),
		);
	});
	it("new AUTO provisioning runs do not create account hooks before encoding/version resolution", async () => {
		const h = harness("https://a.trycloudflare.com", {
			intervalS: 20,
			idleMs: 60_000,
		});
		h.db.settings.set("live:heartbeat-per-encoding-rollout", {
			enabledAt: T0.toISOString(),
		});
		h.db.channels.push({
			id: "00000000-0000-4000-8000-000000000002",
			bitmovinAccountId: ACCOUNT,
			plan: { bitmovin: { encoderVersion: "BETA" } },
		});
		h.db.runs.push({
			id: "00000000-0000-4000-8000-000000000001",
			liveChannelId: "00000000-0000-4000-8000-000000000002",
			bitmovinEncodingId: null,
			createdAt: T0,
			status: "PROVISIONING",
		});
		await h.registrar.tick();
		expect(h.provider.heartbeats).toHaveLength(0);
		(h.db.runs[0] as Row).bitmovinEncodingId = "enc-modern";
		(h.db.runs[0] as Row).status = "RUNNING";
		vi.spyOn(h.provider.api, "getHeartbeatEncodingVersion").mockResolvedValue({
			requested: "BETA",
			resolved: "2.285.0",
		});
		await h.registrar.tick();
		expect(h.provider.heartbeats).toHaveLength(0);
		expect(
			h.db.registrations.find((row) => row.kind === HEARTBEAT_WEBHOOK_KIND),
		).toMatchObject({
			scope: "hb",
			encodingId: "enc-modern",
			status: "ACTIVE",
		});
	});
	it.each([
		"QUEUED",
		"RUNNING",
		"AWAITING_QC",
	])("registers only the three VOD kinds for a %s job, one token per encoding, keys derived from the master", async (status) => {
		const h = harness();
		job(h.db, "job-1", "enc-1", status);
		const stats = await h.registrar.tick();
		expect(stats).toMatchObject({
			registered: 3,
			skipped: 0,
			failed: 0,
			retired: 0,
		});
		expect(h.provider.created.map((c) => c.kind)).toEqual(VOD_KINDS);
		const urls = new Set(h.provider.created.map((c) => c.url));
		expect(urls.size).toBe(1);
		const url = [...urls][0] as string;
		expect(
			url.startsWith("https://a.trycloudflare.com/api/webhooks/bitmovin/j/"),
		).toBe(true);
		const token = tokenFromReceiverUrl(url) as string;
		expect(
			h.provider.created.every(
				(c) => c.key === deriveWebhookKey(MASTER, token),
			),
		).toBe(true);
		const rows = h.db.registrations;
		expect(rows).toHaveLength(3);
		for (const row of rows) {
			expect(row).toMatchObject({
				status: "ACTIVE",
				encodingJobId: "job-1",
				bitmovinAccountId: ACCOUNT,
				encodingId: "enc-1",
				tokenHash: hashWebhookToken(token),
				keyId: webhookKeyId(MASTER),
				url,
				nextAttemptAt: null,
			});
			expect(typeof row.providerWebhookId).toBe("string");
		}
		expect(h.providerFor).toHaveBeenCalledWith(ACCOUNT);
	});

	it("keeps all four Live kinds beside a VOD job on the same account", async () => {
		const h = harness();
		job(h.db, "job-1", "enc-1", "RUNNING");
		h.db.channels.push({ id: "ch-1", bitmovinAccountId: ACCOUNT });
		h.db.runs.push({
			id: "run-1",
			liveChannelId: "ch-1",
			bitmovinEncodingId: "enc-live",
			status: "RUNNING",
		});
		expect((await h.registrar.tick()).registered).toBe(7);
		expect(
			h.provider.created
				.filter((c) => c.encodingId === "enc-1")
				.map((c) => c.kind),
		).toEqual(VOD_KINDS);
		expect(
			h.provider.created
				.filter((c) => c.encodingId === "enc-live")
				.map((c) => c.kind),
		).toEqual([...WEBHOOK_REGISTRATION_KINDS]);
	});

	it("preserves a legacy FAILED VOD liveManifestReady row without retrying it, including a manual re-register", async () => {
		const h = harness();
		job(h.db, "job-1", "enc-1", "RUNNING");
		const legacy: Row = {
			id: "legacy-vod-live-kind",
			encodingId: "enc-1",
			encodingJobId: "job-1",
			liveChannelRunId: null,
			bitmovinAccountId: ACCOUNT,
			scope: "j",
			kind: "liveManifestReady",
			status: "FAILED",
			providerWebhookId: null,
			note: "historical provider 409",
			attempts: 2,
			nextAttemptAt: new Date(T0.getTime() - 1),
			claimedUntil: null,
		};
		h.db.registrations.push(legacy);
		expect((await h.registrar.tick()).registered).toBe(3);
		expect(legacy).toMatchObject({
			status: "FAILED",
			note: "historical provider 409",
			attempts: 2,
			providerWebhookId: null,
		});
		h.advance(61_000);
		h.db.settings.set(WEBHOOK_RECONCILE_REQUEST_KEY, {
			requestedAt: "2026-09-02T09:01:01.000Z",
		});
		expect((await h.registrar.tick()).registered).toBe(0);
		expect(h.provider.created.map((c) => c.kind)).toEqual(VOD_KINDS);
		expect(legacy).toMatchObject({
			status: "FAILED",
			note: "historical provider 409",
			attempts: 2,
			providerWebhookId: null,
		});
		expect(h.provider.removed).toHaveLength(0);
	});

	it("is idempotent: a second tick (a second start of the same encoding) creates nothing new", async () => {
		const h = harness();
		job(h.db, "job-1", "enc-1", "RUNNING");
		await h.registrar.tick();
		const stats = await h.registrar.tick();
		expect(stats.registered).toBe(0);
		expect(h.provider.created).toHaveLength(3);
		expect(h.db.registrations).toHaveLength(3);
	});

	it("ignores jobs without an encoding id, terminal jobs, and jobs without an account", async () => {
		const h = harness();
		job(h.db, "job-no-id", null, "RUNNING");
		job(h.db, "job-done", "enc-done", "FINISHED");
		h.db.jobs.push({
			id: "job-no-acct",
			bitmovinEncodingId: "enc-x",
			bitmovinAccountId: null,
			status: "RUNNING",
		});
		const stats = await h.registrar.tick();
		expect(stats.registered).toBe(0);
		expect(h.provider.created).toHaveLength(0);
	});

	it("registers a live run through its channel's account, and provider-error rows become FAILED with backoff, retried later", async () => {
		const h = harness();
		h.db.channels.push({ id: "ch-1", bitmovinAccountId: ACCOUNT_B });
		h.db.runs.push({
			id: "run-1",
			liveChannelId: "ch-1",
			bitmovinEncodingId: "enc-live",
			status: "RUNNING",
		});
		h.provider.failCreate.add("enc-live/error");
		const first = await h.registrar.tick();
		expect(first).toMatchObject({ registered: 3, failed: 1 });
		expect(h.providerFor).toHaveBeenCalledWith(ACCOUNT_B);
		const failed = h.db.registrations.find((r) => r.kind === "error") as Row;
		expect(failed).toMatchObject({
			status: "FAILED",
			liveChannelRunId: "run-1",
			attempts: 1,
		});
		expect(failed.note).toBe("provider: registration failed");
		expect((failed.nextAttemptAt as Date).getTime()).toBe(
			T0.getTime() + 60_000,
		);
		// Inside the backoff window: not retried.
		h.provider.failCreate.clear();
		h.advance(30_000);
		expect((await h.registrar.tick()).registered).toBe(0);
		// Past it: retried with the SAME token as its ACTIVE siblings.
		h.advance(31_000);
		expect((await h.registrar.tick()).registered).toBe(1);
		const urls = new Set(h.db.registrations.map((r) => r.url));
		expect(urls.size).toBe(1);
		expect(h.db.registrations.every((r) => r.status === "ACTIVE")).toBe(true);
	});
});

describe("webhook registrar — provider exception confidentiality", () => {
	const canary = "SYNTHETIC_RECEIVER_SIGNATURE_CANARY";
	const nested = JSON.stringify({
		message: "HTTP 409",
		requestBody: JSON.stringify({
			url: `https://example.invalid/api/webhooks/bitmovin/j/${canary}`,
			signature: { type: "HMAC", key: canary },
		}),
	});

	it.each([
		new Error(nested),
		nested,
		{ toString: () => nested },
	])("does not persist or log provider create exceptions (case %#)", async (failure) => {
		const h = harness();
		job(h.db, "job-1", "enc-1", "RUNNING");
		h.provider.api.create = async () => {
			throw failure;
		};
		expect((await h.registrar.tick()).failed).toBe(3);
		expect(
			h.db.registrations.every(
				(r) => r.note === "provider: registration failed",
			),
		).toBe(true);
		expect(JSON.stringify(h.log.mock.calls)).not.toContain(canary);
	});

	it("does not coerce arbitrary thrown objects while recording failure", async () => {
		const h = harness();
		job(h.db, "job-1", "enc-1", "RUNNING");
		h.provider.api.create = async () => {
			throw {
				toString: () => {
					throw new Error(canary);
				},
			};
		};
		expect((await h.registrar.tick()).failed).toBe(3);
		expect(JSON.stringify(h.log.mock.calls)).not.toContain(canary);
	});

	it("preserves retry state but never stores or logs a delete exception", async () => {
		const h = harness();
		job(h.db, "job-1", "enc-1", "RUNNING");
		await h.registrar.tick();
		(h.db.jobs[0] as Row).status = "FINISHED";
		h.provider.api.remove = async () => {
			throw new Error(nested);
		};
		expect((await h.registrar.tick()).failed).toBe(3);
		expect(
			h.db.registrations.every(
				(r) =>
					r.note === "delete failed (terminal)" &&
					r.status === "ACTIVE" &&
					r.attempts === 1,
			),
		).toBe(true);
		expect(JSON.stringify(h.log.mock.calls)).not.toContain(canary);
	});
});

describe("webhook registrar — no public ingress", () => {
	it("records SKIPPED ingressUnavailable rows, calls the provider never, and registers once ingress appears", async () => {
		const h = harness(null);
		job(h.db, "job-1", "enc-1", "RUNNING");
		const stats = await h.registrar.tick();
		expect(stats).toMatchObject({ registered: 0, skipped: 3 });
		expect(h.provider.created).toHaveLength(0);
		expect(
			h.db.registrations.every(
				(r) => r.status === "SKIPPED" && r.note === "ingressUnavailable",
			),
		).toBe(true);
		// No churn: the second tick rewrites nothing.
		expect((await h.registrar.tick()).skipped).toBe(0);
		h.setIngress("https://b.trycloudflare.com");
		expect((await h.registrar.tick()).registered).toBe(3);
		expect(h.db.registrations.every((r) => r.status === "ACTIVE")).toBe(true);
	});
});

describe("webhook registrar — retire", () => {
	it("deletes at the provider and tombstones rows when the job reaches a terminal status", async () => {
		const h = harness();
		job(h.db, "job-1", "enc-1", "RUNNING");
		await h.registrar.tick();
		(h.db.jobs[0] as Row).status = "FINISHED";
		const stats = await h.registrar.tick();
		expect(stats.retired).toBe(3);
		expect(h.provider.removed.map((r) => r.kind).sort()).toEqual(
			[...VOD_KINDS].sort(),
		);
		expect(
			h.db.registrations.every(
				(r) => r.status === "DELETED" && r.note === "terminal",
			),
		).toBe(true);
		// Terminal rows are never re-created.
		expect((await h.registrar.tick()).registered).toBe(0);
	});

	it("retires a STOPPED run, and an orphan row whose job row was deleted (SetNull)", async () => {
		const h = harness();
		h.db.channels.push({ id: "ch-1", bitmovinAccountId: ACCOUNT });
		h.db.runs.push({
			id: "run-1",
			liveChannelId: "ch-1",
			bitmovinEncodingId: "enc-live",
			status: "RUNNING",
		});
		job(h.db, "job-1", "enc-1", "RUNNING");
		await h.registrar.tick();
		(h.db.runs[0] as Row).status = "STOPPED";
		// The job row vanished: FK SetNull leaves rows with no owner.
		h.db.jobs.length = 0;
		for (const r of h.db.registrations) {
			if (r.encodingJobId === "job-1") r.encodingJobId = null;
		}
		const stats = await h.registrar.tick();
		expect(stats.retired).toBe(7);
		expect(h.db.registrations.filter((r) => r.note === "orphan")).toHaveLength(
			3,
		);
		expect(
			h.db.registrations.filter((r) => r.note === "terminal"),
		).toHaveLength(4);
	});

	it("a provider delete failure keeps the row ACTIVE with a backoff and retries later", async () => {
		const h = harness();
		job(h.db, "job-1", "enc-1", "RUNNING");
		await h.registrar.tick();
		const target = h.db.registrations[0] as Row;
		h.provider.failRemove.add(target.providerWebhookId as string);
		(h.db.jobs[0] as Row).status = "ERROR";
		const stats = await h.registrar.tick();
		expect(stats).toMatchObject({ retired: 2, failed: 1 });
		expect(target.status).toBe("ACTIVE");
		expect(String(target.note)).toContain("delete failed (terminal)");
		h.provider.failRemove.clear();
		h.advance(30_000);
		expect((await h.registrar.tick()).retired).toBe(0);
		h.advance(31_000);
		expect((await h.registrar.tick()).retired).toBe(1);
		expect(target.status).toBe("DELETED");
	});

	it("prunes DELETED tombstones older than the TTL", async () => {
		const h = harness();
		job(h.db, "job-1", "enc-1", "RUNNING");
		await h.registrar.tick();
		(h.db.jobs[0] as Row).status = "FINISHED";
		await h.registrar.tick();
		h.advance(REGISTRATION_TOMBSTONE_TTL_MS + 1_000);
		const stats = await h.registrar.tick();
		expect(stats.pruned).toBe(3);
		expect(h.db.registrations).toHaveLength(0);
	});
});

describe("webhook registrar — re-registration", () => {
	it("on an ingress change: deletes the old-URL hooks and re-creates them under the new base with a NEW token", async () => {
		const h = harness("https://a.trycloudflare.com");
		job(h.db, "job-1", "enc-1", "RUNNING");
		await h.registrar.tick();
		const oldUrl = h.db.registrations[0]?.url as string;
		h.setIngress("https://b.trycloudflare.com");
		const stats = await h.registrar.tick();
		expect(stats).toMatchObject({ retired: 3, registered: 3 });
		expect(h.provider.removed).toHaveLength(3);
		expect(h.provider.created).toHaveLength(6);
		const rows = h.db.registrations;
		expect(rows).toHaveLength(3);
		expect(rows.every((r) => r.status === "ACTIVE")).toBe(true);
		const newUrl = rows[0]?.url as string;
		expect(newUrl.startsWith("https://b.trycloudflare.com/")).toBe(true);
		expect(tokenFromReceiverUrl(newUrl)).not.toBe(tokenFromReceiverUrl(oldUrl));
	});

	it("on a rotated master (keyId mismatch) rows are re-registered with keys of the new master", async () => {
		const h = harness();
		job(h.db, "job-1", "enc-1", "RUNNING");
		await h.registrar.tick();
		for (const r of h.db.registrations) r.keyId = "0000000000000000"; // an older master
		const stats = await h.registrar.tick();
		expect(stats).toMatchObject({ retired: 3, registered: 3 });
		expect(
			h.db.registrations.every((r) => r.keyId === webhookKeyId(MASTER)),
		).toBe(true);
	});

	it("losing the ingress does NOT retire ACTIVE hooks (they may come back), but new encodings are SKIPPED", async () => {
		const h = harness();
		job(h.db, "job-1", "enc-1", "RUNNING");
		await h.registrar.tick();
		h.setIngress(null);
		job(h.db, "job-2", "enc-2", "RUNNING");
		const stats = await h.registrar.tick();
		expect(stats).toMatchObject({ retired: 0, skipped: 3 });
		expect(
			h.db.registrations
				.filter((r) => r.encodingId === "enc-1")
				.every((r) => r.status === "ACTIVE"),
		).toBe(true);
	});

	it("honours the settings screen's re-register request: backoffs are cleared and the request is marked handled", async () => {
		const h = harness();
		job(h.db, "job-1", "enc-1", "RUNNING");
		h.provider.failCreate.add("enc-1/finished");
		await h.registrar.tick();
		h.provider.failCreate.clear();
		// Still backing off: nothing happens without the request.
		h.advance(5_000);
		expect((await h.registrar.tick()).registered).toBe(0);
		h.db.settings.set(WEBHOOK_RECONCILE_REQUEST_KEY, {
			requestedAt: "2026-09-02T09:00:05.000Z",
		});
		expect((await h.registrar.tick()).registered).toBe(1);
		expect(h.db.settings.get(WEBHOOK_RECONCILE_REQUEST_KEY)).toMatchObject({
			requestedAt: "2026-09-02T09:00:05.000Z",
			handledAt: "2026-09-02T09:00:05.000Z",
		});
		// The same request is not honoured twice.
		expect(h.log).toHaveBeenCalledTimes(2);
		await h.registrar.tick();
		expect(h.log).toHaveBeenCalledTimes(2);
	});
});

describe("webhook registrar — budget and claims", () => {
	it("spends at most maxProviderCallsPerTick calls and reports the exhaustion", async () => {
		const db = fakeDb();
		db.settings.set(
			INGRESS_SETTING_KEY,
			ingress("https://a.trycloudflare.com"),
		);
		const provider = fakeProvider();
		const registrar = createWebhookRegistrar({
			prisma: db.prisma,
			cipher: new AesGcmCipher(randomBytes(32)),
			envSecret: MASTER,
			providerFor: async () => provider.api,
			now: () => T0,
			log: () => {},
			maxProviderCallsPerTick: 5,
		});
		job(db, "job-1", "enc-1", "RUNNING");
		job(db, "job-2", "enc-2", "RUNNING");
		const first = await registrar.tick();
		expect(first).toMatchObject({ registered: 5, budgetExhausted: true });
		const second = await registrar.tick();
		expect(second).toMatchObject({ registered: 1, budgetExhausted: false });
	});

	it("a row claimed by another worker (claimedUntil in the future) is left alone", async () => {
		const h = harness();
		job(h.db, "job-1", "enc-1", "RUNNING");
		await h.registrar.tick();
		(h.db.jobs[0] as Row).status = "FINISHED";
		for (const r of h.db.registrations)
			r.claimedUntil = new Date(T0.getTime() + 50_000);
		const stats = await h.registrar.tick();
		expect(stats.retired).toBe(0);
		expect(h.provider.removed).toHaveLength(0);
	});

	it("a Settings re-register clears BACKOFFS but never another worker's in-flight claim (claimedUntil) — no duplicate provider hook", async () => {
		const h = harness();
		job(h.db, "job-1", "enc-1", "RUNNING");
		h.provider.failCreate.add("enc-1/error");
		await h.registrar.tick();
		const failed = h.db.registrations.find((r) => r.kind === "error") as Row;
		expect(failed).toMatchObject({ status: "FAILED", attempts: 1 });
		// Another worker claimed the row for its own create, still in flight.
		failed.claimedUntil = new Date(T0.getTime() + 50_000);
		h.provider.failCreate.clear();
		h.db.settings.set(WEBHOOK_RECONCILE_REQUEST_KEY, {
			requestedAt: "2026-09-02T09:00:05.000Z",
		});
		const created = h.provider.created.length;
		const stats = await h.registrar.tick();
		// The backoff is gone, the claim is not: this worker registers nothing.
		expect(failed.nextAttemptAt).toBeNull();
		expect((failed.claimedUntil as Date).getTime()).toBe(T0.getTime() + 50_000);
		expect(stats.registered).toBe(0);
		expect(h.provider.created).toHaveLength(created);
		// Once the claim window passes the row is ours again.
		h.advance(51_000);
		expect((await h.registrar.tick()).registered).toBe(1);
		expect(failed).toMatchObject({ status: "ACTIVE", claimedUntil: null });
	});

	it("a claim LOST between the read and the CAS (updateMany matches nothing) makes no provider call", async () => {
		// The race the CAS exists for: another worker claimed the row after
		// this tick read it. The fake's updateMany reports 0 rows matched for
		// the claim, and the registrar must not delete/create on its behalf.
		const h = harness();
		job(h.db, "job-1", "enc-1", "RUNNING");
		await h.registrar.tick();
		(h.db.jobs[0] as Row).status = "FINISHED";
		const delegate = (
			h.db.prisma as unknown as {
				webhookRegistration: {
					updateMany: (args: Row) => Promise<{ count: number }>;
				};
			}
		).webhookRegistration;
		const realUpdateMany = delegate.updateMany;
		delegate.updateMany = async (args: Row) => {
			const where = args.where as Row;
			// Only the retire CLAIM (id + status ACTIVE + the AND of both windows) is lost.
			if (where.id && where.status === "ACTIVE" && Array.isArray(where.AND)) {
				return { count: 0 };
			}
			return realUpdateMany(args);
		};
		const stats = await h.registrar.tick();
		expect(stats.retired).toBe(0);
		expect(h.provider.removed).toHaveLength(0);
		expect(h.db.registrations.every((r) => r.status === "ACTIVE")).toBe(true);
	});
});

describe("webhook registrar — heartbeat event retention", () => {
	const HB = { intervalS: 1, idleMs: 60 * 60_000 };
	it("prunes heartbeat WebhookEvent rows past the 7-day retention, oldest first, ≤ 500 per tick, and never a delivery or a fresh heartbeat (rev414 R4)", async () => {
		const h = harness("https://a.trycloudflare.com", HB);
		const old = new Date(T0.getTime() - HEARTBEAT_EVENT_RETENTION_MS - 1_000);
		for (let i = 0; i < 3; i += 1) {
			h.db.events.push({
				id: `hb-old-${i}`,
				eventType: "LIVE_ENCODING_HEARTBEAT",
				receivedAt: new Date(old.getTime() - i * 1_000),
			});
		}
		h.db.events.push({
			id: "hb-fresh",
			eventType: "LIVE_ENCODING_HEARTBEAT",
			receivedAt: new Date(T0.getTime() - 60_000),
		});
		h.db.events.push({
			id: "finished-old",
			eventType: "ENCODING_FINISHED",
			receivedAt: old,
		});
		const stats = await h.registrar.tick();
		expect(stats.heartbeatEventsPruned).toBe(3);
		expect(h.db.events.map((e) => e.id).sort()).toEqual([
			"finished-old",
			"hb-fresh",
		]);
		// Nothing left past the TTL: the next tick prunes 0.
		expect((await h.registrar.tick()).heartbeatEventsPruned).toBe(0);
	});
});

describe("webhook registrar — rev412: the wirings the first round left unobserved", () => {
	type Delegate = {
		webhookRegistration: {
			updateMany: (args: Row) => Promise<{ count: number }>;
		};
	};

	it("a REGISTER claim lost between the read and the CAS makes no provider call and leaves the row un-ACTIVE (rev412 R1)", async () => {
		// The onChange tick can start while the 10 s tick is mid-register; the
		// second tick's row snapshot predates the first's claim, so the CAS on
		// the register path is the only thing stopping a duplicate create.
		const h = harness();
		job(h.db, "job-1", "enc-1", "RUNNING");
		const delegate = (h.db.prisma as unknown as Delegate).webhookRegistration;
		const realUpdateMany = delegate.updateMany;
		delegate.updateMany = async (args: Row) => {
			const where = args.where as Row;
			const status = where.status as Row | undefined;
			// Only the register CLAIM (encodingId + kind + status in [...]) is lost.
			if (where.encodingId && where.kind && status && "in" in status) {
				return { count: 0 };
			}
			return realUpdateMany(args);
		};
		const stats = await h.registrar.tick();
		expect(stats.registered).toBe(0);
		expect(h.provider.created).toHaveLength(0);
		expect(h.db.registrations.length).toBeGreaterThan(0);
		expect(h.db.registrations.every((r) => r.status !== "ACTIVE")).toBe(true);
	});

	it("a create that keeps failing backs off EXPONENTIALLY: attempts 2 waits 120 s after the second failure (rev412 R2)", async () => {
		const h = harness();
		h.db.channels.push({ id: "ch-1", bitmovinAccountId: ACCOUNT_B });
		h.db.runs.push({
			id: "run-1",
			liveChannelId: "ch-1",
			bitmovinEncodingId: "enc-live",
			status: "RUNNING",
		});
		h.provider.failCreate.add("enc-live/error");
		await h.registrar.tick();
		const failed = h.db.registrations.find((r) => r.kind === "error") as Row;
		expect(failed).toMatchObject({ status: "FAILED", attempts: 1 });
		expect((failed.nextAttemptAt as Date).getTime()).toBe(
			T0.getTime() + 60_000,
		);
		// Still failing past the first window: the SECOND failure doubles the wait.
		h.advance(61_000);
		const second = await h.registrar.tick();
		expect(second.failed).toBe(1);
		expect(failed).toMatchObject({ status: "FAILED", attempts: 2 });
		expect((failed.nextAttemptAt as Date).getTime()).toBe(
			T0.getTime() + 61_000 + 120_000,
		);
	});

	it("a delete that keeps failing backs off EXPONENTIALLY too (the retire twin, rev412 R2)", async () => {
		const h = harness();
		job(h.db, "job-1", "enc-1", "RUNNING");
		await h.registrar.tick();
		const target = h.db.registrations[0] as Row;
		h.provider.failRemove.add(target.providerWebhookId as string);
		(h.db.jobs[0] as Row).status = "ERROR";
		await h.registrar.tick();
		expect(target).toMatchObject({ status: "ACTIVE", attempts: 1 });
		expect((target.nextAttemptAt as Date).getTime()).toBe(
			T0.getTime() + 60_000,
		);
		h.advance(61_000);
		const second = await h.registrar.tick();
		expect(second.failed).toBe(1);
		expect(target).toMatchObject({ status: "ACTIVE", attempts: 2 });
		expect((target.nextAttemptAt as Date).getTime()).toBe(
			T0.getTime() + 61_000 + 120_000,
		);
	});

	it("does NOT prune a tombstone one second before the TTL (rev412 optional)", async () => {
		const h = harness();
		job(h.db, "job-1", "enc-1", "RUNNING");
		await h.registrar.tick();
		(h.db.jobs[0] as Row).status = "FINISHED";
		await h.registrar.tick();
		h.advance(REGISTRATION_TOMBSTONE_TTL_MS - 1_000);
		expect((await h.registrar.tick()).pruned).toBe(0);
		expect(h.db.registrations).toHaveLength(3);
	});

	it("REGISTRABLE ∪ TERMINAL ∪ {DRAFT} is exactly the EncodingJobStatus enum of the schema — a new status cannot be silently neither (rev412 optional)", () => {
		// @bitovp/db exports the generated client as types only, so the
		// population is read from the schema the enum is generated from.
		const schema = readFileSync(
			new URL("../../../../packages/db/prisma/schema.prisma", import.meta.url),
			"utf8",
		);
		const block = /enum EncodingJobStatus \{([^}]*)\}/.exec(schema)?.[1] ?? "";
		const enumMembers = block
			.split("\n")
			.map((line) => line.trim().split(/\s+/)[0] ?? "")
			.filter((name) => /^[A-Z_]+$/.test(name))
			.sort();
		expect(enumMembers.length).toBeGreaterThan(3);
		expect(
			[...REGISTRABLE_JOB_STATUSES, ...TERMINAL_JOB_STATUSES, "DRAFT"].sort(),
		).toEqual(enumMembers);
	});
});

describe("claim windows — a claim that lands BETWEEN this worker's read and its CAS (rev415)", () => {
	type ReadHooks = {
		webhookRegistration: {
			findMany: (args: Row) => Promise<Row[]>;
			findUnique: (args: Row) => Promise<Row | null>;
		};
	};
	it("register: worker B's claimedUntil stamped after A's read makes A's CAS match nothing — no provider create until the window passes", async () => {
		const h = harness();
		job(h.db, "job-1", "enc-1", "RUNNING");
		for (const kind of VOD_KINDS) h.provider.failCreate.add(`enc-1/${kind}`);
		await h.registrar.tick();
		expect(
			h.db.registrations.filter((r) => r.status === "FAILED"),
		).toHaveLength(3);
		h.advance(61_000); // past the backoff
		h.provider.failCreate.clear();
		const delegate = (h.db.prisma as unknown as ReadHooks).webhookRegistration;
		const realFindMany = delegate.findMany;
		delegate.findMany = async (args: Row) => {
			const snapshot = await realFindMany(args); // A's stale snapshot (copies)
			// Only after the REGISTER read (`encodingId: { in }`), not the retire
			// read that opens the tick — a stamp before the register read would be
			// seen by the pre-read check and never reach the CAS.
			const where = args.where as { encodingId?: unknown } | undefined;
			if (where?.encodingId && typeof where.encodingId === "object") {
				for (const r of h.db.registrations)
					if (r.status === "FAILED")
						r.claimedUntil = new Date(T0.getTime() + 61_000 + 50_000); // B claims
			}
			return snapshot;
		};
		const stats = await h.registrar.tick();
		expect(stats.registered).toBe(0);
		expect(h.provider.created).toHaveLength(0);
		expect(h.db.registrations.every((r) => r.status === "FAILED")).toBe(true);
		delegate.findMany = realFindMany;
		h.advance(51_000); // B's window expired without a result: A may claim
		expect((await h.registrar.tick()).registered).toBe(3);
	});

	it("retire: the same stamp between read and CAS blocks the provider delete", async () => {
		const h = harness();
		job(h.db, "job-1", "enc-1", "RUNNING");
		await h.registrar.tick();
		(h.db.jobs[0] as Row).status = "FINISHED";
		const delegate = (h.db.prisma as unknown as ReadHooks).webhookRegistration;
		const realFindMany = delegate.findMany;
		delegate.findMany = async (args: Row) => {
			const snapshot = await realFindMany(args);
			for (const r of h.db.registrations)
				if (r.status === "ACTIVE")
					r.claimedUntil = new Date(T0.getTime() + 50_000);
			return snapshot;
		};
		const stats = await h.registrar.tick();
		expect(stats.retired).toBe(0);
		expect(h.provider.removed).toHaveLength(0);
		expect(h.db.registrations.every((r) => r.status === "ACTIVE")).toBe(true);
		delegate.findMany = realFindMany;
		h.advance(51_000);
		expect((await h.registrar.tick()).retired).toBe(3);
	});
});

describe("per-encoding only account retirement", () => {
	function running() {
		const h = harness("https://a.trycloudflare.com", {
			intervalS: 2,
			idleMs: 3600000,
		});
		h.db.channels.push({ id: "ch-old", bitmovinAccountId: ACCOUNT });
		h.db.runs.push({
			id: "run-old",
			liveChannelId: "ch-old",
			bitmovinEncodingId: "old-encoding",
			status: "RUNNING",
			createdAt: T0,
		});
		return h;
	}
	it("never creates an account hook even for a pre-rollout live run", async () => {
		const h = running();
		await h.registrar.tick();
		expect(h.provider.heartbeats).toHaveLength(0);
		expect(
			h.db.registrations.filter((r) =>
				String(r.encodingId).startsWith("account:"),
			),
		).toHaveLength(0);
	});
	it("retires the exact owned account registration while its legacy run is live", async () => {
		const h = running();
		const run = h.db.runs[0];
		if (!run) throw new Error("missing run");
		run.id = "00000000-0000-4000-8000-000000000091";
		const legacyConfiguration = {
			v: 1,
			mode: "LEGACY_ACCOUNT",
			requestedEncoderVersion: "BETA",
			resolvedEncoderVersion: "2.285.0",
			intervalS: 5,
			registrationId: "00000000-0000-4000-8000-000000000092",
			channelId: "00000000-0000-4000-8000-000000000093",
			runId: run.id,
			createAttempted: false,
		};
		const legacy = {
			id: "historical-intent",
			scope: "hb",
			kind: HEARTBEAT_WEBHOOK_KIND,
			encodingId: "old-encoding",
			bitmovinAccountId: ACCOUNT,
			liveChannelRunId: run.id,
			status: "SKIPPED",
			configuration: legacyConfiguration,
			attempts: 0,
		};
		h.db.registrations.push(legacy);
		h.db.events.push({
			id: "signed-legacy-receipt",
			eventType: "LIVE_ENCODING_HEARTBEAT",
			signatureValid: true,
			liveChannelRunId: run.id,
			receivedAt: T0,
		});

		h.db.registrations.push({
			id: "owned-account",
			scope: "hb",
			kind: HEARTBEAT_WEBHOOK_KIND,
			encodingId: heartbeatRegistrationKey(ACCOUNT),
			bitmovinAccountId: ACCOUNT,
			status: "ACTIVE",
			providerWebhookId: "owned-old",
			url: "https://a.trycloudflare.com/api/webhooks/bitmovin/hb/old",
			keyId: webhookKeyId(MASTER),
			note: "interval 2s",
			attempts: 0,
		});
		await h.registrar.tick();
		expect(h.provider.removedHeartbeats).toEqual(["owned-old"]);
		expect(legacy.configuration).toEqual(legacyConfiguration);
		expect(h.db.events).toEqual([
			expect.objectContaining({
				id: "signed-legacy-receipt",
				liveChannelRunId: run.id,
			}),
		]);
		expect(h.provider.api.createEncodingHeartbeat).not.toHaveBeenCalled();
		expect(
			h.db.registrations.find((r) => r.id === "owned-account"),
		).toMatchObject({ status: "DELETED" });
		expect(h.provider.heartbeats).toHaveLength(0);
	});
	it.each([
		"ACTIVE",
		"FAILED",
		"SKIPPED",
	])("retries owned %s account DELETE without creating a replacement", async (status) => {
		const h = running();
		const row = {
			id: "owned-retry",
			scope: "hb",
			kind: HEARTBEAT_WEBHOOK_KIND,
			encodingId: heartbeatRegistrationKey(ACCOUNT),
			bitmovinAccountId: ACCOUNT,
			status,
			providerWebhookId: "owned-old",
			url: "https://a.trycloudflare.com/api/webhooks/bitmovin/hb/old",
			keyId: webhookKeyId(MASTER),
			note: "interval 2s",
			attempts: 0,
		};
		h.db.registrations.push(row);
		h.provider.failRemove.add("owned-old");
		expect((await h.registrar.tick()).failed).toBe(1);
		expect(row.status).toBe(status);
		expect(row.attempts).toBe(1);
		h.provider.failRemove.clear();
		h.advance(30000);
		await h.registrar.tick();
		expect(h.provider.removedHeartbeats).toEqual([]);
		h.advance(31000);
		await h.registrar.tick();
		expect(h.provider.removedHeartbeats).toEqual(["owned-old"]);
		expect(row.status).toBe("DELETED");
		expect(h.provider.heartbeats).toHaveLength(0);
	});
	it("honors an existing account deletion claim and leaves unrelated provider hooks alone", async () => {
		const h = running();
		const row = {
			id: "held",
			scope: "hb",
			kind: HEARTBEAT_WEBHOOK_KIND,
			encodingId: heartbeatRegistrationKey(ACCOUNT),
			bitmovinAccountId: ACCOUNT,
			status: "ACTIVE",
			providerWebhookId: "owned-old",
			claimedUntil: new Date(T0.getTime() + 50000),
			attempts: 0,
		};
		h.db.registrations.push(row);
		await h.registrar.tick();
		expect(h.provider.removedHeartbeats).toEqual([]);
		h.advance(51000);
		await h.registrar.tick();
		expect(h.provider.removedHeartbeats).toEqual(["owned-old"]);
		expect(h.provider.api.listEncodingHeartbeats).not.toHaveBeenCalled();
		expect(h.provider.heartbeats).toHaveLength(0);
	});
});
