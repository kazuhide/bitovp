import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	importExistingAdminEnv,
	initializeAdminEnv,
	privateEnv,
	readAppEnv,
	runtimeRole,
	runtimeUrls,
	writePrivateEnv,
} from "./runtime-role-setup";

const directories: string[] = [];
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "bitovp-role-config-"));
	directories.push(directory);
	return {
		admin: join(directory, ".env.migrate"),
		app: join(directory, ".env"),
	};
}
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("private runtime database setup", () => {
	it("initializes a distinct private administrator configuration once, with an explicit host port", () => {
		const f = fixture();
		initializeAdminEnv(f.admin, "runtime_test", 15432);
		const admin = privateEnv(f.admin);
		expect(statSync(f.admin).mode & 0o777).toBe(0o600);
		expect(admin.POSTGRES_PASSWORD?.length).toBeGreaterThanOrEqual(40);
		expect(new URL(admin.DATABASE_URL ?? "").port).toBe("15432");
		expect(new URL(admin.COMPOSE_MIGRATION_DATABASE_URL ?? "").hostname).toBe(
			"postgres",
		);
		expect(admin.RUNTIME_DATABASE_ROLE).toBe("runtime_test");
		expect(() => initializeAdminEnv(f.admin)).toThrow(/not be overwritten/);
	});
	it("imports existing administrator URLs but preserves MASTER_KEY and literal authentication hashes", () => {
		const f = fixture();
		const preserved =
			"MASTER_KEY=fixture-master\nAUTH_PASSWORD_HASH=scrypt$16384$8$1$fixture-salt$fixture-hash\nAUTH_SESSION_SECRET=fixture-session\n";
		writeFileSync(
			f.app,
			`${preserved}DATABASE_URL=postgresql://bitovp:fixture-admin@localhost:5432/bitovp\nPOSTGRES_PASSWORD=fixture-admin\n`,
		);
		importExistingAdminEnv(f.admin, f.app);
		expect(readFileSync(f.app, "utf8").startsWith(preserved)).toBe(true);
		expect(new URL(readAppEnv(f.app).DATABASE_URL ?? "").username).toBe(
			"bitovp_runtime",
		);
		expect(new URL(readAppEnv(f.app).DATABASE_URL ?? "").password).toBe("");
		expect(Object.hasOwn(readAppEnv(f.app), "POSTGRES_PASSWORD")).toBe(false);
		expect(new URL(privateEnv(f.admin).DATABASE_URL ?? "").username).toBe(
			"bitovp",
		);
		expect(statSync(f.app).mode & 0o777).toBe(0o600);
	});
	it("imports legacy customer password configuration into the separate migration file", () => {
		const f = fixture();
		writeFileSync(
			f.app,
			"CUSTOMER_DB_PASSWORD=fixture-admin\nCUSTOMER_DATABASE_PORT=15433\nCUSTOMER_MASTER_KEY=fixture-master\n",
		);
		importExistingAdminEnv(f.admin, f.app);
		expect(new URL(privateEnv(f.admin).DATABASE_URL ?? "").port).toBe("15433");
		expect(Object.hasOwn(readAppEnv(f.app), "CUSTOMER_DB_PASSWORD")).toBe(
			false,
		);
		expect(readAppEnv(f.app).CUSTOMER_MASTER_KEY).toBe("fixture-master");
	});
	it("keeps only runtime credentials in generated application URLs and rejects config/role injection", () => {
		const urls = runtimeUrls(
			new URL(
				"postgresql://administrator:fixture-admin@localhost:15432/bitovp?sslmode=require",
			),
			new URL("postgresql://administrator:fixture-admin@postgres:5432/bitovp"),
			"bitovp_runtime",
			"fixture-runtime-password",
		);
		expect(new URL(urls.DATABASE_URL).username).toBe("bitovp_runtime");
		expect(new URL(urls.DATABASE_URL).searchParams.get("sslmode")).toBe(
			"require",
		);
		expect(new URL(urls.COMPOSE_DATABASE_URL).hostname).toBe("postgres");
		expect(() => runtimeRole('x"; ALTER ROLE administrator SUPERUSER')).toThrow(
			/identifier/,
		);
		const f = fixture();
		expect(() =>
			writePrivateEnv(f.app, { DATABASE_URL: "line\nPOSTGRES_PASSWORD=bad" }),
		).toThrow(/one line/);
		expect(() =>
			writePrivateEnv(`${f.app}.example`, { DATABASE_URL: "private" }),
		).toThrow(/Example/);
	});
});
