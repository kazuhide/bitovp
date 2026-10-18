import type { Prisma } from "../generated/client";
import {
	type AppPrismaClient,
	type AppTransactionClient,
	getPrisma,
} from "./client";
import { getTenantPrisma } from "./tenant-client";

type IdentityModel =
	| "user"
	| "organization"
	| "membership"
	| "setupCode"
	| "platformSetting";
export type IdentityTransactionClient = Pick<
	AppTransactionClient,
	IdentityModel
>;
export type IdentityPrismaClient = IdentityTransactionClient & {
	$transaction<T>(
		callback: (tx: IdentityTransactionClient) => Promise<T>,
		options?: {
			maxWait?: number;
			timeout?: number;
			isolationLevel?: Prisma.TransactionIsolationLevel;
		},
	): Promise<T>;
};
const IDENTITY_MODELS = new Set([
	"user",
	"organization",
	"membership",
	"setupCode",
	"platformSetting",
]);

/** No tenant delegates/raw SQL are reachable through this pre-organization capability. */
export function getIdentityPrisma(): IdentityPrismaClient {
	const base = getPrisma();
	const restrict = (
		source: AppPrismaClient | AppTransactionClient,
		transaction: boolean,
	): IdentityTransactionClient =>
		new Proxy(
			{},
			{
				get(_target, key) {
					if (typeof key !== "string" || key === "then") return undefined;
					if (IDENTITY_MODELS.has(key)) return source[key as IdentityModel];
					if (key === "$transaction" && !transaction) {
						return <T>(
							callback: (tx: IdentityTransactionClient) => Promise<T>,
							options?: {
								maxWait?: number;
								timeout?: number;
								isolationLevel?: Prisma.TransactionIsolationLevel;
							},
						) => {
							if (typeof callback !== "function")
								throw new Error(
									"Identity transactions require a restricted callback",
								);
							return base.$transaction(
								(tx) => callback(restrict(tx, true)),
								options,
							);
						};
					}
					throw new Error(
						`Operation ${key} is unavailable in the identity context`,
					);
				},
			},
		) as IdentityTransactionClient;
	return restrict(base, false) as IdentityPrismaClient;
}

export type AuthenticationToken = {
	id: string;
	tokenHash: string;
	role: string;
	revokedAt: Date | null;
	expiresAt: Date | null;
	organizationId: string;
	createdBy: string | null;
	userId: string | null;
};

/** Fixed-column SECURITY DEFINER lookup: no public generic RLS bypass client. */
export async function resolveApiTokenForAuthentication(
	prefix: string,
): Promise<AuthenticationToken | null> {
	if (!/^[A-Za-z0-9_-]{8}$/.test(prefix)) return null;
	const rows = await getPrisma().$queryRaw<
		AuthenticationToken[]
	>`SELECT * FROM bitovp_auth_token(${prefix})`;
	return rows.length === 1 ? (rows[0] ?? null) : null;
}

export async function touchApiTokenForAuthentication(
	tokenId: string,
	organizationId: string,
): Promise<void> {
	await getTenantPrisma(organizationId).apiToken.update({
		where: { id: tokenId },
		data: { lastUsedAt: new Date() },
	});
}

/** The registered token determines the organization; request JSON never does. */
export async function resolveWebhookOrganization(
	tokenHash: string,
): Promise<string | null> {
	if (!/^[0-9a-f]{64}$/i.test(tokenHash)) return null;
	const rows = await getPrisma().$queryRaw<
		{ organizationId: string }[]
	>`SELECT * FROM bitovp_webhook_organization(${tokenHash})`;
	return rows.length === 1 ? (rows[0]?.organizationId ?? null) : null;
}
