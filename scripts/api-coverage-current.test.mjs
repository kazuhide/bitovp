import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { enumerateOperations, collectEvidence, censusContent, censusDifferences, censusRunDifferences } from "./api-coverage-current.mjs";
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

test("source evidence has stable file and line order when input files are reversed", () => {
	const dir = mkdtempSync(join(tmpdir(), "coverage-order-"));
	try {
		const sdk = join(dir, "sdk");
		mkdirSync(join(sdk, "encoding/items"), { recursive: true });
		writeFileSync(join(sdk, "encoding/items/ItemsApi.d.ts"), "export default class ItemsApi { get(id: string): Promise<void>; }");
		const first = join(dir, "a.ts");
		const last = join(dir, "z.ts");
		writeFileSync(first, `import Items from './sdk/encoding/items/ItemsApi';
declare const items: Items;
items.get('first');
items.get('second');
`);
		writeFileSync(last, `import Items from './sdk/encoding/items/ItemsApi';
declare const items: Items;
items.get('last');
`);
		const rows = enumerateOperations("encoding/items/ItemsApi.js", "class ItemsApi { get() { return this.restClient.get('/encoding/items/{id}'); } }");
		const expected = [[rows[0].identity, [
			{ file: "a.ts", line: 3 },
			{ file: "a.ts", line: 4 },
			{ file: "z.ts", line: 3 },
		]]];
		for (const files of [[first, last], [last, first]]) {
			const originalOrder = [...files];
			const evidence = collectEvidence({ root: dir, sdkRoot: sdk, files, operations: rows, options: {} });
			assert.deepEqual([...evidence], expected);
			assert.deepEqual(files, originalOrder);
		}
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

function censusFixture() {
	return {
		schemaVersion: 1,
		provenance: { generatedAt: "2026-11-10T00:00:00.000Z", sourceCommit: "a".repeat(40), sourceFingerprint: "b".repeat(64), sdkVersion: "1.287.0", typescriptVersion: "5.9.3", sdkFingerprint: "c".repeat(64), method: "typescript-resolved-sdk-signatures-v1", scope: "encoding" },
		summary: { totalOperations: 2, sourceConfirmed: 1, unconfirmed: 1, createTotal: 1, createSourceConfirmed: 1 },
		families: [{ family: "items", total: 2, sourceConfirmed: 1, unconfirmed: 1 }],
		endpoints: [
			{ path: "/encoding/items", httpVerb: "POST", operation: "create", sdkMethod: "encoding.items.create", family: "items", status: "source-confirmed", evidence: [{ file: "apps/worker/src/a.ts", line: 10 }, { file: "apps/worker/src/a.ts", line: 30 }, { file: "apps/web/src/b.ts", line: 5 }] },
			{ path: "/encoding/items/{id}", httpVerb: "GET", operation: "get", sdkMethod: "encoding.items.get", family: "items", status: "unconfirmed", evidence: [] },
		],
		requestFields: {
			method: "typescript-sdk-body-properties-v1",
			scope: "fixture",
			summary: { bodyOperations: 1, expandedOperations: 1, unexpandedOperations: 0, totalFields: 2, sourceAssigned: 1, unconfirmed: 1 },
			operations: [{
				sdkMethod: "encoding.items.create", path: "/encoding/items", httpVerb: "POST", bodyParameterIndex: 0, bodyModel: "Item", expansion: "expanded",
				fields: [
					{ name: "name", type: "string | undefined", sdkEvidence: { file: "models/Item.d.ts", line: 4 }, status: "source-assigned", evidence: [{ file: "apps/worker/src/a.ts", line: 12, callLine: 10 }] },
					{ name: "other", type: "string | undefined", sdkEvidence: { file: "models/Item.d.ts", line: 5 }, status: "unconfirmed", evidence: [] },
				],
			}],
		},
	};
}

test("unrelated source changes and shifted lines leave the census content unchanged", () => {
	const saved = censusFixture();
	const current = censusFixture();
	Object.assign(current.provenance, { generatedAt: "2026-11-11T00:00:00.000Z", sourceCommit: "d".repeat(40), sourceFingerprint: "e".repeat(64), typescriptVersion: "5.9.4" });
	for (const entry of current.endpoints[0].evidence) entry.line += 7;
	Object.assign(current.requestFields.operations[0].fields[0].evidence[0], { line: 19, callLine: 17 });
	assert.deepEqual(censusDifferences(saved, current), []);
	// Only the exact check reports what a refresh at release preparation rewrites.
	assert.deepEqual(censusRunDifferences(saved, current), [
		`provenance: sourceFingerprint "${"b".repeat(64)}" -> "${"e".repeat(64)}"`,
		'provenance: typescriptVersion "5.9.3" -> "5.9.4"',
		"evidence line numbers or entry order differ",
	]);
	assert.deepEqual(censusRunDifferences(saved, censusFixture()), []);
});

test("each change to the SDK surface, reached operations, fields or evidence files is named", () => {
	const create = "encoding.items.create (POST /encoding/items)";
	for (const [change, expected] of [
		[(c) => { c.provenance.sdkVersion = "1.288.0"; }, ['census: sdkVersion "1.287.0" -> "1.288.0"']],
		[(c) => { c.provenance.sdkFingerprint = "f".repeat(64); }, [`census: sdkFingerprint "${"c".repeat(64)}" -> "${"f".repeat(64)}"`]],
		[(c) => { c.endpoints[1].status = "source-confirmed"; c.endpoints[1].evidence.push({ file: "apps/web/src/new.ts", line: 3 }); }, [
			'encoding.items.get (GET /encoding/items/{id}): status "unconfirmed" -> "source-confirmed"',
			"encoding.items.get (GET /encoding/items/{id}): evidence +apps/web/src/new.ts",
		]],
		[(c) => { c.endpoints[0].evidence[2].file = "apps/web/src/moved.ts"; }, [`${create}: evidence -apps/web/src/b.ts +apps/web/src/moved.ts`]],
		[(c) => { c.endpoints[0].evidence.pop(); c.endpoints[0].evidence.pop(); }, [`${create}: evidence -apps/web/src/b.ts -apps/worker/src/a.ts x2 +apps/worker/src/a.ts`]],
		[(c) => { c.endpoints.pop(); }, ["encoding.items.get (GET /encoding/items/{id}): no longer produced by the source"]],
		[(c) => { c.endpoints.push({ ...c.endpoints[1], sdkMethod: "encoding.items.list", path: "/encoding/items", operation: "list" }); }, ["encoding.items.list (GET /encoding/items): missing from the committed census"]],
		[(c) => { c.summary.sourceConfirmed = 2; c.families[0].sourceConfirmed = 2; }, ["summary: sourceConfirmed 1 -> 2", "family items: sourceConfirmed 1 -> 2"]],
		[(c) => { const field = c.requestFields.operations[0].fields[1]; field.status = "source-assigned"; field.evidence.push({ file: "apps/worker/src/a.ts", line: 13, callLine: 10 }); }, [
			`${create} body field other: status "unconfirmed" -> "source-assigned"`,
			`${create} body field other: evidence +apps/worker/src/a.ts`,
		]],
		[(c) => { c.requestFields.operations[0].fields[0].type = "number | undefined"; }, [`${create} body field name: type "string | undefined" -> "number | undefined"`]],
		[(c) => { c.requestFields.operations[0].expansion = "unexpanded"; }, [`${create} body: expansion "expanded" -> "unexpanded"`]],
		[(c) => { c.requestFields.summary.sourceAssigned = 2; }, ['request fields: summary {"bodyOperations":1,"expandedOperations":1,"unexpandedOperations":0,"totalFields":2,"sourceAssigned":1,"unconfirmed":1} -> {"bodyOperations":1,"expandedOperations":1,"unexpandedOperations":0,"totalFields":2,"sourceAssigned":2,"unconfirmed":1}']],
	]) {
		const current = censusFixture();
		change(current);
		assert.deepEqual(censusDifferences(censusFixture(), current), expected);
	}
});

test("a census that cannot be compared entry by entry fails closed", () => {
	const duplicate = censusFixture();
	duplicate.endpoints.push({ ...duplicate.endpoints[0] });
	assert.throws(() => censusContent(duplicate), /Ambiguous census entry: encoding\.items\.create/);
	assert.throws(() => censusContent({ ...censusFixture(), extra: [] }), /Unknown census section: extra/);
});

test("the bundled census yields one comparable entry per operation, family and body field", () => {
	const census = JSON.parse(readFileSync(new URL("../apps/web/src/data/api-coverage/current.json", import.meta.url), "utf8"));
	const fields = census.requestFields.operations.reduce((total, operation) => total + operation.fields.length, 0);
	assert.equal(censusContent(census).size, 3 + census.families.length + census.endpoints.length + census.requestFields.operations.length + fields);
	assert.deepEqual(censusDifferences(census, census), []);
});
