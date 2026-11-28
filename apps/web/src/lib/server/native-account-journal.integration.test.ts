import { randomBytes, randomUUID } from "node:crypto";
import { AesGcmCipher } from "@bitovp/core";
import {
	createBitmovinAccountStore,
	createPrismaClient,
	createTenantPrismaClient,
} from "@bitovp/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	claimNativeOperation,
	getNativeOperation,
	listNativeOperations,
	NativeOperationConflict,
	nativeOperationDispatchBudget,
	ownsNativeResource,
	settleNativeOperation,
} from "./native-account-journal";

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const runtimeUrl = process.env.BITOVP_TENANT_TEST_APP_URL;

describe.runIf(!!adminUrl && !!runtimeUrl)(
	"provider settings receipts under RLS",
	() => {
		const admin = createPrismaClient(adminUrl);
		const zonedUrl = runtimeUrl ? new URL(runtimeUrl) : undefined;
		zonedUrl?.searchParams.set("options", "-c TimeZone=America/New_York");
		const runtime = createPrismaClient(zonedUrl?.toString());
		const organizationId = randomUUID();
		const foreignOrganizationId = randomUUID();
		const tenant = createTenantPrismaClient(runtime, organizationId);
		const foreign = createTenantPrismaClient(runtime, foreignOrganizationId);
		const accounts = createBitmovinAccountStore(
			tenant,
			new AesGcmCipher(randomBytes(32)),
		);
		let account: Awaited<ReturnType<typeof accounts.create>>;

		beforeAll(async () => {
			await admin.organization.createMany({
				data: [organizationId, foreignOrganizationId].map((id) => ({
					id,
					slug: id,
					name: "Provider settings fixture",
				})),
			});
			account = await accounts.create({
				label: "Studio",
				apiKey: "fixture-account",
			});
		});

		afterAll(async () => {
			await tenant.nativeEncodingOperation.deleteMany();
			await accounts.remove(account.id);
			await admin.organization.deleteMany({
				where: { id: { in: [organizationId, foreignOrganizationId] } },
			});
			await Promise.all([admin.$disconnect(), runtime.$disconnect()]);
		});

		function attempt(targetId: string | null = null) {
			return {
				id: randomUUID(),
				bitmovinAccountId: account.id,
				scopeVersion: account.resourceScopeVersion,
				fingerprint: randomBytes(32).toString("hex"),
				action: targetId
					? ("start-watch-folder" as const)
					: ("create-ftp-input" as const),
				targetId,
			};
		}

		it("claims one dispatch per key, retains the response, and fences ownership by tenant", async () => {
			expect(
				await runtime.$queryRaw`SELECT current_setting('TimeZone') AS zone`,
			).toEqual([{ zone: "America/New_York" }]);
			const pending = attempt();
			await tenant.$executeRaw`
				INSERT INTO "NativeEncodingOperation"
				("id", "bitmovinAccountId", "scopeVersion", "action", "fingerprint", "state", "updatedAt")
				VALUES (
					${pending.id}::uuid, ${pending.bitmovinAccountId}::uuid,
					${pending.scopeVersion}::uuid, ${pending.action}, ${pending.fingerprint},
					'PENDING', CURRENT_TIMESTAMP
				)
			`;
			const defaulted = await getNativeOperation(tenant, pending.id);
			if (!defaulted) throw new Error("missing receipt with database defaults");
			expect(
				await nativeOperationDispatchBudget(tenant, defaulted),
			).toBeGreaterThan(0);
			const submission = attempt();
			const claims = await Promise.all([
				claimNativeOperation(tenant, submission),
				claimNativeOperation(tenant, submission),
			]);
			const [first] = claims.filter((claim) => claim.send);
			expect(claims.filter((claim) => claim.send)).toHaveLength(1);
			if (!first) throw new Error("missing dispatch");
			expect(
				await nativeOperationDispatchBudget(tenant, first.row),
			).toBeGreaterThan(0);
			expect(Math.abs(Date.now() - first.row.createdAt.getTime())).toBeLessThan(
				10_000,
			);
			expect(
				await nativeOperationDispatchBudget(foreign, first.row),
			).toBeNull();
			const providerId = randomUUID();
			await settleNativeOperation(tenant, first.row, {
				state: "ACCEPTED",
				providerId,
			});
			expect(await nativeOperationDispatchBudget(tenant, first.row)).toBeNull();
			await expect(
				claimNativeOperation(tenant, {
					...submission,
					fingerprint: randomBytes(32).toString("hex"),
				}),
			).rejects.toBeInstanceOf(NativeOperationConflict);
			const replay = await claimNativeOperation(tenant, submission);
			expect(replay).toMatchObject({
				send: false,
				row: { state: "ACCEPTED", providerId },
			});
			expect(
				await ownsNativeResource(
					tenant,
					submission,
					submission.action,
					providerId,
				),
			).toBe(true);
			expect(
				await ownsNativeResource(
					foreign,
					submission,
					submission.action,
					providerId,
				),
			).toBe(false);
			expect(await getNativeOperation(foreign, submission.id)).toBeNull();
			expect(
				await listNativeOperations(foreign, {
					bitmovinAccountId: account.id,
					scopeVersion: account.resourceScopeVersion,
				}),
			).toEqual([]);
		});

		it("serializes competing commands for a target and never resends an indeterminate operation", async () => {
			const target = randomUUID();
			const pending = attempt(target);
			const first = await claimNativeOperation(tenant, pending);
			const stop = { ...attempt(target), action: "stop-watch-folder" as const };
			await expect(claimNativeOperation(tenant, stop)).rejects.toThrow(
				"already running",
			);
			await tenant.nativeEncodingOperation.updateMany({
				where: { id: pending.id },
				data: { createdAt: new Date(0) },
			});
			expect(await nativeOperationDispatchBudget(tenant, first.row)).toBeNull();
			expect((await claimNativeOperation(tenant, stop)).send).toBe(true);
			const replay = await claimNativeOperation(tenant, pending);
			expect(replay).toMatchObject({ send: false, row: { state: "UNKNOWN" } });
			await expect(
				settleNativeOperation(tenant, first.row, {
					state: "ACCEPTED",
					providerId: target,
				}),
			).rejects.toBeInstanceOf(NativeOperationConflict);
		});

		it("refuses to claim after the credential scope used by the preflight changes", async () => {
			const old = attempt();
			const first = await claimNativeOperation(tenant, old);
			expect(
				await nativeOperationDispatchBudget(tenant, first.row),
			).toBeGreaterThan(0);
			account = await accounts.update(account.id, {
				apiKey: "replacement-default-account",
			});
			expect(account.resourceScopeVersion).not.toBe(old.scopeVersion);
			expect(await nativeOperationDispatchBudget(tenant, first.row)).toBeNull();
			await expect(
				claimNativeOperation(tenant, { ...old, id: randomUUID() }),
			).rejects.toThrow("account changed");
		});
	},
);
