import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { enumerateOperations, collectEvidence } from "./api-coverage-current.mjs";
import { enumerateBodyParameters, createRequestFieldAudit } from "./api-coverage-fields.mjs";

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

test("body inventory follows the SDK transport body parameter instead of guessing from parameter types", () => {
	const rows = enumerateBodyParameters("encoding/items/ItemsApi.js", `class ItemsApi {
	 create(id, options, body) { return this.restClient.post('/encoding/items/{id}', {id}, body); }
	 stop(id) { return this.restClient.post('/encoding/items/{id}/stop', {id}); }
	 list(query) { return this.restClient.get('/encoding/items', {}, query); }
	}`);
	assert.deepEqual(rows, [{
		identity: "encoding/items/ItemsApi.d.ts#create", sdkMethod: "encoding.items.create",
		path: "/encoding/items/{id}", httpVerb: "POST", bodyParameterIndex: 2,
	}]);
	assert.throws(() => enumerateBodyParameters("encoding/items/ItemsApi.js", `class ItemsApi {
	 create(body) { return this.restClient.post('/encoding/items', {}, {...body}); }
	}`), /body parameter/);
});

function fieldFixture(source) {
	const dir = mkdtempSync(join(tmpdir(), "coverage-fields-"));
	const sdk = join(dir, "sdk");
	mkdirSync(join(sdk, "encoding/items"), { recursive: true });
	mkdirSync(join(sdk, "models"));
	writeFileSync(join(sdk, "models/Body.d.ts"), `declare class Base {
	 id?: string;
	 inherited?: number;
	 readonly providerType: string;
	 protected hidden: string;
	 static staticField: string;
	 method(): void;
	}
	export default class Body extends Base {
	 own?: string;
	 other?: string;
	 nested?: {child: string};
	 constructor(value?: Partial<Body>);
	}`);
	writeFileSync(join(sdk, "encoding/items/ItemsApi.d.ts"), `import Body from '../../models/Body';
	export default class ItemsApi {
	 create(id: string, body?: Body): Promise<void>;
	 union(body: Body | {alternative: string}): Promise<void>;
	 unknown(body: any): Promise<void>;
	 dictionary(body: {[key: string]: string}): Promise<void>;
	 array(body: Body[]): Promise<void>;
	}`);
	const js = `class ItemsApi {
	 create(id, body) { return this.restClient.post('/encoding/items/{id}', {id}, body); }
	 union(body) { return this.restClient.post('/encoding/union', {}, body); }
	 unknown(body) { return this.restClient.post('/encoding/unknown', {}, body); }
	 dictionary(body) { return this.restClient.post('/encoding/dictionary', {}, body); }
	 array(body) { return this.restClient.post('/encoding/array', {}, body); }
	}`;
	const file = join(dir, "source.ts");
	writeFileSync(file, `import Items from './sdk/encoding/items/ItemsApi';
	import Body from './sdk/models/Body';
	declare const items: Items;
	${source}`);
	const operations = enumerateOperations("encoding/items/ItemsApi.js", js);
	const audit = createRequestFieldAudit({ root: dir, sdkRoot: sdk, bodyOperations: enumerateBodyParameters("encoding/items/ItemsApi.js", js) });
	collectEvidence({ root: dir, sdkRoot: sdk, files: [file], operations, options: {strict: true}, onProgram: audit.observeProgram, onCall: audit.observeCall });
	return { dir, audit };
}

test("request fields include inherited public properties and separate opaque bodies without expanding nested properties", () => {
	const {dir, audit} = fieldFixture("items.create('id', new Body({own: 'value'}));");
	try {
		const inventory = audit.finish();
		const create = inventory.operations.find(r => r.sdkMethod === "encoding.items.create");
		assert.deepEqual(create.fields.map(f => f.name), ["id", "inherited", "nested", "other", "own"]);
		assert.equal(create.fields.find(f => f.name === "nested").status, "unconfirmed");
		assert.ok(create.fields.every(f => f.sdkEvidence.file === "models/Body.d.ts" && f.sdkEvidence.line > 0));
		assert.equal(create.fields.some(f => f.name === "child"), false);
		assert.deepEqual(inventory.operations.filter(r => r.expansion === "unexpanded").map(r => r.reason).sort(), ["array-body", "dictionary-body", "union-body", "unknown-body"]);
		assert.deepEqual(inventory.summary, { bodyOperations: 5, expandedOperations: 1, unexpandedOperations: 4, totalFields: 5, sourceAssigned: 1, unconfirmed: 4 });
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("field evidence comes only from direct SDK call body literals and constructors, never standalone objects or dynamic paths", () => {
	const {dir, audit} = fieldFixture(`
	 new Body({other: 'unused'});
	 const variable = new Body({other: 'variable'});
	 items.create('id', variable);
	 const changed = new Body(); changed.other = 'assignment'; items.create('id', changed);
	 const helper = () => new Body({other: 'helper'}); items.create('id', helper());
	 const spread = {other: 'spread'}; items.create('id', {...spread});
	 items.create('id', {other: 'overridden', ...spread});
	 items.create('id', new Body({['other']: 'computed'}));
	 const Local = class { constructor(value: unknown) {} } as unknown as typeof Body;
	 items.create('id', new Local({other: 'asserted local constructor'}));
	 items.create('id', new Body({own: undefined}));
	 items.create('id', {inherited: 2});
	 const unrelated = {create(id: string, body: Body) {}}; unrelated.create('id', {other: 'local'});
	`);
	try {
		const create = audit.finish().operations.find(r => r.sdkMethod === "encoding.items.create");
		assert.deepEqual(create.fields.filter(f => f.status === "source-assigned").map(f => f.name), ["inherited", "own"]);
		for (const field of create.fields.filter(f => f.status === "source-assigned")) {
			assert.equal(field.evidence.length, 1);
			assert.equal(field.evidence[0].file, "source.ts");
			assert.ok(field.evidence[0].line > 0 && field.evidence[0].callLine > 0);
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unresolved SDK body declarations fail closed instead of silently shrinking the field inventory", () => {
	const audit = createRequestFieldAudit({ root: "/fixture", sdkRoot: "/fixture/sdk", bodyOperations: [{ identity: "encoding/items/ItemsApi.d.ts#create", sdkMethod: "encoding.items.create", path: "/encoding/items", httpVerb: "POST", bodyParameterIndex: 0 }] });
	assert.throws(() => audit.finish(), /Unresolved SDK body models/);
});
