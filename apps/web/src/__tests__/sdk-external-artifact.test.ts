import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts", "assert-sdk-external.sh");
const require = createRequire(join(process.cwd(), "package.json"));
const fixtures: string[] = [];
afterEach(() => {
	for (const directory of fixtures.splice(0))
		rmSync(directory, { recursive: true, force: true });
});
function artifact() {
	const root = mkdtempSync(join(tmpdir(), "bitovp-sdk-artifact-"));
	fixtures.push(root);
	mkdirSync(join(root, "server", "chunks"), { recursive: true });
	for (const [scope, name] of [
		["@bitmovin", "api-sdk-test"],
		["@google-cloud", "storage-test"],
		["@azure", "storage-blob-test"],
	] as const) {
		const path = join(root, "node_modules", scope, name);
		mkdirSync(path, { recursive: true });
		writeFileSync(
			join(path, "package.json"),
			JSON.stringify({ name: `${scope}/${name}` }),
		);
	}
	return root;
}
const check = (root: string) =>
	spawnSync("bash", [script, root], { encoding: "utf8" });

describe("SDK externalization artifact guard", () => {
	it("allows a public SDK source link without treating it as bundled SDK code", () => {
		const root = artifact();
		writeFileSync(
			join(root, "server", "chunks", "sources.js"),
			'export const source="https://github.com/bitmovin/bitmovin-api-sdk-javascript/blob/v1.285.0/src/models/PerTitleConfiguration.ts";',
		);
		const result = check(root);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("all 3 SDKs external");
	});
	it("rejects the actual installed SDK REST client if compiled into a server chunk", () => {
		const root = artifact();
		const client = readFileSync(
			join(
				dirname(require.resolve("@bitmovin/api-sdk")),
				"common",
				"RestClient.js",
			),
			"utf8",
		);
		writeFileSync(join(root, "server", "chunks", "client.js"), client);
		const result = check(root);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("@bitmovin/api-sdk is INLINED");
	});
	it.each([
		["gccl-invocation-id", "@google-cloud/storage"],
		["azsdk-js-azure-storage-blob", "@azure/storage-blob"],
	])("retains the inlined package check for %s", (marker, packageName) => {
		const root = artifact();
		writeFileSync(
			join(root, "server", "chunks", "client.js"),
			`export const telemetry=${JSON.stringify(marker)};`,
		);
		const result = check(root);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(`${packageName} is INLINED`);
	});
	it("still rejects a missing external shim", () => {
		const root = artifact();
		rmSync(join(root, "node_modules", "@bitmovin"), { recursive: true });
		const result = check(root);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("no @bitmovin/api-sdk shim");
	});
});
