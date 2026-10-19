import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = join(__dirname, "../../../..");
const temp = mkdtempSync(join(tmpdir(), "compose-customer-"));
const fixture = [
	`CUSTOMER_WEB_IMAGE=example/web@sha256:${"a".repeat(64)}`,
	`CUSTOMER_WORKER_IMAGE=example/worker@sha256:${"b".repeat(64)}`,
	"CUSTOMER_HTTP_PORT=3199",
	"CUSTOMER_DATABASE_PORT=15499",
	"CUSTOMER_MASTER_KEY=synthetic-master-key",
	"CUSTOMER_AUTH_PASSWORD_HASH='scrypt$synthetic$password$hash'",
	"CUSTOMER_AUTH_SESSION_SECRET=synthetic-session-secret",
].join("\n");
const runtimeSettings = [
	"DATABASE_URL=postgresql://bitovp_runtime:synthetic-runtime-password@localhost:15499/bitovp",
	"COMPOSE_DATABASE_URL=postgresql://bitovp_runtime:synthetic-runtime-password@postgres:5432/bitovp",
].join("\n");
const envFile = join(temp, "customer.env");
const migrationEnvFile = join(temp, "customer.migrate.env");
writeFileSync(envFile, `${fixture}\n${runtimeSettings}\n`, { mode: 0o600 });
writeFileSync(
	migrationEnvFile,
	[
		"POSTGRES_USER=bitovp",
		"POSTGRES_PASSWORD=synthetic-admin-password",
		"POSTGRES_DB=bitovp",
		"DATABASE_URL=postgresql://bitovp:synthetic-admin-password@localhost:15499/bitovp",
		"COMPOSE_MIGRATION_DATABASE_URL=postgresql://bitovp:synthetic-admin-password@postgres:5432/bitovp",
	].join("\n"),
	{ mode: 0o600 },
);
afterAll(() => rmSync(temp, { recursive: true, force: true }));

function config(
	customer = "alpha",
	file = envFile,
	migrationFile = migrationEnvFile,
) {
	return JSON.parse(
		execFileSync(
			"bash",
			[
				"scripts/customer-compose.sh",
				customer,
				file,
				migrationFile,
				"config",
				"--format",
				"json",
			],
			{
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					HOME: homedir(),
					COMPOSE_FILE: "absent.yml",
					COMPOSE_PROFILES: "quick-tunnel",
					CUSTOMER_DB_PASSWORD: "parent-secret",
					COMPOSE_DATABASE_URL:
						"postgresql://parent:parent-secret@parent-db/parent",
					MASTER_KEY: "parent-master",
					AUTH_MODE: "none",
					DEPLOYMENT_PROFILE: "UNRESTRICTED",
				},
			},
		),
	);
}

describe("customer Compose isolation", () => {
	it("preserves retired or unknown private settings for startup validation", () => {
		for (const profile of ["AKAMAI_ONLY", "UNKNOWN_PROFILE"]) {
			const privateFile = join(temp, `${profile}.env`);
			writeFileSync(
				privateFile,
				`${fixture}\n${runtimeSettings}\nDEPLOYMENT_PROFILE=${profile}\n`,
				{ mode: 0o600 },
			);
			const c = config("alpha", privateFile);
			for (const name of ["web", "worker"])
				expect(c.services[name].environment.DEPLOYMENT_PROFILE).toBe(profile);
		}
	});
	it("preserves private local-quality overrides instead of forcing fixed defaults", () => {
		const file = join(temp, "quality-settings.env");
		writeFileSync(
			file,
			`${fixture}\n${runtimeSettings}\nVMAF_THREADS=3\nVMAF_CONCURRENCY=2\n`,
			{ mode: 0o600 },
		);
		const c = config("alpha", file);
		expect(c.services.worker.environment).toMatchObject({
			VMAF_THREADS: "3",
			VMAF_CONCURRENCY: "2",
		});
	});
	it("requires explicit customer settings, never parent environment fallbacks", () => {
		for (const line of fixture.split("\n")) {
			const missing = join(temp, "missing.env");
			writeFileSync(
				missing,
				`${fixture.replace(line, "")}\n${runtimeSettings}\n`,
				{ mode: 0o600 },
			);
			expect(() => config("alpha", missing)).toThrow();
		}
		expect(() => config("../bitovp")).toThrow();
		expect(() =>
			config("alpha", envFile, join(temp, "missing-admin.env")),
		).toThrow();
		expect(() => config("alpha", envFile, envFile)).toThrow();
	});
	it("fixes both runtimes to UNRESTRICTED and inherits no dev services or secrets", () => {
		const c = config();
		expect(Object.keys(c.services).sort()).toEqual([
			"migrate",
			"postgres",
			"redis",
			"report-init",
			"web",
			"worker",
		]);
		for (const name of ["web", "worker"]) {
			const s = c.services[name];
			expect(s.environment.DEPLOYMENT_PROFILE).toBe("UNRESTRICTED");
			expect(s.environment.MASTER_KEY).toBe("synthetic-master-key");
			expect(s.environment.DATABASE_URL).toContain(
				"bitovp_runtime:synthetic-runtime-password@postgres",
			);
			for (const key of [
				"POSTGRES_PASSWORD",
				"MIGRATION_DATABASE_URL",
				"COMPOSE_MIGRATION_DATABASE_URL",
				"CUSTOMER_DB_PASSWORD",
			])
				expect(s.environment).not.toHaveProperty(key);
			expect(s.environment.REDIS_URL).toBe("redis://redis:6379");
			expect(s.restart).toBe("unless-stopped");
			expect(s.build).toBeUndefined();
		}
		expect(c.services.web.environment.AUTH_MODE).toBe("password");
		// `config` escapes literal dollars for round-trip YAML; runtime keeps one.
		expect(
			c.services.web.environment.AUTH_PASSWORD_HASH.replaceAll("$$", "$"),
		).toBe("scrypt$synthetic$password$hash");
		expect(c.services.worker.environment.VERIFY_RUN_ROOT).toBe("/verify-runs");
		expect(c.services.worker.environment.VMAF_CONCURRENCY).toBe("");
		expect(c.services.worker.environment.VMAF_THREADS).toBe("");
		expect(c.services.worker.mem_limit).toBe("4294967296");
		expect(c.services.web.mem_limit).toBe("1073741824");
		for (const s of Object.values(c.services) as {
			mem_limit: string;
			memswap_limit: string;
		}[]) {
			expect(s.memswap_limit).toBe(s.mem_limit);
		}
		expect(c.services.postgres.ports).toEqual([
			expect.objectContaining({
				host_ip: "127.0.0.1",
				published: "15499",
				target: 5432,
			}),
		]);
		expect(c.services.redis.ports).toBeUndefined();
		for (const name of ["postgres", "migrate"]) {
			expect(
				c.services[name].environment.COMPOSE_MIGRATION_DATABASE_URL,
			).toContain("bitovp:synthetic-admin-password@postgres");
			for (const key of [
				"MASTER_KEY",
				"CUSTOMER_MASTER_KEY",
				"AUTH_PASSWORD_HASH",
				"CUSTOMER_AUTH_PASSWORD_HASH",
			])
				expect(c.services[name].environment).not.toHaveProperty(key);
		}
		expect(c.services.migrate.environment.BITOVP_MIGRATION_IN_CONTAINER).toBe(
			"1",
		);
		expect(c.services.web.ports).toEqual([
			expect.objectContaining({
				host_ip: "127.0.0.1",
				published: "3199",
				target: 3100,
			}),
		]);
		for (const s of Object.values(c.services) as {
			volumes?: { type: string }[];
		}[]) {
			expect(s.volumes?.some((v) => v.type === "bind")).not.toBe(true);
		}
	});
	it("uses the same images with project-scoped volumes and networks for two customers", () => {
		const a = config("alpha");
		const b = config("beta");
		for (const name of ["web", "worker", "migrate", "report-init"])
			expect(a.services[name].image).toBe(b.services[name].image);
		for (const name of ["pgdata", "redisdata", "reports"]) {
			expect(a.volumes[name].name).not.toBe(b.volumes[name].name);
			expect(a.volumes[name].external).not.toBe(true);
		}
		expect(a.networks.default.name).not.toBe(b.networks.default.name);
	});
});
