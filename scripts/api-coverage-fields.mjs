/** Static inventory of SDK-declared, top-level body-model properties.
 * Shared response properties may occur in these models. This does not establish
 * write support, GUI reachability, a non-undefined value, or runtime success.
 */
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), "../apps/web/package.json"));
const ts = require("typescript");
const slash = (value) => value.replaceAll("\\", "/");
const WRITES = new Set(["post", "put", "patch"]);
const propertyDeclaration = (node) => ts.isPropertyDeclaration(node) || ts.isPropertySignature(node);
const excludedModifier = (node) => node.modifiers?.some((modifier) => [
	ts.SyntaxKind.ReadonlyKeyword, ts.SyntaxKind.PrivateKeyword,
	ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.StaticKeyword,
].includes(modifier.kind));

/** RestClient's third argument is a write body, but a GET's third argument is a query. */
export function enumerateBodyParameters(file, source) {
	const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	if (ast.parseDiagnostics.length) throw new Error(`Cannot parse SDK source: ${file}`);
	const rows = [];
	function visit(node, method) {
		if (ts.isMethodDeclaration(node)) method = node;
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const access = node.expression;
			if (access.expression.getText(ast) === "this.restClient" && WRITES.has(access.name.text) && node.arguments[2]) {
				const body = node.arguments[2];
				const index = method?.parameters.findIndex((parameter) => parameter.name.getText(ast) === body.getText(ast)) ?? -1;
				const path = node.arguments[0];
				if (!method || !ts.isIdentifier(body) || index < 0) throw new Error(`Unresolved SDK body parameter: ${file}`);
				if (!path || !ts.isStringLiteralLike(path) || !path.text.startsWith("/encoding/")) throw new Error(`Non-literal Encoding body path: ${file}`);
				rows.push({
					identity: `${file.replace(/\.js$/, ".d.ts")}#${method.name.getText(ast)}`,
					sdkMethod: `${slash(dirname(file)).replaceAll("/", ".")}.${method.name.getText(ast)}`,
					path: path.text, httpVerb: access.name.text.toUpperCase(), bodyParameterIndex: index,
				});
			}
		}
		ts.forEachChild(node, (child) => visit(child, method));
	}
	visit(ast);
	if (new Set(rows.map((row) => row.identity)).size !== rows.length) throw new Error(`Duplicate SDK body operation: ${file}`);
	return rows;
}

/** Reuses each source census TypeScript program; never executes SDK code. */
export function createRequestFieldAudit({ root, sdkRoot, bodyOperations }) {
	const metadata = new Map(bodyOperations.map((row) => [row.identity, row]));
	if (metadata.size !== bodyOperations.length) throw new Error("Duplicate SDK body operation identities");
	const inventory = new Map();
	const insideSdk = (file) => {
		const path = slash(relative(sdkRoot, file));
		return !path.startsWith("../") && !isAbsolute(path);
	};
	function observeProgram(program) {
		const checker = program.getTypeChecker();
		for (const [identity, meta] of metadata) {
			if (inventory.has(identity)) continue;
			const [file, name] = identity.split("#");
			const ast = program.getSourceFile(join(sdkRoot, file));
			if (!ast) continue;
			let method;
			function find(node) {
				if (ts.isMethodDeclaration(node) && node.name.getText(ast) === name) {
					if (method) throw new Error(`Ambiguous SDK body declaration: ${identity}`);
					method = node;
				}
				ts.forEachChild(node, find);
			}
			find(ast);
			const parameter = method?.parameters[meta.bodyParameterIndex];
			if (!parameter?.type) throw new Error(`Missing SDK body declaration: ${identity}`);
			const type = checker.getTypeFromTypeNode(parameter.type);
			const { identity: _identity, ...operation } = meta;
			const row = { ...operation, bodyModel: checker.typeToString(type, parameter, ts.TypeFormatFlags.NoTruncation), expansion: "expanded", fields: [] };
			let reason;
			if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) reason = "unknown-body";
			else if (type.isUnion()) reason = "union-body";
			else if (checker.isArrayType(type) || checker.isTupleType(type)) reason = "array-body";
			else if (checker.getIndexInfosOfType(type).length) reason = "dictionary-body";
			else if (!(type.flags & ts.TypeFlags.Object) || checker.getSignaturesOfType(type, ts.SignatureKind.Call).length) reason = "unsupported-body";
			if (reason) {
				row.expansion = "unexpanded";
				row.reason = reason;
			} else {
				for (const symbol of checker.getPropertiesOfType(type)) {
					const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
					if (!declaration || !propertyDeclaration(declaration) || excludedModifier(declaration)) continue;
					if (!insideSdk(declaration.getSourceFile().fileName)) throw new Error(`Non-SDK body property: ${identity}#${symbol.name}`);
					const source = declaration.getSourceFile();
					row.fields.push({
						name: symbol.name,
						type: checker.typeToString(checker.getTypeOfSymbolAtLocation(symbol, declaration), declaration, ts.TypeFormatFlags.NoTruncation),
						sdkEvidence: { file: slash(relative(sdkRoot, source.fileName)), line: source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1 },
						status: "unconfirmed", evidence: [],
					});
				}
				row.fields.sort((a, b) => a.name.localeCompare(b.name));
			}
			inventory.set(identity, row);
		}
	}
	function observeCall({ identity, node, source, checker }) {
		const row = inventory.get(identity);
		if (!row || row.expansion !== "expanded") return;
		let body = node.arguments[row.bodyParameterIndex];
		while (body && ts.isParenthesizedExpression(body)) body = body.expression;
		if (body && ts.isNewExpression(body)) {
			// An unrelated constructor's matching field names are not SDK evidence.
			let constructor = checker.getSymbolAtLocation(body.expression);
			if (constructor?.flags & ts.SymbolFlags.Alias) constructor = checker.getAliasedSymbol(constructor);
			const declarations = constructor?.declarations ?? [];
			if (!declarations.some((declaration) => ts.isClassDeclaration(declaration) && insideSdk(declaration.getSourceFile().fileName))) return;
			body = body.arguments?.[0];
		}
		if (!body || !ts.isObjectLiteralExpression(body)) return;
		// Spreads can override explicit properties; do not infer their final keys.
		if (body.properties.some(ts.isSpreadAssignment)) return;
		for (const property of body.properties) {
			if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
			if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) continue;
			const field = row.fields.find((candidate) => candidate.name === property.name.text);
			if (!field) continue;
			const evidence = {
				file: slash(relative(root, source.fileName)),
				line: source.getLineAndCharacterOfPosition(property.getStart(source)).line + 1,
				callLine: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
			};
			if (!field.evidence.some((old) => old.file === evidence.file && old.line === evidence.line && old.callLine === evidence.callLine)) field.evidence.push(evidence);
			field.status = "source-assigned";
		}
	}
	function finish() {
		const missing = bodyOperations.filter((row) => !inventory.has(row.identity));
		if (missing.length) throw new Error(`Unresolved SDK body models: ${missing.map((row) => row.identity).join(", ")}`);
		const operations = bodyOperations.map((row) => inventory.get(row.identity));
		const fields = operations.flatMap((row) => row.fields);
		const expandedOperations = operations.filter((row) => row.expansion === "expanded").length;
		const sourceAssigned = fields.filter((field) => field.status === "source-assigned").length;
		return {
			method: "typescript-sdk-body-properties-v1",
			scope: "Top-level SDK-declared body-model properties per Encoding write operation; inherited public properties included; nested objects, arrays, unions, dictionaries and opaque bodies are not expanded. Shared response properties may occur. Source assignments are syntax evidence only, not write support, GUI reachability or runtime success.",
			summary: { bodyOperations: operations.length, expandedOperations, unexpandedOperations: operations.length - expandedOperations, totalFields: fields.length, sourceAssigned, unconfirmed: fields.length - sourceAssigned },
			operations,
		};
	}
	return { observeProgram, observeCall, finish };
}
