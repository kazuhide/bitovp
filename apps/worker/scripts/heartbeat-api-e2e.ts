/** Isolated DB + real HTTP receiver, injected provider only. Never starts an encoder. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	computeWebhookSignature,
	deriveWebhookKey,
	hashWebhookToken,
	newWebhookToken,
} from "@bitovp/core";
import { createPrismaClient } from "@bitovp/db";
import plan from "../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json";
import {
	type EncodingHeartbeatPayload,
	reconcilePerEncodingHeartbeats,
} from "../src/webhooks/per-encoding-heartbeat";

const databaseUrl = process.env.HEARTBEAT_E2E_DATABASE_URL;
const base = process.env.HEARTBEAT_E2E_BASE_URL ?? "";
const masterSecret = process.env.BITMOVIN_WEBHOOK_SECRET ?? "";
assert(
	databaseUrl && base && masterSecret,
	"Set explicit HEARTBEAT_E2E_DATABASE_URL, HEARTBEAT_E2E_BASE_URL, BITMOVIN_WEBHOOK_SECRET",
);
const dbAddress = new URL(databaseUrl);
const appAddress = new URL(base);
assert.equal(dbAddress.pathname, "/bitovp_heartbeat_e2e");
assert(["127.0.0.1", "localhost"].includes(dbAddress.hostname));
assert.equal(appAddress.hostname, "127.0.0.1");
assert.equal(appAddress.port, "3115");
const prisma = createPrismaClient(databaseUrl);
const accountId = randomUUID();
const channelId = randomUUID();
const runId = randomUUID();
const encodingId = randomUUID();
const webhookId = randomUUID();
let payload: EncodingHeartbeatPayload | null = null;
let creates = 0;
let exists = false;
const stats = { registered: 0, skipped: 0, failed: 0, retired: 0 };
let stage = "fixture";

async function send(body: unknown, invalidSignature = false) {
	assert(payload);
	assert.equal(new URL(payload.url).origin, appAddress.origin);
	const raw = JSON.stringify(body);
	return fetch(payload.url, {
		method: "POST",
		body: raw,
		headers: {
			"content-type": "application/json",
			"bitmovin-signature": invalidSignature
				? "bad"
				: computeWebhookSignature(raw, payload.signature.key),
		},
		signal: AbortSignal.timeout(30_000),
		redirect: "error",
	});
}
function packet() {
	assert(payload);
	return {
		id: "provider-reuses-this-id",
		eventType: "LIVE_ENCODING_HEARTBEAT",
		webhookId,
		encoding: { id: encodingId },
		customData: payload.customData,
		value: {
			timestamp: new Date().toISOString(),
			ingest: { status: "CONNECTED", streamKey: "PRIVATE_CANARY" },
		},
	};
}
async function tick() {
	await reconcilePerEncodingHeartbeats({
		prisma,
		at: new Date(),
		heartbeat: { intervalS: 5, mode: "AUTO" },
		ingressBase: base,
		masterSecret,
		keyId: "e2e-key",
		spend: () => true,
		stats,
		providerFor: async (id) => {
			assert.equal(id, accountId, "Fixture must not operate other accounts");
			return {
				getHeartbeatEncodingVersion: async () => ({
					requested: "BETA",
					resolved: "2.285.0",
				}),
				listEncodingHeartbeats: async () =>
					exists && payload
						? [
								{
									id: webhookId,
									name: payload.name,
									url: payload.url,
									interval: payload.interval,
								},
							]
						: [],
				getEncodingHeartbeatCustomData: async () => {
					assert(payload);
					return payload.customData;
				},
				createEncodingHeartbeat: async (encoding, request) => {
					assert.equal(encoding, encodingId);
					creates++;
					payload = request;
					exists = true;
					assert.equal((await send(packet())).status, 200);
					assert.equal(
						await prisma.webhookEvent.count({
							where: { liveChannelRunId: runId },
						}),
						0,
						"Immediate receipt must be quarantined",
					);
					throw new Error("Simulated lost POST response after provider commit");
				},
				removeEncodingHeartbeat: async (encoding, hook) => {
					assert.equal(encoding, encodingId);
					assert.equal(hook, webhookId);
					exists = false;
				},
			};
		},
	});
}

async function main() {
	try {
		await prisma.bitmovinAccount.create({
			data: {
				id: accountId,
				label: `heartbeat-http-${accountId}`,
				encryptedApiKey: "fixture-not-a-provider-key",
			},
		});
		await prisma.liveChannel.create({
			data: {
				id: channelId,
				name: "Heartbeat HTTP fixture",
				status: "RUNNING",
				bitmovinAccountId: accountId,
				bitmovinEncodingId: encodingId,
				plan: {
					...plan,
					bitmovin: { ...plan.bitmovin, encoderVersion: "BETA" },
				},
			},
		});
		await prisma.liveChannelRun.create({
			data: {
				id: runId,
				liveChannelId: channelId,
				seq: 1,
				status: "RUNNING",
				bitmovinEncodingId: encodingId,
				outputPrefix: "e2e-only/",
			},
		});
		stage = "immediate receipt";
		await tick();
		assert.equal(creates, 1);
		assert.equal(stats.failed, 1);
		stage = "foreign token isolation";
		const foreignToken = newWebhookToken();
		await prisma.webhookRegistration.create({
			data: {
				encodingId: randomUUID(),
				kind: "liveEncodingHeartbeat",
				scope: "hb",
				bitmovinAccountId: accountId,
				tokenHash: hashWebhookToken(foreignToken),
				status: "SKIPPED",
			},
		});
		const foreignBody = JSON.stringify(packet());
		assert.equal(
			(
				await fetch(`${base}/api/webhooks/bitmovin/hb/${foreignToken}`, {
					method: "POST",
					body: foreignBody,
					headers: {
						"bitmovin-signature": computeWebhookSignature(
							foreignBody,
							deriveWebhookKey(masterSecret, foreignToken),
						),
					},
					signal: AbortSignal.timeout(30_000),
				})
			).status,
			200,
		);
		stage = "lost response adoption";
		await prisma.webhookRegistration.updateMany({
			where: { liveChannelRunId: runId },
			data: { nextAttemptAt: null },
		});
		await tick();
		assert.equal(creates, 1, "Response loss must adopt, never repeat POST");
		assert.equal(
			await prisma.webhookEvent.count({ where: { liveChannelRunId: runId } }),
			1,
			"Only the exact token's early receipt is promoted, not another signed route",
		);
		stage = "receipt verification";
		const before = await prisma.webhookEvent.count();
		assert.equal((await send(packet(), true)).status, 401);
		assert.equal(await prisma.webhookEvent.count(), before);
		assert.equal(
			(
				await send({
					...packet(),
					customData: { bitOvp: { runId: randomUUID() } },
				})
			).status,
			200,
		);
		assert.equal(
			await prisma.webhookEvent.count({ where: { liveChannelRunId: runId } }),
			1,
		);
		assert.equal((await send(packet())).status, 200);
		assert.equal((await send(packet())).status, 200);
		assert.equal(
			await prisma.webhookEvent.count({ where: { liveChannelRunId: runId } }),
			3,
			"Stable provider id must not suppress heartbeats",
		);
		stage = "HTTP projection";
		const detail = await fetch(`${base}/api/live-channels/${channelId}`, {
			signal: AbortSignal.timeout(30_000),
		});
		assert.equal(detail.status, 200);
		const view = (await detail.json()) as {
			heartbeatReception: {
				state: string;
				configuredIntervalS: number;
				registration: { mode: string; resolvedEncoderVersion: string };
				latest: { raw: { ingest: { status: string } } };
			};
			currentRun: { lastHeartbeat: unknown };
		};
		assert.equal(view.heartbeatReception.state, "available");
		assert.equal(view.heartbeatReception.configuredIntervalS, 5);
		assert.equal(view.heartbeatReception.registration.mode, "PER_ENCODING");
		assert.equal(
			view.heartbeatReception.registration.resolvedEncoderVersion,
			"2.285.0",
		);
		assert.equal(view.heartbeatReception.latest.raw.ingest.status, "CONNECTED");
		assert(!JSON.stringify(view).includes("PRIVATE_CANARY"));
		assert.equal(
			view.currentRun.lastHeartbeat,
			null,
			"Push must not overwrite Poll",
		);
		const event = await prisma.webhookEvent.findFirstOrThrow({
			where: { liveChannelRunId: runId },
		});
		const eventDetail = await fetch(`${base}/api/webhook-events/${event.id}`, {
			signal: AbortSignal.timeout(30_000),
		});
		assert.equal(eventDetail.status, 200);
		assert(
			!Object.hasOwn((await eventDetail.json()) as object, "receiverTokenHash"),
			"Internal correlation hash must not escape event details",
		);
		assert.equal(
			await prisma.webhookEvent.count({
				where: { liveChannelRunId: runId, processedAt: null },
			}),
			0,
		);
		stage = "terminal cleanup";
		await prisma.liveChannelRun.update({
			where: { id: runId },
			data: { status: "STOPPED" },
		});
		await tick();
		assert.equal(exists, false);
		assert.equal(
			(await send(packet())).status,
			200,
			"Inflight terminal delivery is accepted without relaunch",
		);
		assert.equal(creates, 1);
		console.log(
			JSON.stringify({
				result: "PASS",
				checks: [
					"real HTTP + DB",
					"immediate quarantine",
					"lost-response adoption",
					"invalid signature no write",
					"customData mismatch unbound",
					"stable event IDs retained",
					"run-specific frozen interval",
					"safe HTTP projection",
					"no Poll dispatcher wake",
					"terminal hook teardown",
				],
			}),
		);
	} finally {
		await prisma.webhookEvent.deleteMany({
			where: { raw: { path: ["encoding", "id"], equals: encodingId } },
		});
		await prisma.webhookRegistration.deleteMany({
			where: { bitmovinAccountId: accountId },
		});
		await prisma.liveChannel.deleteMany({ where: { id: channelId } });
		await prisma.bitmovinAccount.deleteMany({ where: { id: accountId } });
		await prisma.$disconnect();
	}
}
main().catch((error) => {
	console.error(
		`Heartbeat HTTP E2E failed at ${stage}: ${error instanceof assert.AssertionError ? error.message : error instanceof Error ? error.name : "unknown"}`,
	);
	process.exitCode = 1;
});
