import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrismaClient } from "../src/client";
import {
	APP_ADMIN_KEYS,
	DEFAULT_RUNTIME_ROLE,
	databaseUrl,
	importExistingAdminEnv,
	initializeAdminEnv,
	prepareRuntimeRole,
	privateEnv,
	readAppEnv,
	runtimeRole,
	runtimeUrls,
	writePrivateEnv,
} from "../src/runtime-role-setup";

const root = fileURLToPath(new URL("../../..", import.meta.url));
async function main() {
	const args = process.argv.slice(2);
	let adminPath = join(root, ".env.migrate");
	let appPath = join(root, ".env");
	let role = process.env.RUNTIME_DATABASE_ROLE || "";
	let mode = "prepare";
	let databasePort = 5432;
	for (let i = 0; i < args.length; i++) {
		const value = args[i];
		if (value === "--") continue;
		if (value === "--init-admin-env") mode = "init";
		else if (value === "--import-existing-admin") mode = "import";
		else if (
			[
				"--admin-env",
				"--app-env",
				"--runtime-role",
				"--database-port",
			].includes(value ?? "")
		) {
			const next = args[++i];
			if (!next) throw new Error("Missing setup option value.");
			if (value === "--admin-env") adminPath = next;
			else if (value === "--app-env") appPath = next;
			else if (value === "--database-port") databasePort = Number(next);
			else role = next;
		} else throw new Error("Unknown runtime setup option.");
	}
	if (adminPath === appPath)
		throw new Error(
			"Administrator and application configuration must be separate files.",
		);
	role = runtimeRole(
		role || privateEnv(adminPath).RUNTIME_DATABASE_ROLE || DEFAULT_RUNTIME_ROLE,
	);
	if (mode === "init") {
		initializeAdminEnv(adminPath, role, databasePort);
		console.log(
			"Created private migration configuration. Start PostgreSQL, then run db:runtime:prepare.",
		);
		return;
	}
	if (mode === "import") {
		importExistingAdminEnv(adminPath, appPath, role);
		console.log(
			"Separated existing administrator credentials. Keep Web/Worker stopped until runtime preparation succeeds.",
		);
		return;
	}
	const settings = privateEnv(adminPath);
	const url = databaseUrl(
		process.env.MIGRATION_DATABASE_URL || settings.DATABASE_URL,
	);
	const composeUrl = databaseUrl(
		settings.COMPOSE_MIGRATION_DATABASE_URL || url.toString(),
	);
	if (!settings.COMPOSE_MIGRATION_DATABASE_URL) {
		composeUrl.hostname = "postgres";
		composeUrl.port = "5432";
	}
	const app = readAppEnv(appPath);
	const existing = app.DATABASE_URL ? databaseUrl(app.DATABASE_URL) : undefined;
	const password =
		process.env.RUNTIME_DATABASE_PASSWORD ||
		(existing?.username === role
			? decodeURIComponent(existing.password)
			: "") ||
		randomBytes(32).toString("base64url");
	const admin = createPrismaClient(url.toString());
	try {
		await prepareRuntimeRole(admin, role, password);
		writePrivateEnv(
			appPath,
			runtimeUrls(url, composeUrl, role, password),
			APP_ADMIN_KEYS,
		);
		if (Object.keys(settings).length)
			writePrivateEnv(adminPath, { RUNTIME_DATABASE_ROLE: role });
		console.log(
			`Prepared restricted runtime role ${role}; runtime URLs saved privately. Existing MASTER_KEY and authentication settings are preserved.`,
		);
	} catch {
		throw new Error(
			"Runtime role preparation failed. Check the private migration configuration and administrator privileges; applications must remain stopped.",
		);
	} finally {
		await admin.$disconnect();
	}
}

main().catch((error: unknown) => {
	console.error(
		error instanceof Error ? error.message : "Database setup failed.",
	);
	process.exitCode = 1;
});
