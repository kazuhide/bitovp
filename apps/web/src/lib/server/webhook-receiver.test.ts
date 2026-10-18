import { randomBytes } from "node:crypto";
import {
	AesGcmCipher,
	computeWebhookSignature,
	deriveScopedToken,
	deriveWebhookKey,
	hashWebhookToken,
	MasterKeyConfigError,
	newWebhookToken,
} from "@bitovp/core";
import {
	encodeWebhookMasterSecretRow,
	WEBHOOK_MASTER_SECRET_KEY,
} from "@bitovp/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "./context";
import { receiveSignedWebhook } from "./webhook-receiver";

/**
 * WP-G G-1 receiver matrix. Every arm asserts the PERSISTENCE side too:
 * the only writes are verified ones, and every refusal leaves the table
 * untouched (the legacy route's row-flooding lesson, kept).
 */

const MASTER = "env-master-secret";
const create = vi.fn();
const appSettingRows = new Map<string, unknown>();
const appSetting = {
	async findUnique(args: { where: { key: string } }) {
		return appSettingRows.has(args.where.key)
			? { value: appSettingRows.get(args.where.key) }
			: null;
	},
	async create(args: { data: { key: string; value: unknown } }) {
		if (appSettingRows.has(args.data.key)) {
			throw Object.assign(new Error("dup"), { code: "P2002" });
		}
		appSettingRows.set(args.data.key, args.data.value);
		return args.data;
	},
};
const cipher = new AesGcmCipher(randomBytes(32));
/** WP-G G-2: the registration rows a `j` token resolves through. */
const registrations: {
	tokenHash: string;
	encodingJobId: string | null;
	liveChannelRunId: string | null;
	lastDeliveryAt?: Date;
}[] = [];
const registrationUpdateMany = vi.fn(
	async (args: {
		where: { tokenHash: string };
		data: { lastDeliveryAt: Date };
	}) => {
		let count = 0;
		for (const row of registrations) {
			if (row.tokenHash === args.where.tokenHash) {
				row.lastDeliveryAt = args.data.lastDeliveryAt;
				count += 1;
			}
		}
		return { count };
	},
);
const webhookRegistration = {
	async findFirst(args: { where: { tokenHash: string } }) {
		const row = registrations.find((r) => r.tokenHash === args.where.tokenHash);
		return row
			? {
					encodingJobId: row.encodingJobId,
					liveChannelRunId: row.liveChannelRunId,
				}
			: null;
	},
	updateMany: registrationUpdateMany,
};
const ctx = () =>
	({
		prisma: { webhookEvent: { create }, appSetting, webhookRegistration },
		cipher,
	}) as unknown as ServerContext;

const NOW = new Date("2026-09-02T09:00:00.000Z");
const payload = JSON.stringify({
	type: "ENCODING_FINISHED",
	eventId: "evt-1",
	encodingId: "enc-1",
});

let requestCounter = 0;
function request(
	body: string,
	options: { signature?: string; contentLength?: string } = {},
): Request {
	requestCounter++;
	return new Request("http://test/api/webhooks/bitmovin/acct/x", {
		method: "POST",
		body,
		headers: {
			// Single digits against a 120/min budget; the limiter has its own file.
			"x-forwarded-for": `10.0.0.${requestCounter % 250}`,
			...(options.signature ? { "bitmovin-signature": options.signature } : {}),
			...(options.contentLength
				? { "content-length": options.contentLength }
				: {}),
		},
	});
}

const receive = (
	req: Request,
	scope: string,
	token: string,
	context: () => ServerContext = ctx,
) =>
	receiveSignedWebhook(req, { scope, token }, { ctx: context, now: () => NOW });

beforeEach(() => {
	vi.clearAllMocks();
	appSettingRows.clear();
	registrations.length = 0;
	create.mockResolvedValue({ id: "row-1" });
	vi.stubEnv("BITMOVIN_WEBHOOK_SECRET", MASTER);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

const acctToken = () => deriveScopedToken(MASTER, "acct");
const hbToken = () => deriveScopedToken(MASTER, "hb");
const sign = (body: string, token: string) =>
	computeWebhookSignature(body, deriveWebhookKey(MASTER, token));

describe("signed receiver matrix", () => {
	it("good signature on the acct token ⇒ 200, persisted VERIFIED with a dedup slot", async () => {
		const token = acctToken();
		const res = await receive(
			request(payload, { signature: sign(payload, token) }),
			"acct",
			token,
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			accepted: true,
			verified: true,
			scope: "acct",
		});
		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				source: "bitmovin",
				eventType: "ENCODING_FINISHED",
				externalEventId: "evt-1",
				signatureValid: true,
			}),
		});
		const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
		expect(data.processedAt).toBeUndefined();
	});

	it("unknown token ⇒ 404 with NO persistence, even when correctly signed under its own derived key", async () => {
		// A token nobody registered: its derived key is a real key, so a
		// forger who somehow has the master could sign for it — but nothing
		// was registered there, and the receiver says 404, not 200.
		const stray = newWebhookToken();
		const res = await receive(
			request(payload, { signature: sign(payload, stray) }),
			"acct",
			stray,
		);
		expect(res.status).toBe(404);
		expect(create).not.toHaveBeenCalled();
	});

	it("malformed token or unknown scope ⇒ 404 before any work", async () => {
		expect((await receive(request(payload), "acct", "../etc")).status).toBe(
			404,
		);
		expect((await receive(request(payload), "acct", "short")).status).toBe(404);
		expect((await receive(request(payload), "job", acctToken())).status).toBe(
			404,
		);
		expect(create).not.toHaveBeenCalled();
	});

	it("bad signature ⇒ 401 with NO persistence; a signature under another token's key is 'bad'", async () => {
		const token = acctToken();
		expect(
			(
				await receive(
					request(payload, { signature: "deadbeef" }),
					"acct",
					token,
				)
			).status,
		).toBe(401);
		expect((await receive(request(payload), "acct", token)).status).toBe(401);
		// Signed with the hb token's key, presented on the acct URL.
		expect(
			(
				await receive(
					request(payload, { signature: sign(payload, hbToken()) }),
					"acct",
					token,
				)
			).status,
		).toBe(401);
		expect(create).not.toHaveBeenCalled();
	});

	it("oversize ⇒ 413 before the token is even resolved", async () => {
		const res = await receive(
			request(payload, { contentLength: "50000000" }),
			"acct",
			acctToken(),
		);
		expect(res.status).toBe(413);
		expect(create).not.toHaveBeenCalled();
	});

	it("non-JSON / non-object bodies ⇒ 400 after a valid signature, not persisted", async () => {
		const token = acctToken();
		for (const body of ["not json", "null", "[1,2]"]) {
			const res = await receive(
				request(body, { signature: sign(body, token) }),
				"acct",
				token,
			);
			expect(res.status, body).toBe(400);
		}
		expect(create).not.toHaveBeenCalled();
	});

	it("a redelivery (P2002 on the dedup slot) is acknowledged without a new row", async () => {
		const token = acctToken();
		create.mockRejectedValueOnce(
			Object.assign(new Error("unique"), { code: "P2002" }),
		);
		const res = await receive(
			request(payload, { signature: sign(payload, token) }),
			"acct",
			token,
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			accepted: true,
			duplicate: true,
			scope: "acct",
		});
	});

	it("hb scope persists as LIVE_ENCODING_HEARTBEAT and already processed (no dispatcher wake per heartbeat)", async () => {
		const token = hbToken();
		const heartbeat = JSON.stringify({ encodingId: "enc-1", frames: 1 });
		const res = await receive(
			request(heartbeat, { signature: sign(heartbeat, token) }),
			"hb",
			token,
		);
		expect(res.status).toBe(200);
		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				eventType: "LIVE_ENCODING_HEARTBEAT",
				signatureValid: true,
				processedAt: NOW,
			}),
		});
	});

	it("j scope: a token nobody registered ⇒ 404, no persistence, even correctly signed", async () => {
		const token = newWebhookToken();
		const res = await receive(
			request(payload, { signature: sign(payload, token) }),
			"j",
			token,
		);
		expect(res.status).toBe(404);
		expect(create).not.toHaveBeenCalled();
		expect(registrationUpdateMany).not.toHaveBeenCalled();
	});

	it("j scope: a registered token ⇒ persisted with the REGISTRATION's job id (not the body's), and lastDeliveryAt stamped", async () => {
		const token = newWebhookToken();
		registrations.push({
			tokenHash: hashWebhookToken(token),
			encodingJobId: "job-1",
			liveChannelRunId: null,
		});
		const spoofed = JSON.stringify({
			type: "ENCODING_FINISHED",
			eventId: "evt-2",
			encodingId: "enc-of-someone-else",
		});
		const res = await receive(
			request(spoofed, { signature: sign(spoofed, token) }),
			"j",
			token,
		);
		expect(res.status).toBe(200);
		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				signatureValid: true,
				encodingJobId: "job-1",
				liveChannelRunId: null,
			}),
		});
		expect(registrationUpdateMany).toHaveBeenCalledWith({
			where: { tokenHash: hashWebhookToken(token) },
			data: { lastDeliveryAt: NOW },
		});
		expect(registrations[0]?.lastDeliveryAt).toEqual(NOW);
	});

	it("j scope: a registered token with the WRONG signature is still a 401 with nothing written", async () => {
		const token = newWebhookToken();
		registrations.push({
			tokenHash: hashWebhookToken(token),
			encodingJobId: null,
			liveChannelRunId: "run-1",
		});
		const res = await receive(
			request(payload, { signature: sign(payload, newWebhookToken()) }),
			"j",
			token,
		);
		expect(res.status).toBe(401);
		expect(create).not.toHaveBeenCalled();
		expect(registrationUpdateMany).not.toHaveBeenCalled();
	});

	it("the acct token is scope-bound: the hb token on the acct URL is unknown", async () => {
		const token = hbToken();
		const res = await receive(
			request(payload, { signature: sign(payload, token) }),
			"acct",
			token,
		);
		expect(res.status).toBe(404);
		expect(create).not.toHaveBeenCalled();
	});
});

describe("secret resolution on the receiver", () => {
	it("with no env secret, the generated master (encrypted AppSetting row) is the one deliveries verify against", async () => {
		vi.unstubAllEnvs();
		const generated = randomBytes(32).toString("hex");
		appSettingRows.set(
			WEBHOOK_MASTER_SECRET_KEY,
			await encodeWebhookMasterSecretRow(cipher, generated),
		);
		const token = deriveScopedToken(generated, "acct");
		const signature = computeWebhookSignature(
			payload,
			deriveWebhookKey(generated, token),
		);
		const res = await receive(request(payload, { signature }), "acct", token);
		expect(res.status).toBe(200);
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("the env secret overrides a generated row: a delivery signed under the generated master is refused", async () => {
		const generated = randomBytes(32).toString("hex");
		appSettingRows.set(
			WEBHOOK_MASTER_SECRET_KEY,
			await encodeWebhookMasterSecretRow(cipher, generated),
		);
		// Signed and addressed under the GENERATED master; env is set to MASTER.
		const token = deriveScopedToken(generated, "acct");
		const signature = computeWebhookSignature(
			payload,
			deriveWebhookKey(generated, token),
		);
		const res = await receive(request(payload, { signature }), "acct", token);
		// The env-derived acct token differs, so this URL is simply unknown.
		expect(res.status).toBe(404);
		expect(create).not.toHaveBeenCalled();
	});

	it("MASTER_KEY unavailable ⇒ 503, fail closed, nothing persisted", async () => {
		vi.unstubAllEnvs();
		const broken = () =>
			({
				prisma: { webhookEvent: { create }, appSetting },
				cipher: {
					encrypt: async () => {
						throw new MasterKeyConfigError("MASTER_KEY is not set");
					},
					decrypt: async () => {
						throw new MasterKeyConfigError("MASTER_KEY is not set");
					},
				},
			}) as unknown as ServerContext;
		const res = await receive(
			request(payload),
			"acct",
			newWebhookToken(),
			broken,
		);
		expect(res.status).toBe(503);
		expect(create).not.toHaveBeenCalled();
	});
});

describe("raw-body verification (rev407 #1)", () => {
	it("signs the bytes on the wire: a pretty-printed delivery signed over its own bytes ⇒ 200 + persisted; the same bytes signed over the re-serialised JSON ⇒ 401, nothing persisted", async () => {
		const token = acctToken();
		// Same JSON value, different bytes: whitespace the parser discards.
		const pretty = JSON.stringify(JSON.parse(payload), null, 2);
		expect(pretty).not.toBe(payload);
		expect(JSON.parse(pretty)).toEqual(JSON.parse(payload));

		const accepted = await receive(
			request(pretty, { signature: sign(pretty, token) }),
			"acct",
			token,
		);
		expect(accepted.status).toBe(200);
		expect(create).toHaveBeenCalledTimes(1);
		expect(create.mock.calls[0]?.[0]?.data).toEqual(
			expect.objectContaining({
				externalEventId: "evt-1",
				signatureValid: true,
			}),
		);

		// A verifier that re-serialises the parsed body before hashing would
		// accept THIS delivery: signed over the compact form, sent pretty.
		create.mockClear();
		const reserialised = JSON.stringify(JSON.parse(pretty));
		expect(reserialised).toBe(payload);
		const refused = await receive(
			request(pretty, { signature: sign(reserialised, token) }),
			"acct",
			token,
		);
		expect(refused.status).toBe(401);
		expect(create).not.toHaveBeenCalled();
	});
});

describe("body read order (rev414 R3)", () => {
	it("an unknown token is refused WITHOUT the body being read; a known token reads it", async () => {
		const bodyOf = (text: string) => {
			let pulled = false;
			// highWaterMark 0: the stream pulls only when a READER asks — the
			// default of 1 would pre-fill once at construction and fake a read.
			const stream = new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						pulled = true;
						controller.enqueue(new TextEncoder().encode(text));
						controller.close();
					},
				},
				{ highWaterMark: 0 },
			);
			return { stream, wasPulled: () => pulled };
		};
		const stray = bodyOf(payload);
		const refused = await receive(
			new Request("http://test/api/webhooks/bitmovin/acct/x", {
				method: "POST",
				body: stray.stream,
				headers: { "x-forwarded-for": "10.1.0.1" },
				duplex: "half",
			} as RequestInit),
			"acct",
			newWebhookToken(),
		);
		expect(refused.status).toBe(404);
		expect(stray.wasPulled()).toBe(false);
		expect(create).not.toHaveBeenCalled();

		const token = acctToken();
		const known = bodyOf(payload);
		const accepted = await receive(
			new Request("http://test/api/webhooks/bitmovin/acct/x", {
				method: "POST",
				body: known.stream,
				headers: {
					"x-forwarded-for": "10.1.0.2",
					"bitmovin-signature": sign(payload, token),
				},
				duplex: "half",
			} as RequestInit),
			"acct",
			token,
		);
		expect(accepted.status).toBe(200);
		expect(known.wasPulled()).toBe(true);
	});
});

describe("heartbeat dedup (X0 defence)", () => {
	it("keeps an authorized historical hook bound without stamping its replacement registration", async () => {
		const token = hbToken();
		const body = JSON.stringify({
			eventType: "LIVE_ENCODING_HEARTBEAT",
			webhookId: "0a704021-a067-12b7-81a0-7aa96ede7789",
			encoding: { id: "525a5c3b-7116-448e-ad00-4830a509b709" },
			value: { timestamp: NOW.toISOString() },
		});
		const prior = vi.fn().mockResolvedValue({ id: "prior-verified-event" });
		const stamp = vi.fn();
		const context = () =>
			({
				...ctx(),
				prisma: {
					...ctx().prisma,
					webhookRegistration: {
						findFirst: vi.fn().mockResolvedValue(null),
						updateMany: stamp,
					},
					liveChannelRun: {
						findFirst: vi
							.fn()
							.mockResolvedValue({ id: "historically-matched-run" }),
					},
					webhookEvent: { ...ctx().prisma.webhookEvent, findFirst: prior },
				},
			}) as unknown as ServerContext;
		const response = await receive(
			request(body, { signature: sign(body, token) }),
			"hb",
			token,
			context,
		);
		expect(response.status).toBe(200);
		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				liveChannelRunId: "historically-matched-run",
				signatureValid: true,
				processedAt: NOW,
			}),
		});
		expect(stamp).not.toHaveBeenCalled();
		prior.mockClear();
		create.mockClear();
		expect((await receive(request(body), "hb", token, context)).status).toBe(
			401,
		);
		expect(prior).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
	});
	it("binds a verified real heartbeat to its registered account's run and redacts ingestion secrets", async () => {
		const token = hbToken();
		const body = JSON.stringify({
			eventType: "LIVE_ENCODING_HEARTBEAT",
			webhookId: "0a704021-a067-12b7-81a0-7aa96ede7789",
			encoding: { id: "525a5c3b-7116-448e-ad00-4830a509b709" },
			value: {
				timestamp: NOW.toISOString(),
				ingest: {
					status: "CONNECTED",
					rtmpUserIngestInfo: { streamKey: "SYNTHETIC_SECRET_CANARY" },
				},
			},
		});
		const registration = vi.fn().mockResolvedValue({
			id: "registered-hb",
			bitmovinAccountId: "account-1",
		});
		const findRun = vi.fn().mockResolvedValue({ id: "matched-run" });
		const stamp = vi.fn().mockResolvedValue({ count: 1 });
		const context = () =>
			({
				...ctx(),
				prisma: {
					...ctx().prisma,
					webhookRegistration: { findFirst: registration, updateMany: stamp },
					liveChannelRun: { findFirst: findRun },
				},
			}) as unknown as ServerContext;
		const response = await receive(
			request(body, { signature: sign(body, token) }),
			"hb",
			token,
			context,
		);
		expect(response.status).toBe(200);
		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				liveChannelRunId: "matched-run",
				receivedAt: NOW,
				processedAt: NOW,
				signatureValid: true,
			}),
		});
		expect(JSON.stringify(create.mock.calls)).not.toContain(
			"SYNTHETIC_SECRET_CANARY",
		);
		expect(stamp).toHaveBeenCalledWith({
			where: {
				id: "registered-hb",
				providerWebhookId: "0a704021-a067-12b7-81a0-7aa96ede7789",
			},
			data: { lastDeliveryAt: NOW },
		});
		create.mockClear();
		registration.mockClear();
		findRun.mockClear();
		stamp.mockClear();
		expect((await receive(request(body), "hb", token, context)).status).toBe(
			401,
		);
		expect(create).not.toHaveBeenCalled();
		expect(registration).not.toHaveBeenCalled();
		expect(findRun).not.toHaveBeenCalled();
		expect(stamp).not.toHaveBeenCalled();
	});

	it("an hb push owns NO dedup slot until the envelope is pinned: two pushes with the same id both persist", async () => {
		const token = hbToken();
		const body = JSON.stringify({ id: "hb-stable-id", timestamp: 1 });
		// The database's @unique on externalEventId, emulated: a repeated
		// non-null id is a P2002, which the receiver answers as duplicate.
		const seen = new Set<string>();
		create.mockImplementation(
			async (args: { data: { externalEventId?: string } }) => {
				const id = args.data.externalEventId;
				if (id !== undefined && id !== null) {
					if (seen.has(id))
						throw Object.assign(new Error("dup"), { code: "P2002" });
					seen.add(id);
				}
				return { id: "row-hb" };
			},
		);
		for (const _ of [1, 2]) {
			const res = await receive(
				request(body, { signature: sign(body, token) }),
				"hb",
				token,
			);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				accepted: true,
				verified: true,
				scope: "hb",
			});
		}
		expect(create).toHaveBeenCalledTimes(2);
		for (const call of create.mock.calls) {
			const data = call[0]?.data as Record<string, unknown>;
			expect(data.eventType).toBe("LIVE_ENCODING_HEARTBEAT");
			expect(data.externalEventId).toBeUndefined();
		}
	});
});
