import { randomUUID } from "node:crypto";
import { cipherFromEnv } from "@bitovp/core";
import { VOD_INPUT_FAVORITES_KEY } from "@bitovp/core/vod-input-timeline";
import {
	type AppPrismaClient,
	createBitmovinAccountStore,
	createCredentialStore,
	createPrismaClient,
	createTenantPrismaClient,
} from "@bitovp/db";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { ServerContext } from "./context";
import {
	addVodInputFavorite,
	deleteVodInputFavorite,
	listVodInputFavorites,
} from "./vod-input-favorites";

const holder = vi.hoisted(() => ({
	context: null as unknown as ServerContext,
}));
vi.mock("./context", () => ({ getServerContext: async () => holder.context }));
const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;

describe.runIf(Boolean(adminUrl && appUrl))(
	"real PostgreSQL VOD fixed sources",
	() => {
		const org = randomUUID(),
			otherOrg = randomUUID();
		let admin: AppPrismaClient,
			app: AppPrismaClient,
			a: AppPrismaClient,
			b: AppPrismaClient;
		function use(prisma = a, organizationId = org) {
			const cipher = cipherFromEnv();
			holder.context = {
				prisma,
				cipher,
				credentials: createCredentialStore(prisma, cipher),
				bitmovinAccounts: createBitmovinAccountStore(prisma, cipher),
				tenant: {
					organizationId,
					actorUserId: null,
					effectiveUserId: null,
					role: "OPERATOR",
					actorRole: "OPERATOR",
					platformOwner: false,
					isImpersonating: false,
					organizationName: "Fixed source fixture",
					targetDisplayName: null,
					actor: "favorites-integration",
				},
			};
		}
		async function source(prisma = a) {
			const credential = await prisma.credential.create({
				data: {
					label: "Fixed source credential",
					provider: "AWS_S3",
					encryptedSecret: "unused-fixture-ciphertext",
				},
			});
			return {
				credentialId: credential.id,
				bucket: "input",
				objectKey: "intro.mp4",
				label: "Intro",
				kind: "VIDEO" as const,
			};
		}
		beforeAll(async () => {
			vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 23).toString("base64"));
			admin = createPrismaClient(adminUrl);
			app = createPrismaClient(appUrl);
			a = createTenantPrismaClient(app, org);
			b = createTenantPrismaClient(app, otherOrg);
			await admin.organization.createMany({
				data: [org, otherOrg].map((id) => ({
					id,
					name: "Fixed source integration",
					slug: `favorites-${id}`,
				})),
			});
		});
		beforeEach(async () => {
			await admin.appSetting.deleteMany({
				where: { organizationId: { in: [org, otherOrg] } },
			});
			use();
		});
		afterAll(async () => {
			try {
				if (admin) {
					const where = { organizationId: { in: [org, otherOrg] } };
					await admin.appSetting.deleteMany({ where });
					await admin.credential.deleteMany({ where });
					await admin.organization.deleteMany({
						where: { id: { in: [org, otherOrg] } },
					});
				}
			} finally {
				await app?.$disconnect();
				await admin?.$disconnect();
				vi.unstubAllEnvs();
			}
		});
		it("preserves every concurrent first-create addition and deduplicates identical retries", async () => {
			const input = await source();
			await Promise.all(
				[0, 1, 2, 3].map((n) =>
					addVodInputFavorite({ ...input, objectKey: `${n}.mp4` }),
				),
			);
			const saved = await listVodInputFavorites();
			expect(saved.favorites.map((item) => item.objectKey).sort()).toEqual([
				"0.mp4",
				"1.mp4",
				"2.mp4",
				"3.mp4",
			]);
			const retries = await Promise.all([
				addVodInputFavorite(input),
				addVodInputFavorite(input),
			]);
			expect(retries[0]?.id).toBe(retries[1]?.id);
			expect((await listVodInputFavorites()).favorites).toHaveLength(5);
		});
		it("merges concurrent add and delete against an existing JSONB row", async () => {
			const input = await source(),
				old = await addVodInputFavorite(input);
			await Promise.all([
				deleteVodInputFavorite(old.id),
				addVodInputFavorite({ ...input, objectKey: "new.mp4" }),
			]);
			expect(
				(await listVodInputFavorites()).favorites.map((item) => item.objectKey),
			).toEqual(["new.mp4"]);
		});
		it("isolates lists, IDs, raw rows and credential references across organizations", async () => {
			const input = await source(),
				saved = await addVodInputFavorite(input);
			use(b, otherOrg);
			expect(await listVodInputFavorites()).toEqual({ favorites: [] });
			await expect(addVodInputFavorite(input)).rejects.toMatchObject({
				status: 404,
				code: "SOURCE_CREDENTIAL_NOT_FOUND",
			});
			await deleteVodInputFavorite(saved.id);
			expect(
				await b.$queryRaw`SELECT "value" FROM "AppSetting" WHERE "key" = ${VOD_INPUT_FAVORITES_KEY}`,
			).toEqual([]);
			const roles = await app.$queryRaw<
				{ rolsuper: boolean; rolbypassrls: boolean }[]
			>`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
			expect(roles).toEqual([{ rolsuper: false, rolbypassrls: false }]);
			use();
			expect((await listVodInputFavorites()).favorites[0]?.id).toBe(saved.id);
		});
		it("revokes use after deleting the real credential while leaving a removable reference", async () => {
			const input = await source(),
				saved = await addVodInputFavorite(input);
			await a.credential.delete({ where: { id: input.credentialId } });
			expect(await listVodInputFavorites()).toMatchObject({
				favorites: [
					{
						id: saved.id,
						availability: "CREDENTIAL_UNAVAILABLE",
						inputKind: null,
					},
				],
			});
			await expect(addVodInputFavorite(input)).rejects.toMatchObject({
				code: "SOURCE_CREDENTIAL_NOT_FOUND",
			});
			await deleteVodInputFavorite(saved.id);
			expect(await listVodInputFavorites()).toEqual({ favorites: [] });
		});
		it("refuses corrupt persisted JSON without replacing or removing it", async () => {
			const input = await source(),
				broken = { schemaVersion: 1, items: "corrupt" };
			await a.appSetting.create({
				data: { key: VOD_INPUT_FAVORITES_KEY, value: broken },
			});
			await expect(listVodInputFavorites()).rejects.toMatchObject({
				code: "FAVORITES_INVALID",
			});
			await expect(addVodInputFavorite(input)).rejects.toMatchObject({
				code: "FAVORITES_INVALID",
			});
			await expect(deleteVodInputFavorite(randomUUID())).rejects.toMatchObject({
				code: "FAVORITES_INVALID",
			});
			expect(
				(
					await a.appSetting.findUniqueOrThrow({
						where: { key: VOD_INPUT_FAVORITES_KEY },
					})
				).value,
			).toEqual(broken);
		});
		it("enforces the bounded registry while allowing an existing reference to be retried", async () => {
			const input = await source(),
				items = Array.from({ length: 64 }, (_, n) => ({
					...input,
					id: randomUUID(),
					objectKey: `${n}.mp4`,
				}));
			await a.appSetting.create({
				data: {
					key: VOD_INPUT_FAVORITES_KEY,
					value: { schemaVersion: 1, items },
				},
			});
			await expect(addVodInputFavorite(input)).rejects.toMatchObject({
				code: "FAVORITES_LIMIT",
			});
			expect(
				(await addVodInputFavorite({ ...input, objectKey: "0.mp4" })).id,
			).toBe(items[0]?.id);
			expect((await listVodInputFavorites()).favorites).toHaveLength(64);
		});
	},
);
