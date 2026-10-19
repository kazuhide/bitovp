import type { Prisma } from "../generated/client";
import {
	type AppPrismaClient,
	type AppTransactionClient,
	getPrisma,
} from "./client";
import { TENANT_MODEL_RELATIONS } from "./tenant-relations";
import {
	setStatementTimeout,
	transactionSettings,
} from "./transaction-settings";

export const DEFAULT_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
export const TENANT_ORGANIZATION = Symbol.for("bitovp.tenantOrganization");
const COMMAND = Symbol("tenant-command");
const GLOBAL_MODELS = new Set([
	"user",
	"organization",
	"membership",
	"setupCode",
	"platformSetting",
]);
const RAW_METHODS = new Set([
	"$queryRaw",
	"$executeRaw",
	"$queryRawUnsafe",
	"$executeRawUnsafe",
]);
const MODEL_METHODS = new Set([
	"findUnique",
	"findUniqueOrThrow",
	"findFirst",
	"findFirstOrThrow",
	"findMany",
	"create",
	"createMany",
	"createManyAndReturn",
	"update",
	"updateMany",
	"updateManyAndReturn",
	"upsert",
	"delete",
	"deleteMany",
	"count",
	"aggregate",
	"groupBy",
]);
type Operation = (tx: Record<string, unknown>) => Promise<unknown>;
type CommandState = { owner: object; started: boolean; execute: Operation };
export type TenantClientOptions = { readOnly?: boolean };

/** RLS covers DML, not TRUNCATE/DDL or changing the trusted transaction context. */
function assertScopedSql(args: unknown[]): void {
	const first = args[0];
	const sql =
		typeof first === "string"
			? first
			: Array.isArray(first)
				? first.join("?")
				: first && typeof first === "object" && "sql" in first
					? String(first.sql)
					: "";
	const code = sql
		.replace(
			/'(?:''|[^'])*'|--[^\r\n]*|\/\*[\s\S]*?\*\/|\$([A-Za-z_0-9]*)\$[\s\S]*?\$\1\$/g,
			" ",
		)
		.trim();
	if (
		!/^(SELECT|WITH|INSERT|UPDATE|DELETE)\b/i.test(code) ||
		/\b(TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|RESET|DISCARD|CALL|DO)\b|\bset_config"?\s*\(/i.test(
			code,
		) ||
		/;\s*\S/.test(code)
	) {
		throw new Error("Unsafe SQL is unavailable in a tenant context");
	}
	// Global identity tables have no tenant RLS policy. Their only application
	// capability is the restricted identity client and the fixed auth resolvers.
	if (
		/\b(User|Organization|Membership|SetupCode|PlatformSetting|bitovp_auth_token|bitovp_webhook_organization)\b/i.test(
			code,
		)
	) {
		throw new Error("Global identity SQL is unavailable in a tenant context");
	}
}

/** Every tenant model's organization relation, plus token/audit users, is global. */
function assertTenantProjection(args: unknown[]): void {
	const visit = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		const config = value as Record<string, unknown>;
		for (const mode of ["select", "include"] as const) {
			const projection = config[mode];
			if (!projection || typeof projection !== "object") continue;
			for (const [relation, nested] of Object.entries(projection)) {
				if (!nested) continue;
				if (relation === "organization" || relation === "user")
					throw new Error(
						"Global identity projections are unavailable in a tenant context",
					);
				visit(nested);
			}
		}
	};
	visit(args[0]);
}

/** Follow declared relation writes only; JSON plans/settings are application data. */
function assertTenantWrites(model: string, args: unknown[]): void {
	const record = (value: unknown): Record<string, unknown> | undefined =>
		value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	const visitData = (name: string, value: unknown): void => {
		if (Array.isArray(value)) {
			for (const data of value) visitData(name, data);
			return;
		}
		const data = record(value);
		if (!data) return;
		for (const [relation, target] of Object.entries(
			TENANT_MODEL_RELATIONS[name] ?? {},
		)) {
			if (!data[relation]) continue;
			if (GLOBAL_MODELS.has(target))
				throw new Error(
					"Global identity relation writes are unavailable in a tenant context",
				);
			const envelopes = Array.isArray(data[relation])
				? data[relation]
				: [data[relation]];
			for (const envelope of envelopes as unknown[]) {
				const operations = record(envelope);
				if (!operations) continue;
				visitData(target, operations.create);
				visitData(target, record(operations.createMany)?.data);
				for (const operation of [
					"update",
					"updateMany",
					"upsert",
					"connectOrCreate",
				]) {
					const writes = Array.isArray(operations[operation])
						? operations[operation]
						: [operations[operation]];
					for (const write of writes as unknown[]) {
						const input = record(write);
						if (!input) continue;
						if (operation === "upsert" || operation === "connectOrCreate") {
							visitData(target, input.create);
							visitData(target, input.update);
						} else visitData(target, input.data ?? input);
					}
				}
			}
		}
	};
	const input = record(args[0]);
	if (!input) return;
	visitData(model, input.data);
	visitData(model, input.create);
	visitData(model, input.update);
}

export function tenantOrganizationId(client: object): string | undefined {
	return (client as Record<symbol, string | undefined>)[TENANT_ORGANIZATION];
}

function checkedOrganizationId(value: string): string {
	if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) {
		throw new Error(
			"A valid organization id is required for tenant database access",
		);
	}
	return value.toLowerCase();
}

function settingsArgs(
	model: string,
	method: string,
	args: unknown[],
	organizationId: string,
): unknown[] {
	if (
		!["appSetting", "vmafExecutionProfile"].includes(model) ||
		!["findUnique", "findUniqueOrThrow", "update", "delete", "upsert"].includes(
			method,
		)
	)
		return args;
	const input = args[0] as { where?: Record<string, unknown> } | undefined;
	if (!input?.where) return args;
	const logical = model === "appSetting" ? "key" : "id";
	const value = input.where[logical];
	if (typeof value !== "string") return args;
	const { [logical]: _removed, ...rest } = input.where;
	return [
		{
			...input,
			where: {
				...rest,
				[`organizationId_${logical}`]: { organizationId, [logical]: value },
			},
		},
		...args.slice(1),
	];
}

async function setScope(
	tx: AppTransactionClient,
	organizationId: string,
	readOnly: boolean,
): Promise<void> {
	if (readOnly) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
	const roles = await tx.$queryRaw<
		{ rolsuper: boolean; rolbypassrls: boolean }[]
	>`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
	if (roles.length !== 1 || roles[0]?.rolsuper || roles[0]?.rolbypassrls) {
		throw new Error(
			"Tenant database access requires a non-superuser role without BYPASSRLS",
		);
	}
	await tx.$executeRaw`SELECT set_config('bitovp.organization_id', ${organizationId}, true)`;
}

/** Commands stay lazy until awaited, so batch transactions never spend a write early. */
function lazyCommand(
	owner: object,
	execute: Operation,
	run: (execute: Operation) => Promise<unknown>,
): Prisma.PrismaPromise<unknown> {
	let promise: Promise<unknown> | undefined;
	const state: CommandState = { owner, started: false, execute };
	const start = () => {
		if (state.started && !promise)
			return Promise.reject(
				new Error("Batch command has already been consumed"),
			);
		state.started = true;
		promise ??= run(execute);
		return promise;
	};
	return {
		[COMMAND]: state,
		[Symbol.toStringTag]: "PrismaPromise",
		// biome-ignore lint/suspicious/noThenProperty: deliberate lazy PrismaPromise compatibility for await/batch transactions.
		then: (fulfilled, rejected) => start().then(fulfilled, rejected),
		catch: (rejected) => start().catch(rejected),
		finally: (settled) => start().finally(settled),
	} as Prisma.PrismaPromise<unknown>;
}

/** RLS applies equally to delegates, nested projections, raw SQL, and existing transactions. */
export function createTenantPrismaClient(
	base: AppPrismaClient,
	organizationId: string,
	options: TenantClientOptions = {},
): AppPrismaClient {
	const org = checkedOrganizationId(organizationId);
	const readOnly = options.readOnly === true;
	const owner = {};
	const delegateCache = new Map<string, object>();
	const run = (execute: Operation) =>
		base.$transaction(async (tx) => {
			await setScope(tx, org, readOnly);
			return execute(tx as unknown as Record<string, unknown>);
		});
	const scope = (
		source: Record<string, unknown>,
		inTransaction: boolean,
	): object =>
		new Proxy(
			{},
			{
				get(_target, key) {
					if (key === TENANT_ORGANIZATION) return org;
					if (key === Symbol.toStringTag) return "TenantPrismaClient";
					if (typeof key !== "string" || key === "then") return undefined;
					if (GLOBAL_MODELS.has(key))
						throw new Error(
							`Global delegate ${key} is unavailable in a tenant context`,
						);
					if (key === "$transaction") {
						if (inTransaction)
							throw new Error("Nested tenant transactions are unsupported");
						return async (input: unknown, options?: unknown) => {
							const { nativeOptions, statementTimeoutMs } =
								transactionSettings(options);
							if (typeof input === "function") {
								return base.$transaction(async (tx) => {
									await setScope(tx, org, readOnly);
									if (statementTimeoutMs !== undefined)
										await setStatementTimeout(tx, statementTimeoutMs);
									return input(
										scope(tx as unknown as Record<string, unknown>, true),
									);
								}, nativeOptions as never);
							}
							if (!Array.isArray(input))
								throw new Error("Invalid tenant transaction input");
							const states = input.map((command) => {
								const state = command?.[COMMAND] as CommandState | undefined;
								if (!state || state.owner !== owner)
									throw new Error(
										"Foreign or eager commands cannot enter a tenant batch transaction",
									);
								if (state.started)
									throw new Error(
										"Already started commands cannot enter a tenant batch transaction",
									);
								return state;
							});
							if (new Set(states).size !== states.length)
								throw new Error(
									"Duplicate commands cannot enter a tenant batch transaction",
								);
							for (const state of states) state.started = true;
							return base.$transaction(async (tx) => {
								await setScope(tx, org, readOnly);
								if (statementTimeoutMs !== undefined)
									await setStatementTimeout(tx, statementTimeoutMs);
								const results: unknown[] = [];
								for (const state of states)
									results.push(
										await state.execute(
											tx as unknown as Record<string, unknown>,
										),
									);
								return results;
							}, nativeOptions as never);
						};
					}
					if (RAW_METHODS.has(key)) {
						const execute = (...args: unknown[]) => {
							assertScopedSql(args);
							const operation: Operation = (tx) =>
								(tx[key] as (...args: unknown[]) => Promise<unknown>).apply(
									tx,
									args,
								);
							return inTransaction
								? operation(source)
								: lazyCommand(owner, operation, run);
						};
						return execute;
					}
					if (key.startsWith("$"))
						throw new Error(`Unsupported tenant client operation: ${key}`);
					if (!Object.hasOwn(TENANT_MODEL_RELATIONS, key)) return undefined;
					if (!source[key] || typeof source[key] !== "object") return undefined;
					const cached = !inTransaction ? delegateCache.get(key) : undefined;
					if (cached) return cached;
					const delegate = new Proxy(
						{},
						{
							get(_delegate, method) {
								if (method === "fields")
									return (source[key] as Record<string, unknown>).fields;
								if (typeof method !== "string" || !MODEL_METHODS.has(method))
									return undefined;
								const original = (source[key] as Record<PropertyKey, unknown>)[
									method
								];
								if (typeof original !== "function") return undefined;
								return (...args: unknown[]) => {
									assertTenantProjection(args);
									assertTenantWrites(key, args);
									if (
										readOnly &&
										/^(create|update|delete|upsert)/.test(String(method))
									)
										throw new Error("Tenant context is read-only");
									const actual = settingsArgs(key, String(method), args, org);
									const operation: Operation = (tx) => {
										const handle = tx[key] as Record<
											PropertyKey,
											(...args: unknown[]) => Promise<unknown>
										>;
										return (
											handle[method] as (...args: unknown[]) => Promise<unknown>
										).apply(handle, actual);
									};
									return inTransaction
										? operation(source)
										: lazyCommand(owner, operation, run);
								};
							},
						},
					);
					if (!inTransaction) delegateCache.set(key, delegate);
					return delegate;
				},
			},
		);
	return scope(
		base as unknown as Record<string, unknown>,
		false,
	) as AppPrismaClient;
}

const tenantClients = new WeakMap<
	AppPrismaClient,
	Map<string, AppPrismaClient>
>();
export function getTenantPrisma(
	organizationId: string,
	options: TenantClientOptions = {},
): AppPrismaClient {
	const base = getPrisma();
	const org = checkedOrganizationId(organizationId);
	let clients = tenantClients.get(base);
	if (!clients) {
		clients = new Map();
		tenantClients.set(base, clients);
	}
	const key = `${org}:${options.readOnly === true}`;
	let client = clients.get(key);
	if (!client) {
		client = createTenantPrismaClient(base, org, options);
		clients.set(key, client);
	}
	return client;
}
