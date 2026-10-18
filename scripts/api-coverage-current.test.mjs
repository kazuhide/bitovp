import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { enumerateOperations, collectEvidence } from "./api-coverage-current.mjs";

test("operation denominator preserves shared GET/DELETE paths and customData", () => {
	const rows = enumerateOperations("encoding/items/ItemsApi.js", `class ItemsApi {
	 get(id) { return this.restClient.get('/encoding/items/{id}', {}); }
	 delete(id) { return this.restClient.delete('/encoding/items/{id}', {}); }
	 custom() { return this.restClient.get('/encoding/items/{id}/customData', {}); }
	}`);
	assert.equal(rows.length, 3);
	assert.deepEqual(rows.map((r) => r.httpVerb), ["GET", "DELETE", "GET"]);
	assert.equal(rows[2].path, "/encoding/items/{id}/customData");
});

test("unsupported computed SDK transport path fails closed instead of shrinking denominator", () => {
	assert.throws(() => enumerateOperations("encoding/items/ItemsApi.js", `class ItemsApi {
	 get() { return this.restClient.get(prefix + '/items'); }
	}`), /literal/);
});

test("malformed SDK source fails closed instead of accepting a partial parse", () => {
	assert.throws(() => enumerateOperations("encoding/items/ItemsApi.js", "class ItemsApi { get( {"), /parse/);
});

test("checker follows aliases, excludes comments and lookalike local methods, and does not count tests", () => {
	const dir = mkdtempSync(join(tmpdir(), "coverage-checker-"));
	try {
		const sdk = join(dir, "sdk");
		mkdirSync(join(sdk, "encoding/items"), { recursive: true });
		writeFileSync(join(sdk, "encoding/items/ItemsApi.d.ts"), "export default class ItemsApi { get(id: string): Promise<void>; delete(id: string): Promise<void>; }");
		const src = join(dir, "source.ts");
		writeFileSync(src, `import Items from './sdk/encoding/items/ItemsApi';
		declare const items: Items;
		const alias = items; alias.get('id');
		// items.delete('comment');
		const text = "items.delete('string')";
		const unrelated = { delete(id: string) {} }; unrelated.delete('local');
		`);
		const testFile = join(dir, "source.test.ts");
		writeFileSync(testFile, "import Items from './sdk/encoding/items/ItemsApi'; declare const items:Items; items.delete('test');");
		const rows = enumerateOperations("encoding/items/ItemsApi.js", `class ItemsApi {
		get() { return this.restClient.get('/encoding/items/{id}'); }
		delete() { return this.restClient.delete('/encoding/items/{id}'); }
		}`);
		const evidence = collectEvidence({ root: dir, sdkRoot: sdk, files: [src, testFile], operations: rows, options: {} });
		assert.deepEqual(evidence.get(rows[0].identity), [{ file: "source.ts", line: 3 }]);
		assert.equal(evidence.has(rows[1].identity), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("ambiguous union calls do not promote an arbitrary SDK declaration or matching method tail", () => {
	const dir = mkdtempSync(join(tmpdir(), "coverage-union-"));
	try {
		const sdk = join(dir, "sdk");
		for (const family of ["inputs", "outputs"]) {
			mkdirSync(join(sdk, `encoding/${family}`), { recursive: true });
			writeFileSync(join(sdk, `encoding/${family}/ItemsApi.d.ts`), "export default class ItemsApi { get(id: string): Promise<void>; }");
		}
		const src = join(dir, "source.ts");
		writeFileSync(src, `import Inputs from './sdk/encoding/inputs/ItemsApi';
		import Outputs from './sdk/encoding/outputs/ItemsApi';
		declare const ambiguous: Inputs | Outputs; ambiguous.get('id');
		`);
		const rows = ["inputs", "outputs"].flatMap((f) => enumerateOperations(`encoding/${f}/ItemsApi.js`, `class ItemsApi { get() { return this.restClient.get('/encoding/${f}/{id}'); } }`));
		const evidence = collectEvidence({ root: dir, sdkRoot: sdk, files: [src], operations: rows, options: {} });
		assert.equal(evidence.size, 0);
		writeFileSync(src, "import Inputs from './sdk/encoding/inputs/ItemsApi'; declare const input:Inputs; input.get('id');");
		const direct = collectEvidence({ root: dir, sdkRoot: sdk, files: [src], operations: rows, options: {} });
		assert.equal(direct.has(rows[0].identity), true);
		assert.equal(direct.has(rows[1].identity), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("bundled observations include current heartbeat, MSL output, and daily usage callsites, not unrelated families", () => {
	const census = JSON.parse(readFileSync(new URL("../apps/web/src/data/api-coverage/current.json", import.meta.url), "utf8"));
	for (const [method, file] of [
		["encoding.encodings.live.heartbeat.get", "apps/worker/src/orchestrator/ops/live.ts"],
		["encoding.outputs.akamaiMsl.create", "apps/worker/src/orchestrator/ops/io.ts"],
		["encoding.statistics.encodings.live.daily.listByDateRange", "apps/worker/src/usage/statistics-sweep.ts"],
		["encoding.statistics.encodings.vod.daily.listByDateRange", "apps/worker/src/usage/statistics-sweep.ts"],
	]) {
		const row = census.endpoints.find((entry) => entry.sdkMethod === method);
		assert.equal(row?.status, "source-confirmed", method);
		assert.ok(row.evidence.some((entry) => entry.file === file && entry.line > 0));
	}
	assert.ok(census.endpoints.every((row) => row.path.startsWith("/encoding/")));
	assert.equal(census.endpoints.some((row) => row.sdkMethod.startsWith("notifications.")), false);
	assert.equal(census.summary.sourceConfirmed + census.summary.unconfirmed, census.endpoints.length);
});
