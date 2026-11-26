import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prismaEngineEnvironment } from "../../runtime/prisma-engine";

const directories: string[] = [];
function generatedClient() {
	const directory = mkdtempSync(join(tmpdir(), "bitovp-relocated-prisma-"));
	directories.push(directory);
	return directory;
}
afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("Prisma engine for the unbundled Web launcher", () => {
	it("passes the deployed engine to a child launched from another directory", () => {
		const directory = generatedClient();
		const engine = join(
			directory,
			"libquery_engine-debian-openssl-3.0.x.so.node",
		);
		writeFileSync(engine, "native artifact fixture");
		const environment = {
			NODE_ENV: "production" as const,
			DATABASE_URL: "postgresql://not-printed",
		};
		expect(prismaEngineEnvironment(directory, environment)).toEqual({
			...environment,
			PRISMA_QUERY_ENGINE_LIBRARY: engine,
		});
		expect(environment).not.toHaveProperty("PRISMA_QUERY_ENGINE_LIBRARY");
		const child = spawnSync(
			process.execPath,
			["-p", "process.env.PRISMA_QUERY_ENGINE_LIBRARY"],
			{
				cwd: tmpdir(),
				env: prismaEngineEnvironment(directory, environment),
				encoding: "utf8",
			},
		);
		expect(child.status).toBe(0);
		expect(child.stdout.trim()).toBe(engine);
	});

	it.each([
		"libquery_engine-darwin-arm64.dylib.node",
		"query_engine-windows.dll.node",
	])("accepts the generated native library %s", (name) => {
		const directory = generatedClient();
		writeFileSync(join(directory, name), "native artifact fixture");
		expect(
			prismaEngineEnvironment(directory, { NODE_ENV: "production" })
				.PRISMA_QUERY_ENGINE_LIBRARY,
		).toBe(join(directory, name));
	});

	it("retains an explicit operator override", () => {
		const environment = {
			NODE_ENV: "production" as const,
			PRISMA_QUERY_ENGINE_LIBRARY: "/operator/engine.so.node",
		};
		expect(
			prismaEngineEnvironment("/missing-generated-directory", environment),
		).toEqual(environment);
	});

	it("fails before listening when the deployment omitted the engine", () => {
		const directory = generatedClient();
		writeFileSync(join(directory, "schema.prisma"), "schema fixture");
		mkdirSync(join(directory, "libquery_engine-invalid.so.node"));
		expect(() =>
			prismaEngineEnvironment(directory, { NODE_ENV: "production" }),
		).toThrow(/Prisma query engine/);
	});

	it("requires an explicit choice when multiple platform engines were packaged", () => {
		const directory = generatedClient();
		writeFileSync(
			join(directory, "libquery_engine-linux-arm64-openssl-3.0.x.so.node"),
			"arm64",
		);
		writeFileSync(
			join(directory, "libquery_engine-debian-openssl-3.0.x.so.node"),
			"amd64",
		);
		expect(() =>
			prismaEngineEnvironment(directory, { NODE_ENV: "production" }),
		).toThrow(/PRISMA_QUERY_ENGINE_LIBRARY/);
	});
});

import { spawnSync } from "node:child_process";
