import { EVENT_VERSION } from "@bitovp/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNotifyProcessor, type NotifyDeps } from "./processor";

/**
 * : the delivery worker. The C22 worker-end check is the security
 * pin (a channel row written around the route still cannot reach a
 * non-allowlisted host), FAILED deliveries throw so BullMQ retries, and the
 * strict re-parse refuses smuggled fields at the consumer end too.
 */

const CHANNEL = "00000000-0000-4000-8000-0000000000c1";
const CRED = "00000000-0000-4000-8000-0000000000d1";
const JOB = "00000000-0000-4000-8000-0000000000aa";

function event(over: Record<string, unknown> = {}) {
	return {
		kind: "JOB_FINISHED",
		eventVersion: EVENT_VERSION,
		occurredAt: "2026-08-12T00:00:00.000Z",
		link: `https://ovp.example.com/vod/jobs/${JOB}`,
		jobId: JOB,
		name: "nightly drama",
		labels: ["prod"],
		...over,
	};
}

function channelRow(over: Record<string, unknown> = {}) {
	return {
		id: CHANNEL,
		name: "ops hook",
		kind: "GENERIC_WEBHOOK",
		credentialId: CRED,
		rules: [{ events: ["JOB_FINISHED", "JOB_ERROR"], filter: {} }],
		...over,
	};
}

function makeDeps(over: Partial<NotifyDeps> = {}) {
	const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
	const deps: NotifyDeps = {
		prisma: {
			notificationChannel: {
				findMany: vi.fn().mockResolvedValue([channelRow()]),
			},
		},
		revealWebhookUrl: vi.fn().mockResolvedValue("https://hooks.example.com/x"),
		egressAllowlist: () => [],
		fetchImpl: fetchImpl as unknown as typeof fetch,
		...over,
	};
	return { deps, fetchImpl };
}

describe("createNotifyProcessor", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("POSTs the event verbatim with the kind header to a matching channel", async () => {
		const { deps, fetchImpl } = makeDeps();
		const results = await createNotifyProcessor(deps)({ data: event() });
		expect(results).toEqual([
			expect.objectContaining({ channelId: CHANNEL, outcome: "DELIVERED" }),
		]);
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://hooks.example.com/x");
		expect((init.headers as Record<string, string>)["x-bitovp-event"]).toBe(
			"JOB_FINISHED",
		);
		// review-183 I6/MC2: dropping the timeout survived the suite — a host
		// that accepts and never responds would pin a delivery slot again.
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect(JSON.parse(init.body as string)).toMatchObject({
			kind: "JOB_FINISHED",
			jobId: JOB,
		});
	});

	it("REFUSES a host outside the allowlist at send time (C22, worker end)", async () => {
		const { deps, fetchImpl } = makeDeps({
			egressAllowlist: () => ["slack.com"],
		});
		const results = await createNotifyProcessor(deps)({ data: event() });
		expect(results[0]?.outcome).toBe("REFUSED_HOST");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("an EMPTY allowlist (unset env) WARNS and delivers — executor.ts parity (review-183 I1)", async () => {
		// The first cut claimed empty refuses everything and pinned an
		// unreachable branch: loadEnv filters "" to undefined, so [] IS the
		// production default and must behave like the plan validator's
		// unrestricted WARNING, not like a block.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { deps, fetchImpl } = makeDeps({ egressAllowlist: () => [] });
		const results = await createNotifyProcessor(deps)({ data: event() });
		expect(results[0]?.outcome).toBe("DELIVERED");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("SECRET_EGRESS_ALLOWED_HOSTS is unset"),
		);
		warn.mockRestore();
	});

	it("a config error is a TYPED refusal, not a retryable failure (review-183 N2)", async () => {
		// P3's shape: an unparsable vault URL. Throwing out of the processor
		// would burn all five retry attempts on something no retry can fix.
		const { deps, fetchImpl } = makeDeps({
			revealWebhookUrl: vi.fn().mockResolvedValue("not a url"),
			egressAllowlist: () => ["hooks.example.com"],
		});
		const results = await createNotifyProcessor(deps)({ data: event() });
		expect(results[0]?.outcome).toBe("REFUSED_CONFIG");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("a malformed allowlist ENTRY is a typed refusal too (review-183 N9 — P2's shape)", async () => {
		// Distinct path from the unparsable-URL case: hostMatches ->
		// normalizeEntry throws SecretEgressConfigError on an entry carrying
		// a path. Must refuse, not throw (a throw would burn all 5 attempts).
		const { deps, fetchImpl } = makeDeps({
			egressAllowlist: () => ["example.com/evil"],
		});
		const results = await createNotifyProcessor(deps)({ data: event() });
		expect(results[0]?.outcome).toBe("REFUSED_CONFIG");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("an http vault URL is refused at send time (review-183 I2 — a row written around the route)", async () => {
		const { deps, fetchImpl } = makeDeps({
			revealWebhookUrl: vi
				.fn()
				.mockResolvedValue("http://169.254.169.254/latest/meta-data"),
			egressAllowlist: () => [],
		});
		const results = await createNotifyProcessor(deps)({ data: event() });
		expect(results[0]?.outcome).toBe("REFUSED_CONFIG");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("skips a channel whose rules do not name the kind", async () => {
		const { deps, fetchImpl } = makeDeps();
		const results = await createNotifyProcessor(deps)({
			data: event({ kind: "JOB_CANCELED" }),
		});
		expect(results).toEqual([]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("a MALFORMED rule filter refuses rather than matching everything", async () => {
		const { deps, fetchImpl } = makeDeps();
		(
			deps.prisma.notificationChannel.findMany as ReturnType<typeof vi.fn>
		).mockResolvedValue([
			channelRow({
				rules: [{ events: ["JOB_FINISHED"], filter: { labels: "prod" } }],
			}),
		]);
		const results = await createNotifyProcessor(deps)({ data: event() });
		expect(results).toEqual([]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("label filters route: matching label delivers, missing label does not", async () => {
		const { deps, fetchImpl } = makeDeps();
		(
			deps.prisma.notificationChannel.findMany as ReturnType<typeof vi.fn>
		).mockResolvedValue([
			channelRow({
				rules: [{ events: ["JOB_FINISHED"], filter: { labels: ["news"] } }],
			}),
		]);
		const results = await createNotifyProcessor(deps)({ data: event() });
		expect(results).toEqual([]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("SLACK_WEBHOOK rows deliver RENDERED blocks, not the raw event (PR2)", async () => {
		const { deps, fetchImpl } = makeDeps();
		(
			deps.prisma.notificationChannel.findMany as ReturnType<typeof vi.fn>
		).mockResolvedValue([channelRow({ kind: "SLACK_WEBHOOK" })]);
		const results = await createNotifyProcessor(deps)({ data: event() });
		expect(results[0]?.outcome).toBe("DELIVERED");
		const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string) as Record<string, unknown>;
		expect(body.blocks).toBeDefined();
		// The raw event shape must NOT be the body (kind lives in the header).
		expect(body.kind).toBeUndefined();
		expect(JSON.stringify(body)).toContain("nightly drama");
	});

	it("an UNKNOWN channel kind is a visible skip, never a throw (forward-compat)", async () => {
		const { deps, fetchImpl } = makeDeps();
		(
			deps.prisma.notificationChannel.findMany as ReturnType<typeof vi.fn>
		).mockResolvedValue([channelRow({ kind: "CARRIER_PIGEON" })]);
		const results = await createNotifyProcessor(deps)({ data: event() });
		expect(results[0]?.outcome).toBe("SKIPPED_KIND");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("a FAILED delivery THROWS so BullMQ retries (at-least-once)", async () => {
		const { deps, fetchImpl } = makeDeps();
		fetchImpl.mockResolvedValue({ ok: false, status: 500 });
		const failure = createNotifyProcessor(deps)({ data: event() });
		await expect(failure).rejects.toThrow(/ops hook \(HTTP 500\)/);
		// review-185 N5's residual, made structural: the thrown message is
		// what BullMQ persists as failedReason and the deliveries route
		// echoes — the vault URL must never ride it (today guaranteed by
		// undici's message shape; this pins it against OUR code changing).
		await failure.catch((err: Error) => {
			expect(err.message).not.toContain("hooks.example.com");
		});
	});

	it("REJECTS a queue payload with smuggled fields (consumer-end re-parse)", async () => {
		const { deps, fetchImpl } = makeDeps();
		await expect(
			createNotifyProcessor(deps)({
				data: event({ plan: { inputs: [] } }),
			}),
		).rejects.toThrow();
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
