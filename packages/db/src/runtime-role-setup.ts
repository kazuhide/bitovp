import {
	createHash,
	createHmac,
	pbkdf2Sync,
	randomBytes,
	randomUUID,
} from "node:crypto";
import {
	existsSync,
	lstatSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import type { AppPrismaClient } from "./client";

export const DEFAULT_RUNTIME_ROLE = "bitovp_runtime";
const ADMIN_KEYS = [
	"MIGRATION_DATABASE_URL",
	"COMPOSE_MIGRATION_DATABASE_URL",
	"POSTGRES_USER",
	"POSTGRES_PASSWORD",
	"POSTGRES_DB",
	"CUSTOMER_DB_PASSWORD",
];

export function privateEnv(path: string): Record<string, string | undefined> {
	if (!existsSync(path)) return {};
	const stat = lstatSync(path);
	if (!stat.isFile() || (stat.mode & 0o077) !== 0)
		throw new Error(
			"The migration configuration must be a regular private file (chmod 600).",
		);
	return parseEnv(readFileSync(path, "utf8"));
}

export function readAppEnv(path: string): Record<string, string | undefined> {
	return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
}

/** Replace named values only, keeping existing MASTER_KEY/auth lines verbatim. */
export function writePrivateEnv(
	path: string,
	values: Record<string, string>,
	remove: readonly string[] = [],
): void {
	for (const value of Object.values(values))
		if (/[\r\n]/.test(value))
			throw new Error("Private environment values must fit on one line.");
	if (path.endsWith(".example"))
		throw new Error(
			"Example configuration files cannot hold private credentials.",
		);
	if (existsSync(path) && !lstatSync(path).isFile())
		throw new Error("Private configuration must be a regular file.");
	const remaining = new Map(Object.entries(values));
	const removed = new Set(remove);
	const lines = (existsSync(path) ? readFileSync(path, "utf8") : "").split(
		/\r?\n/,
	);
	const next: string[] = [];
	for (const line of lines) {
		const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=/.exec(
			line,
		)?.[1];
		if (key && removed.has(key)) continue;
		if (key && Object.hasOwn(values, key)) {
			if (remaining.has(key)) next.push(`${key}=${remaining.get(key)}`);
			remaining.delete(key);
		} else next.push(line);
	}
	for (const [key, value] of remaining) next.push(`${key}=${value}`);
	const temporary = join(dirname(path), `.env.tmp-${randomUUID()}`);
	writeFileSync(temporary, `${next.join("\n").replace(/\n+$/, "")}\n`, {
		mode: 0o600,
		flag: "wx",
	});
	renameSync(temporary, path);
}

export function databaseUrl(value: string | undefined): URL {
	try {
		const url = new URL(value ?? "");
		if (
			!["postgres:", "postgresql:"].includes(url.protocol) ||
			!url.username ||
			url.pathname.length < 2
		)
			throw new Error();
		return url;
	} catch {
		throw new Error("A valid PostgreSQL migration DATABASE_URL is required.");
	}
}

export function runtimeRole(value: string): string {
	if (!/^[a-z][a-z0-9_]{0,62}$/.test(value))
		throw new Error(
			"Runtime role names must be lowercase PostgreSQL identifiers.",
		);
	return value;
}

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** PostgreSQL accepts a SCRAM verifier directly, so plaintext never enters SQL/logs. */
export function scramVerifier(password: string): string {
	const iterations = 4096;
	const salt = randomBytes(16);
	const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
	const clientKey = createHmac("sha256", salted).update("Client Key").digest();
	const storedKey = createHash("sha256").update(clientKey).digest("base64");
	const serverKey = createHmac("sha256", salted)
		.update("Server Key")
		.digest("base64");
	return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey}:${serverKey}`;
}

export async function prepareRuntimeRole(
	admin: AppPrismaClient,
	roleName: string,
	password?: string,
): Promise<void> {
	const role = runtimeRole(roleName);
	if (password !== undefined && password.length < 16)
		throw new Error(
			"Runtime database passwords must contain at least 16 characters.",
		);
	await admin.$transaction(
		async (tx) => {
			const authority = await tx.$queryRaw<
				{
					name: string;
					superuser: boolean;
					bypass: boolean;
					createRole: boolean;
					database: string;
				}[]
			>`SELECT current_user AS name, r.rolsuper AS superuser, r.rolbypassrls AS bypass, r.rolcreaterole AS "createRole", current_database() AS database FROM pg_roles r WHERE r.rolname=current_user`;
			const actor = authority[0];
			if (!actor || (!actor.superuser && (!actor.bypass || !actor.createRole)))
				throw new Error(
					"Migration credentials require role administration and BYPASSRLS.",
				);
			if (actor.name === role)
				throw new Error(
					"The runtime role must differ from the migration administrator.",
				);
			const existing = await tx.$queryRaw<
				{ id: number }[]
			>`SELECT oid::int AS id FROM pg_roles WHERE rolname=${role}`;
			if (existing.length) {
				const forbidden = await tx.$queryRaw<
					{ unsafe: boolean }[]
				>`SELECT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=${existing[0]?.id}::oid) OR EXISTS(SELECT 1 FROM pg_database WHERE datdba=${existing[0]?.id}::oid) OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=${existing[0]?.id}::oid) OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=${existing[0]?.id}::oid) OR EXISTS(SELECT 1 FROM pg_proc WHERE proowner=${existing[0]?.id}::oid) AS unsafe`;
				if (forbidden[0]?.unsafe)
					throw new Error(
						"The runtime role cannot own database/schema objects or inherit other roles.",
					);
			} else {
				if (!password)
					throw new Error(
						"Prepare the runtime role before running migrations.",
					);
				await tx.$executeRawUnsafe(`CREATE ROLE ${identifier(role)}`);
			}
			await tx.$executeRawUnsafe(
				`ALTER ROLE ${identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS${password ? ` PASSWORD ${literal(scramVerifier(password))}` : ""}`,
			);
			await tx.$executeRawUnsafe(
				`REVOKE ALL PRIVILEGES ON DATABASE ${identifier(actor.database)} FROM ${identifier(role)}`,
			);
			await tx.$executeRawUnsafe(
				`GRANT CONNECT ON DATABASE ${identifier(actor.database)} TO ${identifier(role)}`,
			);
			// PostgreSQL before v15 granted public CREATE to everyone. A runtime
			// role's direct revoke cannot override that inherited PUBLIC privilege.
			await tx.$executeRawUnsafe("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
			await tx.$executeRawUnsafe(
				`REVOKE ALL ON SCHEMA public FROM ${identifier(role)}`,
			);
			await tx.$executeRawUnsafe(
				`GRANT USAGE ON SCHEMA public TO ${identifier(role)}`,
			);
			await tx.$executeRawUnsafe(
				`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${identifier(role)}`,
			);
			await tx.$executeRawUnsafe(
				`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${identifier(role)}`,
			);
			await tx.$executeRawUnsafe(
				`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${identifier(role)}`,
			);
			await tx.$executeRawUnsafe(
				`ALTER DEFAULT PRIVILEGES FOR ROLE ${identifier(actor.name)} IN SCHEMA public REVOKE ALL ON TABLES FROM ${identifier(role)}`,
			);
			await tx.$executeRawUnsafe(
				`ALTER DEFAULT PRIVILEGES FOR ROLE ${identifier(actor.name)} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${identifier(role)}`,
			);
			await tx.$executeRawUnsafe(
				`ALTER DEFAULT PRIVILEGES FOR ROLE ${identifier(actor.name)} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${identifier(role)}`,
			);
			const history = await tx.$queryRaw<
				{ exists: boolean }[]
			>`SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS exists`;
			if (history[0]?.exists)
				await tx.$executeRawUnsafe(
					`REVOKE ALL ON TABLE public."_prisma_migrations" FROM ${identifier(role)}`,
				);
		},
		{ timeout: 30000 },
	);
}

export function initializeAdminEnv(
	path: string,
	role = DEFAULT_RUNTIME_ROLE,
	port = 5432,
): void {
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error("A valid PostgreSQL host port is required.");
	if (existsSync(path))
		throw new Error(
			"Migration configuration already exists; it will not be overwritten.",
		);
	const password = randomBytes(32).toString("base64url");
	const host = new URL("postgresql://bitovp@localhost:5432/bitovp");
	host.port = String(port);
	host.password = password;
	const compose = new URL(host);
	compose.hostname = "postgres";
	compose.port = "5432";
	writePrivateEnv(path, {
		POSTGRES_USER: "bitovp",
		POSTGRES_PASSWORD: password,
		POSTGRES_DB: "bitovp",
		DATABASE_URL: host.toString(),
		COMPOSE_MIGRATION_DATABASE_URL: compose.toString(),
		RUNTIME_DATABASE_ROLE: runtimeRole(role),
	});
}

export function importExistingAdminEnv(
	adminPath: string,
	appPath: string,
	role = DEFAULT_RUNTIME_ROLE,
): void {
	if (existsSync(adminPath))
		throw new Error(
			"Migration configuration already exists; it will not be overwritten.",
		);
	const app = readAppEnv(appPath);
	const legacyCustomer = new URL("postgresql://bitovp@localhost:5432/bitovp");
	if (app.CUSTOMER_DB_PASSWORD)
		legacyCustomer.password = app.CUSTOMER_DB_PASSWORD;
	if (app.CUSTOMER_DATABASE_PORT)
		legacyCustomer.port = app.CUSTOMER_DATABASE_PORT;
	const admin = databaseUrl(
		app.DATABASE_URL ||
			(app.CUSTOMER_DB_PASSWORD ? legacyCustomer.toString() : undefined),
	);
	const compose = databaseUrl(app.COMPOSE_DATABASE_URL || admin.toString());
	if (!app.COMPOSE_DATABASE_URL) {
		compose.hostname = "postgres";
		compose.port = "5432";
	}
	writePrivateEnv(adminPath, {
		DATABASE_URL: admin.toString(),
		COMPOSE_MIGRATION_DATABASE_URL: compose.toString(),
		POSTGRES_USER: decodeURIComponent(admin.username),
		POSTGRES_PASSWORD: decodeURIComponent(admin.password),
		POSTGRES_DB: decodeURIComponent(admin.pathname.slice(1)),
		RUNTIME_DATABASE_ROLE: runtimeRole(role),
	});
	admin.username = role;
	admin.password = "";
	compose.username = role;
	compose.password = "";
	writePrivateEnv(
		appPath,
		{
			DATABASE_URL: admin.toString(),
			COMPOSE_DATABASE_URL: compose.toString(),
		},
		ADMIN_KEYS,
	);
}

export function runtimeUrls(
	adminUrl: URL,
	composeAdminUrl: URL,
	role: string,
	password: string,
): { DATABASE_URL: string; COMPOSE_DATABASE_URL: string } {
	const host = new URL(adminUrl);
	const compose = new URL(composeAdminUrl);
	for (const url of [host, compose]) {
		url.username = runtimeRole(role);
		url.password = password;
	}
	return {
		DATABASE_URL: host.toString(),
		COMPOSE_DATABASE_URL: compose.toString(),
	};
}

export const APP_ADMIN_KEYS = ADMIN_KEYS;
