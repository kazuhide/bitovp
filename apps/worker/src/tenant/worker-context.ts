import {
	type createCredentialStore,
	createPrismaClient,
	createTenantPrismaClient,
	DEFAULT_ORGANIZATION_ID,
	getIdentityPrisma,
	TENANT_ORGANIZATION,
} from "@bitovp/db";
import { createTenantConsumer } from "./consumer";
import { createTenantDispatcher } from "./dispatch";
import { contextualTenantPrisma, requireOrganizationId } from "./scope";

export function createWorkerTenantContext(databaseUrl: string) {
	const basePrisma = createPrismaClient(databaseUrl);
	const tenantClients = new Map<
		string,
		ReturnType<typeof createTenantPrismaClient>
	>();
	const prisma = contextualTenantPrisma((organizationId) => {
		let client = tenantClients.get(organizationId);
		if (!client) {
			client = createTenantPrismaClient(basePrisma, organizationId);
			tenantClients.set(organizationId, client);
		}
		return client;
	}, TENANT_ORGANIZATION);
	const identityPrisma = getIdentityPrisma();
	const forEachOrganization = createTenantDispatcher(identityPrisma);
	const isOrganizationActive = async (
		organizationId = requireOrganizationId(),
	) =>
		(
			await identityPrisma.organization.findUnique({
				where: { id: organizationId },
				select: { active: true },
			})
		)?.active === true;
	const consumeTenantJob = createTenantConsumer({
		prisma,
		forEachOrganization,
		isOrganizationActive,
		...(process.env.TENANT_MIGRATE_LEGACY_QUEUES === "1"
			? { legacyOrganizationId: DEFAULT_ORGANIZATION_ID }
			: {}),
	});
	return {
		basePrisma,
		prisma,
		identityPrisma,
		forEachOrganization,
		isOrganizationActive,
		consumeTenantJob,
	};
}

export function createWorkerStorageCredentialResolver(
	credentials: ReturnType<typeof createCredentialStore>,
) {
	return async (credentialId: string) => {
		const credential = await credentials.get(credentialId);
		if (!credential) throw new Error("Storage credential no longer exists");
		return {
			provider: credential.provider,
			config: (credential.config ?? {}) as Record<string, unknown>,
			secret: JSON.parse(
				await credentials.revealSecret(credentialId),
			) as Record<string, string>,
		};
	};
}
