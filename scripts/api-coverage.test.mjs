import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { renderCoverageCsv } from "./api-coverage.mjs";

const census = {
	provenance: {
		sdkVersion: "1.284.0",
		generatedAt: "2026-10-20T00:00:00.000Z",
		sourceCommit: "source-commit",
		sourceFingerprint: "source-fingerprint",
		sdkFingerprint: "sdk-fingerprint",
		method: "typescript-resolved-sdk-signatures-v1",
		scope: "encoding",
	},
	summary: { totalOperations: 3, sourceConfirmed: 1, unconfirmed: 2 },
	endpoints: [
		{
			httpVerb: "GET",
			path: "/encoding/items/{id}",
			sdkMethod: "encoding.items.get",
			family: "items",
			status: "source-confirmed",
			evidence: [{ file: "apps/worker/src/items.ts", line: 42 }],
		},
		{
			httpVerb: "DELETE",
			path: "/encoding/items/{id}",
			sdkMethod: "encoding.items.delete",
			family: "items",
			status: "unconfirmed",
			evidence: [],
		},
		{
			httpVerb: "GET",
			path: "/encoding/items/{id}/customData",
			sdkMethod: "encoding.items.customData.get",
			family: "items",
			status: "unconfirmed",
			evidence: [],
		},
	],
};

test("CSV preserves GET, DELETE and customData operations with their exact source evidence", () => {
	const csv = renderCoverageCsv(census);
	assert.ok(csv.startsWith("\uFEFF"));
	assert.ok(csv.includes('"SDK version","1.284.0"\r\n'));
	assert.ok(csv.includes('"Total operations","3"\r\n'));
	assert.ok(csv.includes('"Source-confirmed operations","1"\r\n'));
	assert.ok(csv.includes('"GET","/encoding/items/{id}","encoding.items.get","items","source-confirmed","apps/worker/src/items.ts:42"\r\n'));
	assert.ok(csv.includes('"DELETE","/encoding/items/{id}","encoding.items.delete","items","unconfirmed",""\r\n'));
	assert.ok(csv.includes('"GET","/encoding/items/{id}/customData","encoding.items.customData.get","items","unconfirmed",""\r\n'));
	assert.equal(csv.match(/"source-confirmed"/g)?.length, 1);
});

test("CSV escapes quotes, commas and newlines while preserving Unicode evidence", () => {
	const fixture = structuredClone(census);
	fixture.endpoints = [{
		...fixture.endpoints[0],
		evidence: [
			{ file: 'apps/worker/src/a,"b"\n\u00e9.ts', line: 7 },
			{ file: "apps/web/src/c.ts", line: 9 },
		],
	}];
	assert.ok(renderCoverageCsv(fixture).includes('"apps/worker/src/a,""b""\n\u00e9.ts:7; apps/web/src/c.ts:9"\r\n'));
});

function fixtureModule(dir, body) {
	const moduleFile = join(dir, "api-coverage.mjs");
	writeFileSync(moduleFile, readFileSync(new URL("./api-coverage.mjs", import.meta.url)));
	writeFileSync(join(dir, "api-coverage-current.mjs"), body);
	return moduleFile;
}

test("importing the exporter does not generate a census, access the network or create an output", () => {
	const dir = mkdtempSync(join(tmpdir(), "coverage-csv-import-"));
	try {
		const moduleFile = fixtureModule(dir, 'export function generateCensus() { throw new Error("Unexpected census generation"); }');
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", `globalThis.fetch = () => { throw new Error("Unexpected network access"); }; await import(${JSON.stringify(pathToFileURL(moduleFile).href)});`], { cwd: dir, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, "");
		assert.deepEqual(readdirSync(dir).sort(), ["api-coverage-current.mjs", "api-coverage.mjs"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("CLI writes only the requested CSV using the shared census", () => {
	const dir = mkdtempSync(join(tmpdir(), "coverage-csv-cli-"));
	try {
		const moduleFile = fixtureModule(dir, `export function generateCensus() { return ${JSON.stringify(census)}; }`);
		const output = join(dir, "coverage.csv");
		const result = spawnSync(process.execPath, [moduleFile, output], { cwd: dir, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(readFileSync(output, "utf8"), renderCoverageCsv(census));
		assert.deepEqual(readdirSync(dir).sort(), ["api-coverage-current.mjs", "api-coverage.mjs", "coverage.csv"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
