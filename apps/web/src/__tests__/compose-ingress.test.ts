import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * WP-G G-1: the compose ingress profiles, validated by `docker compose
 * config` itself — the only parser whose opinion about this file matters.
 *
 * The docker CLI is a hard requirement of this test, on purpose. A skip would
 * be a named slot with nothing in it: the gate would read green on a machine
 * that never checked the file. `docker compose config` is a client-side
 * operation (no daemon needed; ~0.2 s), and every machine that runs this
 * repository's gates has the CLI. If yours does not, the failure names the
 * gate ENV-BLOCKED rather than pretending.
 */
const REPO = join(__dirname, "..", "..", "..", "..");
const PROFILES = ["--profile", "quick-tunnel", "--profile", "named-tunnel"];
const temp = mkdtempSync(join(tmpdir(), "compose-ingress-"));
const appEnvFile = join(temp, ".env");
writeFileSync(
	appEnvFile,
	"DATABASE_URL=postgresql://bitovp_runtime:synthetic-runtime-password@localhost:15498/bitovp\nCOMPOSE_DATABASE_URL=postgresql://bitovp_runtime:synthetic-runtime-password@postgres:5432/bitovp\n",
	{ mode: 0o600 },
);
writeFileSync(
	join(temp, ".env.migrate"),
	"POSTGRES_USER=bitovp\nPOSTGRES_PASSWORD=synthetic-admin-password\nPOSTGRES_DB=bitovp\nDATABASE_URL=postgresql://bitovp:synthetic-admin-password@localhost:15498/bitovp\nCOMPOSE_MIGRATION_DATABASE_URL=postgresql://bitovp:synthetic-admin-password@postgres:5432/bitovp\n",
	{ mode: 0o600 },
);
afterAll(() => rmSync(temp, { recursive: true, force: true }));

type ComposeService = {
	image?: string;
	profiles?: string[];
	command?: string[];
	ports?: { host_ip?: string; published?: string | number; target?: number }[];
	environment?: Record<string, string | null>;
	restart?: string;
};

function compose(args: string[]): string {
	try {
		return execFileSync(
			"docker",
			[
				"compose",
				"--project-directory",
				temp,
				"--env-file",
				appEnvFile,
				"-f",
				join(REPO, "docker-compose.yml"),
				...args,
			],
			{
				cwd: REPO,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				// Pin the FILE's defaults: `docker compose config` interpolates
				// `${INGRESS_ORIGIN_URL:-…}` from the shell and the project `.env`,
				// and INSTALLATION.md tells a host `pnpm dev` operator to set it.
				// COMPOSE_PROFILES too: the example env ships `quick-tunnel` ,
				// and Compose reads the project `.env` for it, so an operator's checkout
				// would otherwise turn the "plain up starts no tunnel" arm red.
				env: {
					NODE_ENV: "test",
					PATH: process.env.PATH,
					HOME: process.env.HOME,
					INGRESS_ORIGIN_URL: "",
					TUNNEL_TOKEN: "",
					COMPOSE_PROFILES: "",
				},
			},
		);
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code === "ENOENT") {
			throw new Error(
				"ENV-BLOCKED: the docker CLI is not on PATH, so docker-compose.yml could not be validated — this gate is not green",
			);
		}
		throw err;
	}
}

describe("docker-compose.yml ingress profiles (WP-G G-1)", () => {
	it("is valid with NO profile, and a plain `up` never starts a tunnel", () => {
		compose(["config", "--quiet"]);
		const services = compose(["config", "--services"])
			.split("\n")
			.filter((s) => s !== "");
		expect(services).not.toContain("ingress");
		expect(services).not.toContain("ingress-named");
		expect(services).toEqual(
			expect.arrayContaining(["postgres", "redis", "migrate", "worker", "web"]),
		);
	});

	it("is valid with both tunnel profiles, and each profile adds exactly its sidecar", () => {
		compose([...PROFILES, "config", "--quiet"]);
		const quick = compose([
			"--profile",
			"quick-tunnel",
			"config",
			"--services",
		]);
		expect(quick).toContain("ingress\n");
		expect(quick).not.toContain("ingress-named");
		const named = compose([
			"--profile",
			"named-tunnel",
			"config",
			"--services",
		]);
		expect(named).toContain("ingress-named");
		expect(named.split("\n")).not.toContain("ingress");
	});

	describe("the resolved sidecar definitions", () => {
		const resolved = JSON.parse(
			compose([...PROFILES, "config", "--format", "json"]),
		) as { services: Record<string, ComposeService> };
		const ingress = resolved.services.ingress as ComposeService;
		const named = resolved.services["ingress-named"] as ComposeService;

		it("both run the SAME cloudflared image, pinned by digest", () => {
			expect(ingress.image).toMatch(
				/^cloudflare\/cloudflared:\d{4}\.\d+\.\d+@sha256:[0-9a-f]{64}$/,
			);
			expect(named.image).toBe(ingress.image);
		});

		it("quick-tunnel: no autoupdate, forwards to web by default, metrics on 20241 published on loopback only", () => {
			expect(ingress.profiles).toEqual(["quick-tunnel"]);
			const command = ingress.command ?? [];
			expect(command[0]).toBe("tunnel");
			expect(command).toContain("--no-autoupdate");
			expect(command[command.indexOf("--url") + 1]).toBe("http://web:3100");
			// The worker's DEFAULT_QUICKTUNNEL_METRICS_URL is http://ingress:20241/quicktunnel.
			expect(command[command.indexOf("--metrics") + 1]).toBe("0.0.0.0:20241");
			expect(ingress.ports).toEqual([
				expect.objectContaining({
					host_ip: "127.0.0.1",
					published: "20241",
					target: 20241,
				}),
			]);
			expect(ingress.restart).toBe("unless-stopped");
		});

		it("named-tunnel: runs with TUNNEL_TOKEN from the environment, never publishes the metrics port", () => {
			expect(named.profiles).toEqual(["named-tunnel"]);
			const command = named.command ?? [];
			expect(command[0]).toBe("tunnel");
			expect(command).toContain("--no-autoupdate");
			expect(command[command.length - 1]).toBe("run");
			expect(Object.keys(named.environment ?? {})).toEqual(["TUNNEL_TOKEN"]);
			expect(named.ports).toBeUndefined();
			expect(named.restart).toBe("unless-stopped");
		});
	});
});
