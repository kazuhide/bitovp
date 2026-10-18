import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { findForbiddenTerms } from "./customer-copy-registry";

type RuntimeHit = {
	readonly file: string;
	readonly line: number;
	readonly id: string;
	readonly match: string;
	readonly text: string;
};

type Analysis = {
	readonly source: ts.SourceFile;
	readonly checker: ts.TypeChecker;
	readonly assignments: ReadonlyMap<ts.Symbol, readonly ts.Expression[]>;
	readonly emitters: ReadonlyMap<ts.Symbol, number>;
	readonly rawHelpers: ReadonlySet<ts.Symbol>;
};

const SOURCE_ROOT = join(__dirname, "..");

function sourceFiles(root: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...sourceFiles(path));
		} else if (
			/\.tsx?$/.test(entry.name) &&
			!entry.name.includes(".test.") &&
			!entry.name.includes(".spec.")
		) {
			files.push(path);
		}
	}
	return files;
}

/**
 * Every browser-consumable API route is included without checking whether it
 * already adopted the structured helper. Explicit machine/admin boundaries
 * are excluded; shared server response helpers are included separately.
 */
function customerErrorProducers(): string[] {
	return sourceFiles(SOURCE_ROOT).filter((path) => {
		const file = relative(SOURCE_ROOT, path);
		if (file === "proxy.ts") return true;
		if (file.startsWith("lib/server/")) {
			return readFileSync(path, "utf8").includes("jsonError(");
		}
		return (
			file.startsWith("app/api/") &&
			file.endsWith("/route.ts") &&
			!file.startsWith("app/api/admin/") &&
			!file.startsWith("app/api/health/") &&
			!file.startsWith("app/api/webhooks/")
		);
	});
}

function createSource(
	file: string,
	text: string,
): {
	source: ts.SourceFile;
	checker: ts.TypeChecker;
} {
	const options: ts.CompilerOptions = {
		jsx: ts.JsxEmit.Preserve,
		noLib: true,
		noResolve: true,
		target: ts.ScriptTarget.Latest,
	};
	const host = ts.createCompilerHost(options);
	const source = ts.createSourceFile(
		file,
		text,
		ts.ScriptTarget.Latest,
		true,
		file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	host.getSourceFile = (requested) => (requested === file ? source : undefined);
	host.fileExists = (requested) => requested === file;
	host.readFile = (requested) => (requested === file ? text : undefined);
	const program = ts.createProgram([file], options, host);
	return {
		source: program.getSourceFile(file) ?? source,
		checker: program.getTypeChecker(),
	};
}

function symbolOf(
	checker: ts.TypeChecker,
	node: ts.Node,
): ts.Symbol | undefined {
	return checker.getSymbolAtLocation(node);
}

function assignmentMap(
	source: ts.SourceFile,
	checker: ts.TypeChecker,
): Map<ts.Symbol, ts.Expression[]> {
	const map = new Map<ts.Symbol, ts.Expression[]>();
	const add = (name: ts.Identifier, value: ts.Expression) => {
		const symbol = symbolOf(checker, name);
		if (symbol) {
			map.set(symbol, [...(map.get(symbol) ?? []), value]);
		}
	};
	const visit = (node: ts.Node): void => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer
		) {
			add(node.name, node.initializer);
		}
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			ts.isIdentifier(node.left)
		) {
			add(node.left, node.right);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return map;
}

function functionEntries(
	source: ts.SourceFile,
	checker: ts.TypeChecker,
): Array<{ symbol: ts.Symbol; node: ts.FunctionLikeDeclaration }> {
	const entries: Array<{
		symbol: ts.Symbol;
		node: ts.FunctionLikeDeclaration;
	}> = [];
	const visit = (node: ts.Node): void => {
		if (ts.isFunctionDeclaration(node) && node.name && node.body) {
			const symbol = symbolOf(checker, node.name);
			if (symbol) entries.push({ symbol, node });
		}
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			(ts.isArrowFunction(node.initializer) ||
				ts.isFunctionExpression(node.initializer))
		) {
			const symbol = symbolOf(checker, node.name);
			if (symbol) entries.push({ symbol, node: node.initializer });
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return entries;
}

function isNextResponseJson(
	call: ts.CallExpression,
	source: ts.SourceFile,
): boolean {
	return (
		ts.isPropertyAccessExpression(call.expression) &&
		call.expression.expression.getText(source) === "NextResponse" &&
		call.expression.name.text === "json"
	);
}

function errorProperty(
	object: ts.ObjectLiteralExpression,
): ts.Expression | undefined {
	for (const property of object.properties) {
		if (
			ts.isPropertyAssignment(property) &&
			(ts.isIdentifier(property.name) ||
				ts.isStringLiteralLike(property.name)) &&
			property.name.text === "error"
		) {
			return property.initializer;
		}
	}
	return undefined;
}

function namedProperty(
	object: ts.ObjectLiteralExpression,
	name: string,
): ts.Expression | undefined {
	for (const property of object.properties) {
		if (
			ts.isPropertyAssignment(property) &&
			(ts.isIdentifier(property.name) ||
				ts.isStringLiteralLike(property.name)) &&
			property.name.text === name
		) {
			return property.initializer;
		}
	}
	return undefined;
}

function emitterIndex(
	call: ts.CallExpression,
	checker: ts.TypeChecker,
	emitters: ReadonlyMap<ts.Symbol, number>,
	assignments?: ReadonlyMap<ts.Symbol, readonly ts.Expression[]>,
): number | undefined {
	if (ts.isIdentifier(call.expression)) {
		if (
			call.expression.text === "jsonError" ||
			call.expression.text === "codedError"
		) {
			return 1;
		}
		const symbol = symbolOf(checker, call.expression);
		if (!symbol) return undefined;
		const latest = assignments
			?.get(symbol)
			?.filter((value) => value.getStart() < call.expression.getStart())
			.at(-1);
		if (latest && ts.isIdentifier(latest)) {
			if (latest.text === "jsonError" || latest.text === "codedError") return 1;
			const target = symbolOf(checker, latest);
			return target ? emitters.get(target) : undefined;
		}
		return emitters.get(symbol);
	}
	return undefined;
}

function localWalk(root: ts.Node, visit: (node: ts.Node) => void): void {
	const walk = (node: ts.Node): void => {
		if (node !== root && ts.isFunctionLike(node)) return;
		visit(node);
		ts.forEachChild(node, walk);
	};
	walk(root);
}

function buildEmitters(
	source: ts.SourceFile,
	checker: ts.TypeChecker,
): Map<ts.Symbol, number> {
	const emitters = new Map<ts.Symbol, number>();
	const functions = functionEntries(source, checker);
	const aliases: Array<{ alias: ts.Identifier; target: ts.Identifier }> = [];
	const collectAliases = (node: ts.Node): void => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			ts.isIdentifier(node.initializer)
		) {
			aliases.push({ alias: node.name, target: node.initializer });
		}
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			ts.isIdentifier(node.left) &&
			ts.isIdentifier(node.right)
		) {
			aliases.push({ alias: node.left, target: node.right });
		}
		ts.forEachChild(node, collectAliases);
	};
	collectAliases(source);
	let changed = true;
	while (changed) {
		changed = false;
		// Scope-aware direct aliases, including handler-local aliases,
		// reassignment and alias-of-alias chains.
		for (const candidate of aliases) {
			const alias = symbolOf(checker, candidate.alias);
			if (!alias || emitters.has(alias)) continue;
			const targetName = candidate.target.text;
			const target = symbolOf(checker, candidate.target);
			const index =
				targetName === "jsonError" || targetName === "codedError"
					? 1
					: target
						? emitters.get(target)
						: undefined;
			if (index !== undefined) {
				emitters.set(alias, index);
				changed = true;
			}
		}
		// Wrappers whose parameter is forwarded to an emitter or response object.
		for (const entry of functions) {
			if (emitters.has(entry.symbol)) continue;
			const parameterSymbols = entry.node.parameters.map((parameter) =>
				ts.isIdentifier(parameter.name)
					? symbolOf(checker, parameter.name)
					: undefined,
			);
			let wrapperIndex: number | undefined;
			localWalk(entry.node, (node) => {
				if (wrapperIndex !== undefined || !ts.isCallExpression(node)) return;
				let outbound: ts.Expression | undefined;
				const index = emitterIndex(node, checker, emitters);
				if (index !== undefined) outbound = node.arguments[index];
				if (
					!outbound &&
					isNextResponseJson(node, source) &&
					node.arguments[0] &&
					ts.isObjectLiteralExpression(node.arguments[0])
				) {
					outbound = errorProperty(node.arguments[0]);
				}
				if (outbound && ts.isIdentifier(outbound)) {
					const outboundSymbol = symbolOf(checker, outbound);
					const parameterIndex = parameterSymbols.findIndex(
						(symbol) => symbol && symbol === outboundSymbol,
					);
					if (parameterIndex >= 0) wrapperIndex = parameterIndex;
				}
			});
			if (wrapperIndex !== undefined) {
				emitters.set(entry.symbol, wrapperIndex);
				changed = true;
			}
		}
	}
	return emitters;
}

function isEquality(node: ts.Node): boolean {
	return (
		ts.isBinaryExpression(node) &&
		[
			ts.SyntaxKind.EqualsEqualsToken,
			ts.SyntaxKind.EqualsEqualsEqualsToken,
			ts.SyntaxKind.ExclamationEqualsToken,
			ts.SyntaxKind.ExclamationEqualsEqualsToken,
		].includes(node.operatorToken.kind)
	);
}

function unwrapExpression(node: ts.Expression): ts.Expression {
	if (
		ts.isParenthesizedExpression(node) ||
		ts.isAsExpression(node) ||
		ts.isTypeAssertionExpression(node) ||
		ts.isNonNullExpression(node)
	) {
		return unwrapExpression(node.expression);
	}
	return node;
}

/**
 * The request-error shape is intentionally narrow: form-validation and
 * validation-issue messages are locale-owned client copy, while `error.message`
 * and `mutation.error.message` can contain arbitrary API/provider prose.
 */
function directRawRequestMessage(node: ts.Node): boolean {
	if (!ts.isPropertyAccessExpression(node) || node.name.text !== "message") {
		return false;
	}
	const owner = unwrapExpression(node.expression);
	return (
		(ts.isIdentifier(owner) && /^(?:err|error|failure)$/.test(owner.text)) ||
		(ts.isPropertyAccessExpression(owner) &&
			/^(?:error|failure)$/.test(owner.name.text))
	);
}

/** Persisted worker/provider prose fields that must never be customer copy. */
function directPersistedRawValue(node: ts.Node): boolean {
	return (
		ts.isPropertyAccessExpression(node) &&
		(node.name.text === "error" || node.name.text === "unavailableReason")
	);
}

function directRawCustomerValue(node: ts.Node): boolean {
	return directRawRequestMessage(node) || directPersistedRawValue(node);
}

function buildRawHelpers(
	source: ts.SourceFile,
	checker: ts.TypeChecker,
): Set<ts.Symbol> {
	const helpers = new Set<ts.Symbol>();
	for (const entry of functionEntries(source, checker)) {
		localWalk(entry.node, (node) => {
			if (
				(ts.isReturnStatement(node) &&
					node.expression &&
					directRawCustomerValue(node.expression)) ||
				(ts.isArrowFunction(entry.node) &&
					entry.node.body === node &&
					directRawCustomerValue(node))
			) {
				helpers.add(entry.symbol);
			}
		});
	}
	return helpers;
}

function analyze(file: string, text: string): Analysis {
	const { source, checker } = createSource(file, text);
	return {
		source,
		checker,
		assignments: assignmentMap(source, checker),
		emitters: buildEmitters(source, checker),
		rawHelpers: buildRawHelpers(source, checker),
	};
}

function staticTexts(
	node: ts.Expression,
	analysis: Analysis,
	seen: ReadonlySet<ts.Symbol> = new Set(),
): string[] {
	if (ts.isStringLiteralLike(node)) return [node.text];
	if (ts.isIdentifier(node)) {
		const symbol = symbolOf(analysis.checker, node);
		if (!symbol || seen.has(symbol)) return [];
		return (analysis.assignments.get(symbol) ?? [])
			.filter(
				(value) =>
					value.getStart(analysis.source) < node.getStart(analysis.source),
			)
			.flatMap((value) =>
				staticTexts(value, analysis, new Set([...seen, symbol])),
			);
	}
	if (ts.isParenthesizedExpression(node))
		return staticTexts(node.expression, analysis, seen);
	if (
		ts.isBinaryExpression(node) &&
		node.operatorToken.kind === ts.SyntaxKind.PlusToken
	) {
		const left = staticTexts(node.left, analysis, seen);
		const right = staticTexts(node.right, analysis, seen);
		return (left.length ? left : [" "]).flatMap((a) =>
			(right.length ? right : [" "]).map((b) => `${a}${b}`),
		);
	}
	if (ts.isTemplateExpression(node)) {
		let values = [node.head.text];
		for (const span of node.templateSpans) {
			const expressions = staticTexts(span.expression, analysis, seen);
			values = values.flatMap((prefix) =>
				(expressions.length ? expressions : [" "]).map(
					(value) => `${prefix}${value}${span.literal.text}`,
				),
			);
		}
		return values;
	}
	if (ts.isConditionalExpression(node)) {
		return [
			...staticTexts(node.whenTrue, analysis, seen),
			...staticTexts(node.whenFalse, analysis, seen),
		];
	}
	return [];
}

function outboundExpressions(analysis: Analysis): ts.Expression[] {
	const expressions: ts.Expression[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const index = emitterIndex(
				node,
				analysis.checker,
				analysis.emitters,
				analysis.assignments,
			);
			if (index !== undefined && node.arguments[index])
				expressions.push(node.arguments[index]);
			if (
				isNextResponseJson(node, analysis.source) &&
				node.arguments[0] &&
				ts.isObjectLiteralExpression(node.arguments[0])
			) {
				const error = errorProperty(node.arguments[0]);
				if (error) expressions.push(error);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(analysis.source);
	return expressions;
}

function scanOutboundCopy(file: string, text: string): RuntimeHit[] {
	const analysis = analyze(file, text);
	const hits: RuntimeHit[] = [];
	for (const expression of outboundExpressions(analysis)) {
		if (rawOutboundProse(expression, analysis)) {
			const { line } = analysis.source.getLineAndCharacterOfPosition(
				expression.getStart(analysis.source),
			);
			hits.push({
				file,
				line: line + 1,
				id: "raw-outbound-prose",
				match: expression.getText(analysis.source),
				text: expression.getText(analysis.source),
			});
		}
		for (const output of staticTexts(expression, analysis)) {
			for (const hit of findForbiddenTerms(output)) {
				const { line } = analysis.source.getLineAndCharacterOfPosition(
					expression.getStart(analysis.source),
				);
				hits.push({ file, line: line + 1, text: output, ...hit });
			}
		}
	}
	return hits;
}

function rawOutboundProse(
	node: ts.Expression,
	analysis: Analysis,
	seen: ReadonlySet<ts.Symbol> = new Set(),
): boolean {
	const expression = unwrapExpression(node);
	if (directRawRequestMessage(expression)) return true;
	if (ts.isIdentifier(expression)) {
		const symbol = symbolOf(analysis.checker, expression);
		if (!symbol || seen.has(symbol)) return false;
		return (analysis.assignments.get(symbol) ?? []).some((value) =>
			rawOutboundProse(value, analysis, new Set([...seen, symbol])),
		);
	}
	let found = false;
	ts.forEachChild(expression, (child) => {
		if (!found && ts.isExpression(child)) {
			found = rawOutboundProse(child, analysis, seen);
		}
	});
	return found;
}

function rawDiagnosticReason(
	node: ts.Expression,
	analysis: Analysis,
	seen: ReadonlySet<ts.Symbol> = new Set(),
): boolean {
	const expression = unwrapExpression(node);
	if (
		(ts.isIdentifier(expression) &&
			/^(?:reason|configReason|readinessReason)$/.test(expression.text)) ||
		(ts.isPropertyAccessExpression(expression) &&
			expression.name.text === "reason")
	) {
		return true;
	}
	if (ts.isIdentifier(expression)) {
		const symbol = symbolOf(analysis.checker, expression);
		if (!symbol || seen.has(symbol)) return false;
		return (analysis.assignments.get(symbol) ?? []).some((value) =>
			rawDiagnosticReason(value, analysis, new Set([...seen, symbol])),
		);
	}
	let found = false;
	ts.forEachChild(expression, (child) => {
		if (!found && ts.isExpression(child)) {
			found = rawDiagnosticReason(child, analysis, seen);
		}
	});
	return found;
}

/** Raw auth/provider readiness prose must stay in server logs, not JSON details. */
function scanRawResponseDetails(file: string, text: string): RuntimeHit[] {
	const analysis = analyze(file, text);
	const hits: RuntimeHit[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isCallExpression(node) &&
			isNextResponseJson(node, analysis.source) &&
			node.arguments[0] &&
			ts.isObjectLiteralExpression(node.arguments[0])
		) {
			const details = namedProperty(node.arguments[0], "details");
			if (details && rawDiagnosticReason(details, analysis)) {
				const { line } = analysis.source.getLineAndCharacterOfPosition(
					details.getStart(analysis.source),
				);
				hits.push({
					file,
					line: line + 1,
					id: "raw-diagnostic-details",
					match: details.getText(analysis.source),
					text: details.getText(analysis.source),
				});
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(analysis.source);
	return hits;
}

const SAFE_CUSTOMER_ERROR_RENDERERS = new Set([
	"localizedCustomerError",
	// C36: extracts the STRUCTURED per-attribute differences of a
	// SLATE_INCOMPATIBLE refusal (table attribute names + measured AV values);
	// it drops every other field, so no provider prose reaches the DOM through it.
	"slateDifferencesOf",
	"customerFeederErrorMessage",
	"feederErrorMessage",
	"actionFailureMessage",
	"feederFailureMessage",
	"wizardSubmitError",
]);

function containsRawCustomerValue(
	node: ts.Expression,
	analysis: Analysis,
	seen: ReadonlySet<ts.Symbol> = new Set(),
): boolean {
	if (isEquality(node)) return false;
	const expression = unwrapExpression(node);
	if (directRawCustomerValue(expression)) return true;
	if (ts.isConditionalExpression(expression)) {
		return (
			containsRawCustomerValue(expression.whenTrue, analysis, seen) ||
			containsRawCustomerValue(expression.whenFalse, analysis, seen)
		);
	}
	if (
		ts.isBinaryExpression(expression) &&
		expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
	) {
		// The left arm is only a render predicate; only the right arm reaches DOM.
		return containsRawCustomerValue(expression.right, analysis, seen);
	}
	if (ts.isIdentifier(expression)) {
		const symbol = symbolOf(analysis.checker, expression);
		if (!symbol || seen.has(symbol)) return false;
		return (analysis.assignments.get(symbol) ?? []).some((value) =>
			containsRawCustomerValue(value, analysis, new Set([...seen, symbol])),
		);
	}
	if (
		ts.isCallExpression(expression) &&
		ts.isIdentifier(expression.expression)
	) {
		if (expression.expression.text === "Boolean") return false;
		if (SAFE_CUSTOMER_ERROR_RENDERERS.has(expression.expression.text))
			return false;
		const symbol = symbolOf(analysis.checker, expression.expression);
		if (symbol && analysis.rawHelpers.has(symbol)) return true;
	}
	let found = false;
	ts.forEachChild(expression, (child) => {
		if (!found && ts.isExpression(child)) {
			found = containsRawCustomerValue(child, analysis, seen);
		}
	});
	return found;
}

function conditionRequiresTrueIdentifier(
	node: ts.Expression,
	name: string,
): boolean {
	const expression = unwrapExpression(node);
	if (ts.isIdentifier(expression)) return expression.text === name;
	if (
		ts.isBinaryExpression(expression) &&
		expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
	) {
		return (
			conditionRequiresTrueIdentifier(expression.left, name) ||
			conditionRequiresTrueIdentifier(expression.right, name)
		);
	}
	if (
		ts.isBinaryExpression(expression) &&
		[
			ts.SyntaxKind.EqualsEqualsToken,
			ts.SyntaxKind.EqualsEqualsEqualsToken,
		].includes(expression.operatorToken.kind)
	) {
		return (
			(ts.isIdentifier(expression.left) &&
				expression.left.text === name &&
				expression.right.kind === ts.SyntaxKind.TrueKeyword) ||
			(ts.isIdentifier(expression.right) &&
				expression.right.text === name &&
				expression.left.kind === ts.SyntaxKind.TrueKeyword)
		);
	}
	return false;
}

/**
 * Raw provider diagnostics are permitted only when the enclosing true arm
 * logically requires the server-authorized ADMIN flag. Names are never an
 * exemption, and negated/OR conditions do not prove authorization.
 */
function isAdminDiagnosticExpression(node: ts.JsxExpression): boolean {
	for (
		let current: ts.Node | undefined = node;
		current;
		current = current.parent
	) {
		if (
			ts.isConditionalExpression(current) &&
			conditionRequiresTrueIdentifier(
				current.condition,
				"technicalDetailsAllowed",
			) &&
			node.getStart() >= current.whenTrue.getStart() &&
			node.getEnd() <= current.whenTrue.getEnd()
		) {
			return true;
		}
	}
	return false;
}

function customerVisibleJsxExpression(
	node: ts.JsxExpression,
): ts.Expression | undefined {
	const expression = node.expression;
	if (
		expression &&
		ts.isConditionalExpression(expression) &&
		conditionRequiresTrueIdentifier(
			expression.condition,
			"technicalDetailsAllowed",
		)
	) {
		// The true arm is the server-authorized ADMIN disclosure. The false arm
		// is still customer-visible and therefore remains under the raw-copy gate.
		return expression.whenFalse;
	}
	return expression;
}

function scanRawJsxErrors(file: string, text: string): RuntimeHit[] {
	const analysis = analyze(file, text);
	const hits: RuntimeHit[] = [];
	const visit = (node: ts.Node): void => {
		const visibleExpression = ts.isJsxExpression(node)
			? customerVisibleJsxExpression(node)
			: undefined;
		if (
			ts.isJsxExpression(node) &&
			visibleExpression &&
			!isAdminDiagnosticExpression(node) &&
			containsRawCustomerValue(visibleExpression, analysis)
		) {
			const { line } = analysis.source.getLineAndCharacterOfPosition(
				visibleExpression.getStart(analysis.source),
			);
			hits.push({
				file,
				line: line + 1,
				id: "raw-customer-error",
				match: visibleExpression.getText(analysis.source),
				text: visibleExpression.getText(analysis.source),
			});
		}
		ts.forEachChild(node, visit);
	};
	visit(analysis.source);
	return hits;
}

describe("customer runtime copy", () => {
	it("discovers browser APIs including alert rules independently of helper adoption", () => {
		const files = customerErrorProducers().map((path) =>
			relative(SOURCE_ROOT, path),
		);
		for (const required of [
			"proxy.ts",
			"app/api/alert-rules/route.ts",
			"app/api/auth/login/route.ts",
			"app/api/auth/session/route.ts",
			"app/api/live-channels/[id]/actions/route.ts",
			"app/api/live-channels/[id]/capture-vmaf/route.ts",
			"lib/server/live-channel-encoding.ts",
		])
			expect(files).toContain(required);
	});

	it("rejects raw provider/config reasons from response details", () => {
		const fixture = `
			const raw = tokenConfig.reason;
			NextResponse.json({ error: "Unavailable", details: raw }, { status: 503 });
		`;
		expect(
			scanRawResponseDetails("proxy-positive-control.ts", fixture),
		).toHaveLength(1);
	});

	it("catches raw/coded/wrapped/aliased routes, reassignment, shadowing and split text", () => {
		const fixture = `
			const emit = jsonError;
			const wrapped = (status, message) => emit(status, message);
			let reassigned = "safe"; reassigned = "AUTH_" + "MODE";
			const shadowed = "safe";
			{ const shadowed = "台" + "帳 タ" + "スク #27"; wrapped(409, shadowed); }
			jsonError(409, "led" + "ger (#108)");
			codedError(409, reassigned, "CODE");
			function handler(error) {
				const localAlias = jsonError;
				const localEmitter = localAlias;
				const dynamic = error.message;
				localEmitter(500, dynamic);
			}
		`;
		const ids = scanOutboundCopy("brand-new-route.ts", fixture).map(
			(hit) => hit.id,
		);
		expect(ids).toEqual(
			expect.arrayContaining([
				"raw-outbound-prose",
				"ledger",
				"issue-number",
				"ledger-ja",
				"task-number-ja",
				"auth-mode",
			]),
		);
	});

	it("uses the latest emitter assignment at each call site", () => {
		const fixture = `
			function handler() {
				let emit = jsonError;
				emit = safeResponse;
				emit(409, "ledger (#108)");
			}
		`;
		expect(scanOutboundCopy("safe-reassignment-control.ts", fixture)).toEqual(
			[],
		);
	});

	it("catches direct, aliased and helper-returned raw messages in JSX", () => {
		const fixture = `
			const raw = (error) => error.message;
			const direct = () => <p>{mutation.error.message}</p>;
			const aliased = () => { const msg = mutation.error.message; return <p>{msg}</p>; };
			const helper = () => <p>{raw(mutation.error)}</p>;
			const sentinel = () => <p>{mutation.error.message === "known" ? t("known") : t("fallback")}</p>;
			const stored = row.error;
			const persisted = () => <p>{stored}</p>;
			const reason = row.unavailableReason;
			const attribute = () => <p title={reason}>status</p>;
			const predicateOnly = () => <p>{row.error ? t("known") : t("fallback")}</p>;
			const localized = () => <p>{localizedCustomerError(t, mutation.error, "common.requestFailed")}</p>;
		`;
		expect(scanRawJsxErrors("positive-control.tsx", fixture)).toHaveLength(5);
	});

	it("exempts only the ADMIN true arm, never the customer false arm", () => {
		const adminOnly = `
			const view = () => <p>{technicalDetailsAllowed ? row.error : t("fallback")}</p>;
		`;
		const customerLeak = `
			const view = () => <p>{technicalDetailsAllowed ? t("admin") : row.error}</p>;
		`;
		const invertedGuard = `
			const view = () => <p>{!technicalDetailsAllowed ? row.error : t("fallback")}</p>;
		`;
		const nameOnlyBoundary = `
			function DiagnosticsBody() { return <p>{row.error}</p>; }
		`;
		expect(scanRawJsxErrors("admin-true-control.tsx", adminOnly)).toEqual([]);
		expect(
			scanRawJsxErrors("admin-false-positive-control.tsx", customerLeak),
		).toHaveLength(1);
		expect(
			scanRawJsxErrors("admin-inverted-positive-control.tsx", invertedGuard),
		).toHaveLength(1);
		expect(
			scanRawJsxErrors(
				"admin-name-only-positive-control.tsx",
				nameOnlyBoundary,
			),
		).toHaveLength(1);
	});

	it("keeps developer copy out of public errors and raw errors out of customer DOM", () => {
		const apiHits = customerErrorProducers().flatMap((path) => [
			...scanOutboundCopy(
				relative(SOURCE_ROOT, path),
				readFileSync(path, "utf8"),
			),
			...scanRawResponseDetails(
				relative(SOURCE_ROOT, path),
				readFileSync(path, "utf8"),
			),
		]);
		const uiHits = [
			join(SOURCE_ROOT, "app", "live"),
			join(SOURCE_ROOT, "app", "settings", "credentials"),
		].flatMap((root) =>
			sourceFiles(root).flatMap((path) =>
				scanRawJsxErrors(
					relative(SOURCE_ROOT, path),
					readFileSync(path, "utf8"),
				),
			),
		);
		expect([...apiHits, ...uiHits]).toEqual([]);
	});
});
