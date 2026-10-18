import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const directories: string[] = [];
function settings(prepared = true) {
	const directory = mkdtempSync(join(tmpdir(), "bitovp-compose-role-"));
	directories.push(directory);
	const app = join(directory, ".env");
	const admin = join(directory, ".env.migrate");
	writeFileSync(
		app,
		`MASTER_KEY=fixture-app-master\nAUTH_PASSWORD_HASH=scrypt$16384$8$1$fixture-salt$fixture-hash\nCUSTOMER_MASTER_KEY=fixture-app-master\nCUSTOMER_AUTH_PASSWORD_HASH='scrypt$16384$8$1$fixture-salt$fixture-hash'\nCUSTOMER_AUTH_SESSION_SECRET=fixture-app-session\nCUSTOMER_WORKER_IMAGE=fixture-worker\nCUSTOMER_WEB_IMAGE=fixture-web\nCUSTOMER_HTTP_PORT=13100\nCUSTOMER_DATABASE_PORT=15432\n${prepared ? "DATABASE_URL=postgresql://bitovp_runtime:fixture-runtime@localhost:15432/bitovp\nCOMPOSE_DATABASE_URL=postgresql://bitovp_runtime:fixture-runtime@postgres:5432/bitovp\n" : ""}`,
		{ mode: 0o600 },
	);
	writeFileSync(
		admin,
		"POSTGRES_USER=bitovp\nPOSTGRES_PASSWORD=fixture-admin\nPOSTGRES_DB=bitovp\nDATABASE_URL=postgresql://bitovp:fixture-admin@localhost:15432/bitovp\nCOMPOSE_MIGRATION_DATABASE_URL=postgresql://bitovp:fixture-admin@postgres:5432/bitovp\n",
		{ mode: 0o600 },
	);
	return { directory, app, admin };
}
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

let docker = true;
try {
	execFileSync("docker", ["compose", "version", "--short"], {
		stdio: "ignore",
	});
} catch {
	docker = false;
}
type Config = {
	services: Record<string, { environment?: Record<string, string> }>;
};
function assertSplit(config: Config, applications: string[]) {
	for (const name of applications) {
		const env = config.services[name]?.environment ?? {};
		expect(new URL(env.DATABASE_URL ?? "").username).toBe("bitovp_runtime");
		for (const key of [
			"POSTGRES_PASSWORD",
			"MIGRATION_DATABASE_URL",
			"COMPOSE_MIGRATION_DATABASE_URL",
			"CUSTOMER_DB_PASSWORD",
		])
			expect(Object.hasOwn(env, key)).toBe(false);
		// Compose escapes dollars in serialized config for a safe subsequent
		// YAML/JSON reload; the raw env_file still supplies single dollars.
		expect(
			env.AUTH_PASSWORD_HASH?.replaceAll("$$", "$").startsWith(
				"scrypt$16384$8$1$",
			) ?? true,
		).toBe(true);
	}
	for (const name of ["postgres", "migrate"]) {
		const env = config.services[name]?.environment ?? {};
		expect(new URL(env.COMPOSE_MIGRATION_DATABASE_URL ?? "").username).toBe(
			"bitovp",
		);
		expect(Object.hasOwn(env, "MASTER_KEY")).toBe(false);
		expect(Object.hasOwn(env, "AUTH_PASSWORD_HASH")).toBe(false);
	}
}

describe("Compose database capability source contract", () => {
	it("includes only runtime URLs in application defaults", () => {
		for (const file of [
			"docker-compose.yml",
			"docker-compose.customer.yml",
			".env.example",
		]) {
			const source = readFileSync(join(root, file), "utf8");
			expect(source.includes("postgresql://bitovp:bitovp")).toBe(false);
			expect(source.includes("postgresql://bitovp_runtime@")).toBe(true);
		}
	});
});

describe.runIf(docker)("real Compose database environment rendering", () => {
	it("keeps admin credentials out of Web/Worker/Akamai and app secrets out of migration services", () => {
		const f = settings();
		const output = execFileSync(
			"docker",
			[
				"compose",
				"--project-directory",
				f.directory,
				"--env-file",
				f.app,
				"-f",
				join(root, "docker-compose.yml"),
				"--profile",
				"akamai",
				"config",
				"--format",
				"json",
			],
			{
				env: { PATH: process.env.PATH, HOME: process.env.HOME },
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		assertSplit(JSON.parse(output) as Config, ["web", "worker"]);
	});
	it.each([
		true,
		false,
	])("keeps customer credentials separated, and can render fresh infra before role preparation (prepared=%s)", (prepared) => {
		const f = settings(prepared);
		const output = execFileSync(
			"bash",
			[
				join(root, "scripts/customer-compose.sh"),
				"role-proof",
				f.app,
				f.admin,
				"config",
				"--format",
				"json",
			],
			{
				env: {
					PATH: process.env.PATH,
					HOME: process.env.HOME,
					COMPOSE_FILE: "/invalid/inherited.yml",
					COMPOSE_PROFILES: "unwanted",
				},
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		assertSplit(JSON.parse(output) as Config, ["web", "worker"]);
	});
});
