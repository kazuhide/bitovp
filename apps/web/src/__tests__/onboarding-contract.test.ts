import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const installation = read("docs/user-guide/INSTALLATION.md");
const operations = read("docs/OPERATIONS.md");

describe("onboarding agrees with deployment boundaries", () => {
	it("prepares restricted database access before starting web and worker", () => {
		const prepare = installation.indexOf("db:runtime:prepare");
		const pull = installation.indexOf("docker compose pull postgres redis");
		const database = installation.indexOf(
			"docker compose up -d postgres redis",
		);
		const build = installation.indexOf(
			"docker compose build --pull --no-cache migrate worker web",
		);
		expect(pull).toBeGreaterThan(0);
		expect(database).toBeGreaterThan(pull);
		expect(prepare).toBeGreaterThan(database);
		expect(build).toBeGreaterThan(prepare);
		expect(installation).toContain("docker compose up -d --no-build");
		expect(installation).toContain(".env.migrate");
		expect(installation).toContain("INGRESS_ORIGIN_URL=http://web:3100");
	});

	it("opens setup before reading the lazily generated one-time code", () => {
		const setup = installation.split("## 7.")[1]?.split("## 8.")[0] ?? "";
		expect(setup.indexOf("http://localhost:3100/setup")).toBeGreaterThan(0);
		expect(setup.indexOf("logs web")).toBeGreaterThan(
			setup.indexOf("http://localhost:3100/setup"),
		);
		expect(setup).toContain("no default credentials");
	});

	it("retains data on shutdown and releases services before host development", () => {
		expect(installation).toContain("docker compose down");
		expect(installation).toContain("retains database volumes");
		expect(operations).toContain("docker compose stop web worker");
		expect(read("docker-compose.yml")).toMatch(
			/"127\.0\.0\.1:\$\{WEB_PORT:-3100\}:3100"/,
		);
	});

	it("documents native media binaries and host-side tunnel wiring", () => {
		for (const value of [
			"ffmpeg -version",
			"ffprobe -version",
			"INGRESS_ORIGIN_URL=http://host.docker.internal:3100",
			"INGRESS_QUICKTUNNEL_METRICS_URL=http://127.0.0.1:20241/quicktunnel",
			"docker compose --profile quick-tunnel up -d ingress",
			"Next binds to `127.0.0.1`",
		])
			expect(operations).toContain(value);
	});

	it("distinguishes webhook ingress from UI exposure and local HTTP", () => {
		expect(operations).toContain("only `/api/webhooks/*` and `/api/health`");
		expect(operations).toContain(
			"UI hostname must be in `ALLOWED_ORIGIN_HOSTS`",
		);
		expect(installation).toContain("AUTH_ALLOW_INSECURE_HTTP=true");
		expect(installation).toContain("only for trusted local use");
	});

	it("checks backup restoration in isolation without assuming production ACLs", () => {
		expect(operations).toContain("new isolated database/container");
		expect(operations).toContain(
			"pg_restore --exit-on-error --no-owner --no-acl",
		);
		expect(operations).toContain("not\nproof that production role privileges");
	});
});
