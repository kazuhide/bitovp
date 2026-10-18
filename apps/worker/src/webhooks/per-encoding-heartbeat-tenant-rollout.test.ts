import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	deriveWebhookKey,
	hashWebhookToken,
	parseHeartbeatRegistrationConfig,
} from "@bitovp/core";
import { TENANT_ORGANIZATION } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import {
	contextualTenantPrisma,
	requireOrganizationId,
	runInOrganization,
} from "../tenant/scope";
import {
	type EncodingHeartbeatPayload,
	reconcilePerEncodingHeartbeats,
} from "./per-encoding-heartbeat";
import { fakeDb } from "./registrar-test-db";

const key = "live:heartbeat-per-encoding-rollout";
const orgA = "00000000-0000-4000-8000-000000000001";
const orgB = "00000000-0000-4000-8000-000000000002";
const at = new Date("2026-10-06T10:00:00Z");
function fixture(label: string, createdAt = at) {
	const db = fakeDb();
	const channelId = randomUUID();
	const runId = randomUUID();
	db.channels.push({
		id: channelId,
		bitmovinAccountId: `account-${label}`,
		plan: { bitmovin: { encoderVersion: "2.285.0" } },
	});
	db.runs.push({
		id: runId,
		liveChannelId: channelId,
		bitmovinEncodingId: `enc-${label}`,
		status: "RUNNING",
		createdAt,
	});
	const payloads: EncodingHeartbeatPayload[] = [];
	const api = {
		getHeartbeatEncodingVersion: vi.fn(async () => ({
			requested: "2.285.0",
			resolved: "2.285.0",
		})),
		listEncodingHeartbeats: vi.fn(async () => []),
		getEncodingHeartbeatCustomData: vi.fn(async () => null),
		createEncodingHeartbeat: vi.fn(
			async (_encoding: string, payload: EncodingHeartbeatPayload) => {
				payloads.push(payload);
				return { id: `hook-${label}` };
			},
		),
		removeEncodingHeartbeat: vi.fn(async () => {}),
	};
	const stats = { registered: 0, skipped: 0, failed: 0, retired: 0 };
	const tick = (
		rolloutEnabledAt?: () => Promise<Date | null>,
		heartbeat: { intervalS: number } | null = { intervalS: 2 },
		prisma = db.prisma,
	) =>
		reconcilePerEncodingHeartbeats({
			prisma,
			at,
			heartbeat,
			rolloutEnabledAt,
			ingressBase: "https://ingress.invalid",
			masterSecret: "test-master",
			keyId: "test-key",
			providerFor: async () => api,
			spend: () => true,
			stats,
		});
	return { db, api, payloads, tick, runId, channelId };
}

describe("tenant per-encoding heartbeat rollout initialization", () => {
	it("seeds fresh tenant A and B from their own creation times and preserves exact signed binding", async () => {
		const a = fixture("a");
		const b = fixture("b");
		const clients = new Map([
			[orgA, a.db.prisma],
			[orgB, b.db.prisma],
		]);
		const dates = new Map([
			[orgA, new Date("2026-10-04T10:00:00Z")],
			[orgB, new Date("2026-10-05T10:00:00Z")],
		]);
		const prisma = contextualTenantPrisma((id) => {
			const client = clients.get(id);
			assert(client);
			return client;
		}, TENANT_ORGANIZATION);
		const resolve = vi.fn(
			async () => dates.get(requireOrganizationId()) ?? null,
		);
		await runInOrganization(orgA, () =>
			a.tick(resolve, { intervalS: 2 }, prisma),
		);
		await runInOrganization(orgB, () =>
			b.tick(resolve, { intervalS: 2 }, prisma),
		);
		for (const [org, label, f] of [
			[orgA, "a", a],
			[orgB, "b", b],
		] as const) {
			const createdAt = dates.get(org);
			assert(createdAt);
			expect(f.db.settings.get(key)).toEqual({
				enabledAt: createdAt.toISOString(),
			});
			expect(f.api.createEncodingHeartbeat).toHaveBeenCalledOnce();
			const firstCall = f.api.createEncodingHeartbeat.mock.calls[0];
			assert(firstCall);
			expect(firstCall[0]).toBe(`enc-${label}`);
			const row = f.db.registrations[0];
			assert(row);
			expect(row.liveChannelRunId).toBe(f.runId);
			const config = parseHeartbeatRegistrationConfig(row.configuration);
			assert(config);
			expect(config).toMatchObject({
				channelId: f.channelId,
				runId: f.runId,
				intervalS: 2,
				mode: "PER_ENCODING",
			});
			const payload = f.payloads[0];
			assert(payload);
			const token = new URL(payload.url).pathname.split("/").at(-1);
			assert(token);
			expect(payload.signature).toEqual({
				type: "HMAC",
				key: deriveWebhookKey("test-master", token),
			});
			expect(row.tokenHash).toBe(hashWebhookToken(token));
			expect(payload.customData).toMatchObject({
				bitOvp: {
					channelId: f.channelId,
					runId: f.runId,
					registrationId: config.registrationId,
				},
			});
		}
		expect(a.db.settings.get(key)).not.toEqual(b.db.settings.get(key));
		const aPayload = a.payloads[0];
		const bPayload = b.payloads[0];
		assert(aPayload && bPayload);
		expect(aPayload.url).not.toBe(bPayload.url);
	});
	it("leaves a pre-organization legacy airing excluded", async () => {
		const f = fixture("legacy", new Date("2026-09-15T10:00:00Z"));
		await f.tick(async () => new Date("2026-10-04T10:00:00Z"));
		expect(f.db.settings.get(key)).toEqual({
			enabledAt: "2026-10-04T10:00:00.000Z",
		});
		expect(f.db.registrations).toEqual([]);
		expect(f.api.createEncodingHeartbeat).not.toHaveBeenCalled();
	});
	it.each([
		{ enabledAt: "2026-10-07T10:00:00Z" },
		{ enabledAt: "invalid" },
	])("preserves an existing cutoff without broadening eligibility: %j", async (value) => {
		const f = fixture("existing");
		f.db.settings.set(key, value);
		const resolve = vi.fn(async () => new Date("2026-10-04T10:00:00Z"));
		await f.tick(resolve);
		expect(resolve).not.toHaveBeenCalled();
		expect(f.db.settings.get(key)).toEqual(value);
		expect(f.api.createEncodingHeartbeat).not.toHaveBeenCalled();
	});
	it("does not initialize when heartbeat is disabled or organization metadata is missing", async () => {
		const disabled = fixture("disabled");
		const resolve = vi.fn(async () => at);
		await disabled.tick(resolve, null);
		expect(resolve).not.toHaveBeenCalled();
		expect(disabled.db.settings.has(key)).toBe(false);
		const missing = fixture("missing");
		await missing.tick(async () => null);
		expect(missing.db.settings.has(key)).toBe(false);
		expect(missing.api.createEncodingHeartbeat).not.toHaveBeenCalled();
	});
	it("honors the persisted winner after a concurrent unique conflict", async () => {
		const f = fixture("race");
		f.db.prisma.appSetting.create = vi.fn(async () => {
			f.db.settings.set(key, { enabledAt: "2026-10-07T10:00:00Z" });
			throw Object.assign(new Error("concurrent"), { code: "P2002" });
		}) as never;
		await f.tick(async () => new Date("2026-10-04T10:00:00Z"));
		expect(f.db.settings.get(key)).toEqual({
			enabledAt: "2026-10-07T10:00:00Z",
		});
		expect(f.api.createEncodingHeartbeat).not.toHaveBeenCalled();
	});
	it("does not bypass a non-unique initialization failure", async () => {
		const f = fixture("db-failure");
		f.db.prisma.appSetting.create = vi.fn(async () => {
			throw new Error("database unavailable");
		}) as never;
		await expect(f.tick(async () => at)).rejects.toThrow(
			"database unavailable",
		);
		expect(f.api.createEncodingHeartbeat).not.toHaveBeenCalled();
	});
});
