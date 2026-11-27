import { randomBytes, randomUUID } from "node:crypto";
import { AesGcmCipher } from "@bitovp/core";
import {
	type AppPrismaClient,
	createBitmovinAccountStore,
	createCredentialStore,
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
import { createNativeCodecSchema } from "@/lib/native-codec-configurations";
import * as auth from "@/lib/server/context";
import { createRequestIdentity } from "@/lib/server/create-request";
import { reserveCodecCreate } from "@/lib/server/native-codec-journal";
import { auditedOperationCases } from "../../../../../../../scripts/api-coverage-test-cases";
import { DELETE, GET, PATCH, POST } from "./route";

const auditCases = [
	{
		codec: "dts",
		family: "audio",
		type: "DTS",
		fields: { bitrate: 384000, rate: 48000, mode: "DIGITAL_SURROUND" },
	},
	{
		codec: "dts-passthrough",
		family: "audio",
		type: "DTS_PASSTHROUGH",
		fields: {},
	},
	{
		codec: "dtsx",
		family: "audio",
		type: "DTSX",
		fields: { bitrate: 384000, channelLayout: "5.1.4" },
	},
	{ codec: "mp2", family: "audio", type: "MP2", fields: { bitrate: 128000 } },
	{
		codec: "mp3",
		family: "audio",
		type: "MP3",
		fields: { bitrate: 128000, rate: 44100 },
	},
	{
		codec: "vorbis",
		family: "audio",
		type: "VORBIS",
		fields: { bitrate: 96000 },
	},
	{
		codec: "dvb-subtitle",
		family: "subtitles",
		type: "DVB_SUBTITLE",
		fields: {},
	},
	{
		codec: "h262",
		family: "video",
		type: "H262",
		fields: {
			profile: "MPEG2_422",
			bitrate: 50000000,
			width: 1920,
			height: 1080,
			rate: 25,
		},
	},
	{
		codec: "mjpeg",
		family: "video",
		type: "MJPEG",
		fields: { width: 1280, height: 720, rate: 24, qScale: 3 },
	},
	{
		codec: "vp8",
		family: "video",
		type: "VP8",
		fields: { bitrate: 2500000, width: 1280, height: 720 },
	},
] as const;
const mp3 = auditCases[4];
type Case = (typeof auditCases)[number];
const endpoint = ({ family, codec }: Case) =>
	`/encoding/configurations/${family}/${codec}`;
const path = "http://fixture.invalid/api/encoding-native/codecs";
const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const runtimeUrl = process.env.BITOVP_TENANT_TEST_APP_URL;

function request(
	method: "POST" | "DELETE" | "PATCH",
	body: object,
	key?: string,
) {
	return new Request(path, {
		method,
		headers: {
			"content-type": "application/json",
			...(key && { "Idempotency-Key": key }),
		},
		body: JSON.stringify(body),
	});
}

function success(result: object, status = 200) {
	return Response.json({ status: "SUCCESS", data: { result } }, { status });
}

function absent() {
	return Response.json(
		{
			status: "ERROR",
			data: { code: 1001, message: "Not found", developerMessage: "Not found" },
		},
		{ status: 404 },
	);
}

function gate() {
	let resolve = () => {};
	const waiting = new Promise<void>((done) => {
		resolve = done;
	});
	return { waiting, resolve };
}

describe.runIf(!!adminUrl && !!runtimeUrl)(
	"managed codec configuration lifecycle under RLS",
	() => {
		const admin = createPrismaClient(adminUrl);
		const runtime = createPrismaClient(runtimeUrl);
		const ownOrg = randomUUID();
		const foreignOrg = randomUUID();
		const upstream = randomUUID();
		const own = createTenantPrismaClient(runtime, ownOrg);
		const foreign = createTenantPrismaClient(runtime, foreignOrg);
		const cipher = new AesGcmCipher(randomBytes(32));
		const localStore = createBitmovinAccountStore(own, cipher);
		const foreignStore = createBitmovinAccountStore(foreign, cipher);
		type Account = Awaited<ReturnType<typeof localStore.create>>;
		let account: Account;
		let other: Account;
		const provider = vi.fn();

		function tenant(
			db: AppPrismaClient,
			organizationId: string,
			role: "ADMIN" | "OPERATOR" = "ADMIN",
			isImpersonating = false,
		) {
			const store = createBitmovinAccountStore(db, cipher);
			vi.spyOn(auth, "getServerContext").mockResolvedValue({
				prisma: db,
				cipher,
				bitmovinAccounts: store,
				credentials: createCredentialStore(db, cipher),
				tenant: {
					organizationId,
					role,
					actorRole: role,
					isImpersonating,
					actorUserId: null,
					effectiveUserId: null,
					platformOwner: false,
					organizationName: "Fixture",
					targetDisplayName: null,
					actor: "token:fixture",
				},
			});
			return store;
		}

		beforeAll(async () => {
			await admin.organization.createMany({
				data: [ownOrg, foreignOrg].map((id) => ({
					id,
					name: "Managed codec fixture",
					slug: id,
				})),
			});
			account = await localStore.create({
				label: "Fixture",
				apiKey: "fixture-only",
				tenantOrgId: upstream,
			});
			other = await foreignStore.create({
				label: "Other fixture",
				apiKey: "foreign-only",
				tenantOrgId: upstream,
			});
		});
		beforeEach(async () => {
			const refreshed = await localStore.update(account.id, {
				tenantOrgId: upstream,
			});
			account = refreshed;
			tenant(own, ownOrg);
			provider.mockReset();
			vi.stubGlobal("fetch", provider);
		});
		afterEach(async () => {
			vi.restoreAllMocks();
			vi.unstubAllGlobals();
			for (const db of [own, foreign]) {
				await db.nativeCodecConfiguration.deleteMany();
				await db.auditLog.deleteMany();
			}
		});
		afterAll(async () => {
			await localStore.remove(account.id);
			await foreignStore.remove(other.id);
			await admin.organization.deleteMany({
				where: { id: { in: [ownOrg, foreignOrg] } },
			});
			await Promise.all([admin.$disconnect(), runtime.$disconnect()]);
		});

		const scope = (acc = account) => ({
			bitmovinAccountId: acc.id,
			scopeVersion: acc.resourceScopeVersion,
		});
		const body = (testCase: Case = mp3) => ({
			...scope(),
			name: "Fixture codec",
			codec: testCase.codec,
			...testCase.fields,
		});
		const command = (id: string, providerId: string, acc = account) => ({
			...scope(acc),
			id,
			confirmProviderId: providerId,
		});

		function fixture(testCase: Case = mp3) {
			const providerId = randomUUID();
			const providerTenant = account.tenantOrgId;
			const base = `/v1${endpoint(testCase)}`;
			const detail = `${base}/${providerId}`;
			const calls: string[] = [];
			let remote: Record<string, unknown> | undefined;
			const faults: {
				create?: () => Promise<Response> | Response;
				remove?: () => Promise<Response> | Response;
				metadata?: () => Response;
				list?: () => Response;
			} = {};
			provider.mockImplementation(async (url: string, init: RequestInit) => {
				const { pathname, searchParams } = new URL(url);
				const method = init.method?.toUpperCase();
				const call = `${method} ${pathname}`;
				calls.push(call);
				expect(new Headers(init.headers).get("X-Tenant-Org-Id")).toBe(
					providerTenant,
				);
				expect(new Headers(init.headers).get("X-Api-Key")).toBe("fixture-only");
				if (call === `POST ${base}`) {
					const sent = JSON.parse(String(init.body));
					expect(sent.name).toMatch(/^Fixture codec \(BitOVP [0-9a-f]{24}\)$/);
					expect(sent.customData.bitovpNativeCodec.ownerToken).toMatch(
						/^[0-9a-f-]{36}$/,
					);
					expect(sent).toMatchObject(testCase.fields);
					if (testCase.codec === "dtsx") {
						expect(sent).toMatchObject({
							rate: 48000,
							ottLoudnessMode: "DTSX_OTT_LOUDNESS_DETECT",
						});
					}
					expect(sent).not.toHaveProperty("bitmovinAccountId");
					expect(sent).not.toHaveProperty("scopeVersion");
					remote = { ...sent, type: testCase.type, id: providerId };
					return faults.create
						? await faults.create()
						: success({ ...remote, secret: "not-for-client" }, 201);
				}
				if (call === `GET ${base}`) {
					expect(searchParams.get("name")).toBe(remote?.name);
					expect(searchParams.get("limit")).toBe("2");
					expect(searchParams.get("offset")).toBe("0");
					return (
						faults.list?.() ??
						success({
							offset: 0,
							totalCount: remote ? 1 : 0,
							items: remote ? [remote] : [],
						})
					);
				}
				if (call === `GET ${detail}`)
					return remote ? success(remote) : absent();
				if (call === `GET ${detail}/customData`)
					return (
						faults.metadata?.() ?? success({ customData: remote?.customData })
					);
				if (call === `DELETE ${detail}`) {
					if (faults.remove) return await faults.remove();
					remote = undefined;
					return success({ id: providerId });
				}
				throw new Error("Unexpected provider SDK route in fixture");
			});
			return {
				providerId,
				base,
				detail,
				calls,
				faults,
				drop: () => {
					remote = undefined;
				},
			};
		}

		it.each(
			auditedOperationCases(
				import.meta.url,
				"managed-native-codec-lifecycle",
				auditCases,
				(row) => [
					`POST ${endpoint(row)}`,
					`DELETE ${endpoint(row)}/{configuration_id}`,
				],
			),
		)("creates and removes a managed $codec configuration using the typed provider routes", async (row) => {
			const { providerId, base, detail, calls } = fixture(row);
			const id = randomUUID();
			const created = await POST(request("POST", body(row), id));
			expect(created.status).toBe(201);
			expect(await created.json()).toEqual({
				id,
				providerId,
				name: "Fixture codec",
				codec: row.codec,
				state: "ACTIVE",
				canAct: true,
				canResumeCreate: false,
				canRetryDelete: false,
			});
			const query = new URLSearchParams({ bitmovinAccountId: account.id });
			const listed = await (await GET(new Request(`${path}?${query}`))).json();
			expect(listed.rows).toHaveLength(1);
			expect(listed.rows[0]).not.toHaveProperty("ownerToken");
			expect(listed.rows[0]).not.toHaveProperty("requestSha256");
			expect(listed.rows[0]).not.toHaveProperty("pendingCreateRequest");
			expect(listed.rows[0]).not.toHaveProperty("providerScopeIdentity");
			const removed = await DELETE(request("DELETE", command(id, providerId)));
			expect(removed.status).toBe(200);
			expect(await removed.json()).toMatchObject({
				state: "REMOVED",
				id,
				providerId,
			});
			expect(calls).toEqual([
				`POST ${base}`,
				`GET ${detail}`,
				`GET ${detail}/customData`,
				`DELETE ${detail}`,
			]);
			expect((await POST(request("POST", body(row), id))).status).toBe(410);
			expect(
				(await DELETE(request("DELETE", command(id, providerId)))).status,
			).toBe(200);
			expect(calls).toHaveLength(4);
		});

		it("reserves a single provider create and delete across concurrent requests", async () => {
			const { providerId, calls, faults } = fixture();
			const key = randomUUID();
			const sent = gate();
			const settle = gate();
			faults.create = async () => {
				sent.resolve();
				await settle.waiting;
				return success({ id: providerId, type: "MP3" }, 201);
			};
			const accepted = POST(request("POST", body(), key));
			try {
				await sent.waiting;
				const concurrent = await POST(request("POST", body(), key));
				expect(concurrent.status).toBe(202);
				expect(await concurrent.json()).toMatchObject({ state: "CREATING" });
				expect(calls.filter((call) => call.startsWith("POST "))).toHaveLength(
					1,
				);
			} finally {
				settle.resolve();
			}
			expect((await accepted).status).toBe(201);
			const deleting = gate();
			const deleted = gate();
			faults.remove = async () => {
				deleting.resolve();
				await deleted.waiting;
				return success({ id: providerId });
			};
			const sentDelete = DELETE(request("DELETE", command(key, providerId)));
			try {
				await deleting.waiting;
				const concurrent = await DELETE(
					request("DELETE", command(key, providerId)),
				);
				expect(concurrent.status).toBe(202);
				expect(await concurrent.json()).toMatchObject({ state: "DELETING" });
				expect(calls.filter((call) => call.startsWith("DELETE "))).toHaveLength(
					1,
				);
			} finally {
				deleted.resolve();
			}
			expect((await sentDelete).status).toBe(200);
		});

		it.each([
			"POST",
			"PATCH",
		] as const)("resumes an interrupted reservation with %s before any provider dispatch", async (method) => {
			const { providerId, base, calls } = fixture();
			const id = randomUUID();
			const input = body();
			const submission = request("POST", input, id);
			const identity = createRequestIdentity(submission, input);
			if (!identity) throw new Error("Missing fixture idempotency key");
			await reserveCodecCreate(
				own,
				createNativeCodecSchema.parse(input),
				id,
				identity.requestSha256,
			);
			const read = await PATCH(request("PATCH", { ...scope(), id }));
			expect(read.status).toBe(202);
			expect(await read.json()).toMatchObject({
				state: "CREATING",
				canResumeCreate: true,
			});
			expect(calls).toEqual([]);
			const created =
				method === "POST"
					? await POST(submission)
					: await PATCH(request("PATCH", { ...scope(), id, resume: true }));
			expect(created.status).toBe(201);
			expect(await created.json()).toMatchObject({
				state: "ACTIVE",
				providerId,
				canResumeCreate: false,
			});
			expect(calls).toEqual([`POST ${base}`]);
			expect(
				(await own.nativeCodecConfiguration.findFirst({ where: { id } }))
					?.pendingCreateRequest,
			).toBeNull();
		});

		it("does not resend a claimed creation even if a lookup is still empty", async () => {
			const id = randomUUID();
			provider.mockRejectedValueOnce(new Error("Connection lost"));
			provider.mockResolvedValueOnce(
				success({ offset: 0, totalCount: 0, items: [] }),
			);
			const created = await POST(request("POST", body(), id));
			expect(created.status).toBe(202);
			expect(await created.json()).toMatchObject({ canResumeCreate: false });
			const reconcile = await PATCH(
				request("PATCH", { ...scope(), id, resume: true }),
			);
			expect(reconcile.status).toBe(202);
			expect((await POST(request("POST", body(), id))).status).toBe(202);
			expect(provider.mock.calls.map(([, init]) => init.method)).toEqual([
				"POST",
				"GET",
			]);
		});

		it("reconciles only after restoring the explicit provider tenant", async () => {
			const { providerId, calls, faults } = fixture();
			const id = randomUUID();
			const original = account.resourceScopeVersion;
			faults.create = () => success({ id: providerId, type: "H264" }, 201);
			expect((await POST(request("POST", body(), id))).status).toBe(202);
			account = await localStore.update(account.id, {
				tenantOrgId: randomUUID(),
			});
			expect((await PATCH(request("PATCH", { ...scope(), id }))).status).toBe(
				409,
			);
			expect(calls).toHaveLength(1);
			account = await localStore.update(account.id, { tenantOrgId: upstream });
			expect(account.resourceScopeVersion).not.toBe(original);
			const query = new URLSearchParams({ bitmovinAccountId: account.id });
			const listed = await (await GET(new Request(`${path}?${query}`))).json();
			expect(listed.rows[0]).toMatchObject({ id, canAct: true });
			const verified = await PATCH(request("PATCH", { ...scope(), id }));
			expect(verified.status).toBe(200);
			expect(await verified.json()).toMatchObject({
				state: "ACTIVE",
				providerId,
			});
			expect(calls).toHaveLength(4);
		});

		it("preserves default-scope recovery across tenant edits and refuses a different credential", async () => {
			account = await localStore.update(account.id, { tenantOrgId: null });
			const { providerId, calls, faults, drop } = fixture();
			const id = randomUUID();
			expect((await POST(request("POST", body(), id))).status).toBe(201);
			faults.remove = () => success({ id: randomUUID() });
			expect(
				(await DELETE(request("DELETE", command(id, providerId)))).status,
			).toBe(202);
			drop();
			account = await localStore.update(account.id, {
				tenantOrgId: randomUUID(),
			});
			account = await localStore.update(account.id, { tenantOrgId: null });
			const verified = await PATCH(request("PATCH", { ...scope(), id }));
			expect(verified.status).toBe(200);
			expect(await verified.json()).toMatchObject({ state: "REMOVED" });
			expect(calls).toHaveLength(5);
			try {
				account = await localStore.update(account.id, {
					apiKey: "fixture-rotated",
				});
				expect((await PATCH(request("PATCH", { ...scope(), id }))).status).toBe(
					409,
				);
				expect(calls).toHaveLength(5);
			} finally {
				account = await localStore.update(account.id, {
					apiKey: "fixture-only",
				});
			}
		});

		it("reconciles only an exact stamped configuration after a malformed create response", async () => {
			const { providerId, calls, faults } = fixture();
			const id = randomUUID();
			faults.create = () => success({ id: providerId, type: "H264" }, 201);
			const accepted = await POST(request("POST", body(), id));
			expect(accepted.status).toBe(202);
			expect(await accepted.json()).toMatchObject({
				state: "CREATING",
				providerId: null,
			});
			expect((await POST(request("POST", body(), id))).status).toBe(202);
			expect(
				(await POST(request("POST", { ...body(), rate: 48000 }, id))).status,
			).toBe(409);
			expect(calls).toHaveLength(1);
			const pending = { ...scope(), id };
			faults.list = () => success({ offset: 0, totalCount: 2, items: [] });
			expect((await PATCH(request("PATCH", pending))).status).toBe(202);
			faults.list = undefined;
			faults.metadata = () =>
				success({
					customData: { bitovpNativeCodec: { ownerToken: randomUUID() } },
				});
			expect((await PATCH(request("PATCH", pending))).status).toBe(202);
			expect(
				(await own.nativeCodecConfiguration.findFirst({ where: { id } }))
					?.providerId,
			).toBeNull();
			faults.metadata = undefined;
			const verified = await PATCH(request("PATCH", pending));
			expect(verified.status).toBe(200);
			expect(await verified.json()).toMatchObject({
				state: "ACTIVE",
				providerId,
			});
			expect(calls.filter((call) => call.startsWith("POST "))).toHaveLength(1);
		});

		it("confirms ambiguous removal by typed resource absence and preserves other uncertainty", async () => {
			const { providerId, calls, faults, drop } = fixture();
			const id = randomUUID();
			expect((await POST(request("POST", body(), id))).status).toBe(201);
			faults.remove = () => success({ id: randomUUID() });
			const deletion = await DELETE(request("DELETE", command(id, providerId)));
			expect(deletion.status).toBe(202);
			expect(await deletion.json()).toMatchObject({ state: "DELETING" });
			const unchanged = await DELETE(
				request("DELETE", command(id, providerId)),
			);
			expect(unchanged.status).toBe(202);
			const pending = { ...scope(), id };
			faults.metadata = absent;
			expect((await PATCH(request("PATCH", pending))).status).toBe(202);
			drop();
			const removed = await PATCH(request("PATCH", pending));
			expect(removed.status).toBe(200);
			expect(await removed.json()).toMatchObject({ state: "REMOVED" });
			expect(calls.filter((call) => call.startsWith("DELETE "))).toHaveLength(
				1,
			);
		});

		it("refuses foreign receipts, unconfirmed identities, and changed provider scopes", async () => {
			const { providerId, calls } = fixture();
			const id = randomUUID();
			expect((await POST(request("POST", body(), id))).status).toBe(201);
			expect(
				(await DELETE(request("DELETE", command(id, randomUUID())))).status,
			).toBe(409);
			tenant(foreign, foreignOrg);
			expect(
				(await DELETE(request("DELETE", command(id, providerId, other))))
					.status,
			).toBe(404);
			expect(
				await foreign.nativeCodecConfiguration.findFirst({ where: { id } }),
			).toBeNull();
			tenant(own, ownOrg);
			const changed = await localStore.update(account.id, {
				tenantOrgId: randomUUID(),
			});
			expect(
				(await DELETE(request("DELETE", command(id, providerId)))).status,
			).toBe(409);
			expect(
				(await DELETE(request("DELETE", command(id, providerId, changed))))
					.status,
			).toBe(409);
			expect(calls).toHaveLength(1);
		});

		it("checks for scope changes between credential resolution and journal reservation", async () => {
			const store = tenant(own, ownOrg);
			const original = store.revealForEncoding;
			vi.spyOn(store, "revealForEncoding").mockImplementation(async (id) => {
				const captured = await original(id);
				await localStore.update(id, { tenantOrgId: randomUUID() });
				return captured;
			});
			expect((await POST(request("POST", body(), randomUUID()))).status).toBe(
				409,
			);
			expect(provider).not.toHaveBeenCalled();
			expect(await own.nativeCodecConfiguration.count()).toBe(0);
		});

		it("does not dispatch for insufficient role, impersonation, or invalid payloads", async () => {
			tenant(own, ownOrg, "OPERATOR");
			expect((await POST(request("POST", body(), randomUUID()))).status).toBe(
				403,
			);
			tenant(own, ownOrg, "ADMIN", true);
			expect((await POST(request("POST", body(), randomUUID()))).status).toBe(
				403,
			);
			tenant(own, ownOrg);
			expect(
				(
					await POST(
						request("POST", { ...body(), customData: {} }, randomUUID()),
					)
				).status,
			).toBe(400);
			expect(
				(
					await POST(
						request(
							"POST",
							{ ...body(auditCases[2]), bitrate: 128000 },
							randomUUID(),
						),
					)
				).status,
			).toBe(400);
			expect((await POST(request("POST", body()))).status).toBe(400);
			expect(provider).not.toHaveBeenCalled();
			expect(await own.nativeCodecConfiguration.count()).toBe(0);
		});
	},
);
