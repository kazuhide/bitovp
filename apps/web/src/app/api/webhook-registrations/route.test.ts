import { WEBHOOK_RECONCILE_REQUEST_KEY } from "@bitovp/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const upsert = vi.fn();
let ingressBase: string | null = "https://a.trycloudflare.com";
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			webhookRegistration: { findMany },
			appSetting: {
				upsert,
				findUnique: async () =>
					ingressBase === null
						? null
						: {
								value: {
									v: 1,
									mode: "quick-tunnel",
									current: {
										baseUrl: ingressBase,
										source: "cloudflared-quicktunnel",
										observedAt: "2026-09-02T09:00:00.000Z",
									},
									checkedAt: "2026-09-02T09:00:30.000Z",
								},
							},
			},
		},
	}),
}));

import { POST as reconcile } from "./reconcile/route";
import { GET } from "./route";

const T = new Date("2026-09-02T09:00:00.000Z");
const TOKEN_URL = (base: string) =>
	`${base}/api/webhooks/bitmovin/j/AAAAAAAAAAAAAAAAAAAAAA`;

beforeEach(() => {
	vi.clearAllMocks();
	ingressBase = "https://a.trycloudflare.com";
	findMany.mockResolvedValue([
		{
			id: "reg-1",
			scope: "j",
			encodingId: "enc-1",
			kind: "finished",
			status: "ACTIVE",
			url: TOKEN_URL("https://a.trycloudflare.com"),
			note: null,
			attempts: 0,
			nextAttemptAt: null,
			registeredAt: T,
			deletedAt: null,
			lastDeliveryAt: T,
			updatedAt: T,
			encodingJobId: "job-1",
			liveChannelRunId: null,
			encodingJob: { name: "Promo 30s", status: "RUNNING" },
			liveChannelRun: null,
		},
		{
			id: "reg-2",
			scope: "j",
			encodingId: "enc-2",
			kind: "error",
			status: "ACTIVE",
			url: TOKEN_URL("https://old.trycloudflare.com"),
			note: null,
			attempts: 0,
			nextAttemptAt: null,
			registeredAt: T,
			deletedAt: null,
			lastDeliveryAt: null,
			updatedAt: T,
			encodingJobId: null,
			liveChannelRunId: "run-1",
			encodingJob: null,
			liveChannelRun: {
				seq: 3,
				status: "RUNNING",
				liveChannel: { id: "ch-1", name: "News" },
			},
		},
		{
			id: "reg-3",
			scope: "j",
			encodingId: "enc-3",
			kind: "finished",
			status: "SKIPPED",
			url: null,
			note: "ingressUnavailable",
			attempts: 0,
			nextAttemptAt: null,
			registeredAt: null,
			deletedAt: null,
			lastDeliveryAt: null,
			updatedAt: T,
			encodingJobId: null,
			liveChannelRunId: null,
			encodingJob: null,
			liveChannelRun: null,
		},
	]);
	upsert.mockResolvedValue({});
});

describe("GET /api/webhook-registrations", () => {
	it.each([
		'provider: {"requestBody":"{\\"signature\\":{\\"key\\":\\"SYNTHETIC_SECRET_CANARY\\"}}"}',
		"delete failed (terminal): https://example.invalid/api/webhooks/bitmovin/j/SYNTHETIC_SECRET_CANARY",
		"SYNTHETIC_SECRET_CANARY",
		"ingressUnavailable\nSYNTHETIC_SECRET_CANARY",
		"interval 20s\nSYNTHETIC_SECRET_CANARY",
		"interval 20s\n",
		"perEncodingOnly\nSYNTHETIC_SECRET_CANARY",
		"delete failed (perEncodingOnly): SYNTHETIC_SECRET_CANARY",
	])("fails closed for untrusted legacy notes (case %#)", async (note) => {
		const rows = await findMany();
		rows[0].note = note;
		findMany.mockResolvedValue(rows);
		const body = await (await GET()).json();
		expect(body.rows[0].note).toBe("details withheld");
		expect(JSON.stringify(body)).not.toContain("SYNTHETIC_SECRET_CANARY");
	});

	it.each([
		null,
		"pending",
		"ingressUnavailable",
		"terminal",
		"orphan",
		"ingressChanged",
		"keyRotated",
		"idle",
		"intervalChanged",
		"perEncodingOnly",
		"delete failed (perEncodingOnly)",
		"interval 20s",
		"provider: registration failed",
		"delete failed (terminal)",
		"heartbeat: slots",
		"heartbeat: ambiguous",
		"heartbeat: provider",
		"heartbeat: budget",
		"heartbeat: unresolved create cleanup",
		"PENDING_VERSION",
		"POLL_ONLY",
		"PER_ENCODING",
		"LEGACY_ACCOUNT",
	])("retains a known non-secret registrar note: %s", async (note) => {
		const rows = await findMany();
		rows[0].note = note;
		findMany.mockResolvedValue(rows);
		const body = await (await GET()).json();
		expect(body.rows[0].note).toBe(note);
	});

	it("projects each row with its subject and whether its URL matches the CURRENT ingress", async () => {
		const res = await GET();
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			currentBase: string | null;
			rows: Record<string, unknown>[];
		};
		expect(body.currentBase).toBe("https://a.trycloudflare.com");
		expect(body.rows).toHaveLength(3);
		expect(body.rows[0]).toMatchObject({
			id: "reg-1",
			kind: "finished",
			status: "ACTIVE",
			urlMatchesIngress: true,
			subject: {
				kind: "job",
				id: "job-1",
				name: "Promo 30s",
				status: "RUNNING",
			},
		});
		expect(body.rows[1]).toMatchObject({
			id: "reg-2",
			urlMatchesIngress: false,
			subject: {
				kind: "run",
				id: "run-1",
				name: "News",
				channelId: "ch-1",
				seq: 3,
			},
		});
		expect(body.rows[2]).toMatchObject({
			status: "SKIPPED",
			note: "ingressUnavailable",
			urlMatchesIngress: false,
			subject: null,
		});
		// Bounded (C6's spirit): never an unbounded findMany.
		// rev413: the raw per-encoding token never reaches a reader — the wire
		// carries the base + scope with the token masked.
		expect(JSON.stringify(body)).not.toContain("AAAAAAAAAAAAAAAAAAAAAA");
		expect((body.rows[0] as { url: string }).url).toBe(
			"https://a.trycloudflare.com/api/webhooks/bitmovin/j/<token>",
		);
		expect(findMany.mock.calls[0]?.[0]).toMatchObject({ take: 500 });
		// Nothing key-shaped is selected: the projection has no tokenHash/keyId.
		const select = findMany.mock.calls[0]?.[0]?.select as Record<
			string,
			unknown
		>;
		expect(select.tokenHash).toBeUndefined();
		expect(select.keyId).toBeUndefined();
	});

	it("with no ingress, every row reads as not matching", async () => {
		ingressBase = null;
		const body = (await (await GET()).json()) as {
			currentBase: string | null;
			rows: { urlMatchesIngress: boolean }[];
		};
		expect(body.currentBase).toBeNull();
		expect(body.rows.every((r) => r.urlMatchesIngress === false)).toBe(true);
	});
});

describe("POST /api/webhook-registrations/reconcile", () => {
	it("records a timestamped request the worker's registrar honours — no provider call here", async () => {
		const res = await reconcile();
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			requestedAt: string;
			appliesWithinMs: number;
		};
		expect(body.appliesWithinMs).toBe(10_000);
		expect(upsert).toHaveBeenCalledWith({
			where: { key: WEBHOOK_RECONCILE_REQUEST_KEY },
			create: {
				key: WEBHOOK_RECONCILE_REQUEST_KEY,
				value: { requestedAt: body.requestedAt },
			},
			update: { value: { requestedAt: body.requestedAt } },
		});
	});
});
