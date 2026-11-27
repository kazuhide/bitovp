import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOperationLedger } from "../apps/web/src/lib/api-coverage/operation-ledger.ts";
import { validateImplementationAudit, operationCoverage } from "./api-coverage-audit.mjs";
import { auditedOperationCases } from "./api-coverage-test-cases.ts";

function fixture() {
	const sdkMethod = "encoding.configurations.video.h264.create";
	const create = { sdkMethod, httpVerb: "POST", path: "/encoding/configurations/video/h264" };
	const list = { sdkMethod: "encoding.templates.list", httpVerb: "GET", path: "/encoding/templates" };
	return {
		census: { provenance: { sdkVersion: "1.288.0" }, endpoints: [{ ...create, status: "source-confirmed", evidence: [{ file: "apps/worker/src/config.ts", line: 1 }] }, { ...list, status: "unconfirmed", evidence: [] }] },
		contracts: { provenance: { sdkVersion: "1.288.0" }, operations: [{ ...create, parameters: [{ location: "body", type: { ref: "H264" } }] }, { ...list, parameters: [] }], schemas: { H264: { kind: "object", properties: [{ name: "autoLevelSetup", type: { kind: "string" }, apiWriteability: "unconfirmed" }] } } },
		audit: { schemaVersion: 2, sdkVersion: "1.288.0", operations: [], entries: [{ sdkMethod, target: { location: "body", propertyPath: ["autoLevelSetup"] }, access: "gui-confirmed", evidence: { gui: [{ file: "apps/web/src/form.tsx", anchor: "autoLevelSetup" }], payload: [{ file: "apps/worker/src/config.ts", anchor: "serialize" }], contractTests: [{ file: "apps/worker/src/config.test.ts", anchor: "wire payload" }] }, provider: "unverified" }] },
		readSource: () => `export async function POST() {}\nautoLevelSetup; serialize; it("wire payload", () => {});\napi.${sdkMethod}();`,
	};
}

function withOperationProof(f) {
	f.audit.operations.push({
		sdkMethod: f.census.endpoints[0].sdkMethod,
		httpVerb: "POST",
		path: f.census.endpoints[0].path,
		scope: "vod",
		scenario: "A submitted VOD plan builds one H.264 configuration.",
		entrypoint: { httpVerb: "POST", path: "/api/encoding-jobs", anchor: "export async function POST" },
		transport: { file: "apps/worker/src/config.ts", anchor: `api.${f.census.endpoints[0].sdkMethod}(` },
		contractTest: { file: "apps/worker/src/config.test.ts", anchor: '\"wire payload\"' },
		provider: "unverified",
	});
	return f.audit.operations[0];
}

test("a bounded field audit does not promote the whole operation or unaudited APIs", () => {
	const f = fixture();
	assert.deepEqual(validateImplementationAudit(f), { auditedTargets: 1, guiConfirmedTargets: 1, jsonOnlyTargets: 0, missingTargets: 0, unconfirmedTargets: 0, providerVerifiedTargets: 0, operationSummary: { total: 2, appConfirmed: 0, transportConfirmed: 0, providerVerified: 0, unreviewed: 2 } });
	const row = operationCoverage(f.census.endpoints[0], f.audit);
	assert.equal(row.source, "source-confirmed");
	assert.equal(row.gui, "unconfirmed");
	assert.equal(row.provider, "unverified");
	assert.equal(row.targets[0].access, "gui-confirmed");
	assert.deepEqual(operationCoverage(f.census.endpoints[1], f.audit), { source: "unconfirmed", gui: "unconfirmed", json: "unconfirmed", contractTests: "unverified", provider: "unverified", targets: [] });
});

test("audited route and transport apply to only that operation, never the provider", () => {
	const f = fixture();
	const proof = withOperationProof(f);
	const ledger = buildOperationLedger(f.census, f.audit, "1.288.0");
	assert.deepEqual(ledger.summary, { total: 2, appConfirmed: 1, transportConfirmed: 1, providerVerified: 0, unreviewed: 1 });
	assert.deepEqual(validateImplementationAudit(f).operationSummary, ledger.summary);
	assert.deepEqual(ledger.operations[proof.sdkMethod], { reachability: "app-confirmed", contract: "transport-confirmed", provider: "unverified", proof });
	assert.deepEqual(ledger.operations[f.census.endpoints[1].sdkMethod], { reachability: "unreviewed", contract: "unverified", provider: "unverified", proof: null });
	assert.equal(buildOperationLedger(f.census, f.audit, "1.289.0").summary.unreviewed, 2);
});

test("operation proofs reject route, contract and canonical identity drift", () => {
	for (const mutate of [
		(f) => { f.audit.schemaVersion = 3; },
		(f, proof) => { proof.sdkMethod = "encoding.unknown"; },
		(f, proof) => { proof.httpVerb = "GET"; },
		(f, proof) => { proof.provider = "verified"; },
		(f, proof) => { proof.unrecognized = true; },
		(f, proof) => { f.audit.operations.push(structuredClone(proof)); },
		(f, proof) => { proof.entrypoint.path = "/api/../missing"; },
		(f, proof) => { proof.entrypoint.httpVerb = "DELETE"; },
		(f, proof) => { proof.transport.file = "apps/worker/src/unrelated.ts"; },
		(f) => { f.census.endpoints[0].status = "unconfirmed"; },
		(f, proof) => { proof.transport.anchor = "serialize"; },
		(f, proof) => { proof.contractTest.anchor = "old assertion"; },
		(f) => { f.contracts.operations[0].path = "/encoding/other"; },
	]) {
		const f = fixture();
		mutate(f, withOperationProof(f));
		assert.throws(() => validateImplementationAudit(f), /operation|proof|transport|anchor|route|provider|contract/i);
	}
});

test("a skipped, conditional or detached test cannot prove transport coverage", () => {
	for (const source of [
		'const fixture = "wire payload";',
		'it.skip("wire payload", () => {});',
		'it.skipIf(true)("wire payload", () => {});',
		'describe.skip("wire checks", () => { test("wire payload", () => {}); });',
	]) {
		const f = fixture();
		withOperationProof(f);
		const readSource = f.readSource;
		f.readSource = (file) => file.endsWith(".test.ts") ? source : readSource(file);
		assert.throws(() => validateImplementationAudit(f), /contract-test anchor/i);
	}
});

test("a database-dependent test may use its mandatory PostgreSQL fixture guard", () => {
	const f = fixture();
	const proof = withOperationProof(f);
	proof.contractTest.file = "apps/web/src/lib/server/encoding-resources/removal.integration.test.ts";
	const readSource = f.readSource;
	f.readSource = (file) => file === proof.contractTest.file
		? 'describe.runIf(available)("wire checks", () => { test("wire payload", () => {}); });'
		: readSource(file);
	assert.equal(validateImplementationAudit(f).operationSummary.transportConfirmed, 1);
});

test("an audited each test must register the ledger-bound case dataset", () => {
	const f = fixture();
	const proof = withOperationProof(f);
	const readSource = f.readSource;
	const imported = 'import { auditedOperationCases } from "../../../scripts/api-coverage-test-cases";';
	const withCases = (group) => `it.each(auditedOperationCases(import.meta.url, "${group}", rows, targets))("wire payload", () => {});`;
	const setTest = (source) => { f.readSource = (file) => file === proof.contractTest.file ? source : readSource(file); };
	setTest('it.each(rows)("wire payload", () => {});');
	assert.throws(() => validateImplementationAudit(f), /contract-test anchor/i);
	proof.contractTest.caseGroup = "codec-create";
	setTest(`${imported}\n${withCases("codec-create")}`);
	assert.equal(validateImplementationAudit(f).operationSummary.transportConfirmed, 1);
	for (const source of [
		`${imported}\n${withCases("another-group")}`,
		withCases("codec-create"),
		`${imported}\ndescribe("shadowed guard", () => { const auditedOperationCases = (...args) => args[2]; ${withCases("codec-create")} });`,
		`${imported}\nit.each(rows)("wire payload", () => { auditedOperationCases(import.meta.url, "codec-create", rows, targets); });`,
		`${imported}\ndescribe.skipIf(true).each(rows)("suite", () => { ${withCases("codec-create")} });`,
	]) {
		setTest(source);
		assert.throws(() => validateImplementationAudit(f), /contract-test anchor/i);
	}
});

test("dropping a row from a paired dataset loses its reviewed operation proof", () => {
	const file = new URL("../apps/worker/src/orchestrator/make-sdk.test.ts", import.meta.url).href;
	const cases = ["/encoding/inputs/s3-role-based", "/encoding/outputs/s3-role-based"];
	const targets = (path) => [`POST ${path}`];
	assert.equal(auditedOperationCases(file, "worker-s3-role-create", cases, targets), cases);
	assert.throws(
		() => auditedOperationCases(file, "worker-s3-role-create", cases.slice(0, 1), targets),
		/Audit case missing .*encoding\.outputs\.s3RoleBased\.create/i,
	);
});

test("transport proof pins the full SDK family and resolves a const alias scope", () => {
	const f = fixture();
	const proof = withOperationProof(f);
	const target = { sdkMethod: "encoding.encodings.muxings.mp4.information.get", httpVerb: "GET", path: "/encoding/encodings/{encoding_id}/muxings/mp4/{muxing_id}/information" };
	Object.assign(f.census.endpoints[0], target);
	Object.assign(f.contracts.operations[0], target);
	Object.assign(proof, target);
	f.audit.entries = [];
	const readSource = f.readSource;
	const supplyTransport = (source) => { f.readSource = (file) => file === proof.transport.file ? source : readSource(file); };
	const direct = "api.encoding.encodings.muxings.mp4.information.get(";
	const other = "api.encoding.encodings.muxings.fmp4.information.get(";
	supplyTransport(`${direct}id,muxing);\n${other}id,muxing);`);
	proof.transport.anchor = direct;
	assert.equal(validateImplementationAudit(f).operationSummary.transportConfirmed, 1);
	proof.transport.anchor = other;
	assert.throws(() => validateImplementationAudit(f), /anchor one SDK call/i);

	proof.transport.anchor = "muxing.information.get(";
	supplyTransport('const muxing = api.encoding.encodings.muxings.mp4; function inspect() { muxing.information.get(id, resource); }');
	assert.equal(validateImplementationAudit(f).operationSummary.transportConfirmed, 1);
	supplyTransport('const muxing = api.encoding.encodings.muxings.mp4; function inspect(muxing) { muxing.information.get(id, resource); }');
	assert.throws(() => validateImplementationAudit(f), /anchor one SDK call/i);
});

test("a commented route or detached route anchor cannot prove app reachability", () => {
	for (const source of [
		"// export async function POST() {}",
		"export async function POST() { /* await enqueue() */ }",
		"export async function POST() {}\nexport async function GET() { await enqueue() }",
	]) {
		const f = fixture();
		const proof = withOperationProof(f);
		if (!source.startsWith("//")) proof.entrypoint.anchor = "await enqueue()";
		const readSource = f.readSource;
		f.readSource = (file) => file.endsWith("/route.ts") ? source : readSource(file);
		assert.throws(() => validateImplementationAudit(f), /route|anchor/i);
	}
});

test("SDK skew and omitted or duplicate operations fail instead of silently changing the denominator", () => {
	for (const change of [
		(f) => { f.audit.sdkVersion = "1.287.0"; },
		(f) => { f.contracts.provenance.sdkVersion = "1.287.0"; },
		(f) => { f.contracts.operations.pop(); },
		(f) => { f.contracts.operations.push(f.contracts.operations[0]); },
	]) {
		const f = fixture(); change(f);
		assert.throws(() => validateImplementationAudit(f), /SDK|operation/i);
	}
});

test("audit targets must exist in the current request schema and be unique", () => {
	for (const change of [
		(f) => { f.audit.entries[0].target.propertyPath = ["madeUp"]; },
		(f) => { f.audit.entries[0].sdkMethod = "encoding.madeUp.create"; },
		(f) => { f.audit.entries.push(structuredClone(f.audit.entries[0])); },
		(f) => { const copy = structuredClone(f.audit.entries[0]); copy.target = { propertyPath: copy.target.propertyPath, location: copy.target.location }; f.audit.entries.push(copy); },
	]) {
		const f = fixture(); change(f);
		assert.throws(() => validateImplementationAudit(f), /target|operation|duplicate/i);
	}
});

test("GUI confirmation requires actual form, payload, and contract-test evidence", () => {
	for (const key of ["gui", "payload", "contractTests"]) {
		const f = fixture(); f.audit.entries[0].evidence[key] = [];
		assert.throws(() => validateImplementationAudit(f), /evidence/i);
	}
	const f = fixture(); f.readSource = () => "unrelated source";
	assert.throws(() => validateImplementationAudit(f), /anchor/i);
});

test("unsafe evidence paths and invented statuses are refused", () => {
	for (const file of ["/etc/passwd", "../private", "apps/../../secret", "C:\\secret", "apps\\secret"]) {
		const f = fixture(); f.audit.entries[0].evidence.gui[0].file = file;
		assert.throws(() => validateImplementationAudit(f), /evidence path/i);
	}
	const f = fixture(); f.audit.entries[0].access = "all-supported";
	assert.throws(() => validateImplementationAudit(f), /access/i);
});

test("source and test-file existence cannot become provider verification", () => {
	const f = fixture(); f.audit.entries[0].provider = "verified";
	assert.throws(() => validateImplementationAudit(f), /provider/i);
	const unknown = fixture(); unknown.audit.entries[0].access = "unconfirmed";
	assert.equal(validateImplementationAudit(unknown).unconfirmedTargets, 1);
});

test("a missing-implementation finding needs a scoped reason and source evidence", () => {
	const f = fixture();
	f.audit.entries[0].access = "not-implemented-confirmed";
	f.audit.entries[0].reason = "The current plan cannot represent the output.";
	f.audit.entries[0].evidence = {};
	assert.throws(() => validateImplementationAudit(f), /evidence/i);
});

test("JSON-only and SDK read-only evidence stay distinct from GUI support and API writeability", () => {
	const f = fixture();
	f.audit.entries[0].access = "json-only-confirmed";
	f.audit.entries[0].evidence.json = f.audit.entries[0].evidence.gui;
	delete f.audit.entries[0].evidence.gui;
	f.contracts.schemas.H264.properties[0].sdkReadonly = true;
	assert.equal(validateImplementationAudit(f).jsonOnlyTargets, 1);
	assert.equal(operationCoverage(f.census.endpoints[0], f.audit).gui, "unconfirmed");
	assert.equal(f.contracts.schemas.H264.properties[0].apiWriteability, "unconfirmed");
});

test("documented request acceptance needs a dated official reference and cannot imply execution", () => {
	const f = fixture();
	f.audit.entries[0].api = { writeability: "documented-request-field", reference: { url: "https://developer.bitmovin.com/encoding/reference/postencodingconfigurationsvideoh264", reviewedAt: "2026-11-16" }, conditions: ["Explicit maxBitrate disables automatic calculation."] };
	assert.equal(validateImplementationAudit(f).providerVerifiedTargets, 0);
	for (const url of ["http://developer.bitmovin.com/encoding/reference/item", "https://developer.bitmovin.com.evil.example/encoding/reference/item", "https://user:secret@developer.bitmovin.com/encoding/reference/item"]) {
		const invalid = structuredClone(f.audit);
		invalid.entries[0].api.reference.url = url;
		assert.throws(() => validateImplementationAudit({ ...f, audit: invalid }), /official reference/i);
	}
	delete f.audit.entries[0].api.reference;
	assert.throws(() => validateImplementationAudit(f), /official reference/i);
});
