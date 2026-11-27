/** Bounded manual GUI/payload audits. Source evidence is never provider proof. */
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOperationLedger, readOperationProofs, sameOperation } from "../apps/web/src/lib/api-coverage/operation-ledger.ts";
import { readContracts } from "./api-coverage-contract-files.mjs";
import { GROUPS } from "./postgres-integration.mjs";

const ACCESS = new Set(["gui-confirmed", "json-only-confirmed", "not-implemented-confirmed", "unconfirmed"]);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(root, "apps/web/package.json"));
const ts = require("typescript");
const mandatoryFixtures = new Set(GROUPS.flatMap(({ directory, files }) =>
	Object.keys(files).map((file) => `${directory}/${file}`),
));

function uniqueOperations(rows) {
	const operations = new Map(rows.map((row) => [row.sdkMethod, row]));
	if (operations.size !== rows.length) throw new Error("Duplicate coverage operation");
	return operations;
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

function hasCodeAnchor(source, node, anchor) {
	return source.text.startsWith(anchor, node.getStart(source)) ||
		Boolean(ts.forEachChild(node, (child) => hasCodeAnchor(source, child, anchor) || undefined));
}

function verifyEntrypoint({ path, httpVerb, anchor }, readSource) {
	const file = `apps/web/src/app${path}/route.ts`;
	const source = ts.createSourceFile(file, readSource(file), ts.ScriptTarget.Latest, true);
	const hasHandler = source.statements.some((statement) => {
		if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return false;
		if (ts.isFunctionDeclaration(statement)) {
			return statement.name?.text === httpVerb && Boolean(statement.body) && hasCodeAnchor(source, statement, anchor);
		}
		return ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) =>
			ts.isIdentifier(declaration.name) && declaration.name.text === httpVerb && declaration.initializer &&
			hasCodeAnchor(source, statement, anchor),
		);
	});
	if (!hasHandler) throw new Error(`Operation proof lacks an exported route with its evidence anchor: ${file}`);
}

function propertyPath(expression) {
	const parts = [];
	while (ts.isPropertyAccessExpression(expression)) {
		parts.unshift(expression.name.text);
		expression = expression.expression;
	}
	return ts.isIdentifier(expression) ? { base: expression, parts } : undefined;
}

function localBindingChecker(source) {
	const options = { noLib: true, noResolve: true, types: [] };
	const host = ts.createCompilerHost(options);
	host.getSourceFile = (file) => file === source.fileName ? source : undefined;
	return ts.createProgram([source.fileName], options, host).getTypeChecker();
}

function sdkTarget(expression, checker) {
	let target = propertyPath(expression);
	const seen = new Set();
	while (target) {
		if (target.parts[0] === "encoding") return target.parts.join(".");
		const binding = checker().getSymbolAtLocation(target.base)?.valueDeclaration;
		if (!binding || seen.has(binding) || !ts.isVariableDeclaration(binding) ||
			!ts.isVariableDeclarationList(binding.parent) || !(binding.parent.flags & ts.NodeFlags.Const) || !binding.initializer) return;
		seen.add(binding);
		const alias = propertyPath(binding.initializer);
		target = alias && { base: alias.base, parts: [...alias.parts, ...target.parts] };
	}
}

function verifyTransport(proof, readSource) {
	const { file, anchor } = proof.transport;
	const source = ts.createSourceFile(resolve(root, file), readSource(file), ts.ScriptTarget.Latest, true);
	let bindingChecker;
	const checker = () => bindingChecker ??= localBindingChecker(source);
	let matches = 0;
	function visit(node) {
		if (ts.isCallExpression(node) && node.getText(source).startsWith(anchor) &&
			sdkTarget(node.expression, checker) === proof.sdkMethod) matches++;
		ts.forEachChild(node, visit);
	}
	visit(source);
	if (matches !== 1) throw new Error(`Operation proof must anchor one SDK call: ${proof.sdkMethod}`);
}

function callName(node) {
	if (ts.isIdentifier(node)) return [node.text];
	if (ts.isCallExpression(node)) return callName(node.expression);
	if (ts.isPropertyAccessExpression(node)) return [...callName(node.expression), node.name.text];
	return [];
}

function hasAuditedCases(source, test, group, checker) {
	const each = test.expression;
	if (!ts.isCallExpression(each) || !ts.isPropertyAccessExpression(each.expression) || each.expression.name.text !== "each") return false;
	const wrapped = each.arguments[0];
	if (!wrapped || !ts.isCallExpression(wrapped) || !ts.isIdentifier(wrapped.expression) || wrapped.expression.text !== "auditedOperationCases" || wrapped.arguments.length !== 4) return false;
	const [file, name] = wrapped.arguments;
	if (file.getText(source) !== "import.meta.url" || !ts.isStringLiteral(name) || name.text !== group) return false;
	const binding = checker().getSymbolAtLocation(wrapped.expression)?.declarations?.find(ts.isImportSpecifier);
	if (!binding || binding.isTypeOnly || binding.propertyName) return false;
	const clause = binding.parent.parent;
	const statement = clause.parent;
	if (!ts.isImportClause(clause) || clause.isTypeOnly || !ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return false;
	return resolve(dirname(source.fileName), statement.moduleSpecifier.text) === resolve(root, "scripts/api-coverage-test-cases");
}

function hasTestAnchor(source, node, proof, mandatoryFixture, checker) {
	const { anchor, caseGroup } = proof;
	if (ts.isCallExpression(node)) {
		const [name, ...modifiers] = callName(node.expression);
		if (["it", "test", "describe", "suite"].includes(name) &&
			modifiers.some((modifier) => ["skip", "todo", "only"].includes(modifier) ||
				(!mandatoryFixture && ["skipIf", "runIf"].includes(modifier)))) return false;
		if ((name === "it" || name === "test") &&
			node.arguments.some((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) &&
			(modifiers.includes("each") ? caseGroup && hasAuditedCases(source, node, caseGroup, checker) : !caseGroup) &&
			hasCodeAnchor(source, node, anchor)) return true;
	}
	return Boolean(ts.forEachChild(node, (child) => hasTestAnchor(source, child, proof, mandatoryFixture, checker) || undefined));
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
	if (audit.sdkVersion !== census.provenance.sdkVersion || audit.sdkVersion !== contracts.provenance.sdkVersion) throw new Error("SDK versions must agree across all coverage evidence");
	const endpoints = uniqueOperations(census.endpoints);
	const contractOperations = uniqueOperations(contracts.operations);
	if (endpoints.size !== contractOperations.size || [...endpoints.values()].some((endpoint) => {
		const contract = contractOperations.get(endpoint.sdkMethod);
		return !contract || !sameOperation(endpoint, contract);
	})) throw new Error("Request-contract operation denominator differs from source census");
	const proofs = readOperationProofs(census, audit);
	const tests = new Map();
	for (const proof of proofs.values()) {
		verifyEntrypoint(proof.entrypoint, readSource);
		checkEvidence([proof.transport], "transport", readSource);
		verifyTransport(proof, readSource);
		checkEvidence([proof.contractTest], "contractTests", readSource);
		const { file } = proof.contractTest;
		if (!tests.has(file)) {
			const source = ts.createSourceFile(resolve(root, file), readSource(file), ts.ScriptTarget.Latest, true);
			let bindingChecker;
			tests.set(file, { source, checker: () => bindingChecker ??= localBindingChecker(source) });
		}
		const { source, checker } = tests.get(file);
		if (!hasTestAnchor(source, source, proof.contractTest, mandatoryFixtures.has(file), checker)) throw new Error(`Operation proof lacks an active contract-test anchor or bound case group: ${proof.sdkMethod} in ${file}`);
	}
	const summary = { auditedTargets: 0, guiConfirmedTargets: 0, jsonOnlyTargets: 0, missingTargets: 0, unconfirmedTargets: 0, providerVerifiedTargets: 0 };
	const keys = new Set();
	for (const entry of audit.entries) {
		const operation = contractOperations.get(entry.sdkMethod);
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
	return { ...summary, operationSummary: buildOperationLedger(census, audit, audit.sdkVersion).summary };
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
