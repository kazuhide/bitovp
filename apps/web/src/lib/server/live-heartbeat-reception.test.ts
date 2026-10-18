import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import {
	bindHeartbeatRun,
	readHeartbeatReception,
} from "./live-heartbeat-reception";

const encodingId = "525a5c3b-7116-448e-ad00-4830a509b709";
const webhookId = "0a704021-a067-12b7-81a0-7aa96ede7789";
const configuration = {
	v: 1,
	mode: "PER_ENCODING",
	requestedEncoderVersion: "BETA",
	resolvedEncoderVersion: "2.285.0",
	intervalS: 5,
	createAttempted: true,
	registrationId: "11111111-1111-4111-8111-111111111111",
	channelId: "22222222-2222-4222-8222-222222222222",
	runId: "33333333-3333-4333-8333-333333333333",
};
const customData = {
	bitOvp: {
		v: 1,
		registrationId: configuration.registrationId,
		channelId: configuration.channelId,
		runId: configuration.runId,
	},
};
const run = {
	id: "run-1",
	bitmovinEncodingId: encodingId,
	createdAt: new Date("2026-09-07T07:00:00Z"),
};
const packet = (sampledAt = "2026-09-07T07:04:00Z") => ({
	eventType: "LIVE_ENCODING_HEARTBEAT",
	webhookId,
	encoding: { id: encodingId },
	value: {
		timestamp: sampledAt,
		ingest: {
			status: "CONNECTED",
			healthy: true,
			rtmpUserIngestInfo: { streamKey: "SYNTHETIC_SECRET_CANARY" },
		},
	},
});
function fixture() {
	const registration = vi.fn().mockResolvedValue({
		id: "registration-1",
		bitmovinAccountId: "account-1",
	});
	const findRun = vi.fn().mockResolvedValue({ id: run.id });
	const events = vi.fn().mockResolvedValue([]);
	const priorEvent = vi.fn().mockResolvedValue(null);
	const db = {
		webhookRegistration: { findFirst: registration },
		liveChannelRun: { findFirst: findRun },
		webhookEvent: { findMany: events, findFirst: priorEvent },
		appSetting: { findUnique: vi.fn().mockResolvedValue(null) },
	} as unknown as AppPrismaClient;
	return { db, registration, findRun, events, priorEvent };
}
describe("signed heartbeat run binding", () => {
	it.each([
		"POLL_ONLY",
		"PENDING_VERSION",
	])("does not bind deliveries for %s runs", async (mode) => {
		const f = fixture();
		f.registration.mockResolvedValue({
			id: "registration-1",
			bitmovinAccountId: "account-1",
			configuration: { ...configuration, mode },
		});
		expect(
			await bindHeartbeatRun(f.db, { ...packet(), customData }, "hash"),
		).toBeNull();
		expect(f.findRun).not.toHaveBeenCalled();
	});
	it("cross-checks per-encoding custom data against stored run ownership", async () => {
		const f = fixture();
		f.registration.mockResolvedValue({
			id: configuration.registrationId,
			bitmovinAccountId: "account-1",
			encodingId,
			liveChannelRunId: configuration.runId,
			configuration,
		});
		f.findRun.mockResolvedValue({ id: configuration.runId });
		expect(
			await bindHeartbeatRun(f.db, { ...packet(), customData }, "hash"),
		).toEqual({
			runId: configuration.runId,
			registrationId: configuration.registrationId,
		});
		for (const invalid of [
			undefined,
			{},
			{ bitOvp: { ...customData.bitOvp, runId: run.id } },
		]) {
			expect(
				await bindHeartbeatRun(
					f.db,
					{ ...packet(), customData: invalid },
					"hash",
				),
			).toBeNull();
		}
	});
	it.each([
		"PER_ENCODING",
		"POLL_ONLY",
		"PENDING_VERSION",
	])("does not bind an account delivery when this run selected %s", async (mode) => {
		const f = fixture();
		f.registration
			.mockResolvedValueOnce({
				id: "account-hook",
				bitmovinAccountId: "account-1",
			})
			.mockResolvedValueOnce({ configuration: { ...configuration, mode } });
		expect(await bindHeartbeatRun(f.db, packet(), "hash")).toBeNull();
	});
	it("retains a previously verified run/hook binding after the registration is replaced", async () => {
		const f = fixture();
		f.registration.mockResolvedValue(null);
		f.priorEvent.mockResolvedValue({ id: "prior-verified-event" });
		expect(
			await bindHeartbeatRun(
				f.db,
				{ ...packet(), accountId: "foreign", liveChannelRunId: "foreign" },
				"hash",
			),
		).toEqual({ runId: run.id, registrationId: null });
		expect(f.findRun).toHaveBeenCalledWith({
			where: { bitmovinEncodingId: encodingId },
			select: { id: true },
		});
		expect(f.priorEvent).toHaveBeenCalledWith({
			where: {
				source: "bitmovin",
				eventType: "LIVE_ENCODING_HEARTBEAT",
				signatureValid: true,
				liveChannelRunId: run.id,
				AND: [
					{ raw: { path: ["webhookId"], equals: webhookId } },
					{ raw: { path: ["encoding", "id"], equals: encodingId } },
				],
			},
			select: { id: true },
		});
	});
	it("unseen hooks and historical evidence from another run/encoding or without verification never authorize fallback", async () => {
		for (const mismatch of [
			"hook",
			"encoding",
			"run",
			"signature",
			"type",
			"unbound",
		] as const) {
			const f = fixture();
			f.registration.mockResolvedValue(null);
			const prior = {
				source: "bitmovin",
				eventType: mismatch === "type" ? "WEBHOOK" : "LIVE_ENCODING_HEARTBEAT",
				signatureValid: mismatch !== "signature",
				liveChannelRunId:
					mismatch === "unbound"
						? null
						: mismatch === "run"
							? "other-run"
							: run.id,
				webhookId: mismatch === "hook" ? "other-hook" : webhookId,
				encodingId: mismatch === "encoding" ? "other-encoding" : encodingId,
			};
			f.priorEvent.mockImplementation(async ({ where }) =>
				where.source === prior.source &&
				where.eventType === prior.eventType &&
				where.signatureValid === prior.signatureValid &&
				where.liveChannelRunId === prior.liveChannelRunId &&
				where.AND[0].raw.equals === prior.webhookId &&
				where.AND[1].raw.equals === prior.encodingId
					? { id: "wrong-history" }
					: null,
			);
			expect(
				await bindHeartbeatRun(f.db, packet(), "hash"),
				mismatch,
			).toBeNull();
			expect(f.priorEvent).toHaveBeenCalledOnce();
		}
	});
	it("no exact encoding run means no historical lookup, even with a supplied run id", async () => {
		const f = fixture();
		f.registration.mockResolvedValue(null);
		f.findRun.mockResolvedValue(null);
		expect(
			await bindHeartbeatRun(
				f.db,
				{ ...packet(), liveChannelRunId: run.id },
				"hash",
			),
		).toBeNull();
		expect(f.priorEvent).not.toHaveBeenCalled();
	});
	it("binds the provider hook account and exact encoding, not a body-supplied run", async () => {
		const f = fixture();
		expect(
			await bindHeartbeatRun(
				f.db,
				{ ...packet(), liveChannelRunId: "foreign" },
				"hash",
			),
		).toEqual({ runId: run.id, registrationId: "registration-1" });
		expect(f.registration).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					scope: "hb",
					kind: "liveEncodingHeartbeat",
					providerWebhookId: webhookId,
					tokenHash: "hash",
				},
			}),
		);
		expect(f.findRun).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					bitmovinEncodingId: encodingId,
					liveChannel: { bitmovinAccountId: "account-1" },
				},
			}),
		);
	});
	it("never binds malformed, unknown hook, or another account's encoding", async () => {
		const f = fixture();
		expect(await bindHeartbeatRun(f.db, { value: {} }, "hash")).toBeNull();
		expect(f.registration).not.toHaveBeenCalled();
		f.registration.mockResolvedValueOnce(null);
		expect(await bindHeartbeatRun(f.db, packet(), "hash")).toBeNull();
		f.findRun.mockResolvedValueOnce(null);
		expect(await bindHeartbeatRun(f.db, packet(), "hash")).toBeNull();
	});
});
describe("heartbeat reception projection", () => {
	it.each([
		"POLL_ONLY",
		"PENDING_VERSION",
	])("shows %s registration without accepting stored Push samples", async (mode) => {
		const f = fixture();
		f.registration.mockResolvedValue({
			configuration: { ...configuration, mode },
			status: "SKIPPED",
		});
		f.events.mockResolvedValue([
			{
				receivedAt: new Date("2026-09-07T07:04:01Z"),
				raw: { ...packet(), customData },
			},
		]);
		expect(
			await readHeartbeatReception(f.db, run, new Date("2026-09-07T07:05:00Z")),
		).toMatchObject({
			latest: null,
			registration: { mode, status: "SKIPPED" },
		});
	});
	it("retains a verified legacy run's history after its account registration is retired", async () => {
		const f = fixture();
		const legacyIntent = {
			configuration: { ...configuration, mode: "LEGACY_ACCOUNT" },
			status: "SKIPPED",
		};
		const retiredAccountHook = { configuration: null, status: "DELETED" };
		f.registration.mockImplementation(
			async ({ where }: { where: { liveChannelRunId?: string } }) =>
				where.liveChannelRunId === run.id ? legacyIntent : retiredAccountHook,
		);
		f.events.mockResolvedValue([
			{ receivedAt: new Date("2026-09-07T07:04:01Z"), raw: packet() },
		]);
		expect(
			await readHeartbeatReception(f.db, run, new Date("2026-09-07T07:05:00Z")),
		).toMatchObject({
			registration: { mode: "LEGACY_ACCOUNT", status: "SKIPPED" },
			latest: { sampledAt: "2026-09-07T07:04:00Z" },
		});
		expect(f.events).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					signatureValid: true,
					liveChannelRunId: run.id,
					eventType: "LIVE_ENCODING_HEARTBEAT",
				}),
			}),
		);
		expect(legacyIntent.configuration.mode).toBe("LEGACY_ACCOUNT");
	});

	it("ignores previously bound account samples after per-encoding selection", async () => {
		const f = fixture();
		f.registration.mockResolvedValue({ configuration, status: "ACTIVE" });
		f.events.mockResolvedValue([
			{ receivedAt: new Date("2026-09-07T07:04:01Z"), raw: packet() },
		]);
		expect(
			await readHeartbeatReception(f.db, run, new Date("2026-09-07T07:05:00Z")),
		).toMatchObject({ latest: null });
	});
	it("uses the run's frozen interval and exposes registration separately from receipts", async () => {
		const f = fixture();
		f.registration.mockResolvedValue({ configuration, status: "ACTIVE" });
		expect(
			await readHeartbeatReception(f.db, run, new Date("2026-09-07T07:05:00Z")),
		).toMatchObject({
			configuredIntervalS: 5,
			latest: null,
			registration: {
				mode: "PER_ENCODING",
				resolvedEncoderVersion: "2.285.0",
				status: "ACTIVE",
			},
		});
	});
	it("adds a distinct previous sample and bounded, allowlisted cumulative Push events", async () => {
		const f = fixture();
		const event = (time: string, eventType: string) => ({
			time,
			details: { eventType, message: "PRIVATE_URL_CANARY" },
		});
		const row = (sample: string, received: string) => ({
			receivedAt: new Date(received),
			raw: {
				...packet(sample),
				value: {
					...packet(sample).value,
					events: [
						event("2026-09-07T07:01:00Z", "FIRST_CONNECT"),
						event("2026-09-07T07:01:00Z", "FIRST_CONNECT"),
						event("2026-09-07T06:59:00Z", "DISCONNECT"),
						event("2026-09-07T07:06:00Z", "RECONNECT"),
						event("invalid", "DISCONNECT"),
						event("2026-09-07T07:02:00Z", "PRIVATE_KIND"),
					],
				},
			},
		});
		f.events.mockResolvedValue([
			row("2026-09-07T07:04:20Z", "2026-09-07T07:04:21Z"),
			row("2026-09-07T07:04:00Z", "2026-09-07T07:04:01Z"),
		]);
		const result = await readHeartbeatReception(
			f.db,
			run,
			new Date("2026-09-07T07:05:00Z"),
		);
		expect(result).toMatchObject({
			previous: { sampledAt: "2026-09-07T07:04:00Z" },
			timeline: {
				coverage: "recent-receipts",
				truncated: false,
				events: [
					{
						kind: "FIRST_CONNECT",
						eventAt: "2026-09-07T07:01:00.000Z",
						observedReceivedAt: "2026-09-07T07:04:01.000Z",
					},
				],
			},
		});
		if (result.state === "available")
			expect(JSON.stringify(result.timeline)).not.toMatch(/PRIVATE/);
	});
	it("rejects pre-run and future provider samples without warning at 50 receipts", async () => {
		const f = fixture();
		f.events.mockResolvedValue(
			["2026-09-07T06:59:59Z", "2026-09-07T07:05:01Z"].map((at) => ({
				receivedAt: new Date("2026-09-07T07:05:00Z"),
				raw: packet(at),
			})),
		);
		expect(
			await readHeartbeatReception(f.db, run, new Date("2026-09-07T07:05:00Z")),
		).toMatchObject({ latest: null, previous: null, timeline: { events: [] } });
		f.events.mockResolvedValue(
			Array.from({ length: 50 }, () => ({
				receivedAt: new Date("2026-09-07T07:04:01Z"),
				raw: packet(),
			})),
		);
		expect(
			await readHeartbeatReception(f.db, run, new Date("2026-09-07T07:05:00Z")),
		).toMatchObject({ timeline: { truncated: false } });
	});
	it.each([
		50, 300, 301,
	])("bounds the 2s receipt window with an actual overflow lookahead: %i", async (count) => {
		const f = fixture();
		const newest = Date.parse("2026-09-07T07:10:00Z");
		f.events.mockResolvedValue(
			Array.from({ length: count }, (_, index) => {
				const at = new Date(newest - index * 2_000);
				return { receivedAt: at, raw: packet(at.toISOString()) };
			}),
		);
		expect(
			await readHeartbeatReception(f.db, run, new Date(newest)),
		).toMatchObject({
			latest: { sampledAt: new Date(newest).toISOString() },
			timeline: { truncated: count > 300 },
		});
		expect(f.events).toHaveBeenCalledWith(
			expect.objectContaining({ take: 301 }),
		);
	});
	it("uses older receipts inside the window but never parses the overflow row", async () => {
		const f = fixture();
		const rows = Array.from({ length: 300 }, () => ({
			receivedAt: new Date("2026-09-07T07:04:01Z"),
			raw: packet(),
		}));
		rows.splice(100, 1, {
			receivedAt: new Date("2026-09-07T07:04:01Z"),
			raw: {
				...packet(),
				value: {
					...packet().value,
					events: [
						{
							time: "2026-09-07T07:01:00Z",
							details: { eventType: "FIRST_CONNECT" },
						},
					],
				} as ReturnType<typeof packet>["value"],
			},
		});
		const overflow = {
			receivedAt: new Date("2026-09-07T07:00:00Z"),
			get raw(): ReturnType<typeof packet> {
				throw new Error("Overflow payload must not be parsed");
			},
		};
		f.events.mockResolvedValue([...rows, overflow]);
		expect(
			await readHeartbeatReception(f.db, run, new Date("2026-09-07T07:05:00Z")),
		).toMatchObject({
			state: "available",
			timeline: { truncated: true, events: [{ kind: "FIRST_CONNECT" }] },
		});
	});
	it("caps cumulative event output at 100, excluding events after their provider sample", async () => {
		const f = fixture();
		f.events.mockResolvedValue([
			{
				receivedAt: new Date("2026-09-07T07:04:01Z"),
				raw: {
					...packet(),
					value: {
						...packet().value,
						events: [
							...Array.from({ length: 101 }, (_, index) => ({
								time: new Date(
									run.createdAt.getTime() + index * 1_000,
								).toISOString(),
								details: { eventType: "RECONNECT" },
							})),
							{
								time: "2026-09-07T07:04:10Z",
								details: { eventType: "DISCONNECT" },
							},
						],
					},
				},
			},
		]);
		const result = await readHeartbeatReception(
			f.db,
			run,
			new Date("2026-09-07T07:05:00Z"),
		);
		if (result.state !== "available") throw new Error("projection unavailable");
		expect(result.timeline?.events).toHaveLength(100);
		expect(result.timeline?.truncated).toBe(true);
		expect(
			result.timeline?.events.some((event) => event.kind === "DISCONNECT"),
		).toBe(false);
		expect(result.timeline?.events[0]?.eventAt).toBe(
			"2026-09-07T07:00:01.000Z",
		);
	});
	it("queries only the verified current run and distinguishes no delivery from read failure", async () => {
		const f = fixture();
		const now = new Date("2026-09-07T07:05:00Z");
		const empty = await readHeartbeatReception(f.db, run, now);
		expect(empty).toMatchObject({
			state: "available",
			runId: run.id,
			latest: null,
			previousReceivedAt: null,
		});
		expect(f.events).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					eventType: "LIVE_ENCODING_HEARTBEAT",
					signatureValid: true,
					liveChannelRunId: run.id,
					receivedAt: { gte: run.createdAt, lte: now },
				},
				take: 301,
			}),
		);
		f.events.mockRejectedValueOnce(new Error("private db detail"));
		expect(await readHeartbeatReception(f.db, run, now)).toEqual({
			state: "unavailable",
			runId: run.id,
		});
	});
	it("does not turn late replay into a new sample or leak stream keys", async () => {
		const f = fixture();
		f.events.mockResolvedValue([
			{
				receivedAt: new Date("2026-09-07T07:04:25Z"),
				raw: packet("2026-09-07T07:03:40Z"),
			},
			{
				receivedAt: new Date("2026-09-07T07:04:22Z"),
				raw: packet("2026-09-07T07:04:20Z"),
			},
			{
				receivedAt: new Date("2026-09-07T07:04:21Z"),
				raw: packet("2026-09-07T07:04:20Z"),
			},
			{ receivedAt: new Date("2026-09-07T07:04:01Z"), raw: packet() },
		]);
		const result = await readHeartbeatReception(
			f.db,
			run,
			new Date("2026-09-07T07:05:00Z"),
		);
		expect(result).toMatchObject({
			latest: {
				receivedAt: "2026-09-07T07:04:21.000Z",
				sampledAt: "2026-09-07T07:04:20Z",
			},
			previousReceivedAt: "2026-09-07T07:04:01.000Z",
		});
		expect(JSON.stringify(result)).not.toContain("SYNTHETIC_SECRET_CANARY");
	});
	it("rejects historical rows for a different encoding and malformed sample clocks", async () => {
		const f = fixture();
		f.events.mockResolvedValue([
			{
				receivedAt: new Date(),
				raw: { ...packet(), encoding: { id: "foreign" } },
			},
			{ receivedAt: new Date(), raw: packet("garbage") },
		]);
		expect(await readHeartbeatReception(f.db, run, new Date())).toMatchObject({
			state: "available",
			latest: null,
		});
	});
	it("a never-run channel does not query events", async () => {
		const f = fixture();
		expect(await readHeartbeatReception(f.db, null, new Date())).toMatchObject({
			state: "available",
			runId: null,
			latest: null,
		});
		expect(f.events).not.toHaveBeenCalled();
	});
});
