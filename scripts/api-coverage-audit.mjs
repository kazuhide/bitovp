/** Bounded manual GUI/payload audits. Source evidence is never provider proof. */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readContracts } from "./api-coverage-contract-files.mjs";

const ACCESS = new Set(["gui-confirmed", "json-only-confirmed", "not-implemented-confirmed", "unconfirmed"]);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function uniqueOperations(rows) {
	const names = rows.map((row) => row.sdkMethod);
	if (new Set(names).size !== names.length) throw new Error("Duplicate coverage operation");
	return names.sort();
}

function targetExists(type, path, schemas, seen = new Set()) {
	if (!type) return false;
	if (type.ref) {
		const key = `${type.ref}:${JSON.stringify(path)}`;
		if (seen.has(key)) return false;
		return targetExists(schemas[type.ref], path, schemas, new Set([...seen, key]));
	}
	if (!path.length) return true;
	if (type.kind === "union" || type.kind === "intersection") {
		return (type.variants ?? []).some((variant) => targetExists(variant, path, schemas, seen));
	}
	const property = type.properties?.find((row) => row.name === path[0]);
	return Boolean(property && targetExists(property.type, path.slice(1), schemas, seen));
}

function checkEvidence(rows, kind, readSource) {
	if (!Array.isArray(rows) || !rows.length) throw new Error(`Missing ${kind} evidence`);
	for (const row of rows) {
		if (typeof row.file !== "string" || !/^(apps|packages|scripts|docs)\//.test(row.file) || row.file.includes("\\") || row.file.split("/").some((part) => part === ".." || !part)) throw new Error("Unsafe evidence path");
		if (typeof row.anchor !== "string" || !row.anchor.trim() || !readSource(row.file).includes(row.anchor)) throw new Error(`Missing evidence anchor: ${row.file}`);
		if (kind === "gui" && !/^apps\/web\/src\/.*\.tsx$/.test(row.file)) throw new Error("GUI evidence must identify a form");
		if (kind === "contractTests" && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(row.file)) throw new Error("Contract-test evidence must identify a test");
	}
}

/** All unspecified operations and properties remain unconfirmed. No GUI percentage is inferred. */
export function operationCoverage(endpoint, audit) {
	return {
		source: endpoint.status,
		gui: "unconfirmed", json: "unconfirmed", contractTests: "unverified", provider: "unverified",
		targets: audit.entries.filter((entry) => entry.sdkMethod === endpoint.sdkMethod),
	};
}

export function validateImplementationAudit({ census, contracts, audit, readSource }) {
	if (audit.schemaVersion !== 1 || audit.sdkVersion !== census.provenance.sdkVersion || audit.sdkVersion !== contracts.provenance.sdkVersion) throw new Error("SDK versions must agree across all coverage evidence");
	if (JSON.stringify(uniqueOperations(census.endpoints)) !== JSON.stringify(uniqueOperations(contracts.operations))) throw new Error("Request-contract operation denominator differs from source census");
	const summary = { auditedTargets: 0, guiConfirmedTargets: 0, jsonOnlyTargets: 0, missingTargets: 0, unconfirmedTargets: 0, providerVerifiedTargets: 0 };
	const keys = new Set();
	for (const entry of audit.entries) {
		const operation = contracts.operations.find((row) => row.sdkMethod === entry.sdkMethod);
		if (!operation) throw new Error(`Unknown audit operation: ${entry.sdkMethod}`);
		const target = entry.target;
		if (!target || !["path", "query", "body"].includes(target.location) || !Array.isArray(target.propertyPath) || target.propertyPath.some((part) => typeof part !== "string" || !part)) throw new Error("Invalid audit target");
		const parameters = operation.parameters.filter((row) => row.location === target.location);
		if (!parameters.some((row) => targetExists(row.type, target.propertyPath, contracts.schemas))) throw new Error(`Unknown request target: ${entry.sdkMethod} ${target.propertyPath.join(".")}`);
		const key = JSON.stringify([entry.sdkMethod, target.location, target.propertyPath]);
		if (keys.has(key)) throw new Error(`Duplicate audit target: ${key}`);
		keys.add(key);
		if (!ACCESS.has(entry.access)) throw new Error("Unknown audit access status");
		if (entry.api) {
			const reference = entry.api.reference;
			let url;
			try { url = new URL(reference?.url); } catch { /* Report the evidence rule below. */ }
			if (entry.api.writeability !== "documented-request-field" || !url || url.protocol !== "https:" || url.hostname !== "developer.bitmovin.com" || url.username || url.password || !url.pathname.startsWith("/encoding/reference/") || !/^\d{4}-\d{2}-\d{2}$/.test(reference?.reviewedAt ?? "")) throw new Error("API request acceptance needs a dated official reference");
			if (!Array.isArray(entry.api.conditions) || entry.api.conditions.some((condition) => typeof condition !== "string" || !condition.trim())) throw new Error("Invalid documented request conditions");
		}
		// This ledger currently records source audits, not imported runtime receipts.
		if (entry.provider !== "unverified") throw new Error("A source audit cannot establish provider verification");
		for (const [kind, rows] of Object.entries(entry.evidence ?? {})) checkEvidence(rows, kind, readSource);
		if (entry.access === "gui-confirmed" || entry.access === "json-only-confirmed") {
			for (const kind of [entry.access === "gui-confirmed" ? "gui" : "json", "payload", "contractTests"]) checkEvidence(entry.evidence?.[kind], kind, readSource);
		}
		if (entry.access === "not-implemented-confirmed") {
			if (!entry.reason?.trim()) throw new Error("Missing target requires a scoped audit reason");
			if (!Object.values(entry.evidence ?? {}).some((rows) => rows.length)) throw new Error("Missing implementation finding requires source evidence");
		}
		summary.auditedTargets++;
		const count = { "gui-confirmed": "guiConfirmedTargets", "json-only-confirmed": "jsonOnlyTargets", "not-implemented-confirmed": "missingTargets", unconfirmed: "unconfirmedTargets" }[entry.access];
		summary[count]++;
	}
	return summary;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		if (process.argv[2] !== "--check") throw new Error("Usage: node scripts/api-coverage-audit.mjs --check");
		const read = (file) => JSON.parse(readFileSync(resolve(root, "apps/web/src/data/api-coverage", file), "utf8"));
		const summary = validateImplementationAudit({ census: read("current.json"), contracts: readContracts(resolve(root, "apps/web/src/data/api-coverage/contracts.json")), audit: read("implementation-audit.json"), readSource(file) {
			const actual = realpathSync(resolve(root, file));
			const rel = relative(root, actual);
			if (rel.startsWith("../") || isAbsolute(rel)) throw new Error("Unsafe evidence path outside repository");
			return readFileSync(actual, "utf8");
		} });
		console.log(JSON.stringify({ ...summary, fullGuiCoverage: "unconfirmed", providerCoverage: "unverified" }));
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
