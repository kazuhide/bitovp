import { randomUUID } from "node:crypto";
import {
	type AppPrismaClient,
	createPrismaClient,
	createTenantPrismaClient,
} from "@bitovp/db";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
	context: vi.fn(),
	enqueue: vi.fn(),
	seal: vi.fn(),
}));
vi.mock("@/lib/server/context", () => ({ getServerContext: mocks.context }));
vi.mock("@/lib/server/queue", () => ({
	getFeederQueue: () => ({ add: mocks.enqueue }),
}));
vi.mock("@/lib/server/storage", () => ({ sealSourceIdentity: mocks.seal }));

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;

describe.runIf(Boolean(adminUrl && appUrl))(
	"single-pass HTTP receipts in PostgreSQL",
	() => {
		const organizations = [randomUUID(), randomUUID()];
		let admin: AppPrismaClient;
		let app: AppPrismaClient;
		beforeAll(async () => {
			admin = createPrismaClient(adminUrl);
			app = createPrismaClient(appUrl);
			await admin.organization.createMany({
				data: organizations.map((id) => ({
					id,
					name: "Single-pass HTTP fixture",
					slug: id,
				})),
			});
		});

		beforeEach(() => {
			vi.clearAllMocks();
			vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
			mocks.seal.mockResolvedValue({
				ok: true,
				identity: { etag: '"fixture"', size: 4096 },
			});
		});

		afterEach(() => vi.unstubAllEnvs());
		afterAll(async () => {
			try {
				if (!admin) return;
				const where = { organizationId: { in: organizations } };
				await admin.createRequest.deleteMany({ where });
				await admin.liveChannel.deleteMany({ where });
				await admin.credential.deleteMany({ where });
				await admin.organization.deleteMany({
					where: { id: { in: organizations } },
				});
			} finally {
				await app?.$disconnect();
				await admin?.$disconnect();
			}
		});

		async function fixture(organizationId: string) {
			const prisma = createTenantPrismaClient(app, organizationId);
			const credential = await prisma.credential.create({
				data: {
					label: "Synthetic feeder input",
					provider: "AWS_S3",
					encryptedSecret: "fixture-unused",
				},
			});
			const encodingId = randomUUID();
			const channel = await prisma.liveChannel.create({
				data: {
					name: "Synthetic feeder input",
					status: "RUNNING",
					plan: {},
					bitmovinEncodingId: encodingId,
				},
			});
			await prisma.liveChannelRun.create({
				data: {
					liveChannelId: channel.id,
					seq: 1,
					status: "RUNNING",
					bitmovinEncodingId: encodingId,
					outputPrefix: "",
				},
			});
			mocks.context.mockResolvedValue({
				prisma,
				credentials: {
					get: (id: string) => prisma.credential.findUnique({ where: { id } }),
				},
			});
			const body = {
				liveChannelId: channel.id,
				source: {
					credentialId: credential.id,
					bucket: "fixture",
					key: "full.mp4",
				},
				protocol: "RTMP",
				target: { url: "rtmp://example.invalid/live", streamKey: "fixture" },
				playbackMode: "ONCE",
			};
			return {
				prisma,
				post: (key: string) =>
					POST(
						new Request("http://localhost/api/feeder-sessions", {
							method: "POST",
							headers: {
								"content-type": "application/json",
								"Idempotency-Key": key,
							},
							body: JSON.stringify(body),
						}),
					),
			};
		}

		async function race(
			posts: [() => Promise<Response>, () => Promise<Response>],
		) {
			let arrived = 0;
			let resume = () => {};
			const prepare = new Promise<void>((resolve) => {
				resume = resolve;
			});
			const simultaneousSeal = async () => {
				arrived += 1;
				await prepare;
				return { ok: true };
			};
			mocks.seal
				.mockImplementationOnce(simultaneousSeal)
				.mockImplementationOnce(simultaneousSeal);
			const both = Promise.all(posts.map((post) => post()));
			try {
				await vi.waitFor(() => expect(arrived).toBe(2));
			} finally {
				resume();
				await both;
			}
			return both;
		}

		it("binds simultaneous HTTP requests, EOF replays and deletion to one tenant receipt", async () => {
			const key = randomUUID();
			const first = await fixture(organizations[0] as string);
			const responses = await race([
				() => first.post(key),
				() => first.post(key),
			]);
			expect(responses.map((res) => res.status).sort()).toEqual([200, 201]);
			const [a, b] = await Promise.all(responses.map((res) => res.json()));
			expect(a.id).toEqual(expect.any(String));
			expect(a.id).toBe(b.id);
			expect(a.replayed ?? b.replayed).toBe(true);
			expect(await first.prisma.feederSession.count()).toBe(1);
			expect(
				await first.prisma.createRequest.count({
					where: { kind: "FEEDER_ONCE", requestKey: key },
				}),
			).toBe(1);
			expect(mocks.enqueue).toHaveBeenCalled();
			for (const [, payload, options] of mocks.enqueue.mock.calls) {
				expect(payload).toMatchObject({
					feederSessionId: a.id,
					action: "start",
				});
				expect(options.jobId).toBe(a.id);
			}
			mocks.enqueue.mockClear();
			await first.prisma.feederSession.update({
				where: { id: a.id },
				data: { status: "STOPPED", playbackDispatchedAt: new Date() },
			});
			const completed = await first.post(key);
			expect(completed.status).toBe(200);
			expect(await completed.json()).toMatchObject({
				id: a.id,
				status: "STOPPED",
				replayed: true,
			});
			await first.prisma.feederSession.delete({ where: { id: a.id } });
			const deleted = await first.post(key);
			expect(deleted.status).toBe(410);
			expect(mocks.enqueue).not.toHaveBeenCalled();

			const other = await fixture(organizations[1] as string);
			const independent = await other.post(key);
			expect(independent.status).toBe(201);
			expect((await independent.json()).id).not.toBe(a.id);
			expect(await first.prisma.feederSession.count()).toBe(0);
		});

		it("rolls back the receipt when an independent key loses the active-publisher race", async () => {
			const { prisma, post } = await fixture(organizations[0] as string);
			const keys = [randomUUID(), randomUUID()];
			const responses = await race([
				() => post(keys[0] as string),
				() => post(keys[1] as string),
			]);
			expect(responses.map((res) => res.status).sort()).toEqual([201, 409]);
			const winningIndex = responses.findIndex((res) => res.status === 201);
			const winner = await responses[winningIndex]?.json();
			const loser = await responses[1 - winningIndex]?.json();
			expect(loser.details.code).toBe("FEEDER_CHANNEL_OCCUPIED");
			const receipts = await prisma.createRequest.findMany({
				where: { kind: "FEEDER_ONCE", requestKey: { in: keys } },
				select: { requestKey: true, resourceId: true },
			});
			expect(receipts).toEqual([
				{ requestKey: keys[winningIndex], resourceId: winner.id },
			]);
			await prisma.feederSession.update({
				where: { id: winner.id },
				data: { status: "STOPPED" },
			});
			const accepted = await post(keys[1 - winningIndex] as string);
			expect(accepted.status).toBe(201);
		});
	},
);
