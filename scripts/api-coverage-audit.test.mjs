import assert from "node:assert/strict";
import { test } from "node:test";
import { validateImplementationAudit, operationCoverage } from "./api-coverage-audit.mjs";

function fixture() {
	const sdkMethod = "encoding.configurations.video.h264.create";
	return {
		census: { provenance: { sdkVersion: "1.288.0" }, endpoints: [{ sdkMethod, status: "source-confirmed" }, { sdkMethod: "encoding.templates.list", status: "unconfirmed" }] },
		contracts: { provenance: { sdkVersion: "1.288.0" }, operations: [{ sdkMethod, parameters: [{ location: "body", type: { ref: "H264" } }] }, { sdkMethod: "encoding.templates.list", parameters: [] }], schemas: { H264: { kind: "object", properties: [{ name: "autoLevelSetup", type: { kind: "string" }, apiWriteability: "unconfirmed" }] } } },
		audit: { schemaVersion: 1, sdkVersion: "1.288.0", entries: [{ sdkMethod, target: { location: "body", propertyPath: ["autoLevelSetup"] }, access: "gui-confirmed", evidence: { gui: [{ file: "apps/web/src/form.tsx", anchor: "autoLevelSetup" }], payload: [{ file: "apps/worker/src/config.ts", anchor: "serialize" }], contractTests: [{ file: "apps/worker/src/config.test.ts", anchor: "wire payload" }] }, provider: "unverified" }] },
		readSource: () => "autoLevelSetup serialize wire payload",
	};
}

test("a bounded field audit does not promote the whole operation or unaudited APIs", () => {
	const f = fixture();
	assert.deepEqual(validateImplementationAudit(f), { auditedTargets: 1, guiConfirmedTargets: 1, jsonOnlyTargets: 0, missingTargets: 0, unconfirmedTargets: 0, providerVerifiedTargets: 0 });
	const row = operationCoverage(f.census.endpoints[0], f.audit);
	assert.equal(row.source, "source-confirmed");
	assert.equal(row.gui, "unconfirmed");
	assert.equal(row.provider, "unverified");
	assert.equal(row.targets[0].access, "gui-confirmed");
	assert.deepEqual(operationCoverage(f.census.endpoints[1], f.audit), { source: "unconfirmed", gui: "unconfirmed", json: "unconfirmed", contractTests: "unverified", provider: "unverified", targets: [] });
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
