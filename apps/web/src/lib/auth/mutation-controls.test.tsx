import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { UserRole } from "@bitovp/db";
import { screen } from "@testing-library/react";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { canAccess, pageAccess } from "./audience";
import type { SessionDto } from "./dto";
import {
	MUTATION_CONTROLS,
	MUTATION_SOURCE_CENSUS,
	MUTATION_WRITE_FAMILIES,
	type MutationControlContract,
	type MutationControlId,
	type MutationSourceContract,
	type MutationWriteFamily,
} from "./mutation-controls";
import { evaluateRole } from "./roles";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { RoleAccess } from "./use-role-access";

const SRC_DIR = join(__dirname, "../..");

type MutationSource = keyof typeof MUTATION_SOURCE_CENSUS;
const MUTATION_SOURCE_ENTRIES = Object.entries(MUTATION_SOURCE_CENSUS) as [
	MutationSource,
	MutationSourceContract,
][];
const MUTATION_WRITE_ENTRIES = Object.entries(MUTATION_WRITE_FAMILIES) as [
	MutationSource,
	readonly MutationWriteFamily[],
][];
const MUTATION_CONTROL_ENTRIES = Object.entries(MUTATION_CONTROLS) as [
	MutationControlId,
	MutationControlContract,
][];

const FULL_PAGE_WRITE_SOURCES = {
	"app/change-password/rotate-form.tsx": {
		writeCalls: 1,
		page: "/change-password",
	},
	"app/live/new/live-wizard.tsx": { writeCalls: 1, page: "/live/new" },
	"app/settings/reset/reset-client.tsx": {
		// Reconciliation runs internally; this page only posts the selected reset.
		writeCalls: 1,
		page: "/settings/reset",
	},
	"app/settings/tokens/tokens-client.tsx": {
		writeCalls: 2,
		page: "/settings/tokens",
	},
	"app/settings/users/users-client.tsx": {
		writeCalls: 3,
		page: "/settings/users",
	},
	"app/settings/organizations/organizations.tsx": {
		writeCalls: 3,
		page: "/settings/organizations",
	},
	"app/settings/organizations/view-as.tsx": {
		writeCalls: 1,
		page: "/settings/organizations",
	},
	"app/settings/organizations/ip-policy.tsx": {
		writeCalls: 2,
		page: "/settings/access-audit",
	},
	"app/settings/vmaf/profiles-client.tsx": {
		writeCalls: 2,
		page: "/settings/vmaf",
	},
	"app/settings/vmaf/credential-panel.tsx": {
		writeCalls: 2,
		page: "/settings/vmaf",
	},
	"app/storage/inspect-dialog.tsx": { writeCalls: 1, page: "/storage" },
	"app/storage/storage-client.tsx": { writeCalls: 2, page: "/storage" },
	"app/vod/new/plan-presets-panel.tsx": {
		writeCalls: 1,
		page: "/vod/new",
	},
	"app/vod/new/wizard.tsx": { writeCalls: 2, page: "/vod/new" },
} as const;

const PUBLIC_WRITE_SOURCES = {
	"app/login/login-form.tsx": 1,
	"app/setup/setup-form.tsx": 1,
} as const;

/** Authentication lifecycle writes live outside the users-mode role gate. */
const UNIVERSAL_AUTH_WRITE_SOURCES = {
	"components/session-menu.tsx": 1,
	"components/organization-menu.tsx": 2,
} as const;

function productionTsxFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			files.push(...productionTsxFiles(path));
		} else if (entry.endsWith(".tsx") && !entry.endsWith(".test.tsx")) {
			files.push(path);
		}
	}
	return files;
}

type ApiCall = {
	readonly endpoint: string;
	readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	readonly node: ts.CallExpression;
};

type ParsedSource = {
	readonly file: ts.SourceFile;
	readonly declarations: ReadonlyMap<string, readonly ts.VariableDeclaration[]>;
};

function parseSourceText(source: string, text: string): ParsedSource {
	const file = ts.createSourceFile(
		source,
		text,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	);
	const declarations = new Map<string, ts.VariableDeclaration[]>();
	const visit = (node: ts.Node) => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
			const rows = declarations.get(node.name.text) ?? [];
			rows.push(node);
			declarations.set(node.name.text, rows);
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return { file, declarations };
}

function parseSource(source: string): ParsedSource {
	return parseSourceText(source, readFileSync(join(SRC_DIR, source), "utf8"));
}

function lexicalScopes(node: ts.Node): ts.Node[] {
	const scopes: ts.Node[] = [];
	for (let cursor: ts.Node | undefined = node; cursor; cursor = cursor.parent) {
		if (
			ts.isSourceFile(cursor) ||
			ts.isBlock(cursor) ||
			ts.isFunctionLike(cursor)
		) {
			scopes.push(cursor);
		}
	}
	return scopes;
}

function declarationScope(node: ts.Node): ts.Node | undefined {
	for (let cursor = node.parent; cursor; cursor = cursor.parent) {
		if (
			ts.isSourceFile(cursor) ||
			ts.isBlock(cursor) ||
			ts.isFunctionLike(cursor)
		) {
			return cursor;
		}
	}
	return undefined;
}

function resolveIdentifier(
	identifier: ts.Identifier,
	parsed: ParsedSource,
	seen: ReadonlySet<ts.VariableDeclaration>,
): string | null {
	const scopes = lexicalScopes(identifier);
	const candidates = (parsed.declarations.get(identifier.text) ?? [])
		.filter(
			(declaration) =>
				declaration.initializer &&
				declaration.getStart(parsed.file) < identifier.getStart(parsed.file) &&
				scopes.includes(declarationScope(declaration) as ts.Node),
		)
		.sort((left, right) => {
			const leftScope = scopes.indexOf(declarationScope(left) as ts.Node);
			const rightScope = scopes.indexOf(declarationScope(right) as ts.Node);
			return (
				leftScope - rightScope ||
				right.getStart(parsed.file) - left.getStart(parsed.file)
			);
		});
	const declaration = candidates[0];
	if (!declaration?.initializer || seen.has(declaration)) {
		return null;
	}
	return resolveEndpointExpression(
		declaration.initializer,
		parsed,
		new Set([...seen, declaration]),
	);
}

function resolveEndpointExpression(
	expression: ts.Expression,
	parsed: ParsedSource,
	seen: ReadonlySet<ts.VariableDeclaration> = new Set(),
): string | null {
	if (
		ts.isStringLiteral(expression) ||
		ts.isNoSubstitutionTemplateLiteral(expression)
	) {
		return expression.text;
	}
	if (ts.isIdentifier(expression)) {
		return resolveIdentifier(expression, parsed, seen);
	}
	if (ts.isTemplateExpression(expression)) {
		let result = expression.head.text;
		for (const span of expression.templateSpans) {
			const resolved = resolveEndpointExpression(span.expression, parsed, seen);
			result += resolved?.startsWith("/api/") ? resolved : "x";
			result += span.literal.text;
		}
		return result;
	}
	return null;
}

function descendants(node: ts.Node): ts.Node[] {
	const rows: ts.Node[] = [];
	const visit = (child: ts.Node) => {
		rows.push(child);
		ts.forEachChild(child, visit);
	};
	visit(node);
	return rows;
}

/** Read the shared transport, rather than granting a hook-name exemption. */
function creationTransportEndpoints(
	client = parseSource("lib/creation-submission.ts"),
	hook = parseSource("lib/creation-submission-hook.ts"),
) {
	const nodes = descendants(client.file);
	const calls = nodes.filter(ts.isCallExpression);
	const sends = calls.filter(
		(call) =>
			ts.isIdentifier(call.expression) && call.expression.text === "send",
	);
	const endpoint = client.declarations.get("endpoint")?.[0];
	const conditional = endpoint?.initializer;
	const options = sends[0]?.arguments[1];
	const method =
		options && ts.isObjectLiteralExpression(options)
			? options.properties.find(
					(property) =>
						ts.isPropertyAssignment(property) &&
						property.name.getText(client.file) === "method",
				)
			: undefined;
	const defaultSend = nodes.find(
		(node) =>
			ts.isBindingElement(node) &&
			ts.isIdentifier(node.name) &&
			node.name.text === "send" &&
			node.initializer &&
			ts.isIdentifier(node.initializer) &&
			node.initializer.text === "apiFetch",
	);
	if (
		!defaultSend ||
		sends.length !== 1 ||
		!method ||
		!ts.isPropertyAssignment(method) ||
		!ts.isStringLiteral(method.initializer) ||
		method.initializer.text !== "POST" ||
		sends[0]?.arguments[0]?.getText(client.file) !== "endpoint" ||
		!conditional ||
		!ts.isConditionalExpression(conditional)
	) {
		throw new Error(
			"Creation transport must expose one classified POST through its apiFetch-backed send",
		);
	}
	if (
		[...calls, ...descendants(hook.file).filter(ts.isCallExpression)].some(
			(call) =>
				ts.isIdentifier(call.expression) &&
				["apiFetch", "fetch"].includes(call.expression.text),
		)
	) {
		throw new Error(
			"Creation transport contains an unclassified direct HTTP call",
		);
	}
	const condition = conditional.condition;
	if (
		!ts.isBinaryExpression(condition) ||
		condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
		!ts.isElementAccessExpression(condition.left) ||
		condition.left.expression.getText(client.file) !== "scope" ||
		condition.left.argumentExpression?.getText(client.file) !== "2" ||
		!ts.isStringLiteral(condition.right) ||
		condition.right.text !== "live" ||
		!ts.isStringLiteral(conditional.whenTrue) ||
		!ts.isStringLiteral(conditional.whenFalse)
	) {
		throw new Error(
			"Creation transport endpoint must resolve from its exact kind slot",
		);
	}
	const forwards = descendants(hook.file)
		.filter(ts.isCallExpression)
		.filter(
			(call) =>
				ts.isPropertyAccessExpression(call.expression) &&
				call.expression.name.text === "submit" &&
				ts.isCallExpression(call.expression.expression) &&
				call.expression.expression.expression.getText(hook.file) ===
					"createSubmissionClient",
		);
	const forward = forwards[0]?.expression;
	const scope =
		forward &&
		ts.isPropertyAccessExpression(forward) &&
		ts.isCallExpression(forward.expression)
			? forward.expression.arguments[0]
			: undefined;
	if (
		forwards.length !== 1 ||
		!scope ||
		!ts.isArrayLiteralExpression(scope) ||
		scope.elements.length !== 3 ||
		!ts.isSpreadElement(scope.elements[0] as ts.Node) ||
		scope.elements[1]?.getText(hook.file) !== "kind" ||
		scope.elements[2]?.getText(hook.file) !== "context"
	) {
		throw new Error(
			"Creation hook must forward its kind to the classified submit transport",
		);
	}
	return { live: conditional.whenTrue.text, vod: conditional.whenFalse.text };
}

let sharedCreationEndpoints:
	| ReturnType<typeof creationTransportEndpoints>
	| undefined;

function isCreationHook(
	initializer: ts.CallExpression,
	parsed: ParsedSource,
): boolean {
	if (!ts.isIdentifier(initializer.expression)) return false;
	const local = initializer.expression.text;
	return parsed.file.statements.some(
		(statement) =>
			ts.isImportDeclaration(statement) &&
			ts.isStringLiteral(statement.moduleSpecifier) &&
			statement.moduleSpecifier.text === "@/lib/creation-submission-hook" &&
			statement.importClause?.namedBindings &&
			ts.isNamedImports(statement.importClause.namedBindings) &&
			statement.importClause.namedBindings.elements.some(
				(entry) =>
					entry.name.text === local &&
					(entry.propertyName?.text ?? entry.name.text) ===
						"useCreationSubmission",
			),
	);
}

function creationEndpoint(
	receiver: ts.Identifier,
	parsed: ParsedSource,
	seen = new Set<ts.VariableDeclaration>(),
): string | null {
	const declaration = resolveLexicalDeclaration(receiver, parsed);
	if (!declaration?.initializer || seen.has(declaration)) return null;
	seen.add(declaration);
	const initializer = declaration.initializer;
	if (ts.isIdentifier(initializer))
		return creationEndpoint(initializer, parsed, seen);
	if (!ts.isCallExpression(initializer) || !isCreationHook(initializer, parsed))
		return null;
	const kind = initializer.arguments[0]
		? resolveEndpointExpression(initializer.arguments[0], parsed)
		: null;
	if (kind !== "vod" && kind !== "live")
		throw new Error("Unresolved creation kind in mutation census");
	sharedCreationEndpoints ??= creationTransportEndpoints();
	return sharedCreationEndpoints[kind];
}

function apiCallsFromParsed(parsed: ParsedSource): ApiCall[] {
	const calls: ApiCall[] = [];
	const visit = (node: ts.Node) => {
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === "submit" &&
			ts.isIdentifier(node.expression.expression)
		) {
			const endpoint = creationEndpoint(node.expression.expression, parsed);
			if (endpoint) calls.push({ endpoint, method: "POST", node });
		}
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			(node.expression.text === "apiFetch" || node.expression.text === "fetch")
		) {
			const endpoint = node.arguments[0]
				? resolveEndpointExpression(node.arguments[0], parsed)
				: null;
			const options = node.arguments[1];
			let method: ApiCall["method"] = "GET";
			if (options && ts.isObjectLiteralExpression(options)) {
				for (const property of options.properties) {
					if (
						ts.isPropertyAssignment(property) &&
						property.name.getText(parsed.file) === "method" &&
						ts.isStringLiteral(property.initializer) &&
						["POST", "PUT", "PATCH", "DELETE"].includes(
							property.initializer.text,
						)
					) {
						method = property.initializer.text as ApiCall["method"];
					}
				}
			}
			if (endpoint?.startsWith("/api/")) {
				calls.push({
					endpoint: endpoint.split("?")[0] as string,
					method,
					node,
				});
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(parsed.file);
	return calls;
}

function apiCalls(source: string): ApiCall[] {
	return apiCallsFromParsed(parseSource(source));
}

function writeCalls(source: string): ApiCall[] {
	return apiCalls(source).filter((call) => call.method !== "GET");
}

function allowedFor(role: UserRole, minRole: UserRole): boolean {
	return (
		minRole === "VIEWER" ||
		(minRole === "OPERATOR" && role !== "VIEWER") ||
		(minRole === "ADMIN" && role === "ADMIN")
	);
}

function roleAccessControl(node: ts.Node, file: ts.SourceFile): string | null {
	for (let cursor = node.parent; cursor; cursor = cursor.parent) {
		if (!ts.isJsxElement(cursor)) {
			continue;
		}
		const opening = cursor.openingElement;
		if (opening.tagName.getText(file) !== "RoleAccess") {
			continue;
		}
		const attribute = opening.attributes.properties.find(
			(property): property is ts.JsxAttribute =>
				ts.isJsxAttribute(property) &&
				property.name.getText(file) === "control",
		);
		if (attribute?.initializer && ts.isStringLiteral(attribute.initializer)) {
			return attribute.initializer.text;
		}
	}
	return null;
}

function permissionBindings(
	parsed: ParsedSource,
): ReadonlyMap<ts.VariableDeclaration, MutationControlId> {
	const bindings = new Map<ts.VariableDeclaration, MutationControlId>();
	for (const declarations of parsed.declarations.values()) {
		for (const declaration of declarations) {
			const initializer = declaration.initializer;
			if (
				initializer &&
				ts.isCallExpression(initializer) &&
				initializer.expression.getText(parsed.file) === "useMutationAccess" &&
				initializer.arguments[0] &&
				ts.isStringLiteral(initializer.arguments[0])
			) {
				bindings.set(
					declaration,
					initializer.arguments[0].text as MutationControlId,
				);
			}
		}
	}
	return bindings;
}

function resolveLexicalDeclaration(
	identifier: ts.Identifier,
	parsed: ParsedSource,
): ts.VariableDeclaration | null {
	const declarations = parsed.declarations.get(identifier.text) ?? [];
	for (const scope of lexicalScopes(identifier)) {
		const visible = declarations.filter(
			(declaration) =>
				declarationScope(declaration) === scope &&
				declaration.getStart(parsed.file) < identifier.getStart(parsed.file),
		);
		if (visible.length > 1) {
			return null;
		}
		if (visible.length === 1) {
			return visible[0] ?? null;
		}
	}
	return null;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (ts.isParenthesizedExpression(current)) {
		current = current.expression;
	}
	return current;
}

function booleanLiteral(expression: ts.Expression): boolean | null {
	const value = unwrapExpression(expression);
	if (value.kind === ts.SyntaxKind.TrueKeyword) {
		return true;
	}
	if (value.kind === ts.SyntaxKind.FalseKeyword) {
		return false;
	}
	return null;
}

function positivePermissionControl(
	expression: ts.Expression,
	branchWhenTrue: boolean,
	parsed: ParsedSource,
): MutationControlId | null {
	const value = unwrapExpression(expression);
	if (ts.isIdentifier(value)) {
		if (!branchWhenTrue) {
			return null;
		}
		const declaration = resolveLexicalDeclaration(value, parsed);
		return declaration === null
			? null
			: (permissionBindings(parsed).get(declaration) ?? null);
	}
	if (
		ts.isPrefixUnaryExpression(value) &&
		value.operator === ts.SyntaxKind.ExclamationToken
	) {
		return positivePermissionControl(value.operand, !branchWhenTrue, parsed);
	}
	if (ts.isBinaryExpression(value)) {
		const operator = value.operatorToken.kind;
		if (operator === ts.SyntaxKind.AmpersandAmpersandToken && branchWhenTrue) {
			const controls = [
				positivePermissionControl(value.left, true, parsed),
				positivePermissionControl(value.right, true, parsed),
			].filter((control): control is MutationControlId => control !== null);
			return controls.length === 1 ? (controls[0] ?? null) : null;
		}
		if (
			operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
			operator === ts.SyntaxKind.EqualsEqualsToken ||
			operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
			operator === ts.SyntaxKind.ExclamationEqualsToken
		) {
			const leftBoolean = booleanLiteral(value.left);
			const rightBoolean = booleanLiteral(value.right);
			if ((leftBoolean === null) === (rightBoolean === null)) {
				return null;
			}
			const compared = leftBoolean ?? rightBoolean;
			if (compared === null) {
				return null;
			}
			const operand = leftBoolean === null ? value.left : value.right;
			const equality =
				operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
				operator === ts.SyntaxKind.EqualsEqualsToken;
			const operandMustBeTrue =
				branchWhenTrue === equality ? compared : !compared;
			return positivePermissionControl(operand, operandMustBeTrue, parsed);
		}
	}
	return null;
}

function expressionMentions(
	node: ts.Node,
	names: ReadonlySet<string>,
): string | null {
	let found: string | null = null;
	const visit = (child: ts.Node) => {
		if (!found && ts.isIdentifier(child) && names.has(child.text)) {
			found = child.text;
			return;
		}
		ts.forEachChild(child, visit);
	};
	visit(node);
	return found;
}

function conditionalControl(
	node: ts.Node,
	parsed: ParsedSource,
): string | null {
	for (let cursor = node.parent; cursor; cursor = cursor.parent) {
		let condition: ts.Expression | null = null;
		let branchWhenTrue = true;
		if (ts.isConditionalExpression(cursor)) {
			if (
				node.getStart(parsed.file) >= cursor.whenTrue.getStart(parsed.file) &&
				node.getEnd() <= cursor.whenTrue.getEnd()
			) {
				condition = cursor.condition;
			} else if (
				node.getStart(parsed.file) >= cursor.whenFalse.getStart(parsed.file) &&
				node.getEnd() <= cursor.whenFalse.getEnd()
			) {
				condition = cursor.condition;
				branchWhenTrue = false;
			}
		} else if (
			ts.isBinaryExpression(cursor) &&
			cursor.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
			node.getStart(parsed.file) >= cursor.right.getStart(parsed.file) &&
			node.getEnd() <= cursor.right.getEnd()
		) {
			condition = cursor.left;
		} else if (ts.isIfStatement(cursor)) {
			if (
				node.getStart(parsed.file) >=
					cursor.thenStatement.getStart(parsed.file) &&
				node.getEnd() <= cursor.thenStatement.getEnd()
			) {
				condition = cursor.expression;
			} else if (
				cursor.elseStatement &&
				node.getStart(parsed.file) >=
					cursor.elseStatement.getStart(parsed.file) &&
				node.getEnd() <= cursor.elseStatement.getEnd()
			) {
				condition = cursor.expression;
				branchWhenTrue = false;
			}
		}
		if (condition) {
			const control = positivePermissionControl(
				condition,
				branchWhenTrue,
				parsed,
			);
			if (control) {
				return control;
			}
		}
	}
	return null;
}

function nearestJsxAttribute(node: ts.Node): ts.JsxAttribute | null {
	for (let cursor = node.parent; cursor; cursor = cursor.parent) {
		if (ts.isJsxAttribute(cursor)) {
			return cursor;
		}
	}
	return null;
}

function nearestNamedContainer(node: ts.Node): string | null {
	let crossedAnonymousFunction = false;
	for (let cursor = node.parent; cursor; cursor = cursor.parent) {
		if (ts.isFunctionDeclaration(cursor) && cursor.name) {
			return cursor.name.text;
		}
		if (ts.isArrowFunction(cursor) || ts.isFunctionExpression(cursor)) {
			crossedAnonymousFunction = true;
		}
		if (
			crossedAnonymousFunction &&
			ts.isVariableDeclaration(cursor) &&
			ts.isIdentifier(cursor.name) &&
			cursor.initializer
		) {
			return cursor.name.text;
		}
	}
	return null;
}

function containingComponent(node: ts.Node): string | null {
	for (let cursor = node.parent; cursor; cursor = cursor.parent) {
		if (ts.isFunctionDeclaration(cursor) && cursor.name) {
			return cursor.name.text;
		}
	}
	return null;
}

type TriggerProof = {
	readonly handler: string;
	readonly control: string | null;
	readonly component: string | null;
	readonly writes: readonly string[];
};

function mutationTriggerProofsFromParsed(parsed: ParsedSource): TriggerProof[] {
	const writes = apiCallsFromParsed(parsed).filter(
		(call) => call.method !== "GET",
	);
	const mutationWrites = new Map<string, ApiCall[]>();
	const directHandlerWrites = new Map<string, ApiCall[]>();
	const directTriggerNodes: {
		node: ts.Node;
		handler: string;
		writes: readonly ApiCall[];
	}[] = [];
	for (const write of writes) {
		const inlineAttribute = nearestJsxAttribute(write.node);
		let useMutationCall: ts.CallExpression | null = null;
		for (let cursor = write.node.parent; cursor; cursor = cursor.parent) {
			if (
				ts.isCallExpression(cursor) &&
				cursor.expression.getText(parsed.file) === "useMutation"
			) {
				useMutationCall = cursor;
				break;
			}
		}
		if (
			useMutationCall?.parent &&
			ts.isVariableDeclaration(useMutationCall.parent) &&
			ts.isIdentifier(useMutationCall.parent.name)
		) {
			const name = useMutationCall.parent.name.text;
			mutationWrites.set(name, [...(mutationWrites.get(name) ?? []), write]);
		} else if (inlineAttribute) {
			directTriggerNodes.push({
				node: inlineAttribute,
				handler: write.node.expression.getText(parsed.file),
				writes: [write],
			});
		} else {
			const handler = nearestNamedContainer(write.node);
			if (handler) {
				directHandlerWrites.set(handler, [
					...(directHandlerWrites.get(handler) ?? []),
					write,
				]);
			}
		}
	}

	const handlerWrites = new Map(directHandlerWrites);
	const visitMutations = (node: ts.Node) => {
		if (
			ts.isPropertyAccessExpression(node) &&
			ts.isIdentifier(node.expression) &&
			mutationWrites.has(node.expression.text) &&
			(node.name.text === "mutate" || node.name.text === "mutateAsync")
		) {
			const writesForMutation = mutationWrites.get(node.expression.text) ?? [];
			const attribute = nearestJsxAttribute(node);
			if (attribute) {
				directTriggerNodes.push({
					node: attribute,
					handler: node.getText(parsed.file),
					writes: writesForMutation,
				});
			} else {
				const handler = nearestNamedContainer(node);
				if (handler && !mutationWrites.has(handler)) {
					handlerWrites.set(handler, [
						...(handlerWrites.get(handler) ?? []),
						...writesForMutation,
					]);
				}
			}
		}
		ts.forEachChild(node, visitMutations);
	};
	visitMutations(parsed.file);

	const visitHandlers = (node: ts.Node) => {
		if (ts.isJsxAttribute(node) && node.initializer) {
			const handler = expressionMentions(
				node.initializer,
				new Set(handlerWrites.keys()),
			);
			if (handler) {
				directTriggerNodes.push({
					node,
					handler,
					writes: handlerWrites.get(handler) ?? [],
				});
			}
		}
		ts.forEachChild(node, visitHandlers);
	};
	visitHandlers(parsed.file);

	return directTriggerNodes.map(({ node, handler, writes: triggerWrites }) => ({
		handler,
		control:
			roleAccessControl(node, parsed.file) ?? conditionalControl(node, parsed),
		component: containingComponent(node),
		writes: triggerWrites.map((call) => `${call.method} ${call.endpoint}`),
	}));
}

function mutationTriggerProofs(source: string): TriggerProof[] {
	return mutationTriggerProofsFromParsed(parseSource(source));
}

function fixtureTriggerProofs(source: string): TriggerProof[] {
	return mutationTriggerProofsFromParsed(
		parseSourceText("adversarial-fixture.tsx", source),
	);
}

function writeOwnedByControls(
	source: keyof typeof MUTATION_WRITE_FAMILIES,
	write: string,
	controls: ReadonlySet<string>,
): boolean {
	return MUTATION_WRITE_FAMILIES[source].some(
		(family) =>
			family.write === write &&
			family.controls.some((control) => controls.has(control)),
	);
}

function jsxCallProtections(component: string): TriggerProof[] {
	const proofs: TriggerProof[] = [];
	for (const path of productionTsxFiles(SRC_DIR)) {
		const source = relative(SRC_DIR, path);
		const parsed = parseSource(source);
		const visit = (node: ts.Node) => {
			if (
				(ts.isJsxElement(node) &&
					node.openingElement.tagName.getText(parsed.file) === component) ||
				(ts.isJsxSelfClosingElement(node) &&
					node.tagName.getText(parsed.file) === component)
			) {
				proofs.push({
					handler: `${source}:${component}`,
					control:
						roleAccessControl(node, parsed.file) ??
						conditionalControl(node, parsed),
					component,
					writes: [],
				});
			}
			ts.forEachChild(node, visit);
		};
		visit(parsed.file);
	}
	return proofs;
}

function localJsxCallProtections(
	source: string,
	component: string,
): TriggerProof[] {
	const parsed = parseSource(source);
	const proofs: TriggerProof[] = [];
	const visit = (node: ts.Node) => {
		if (
			(ts.isJsxElement(node) &&
				node.openingElement.tagName.getText(parsed.file) === component) ||
			(ts.isJsxSelfClosingElement(node) &&
				node.tagName.getText(parsed.file) === component)
		) {
			proofs.push({
				handler: `${source}:${component}`,
				control:
					roleAccessControl(node, parsed.file) ??
					conditionalControl(node, parsed),
				component: containingComponent(node),
				writes: [],
			});
		}
		ts.forEachChild(node, visit);
	};
	visit(parsed.file);
	return proofs;
}

function users(role: UserRole): SessionDto {
	return {
		mode: "users",
		configured: true,
		authenticated: true,
		loginKind: "password-form",
		role,
	};
}

describe("mixed-page mutation control contract", () => {
	it("classifies the shared POST transport and rejects an added unowned send", () => {
		expect(creationTransportEndpoints()).toEqual({
			vod: "/api/encoding-jobs",
			live: "/api/live-channels",
		});
		const transport = readFileSync(
			join(SRC_DIR, "lib/creation-submission.ts"),
			"utf8",
		);
		expect(() =>
			creationTransportEndpoints(
				parseSourceText(
					"lib/creation-submission.ts",
					`${transport}\nsend("/api/settings/features", { method: "PATCH" });`,
				),
			),
		).toThrow(/classified POST/);
		expect(() =>
			creationTransportEndpoints(
				parseSourceText(
					"lib/creation-submission.ts",
					`${transport}\napiFetch("/api/settings/features", { method: "PATCH" });`,
				),
			),
		).toThrow(/unclassified direct HTTP/);
	});

	it.each([
		["vod", "/api/encoding-jobs"],
		["live", "/api/live-channels"],
	])("discovers delegated %s creates at the owning guarded JSX trigger", (kind, endpoint) => {
		const [proof] = fixtureTriggerProofs(`
   import { useCreationSubmission as useCreate } from "@/lib/creation-submission-hook";
   function Fixture() {
    const creation = useCreate("${kind}", "fixture");
    const alias = creation;
    const launch = useMutation({ mutationFn: () => alias.submit({ plan: {} }) });
    return <RoleAccess control="templates.manage"><button onClick={() => launch.mutate()} /></RoleAccess>;
   }
  `);
		expect(proof).toMatchObject({
			component: "Fixture",
			control: "templates.manage",
			writes: [`POST ${endpoint}`],
		});
	});

	it("discovers an unguarded delegated create and rejects its missing control", () => {
		const [proof] = fixtureTriggerProofs(`
   import { useCreationSubmission } from "@/lib/creation-submission-hook";
   function Fixture() {
    const creation = useCreationSubmission("vod", "fixture");
    const launch = useMutation({ mutationFn: () => creation.submit({ plan: {} }) });
    return <button onClick={() => launch.mutate()} />;
   }
  `);
		expect(proof).toMatchObject({
			component: "Fixture",
			control: null,
			writes: ["POST /api/encoding-jobs"],
		});
		expect(
			writeOwnedByControls(
				"app/templates/launch-dialog.tsx",
				proof?.writes[0] ?? "",
				new Set(proof?.control ? [proof.control] : []),
			),
		).toBe(false);
	});

	it("rejects a new unguarded inline creation trigger instead of losing it behind the helper", () => {
		const proofs = fixtureTriggerProofs(`
   import { useCreationSubmission } from "@/lib/creation-submission-hook";
   function Fixture() {
    const creation = useCreationSubmission("live", "fixture");
    return <button onClick={() => creation.submit({ plan: {} })} />;
   }
  `);
		expect(proofs).toHaveLength(1);
		expect(proofs[0]).toMatchObject({
			control: null,
			component: "Fixture",
			writes: ["POST /api/live-channels"],
		});
		expect(
			writeOwnedByControls(
				"app/templates/live-launch-dialog.tsx",
				proofs[0]?.writes[0] ?? "",
				new Set(),
			),
		).toBe(false);
	});

	it("resolves creation receivers lexically instead of attributing a shadowed unrelated submit", () => {
		expect(
			fixtureTriggerProofs(`
   import { useCreationSubmission } from "@/lib/creation-submission-hook";
   function Fixture() {
    const creation = useCreationSubmission("vod", "fixture");
    {
     const creation = { submit: () => Promise.resolve() };
     return <button onClick={() => creation.submit()} />;
    }
   }
  `),
		).toEqual([]);
	});

	it("fails closed when a delegated create's kind cannot be resolved", () => {
		expect(() =>
			fixtureTriggerProofs(`
   import { useCreationSubmission } from "@/lib/creation-submission-hook";
   function Fixture({ kind }) {
    const creation = useCreationSubmission(kind, "fixture");
    return <button onClick={() => creation.submit({ plan: {} })} />;
   }
  `),
		).toThrow(/creation kind/);
	});

	it("keeps the independent startup cancellation trigger inside the OPERATOR lifecycle gate", () => {
		const triggers = mutationTriggerProofs(
			"app/live/[id]/channel-actions.tsx",
		).filter((proof) => proof.handler === "cancel.mutate");
		expect(triggers).toHaveLength(1);
		expect(triggers[0]).toMatchObject({
			component: "ChannelLifecycleActions",
			writes: ["POST /api/live-channels/x/actions"],
		});
		expect(MUTATION_CONTROLS["live.channel.lifecycle"].minRole).toBe(
			"OPERATOR",
		);
		const callSites = jsxCallProtections("ChannelLifecycleActions");
		expect(callSites.length).toBeGreaterThan(0);
		expect(
			callSites.every((site) => site.control === "live.channel.lifecycle"),
		).toBe(true);
	});

	it("accepts only the positive permission branch that encloses a JSX trigger", () => {
		const proofFor = (condition: string) =>
			fixtureTriggerProofs(`
				function Fixture() {
					const canOperate = useMutationAccess("qc.jobs");
					const save = useMutation({
						mutationFn: () => apiFetch("/api/vmaf-jobs", { method: "POST" }),
					});
					return ${condition};
				}
			`)[0]?.control ?? null;

		expect(
			proofFor("canOperate && <button onClick={() => save.mutate()} />"),
		).toBe("qc.jobs");
		expect(
			proofFor("!canOperate && <button onClick={() => save.mutate()} />"),
		).toBeNull();
		expect(
			proofFor(
				"canOperate === false ? <button onClick={() => save.mutate()} /> : null",
			),
		).toBeNull();
		expect(
			proofFor("canOperate ? null : <button onClick={() => save.mutate()} />"),
		).toBeNull();
	});

	it("resolves permission bindings by lexical declaration identity and fails closed on ambiguity", () => {
		const [operatorProof, adminProof] = fixtureTriggerProofs(`
			function OperatorFixture() {
				const canWrite = useMutationAccess("qc.jobs");
				const save = useMutation({
					mutationFn: () => apiFetch("/api/vmaf-jobs", { method: "POST" }),
				});
				return canWrite && <button onClick={() => save.mutate()} />;
			}
			function AdminFixture() {
				const canWrite = useMutationAccess("settings.features");
				const save = useMutation({
					mutationFn: () => apiFetch("/api/settings/features", { method: "PATCH" }),
				});
				return canWrite && <button onClick={() => save.mutate()} />;
			}
		`);
		expect(operatorProof?.control).toBe("qc.jobs");
		expect(adminProof?.control).toBe("settings.features");

		const shadowed = fixtureTriggerProofs(`
			function Fixture() {
				const canWrite = useMutationAccess("qc.jobs");
				const save = useMutation({
					mutationFn: () => apiFetch("/api/vmaf-jobs", { method: "POST" }),
				});
				{
					const canWrite = false;
					return canWrite && <button onClick={() => save.mutate()} />;
				}
			}
		`);
		expect(shadowed[0]?.control ?? null).toBeNull();

		const ambiguous = fixtureTriggerProofs(`
			function Fixture() {
				const canWrite = useMutationAccess("qc.jobs");
				const canWrite = useMutationAccess("settings.features");
				const save = useMutation({
					mutationFn: () => apiFetch("/api/vmaf-jobs", { method: "POST" }),
				});
				return canWrite && <button onClick={() => save.mutate()} />;
			}
		`);
		expect(ambiguous[0]?.control ?? null).toBeNull();
	});

	it("rejects an OPERATOR control substituted for an ADMIN endpoint even when both are valid catalogue ids", () => {
		expect(
			writeOwnedByControls(
				"app/settings/features/features-client.tsx",
				"PATCH /api/settings/features",
				new Set(["settings.live.alerts"]),
			),
		).toBe(false);
		expect(
			writeOwnedByControls(
				"app/settings/features/features-client.tsx",
				"PATCH /api/settings/features",
				new Set(["settings.features"]),
			),
		).toBe(true);
	});

	it("binds every declared id to the exact number of production gates", () => {
		for (const [id, contract] of MUTATION_CONTROL_ENTRIES) {
			const source = readFileSync(join(SRC_DIR, contract.source), "utf8");
			const roleAccessBindings =
				source.match(new RegExp(`control=["']${id}["']`, "g"))?.length ?? 0;
			const hookBindings =
				source.match(new RegExp(`useMutationAccess\\(["']${id}["']\\)`, "g"))
					?.length ?? 0;
			expect(
				roleAccessBindings + hookBindings,
				`${id} production bindings in ${contract.source}`,
			).toBe(contract.bindings);
		}
	});

	it("censuses every production write call, including additions to existing files", () => {
		const actual = Object.fromEntries(
			productionTsxFiles(SRC_DIR)
				.map((path) => {
					return [
						relative(SRC_DIR, path),
						writeCalls(relative(SRC_DIR, path)).length,
					] as const;
				})
				.filter(([, count]) => count > 0),
		);
		const expected = Object.fromEntries([
			...MUTATION_SOURCE_ENTRIES.map(
				([source, contract]) => [source, contract.writeCalls] as const,
			),
			...Object.entries(FULL_PAGE_WRITE_SOURCES).map(
				([source, contract]) => [source, contract.writeCalls] as const,
			),
			...Object.entries(PUBLIC_WRITE_SOURCES),
			...Object.entries(UNIVERSAL_AUTH_WRITE_SOURCES),
		]);

		expect(actual).toEqual(expected);
		for (const [source, contract] of MUTATION_SOURCE_ENTRIES) {
			expect(writeCalls(source).length, source).toBe(contract.writeCalls);
		}
	});

	it("ties every mutation source to at least one declared production control", () => {
		for (const [source, contract] of MUTATION_SOURCE_ENTRIES) {
			expect(contract.controls.length, source).toBeGreaterThan(0);
			for (const control of contract.controls) {
				expect(
					MUTATION_CONTROLS[control],
					`${source} -> ${control}`,
				).toBeDefined();
			}
		}
	});

	it("pins every actual write family to its invoked endpoint and owning control", () => {
		expect(Object.keys(MUTATION_WRITE_FAMILIES)).toEqual(
			Object.keys(MUTATION_SOURCE_CENSUS),
		);
		for (const [source, families] of MUTATION_WRITE_ENTRIES) {
			const actual = writeCalls(source)
				.map((call) => `${call.method} ${call.endpoint}`)
				.sort();
			const declared = families.map((family) => family.write).sort();
			expect(actual, `${source} exact write families`).toEqual(declared);
			for (const family of families) {
				for (const control of family.controls) {
					expect(
						(
							MUTATION_SOURCE_CENSUS[source].controls as readonly string[]
						).includes(control),
						`${source} ${family.write} -> ${control}`,
					).toBe(true);
				}
			}
		}
	});

	it("mechanically encloses every actual JSX write trigger in its declared production gate", () => {
		for (const [source, contract] of MUTATION_SOURCE_ENTRIES) {
			const proofs = mutationTriggerProofs(source);
			expect(
				proofs.length,
				`${source} exposes a discoverable JSX write trigger`,
			).toBeGreaterThan(0);
			const delegated = new Map(
				(contract.delegatedExports ?? []).map((entry) => [
					entry.name,
					new Set<string>(entry.controls),
				]),
			);
			for (const proof of proofs) {
				const effectiveControls = new Set<string>();
				if (proof.control) {
					effectiveControls.add(proof.control);
				}
				if (proof.component) {
					for (const control of delegated.get(proof.component) ?? []) {
						effectiveControls.add(control);
					}
				}
				const locallyAllowed =
					proof.control !== null &&
					(contract.controls as readonly string[]).includes(proof.control);
				const delegatedAllowed =
					proof.component !== null && delegated.has(proof.component);
				const localCallSites = proof.component
					? localJsxCallProtections(source, proof.component)
					: [];
				const localComponentAllowed =
					localCallSites.length > 0 &&
					localCallSites.every(
						(callSite) =>
							callSite.control !== null &&
							(contract.controls as readonly string[]).includes(
								callSite.control,
							),
					);
				for (const callSite of localCallSites) {
					if (callSite.control) {
						effectiveControls.add(callSite.control);
					}
				}
				expect(
					locallyAllowed || delegatedAllowed || localComponentAllowed,
					`${source} ${proof.handler} is gated (got ${proof.control ?? "none"})`,
				).toBe(true);
				expect(
					proof.writes.length,
					`${source} ${proof.handler} traces to an actual write`,
				).toBeGreaterThan(0);
				for (const write of proof.writes) {
					const endpointOwnedByGate = writeOwnedByControls(
						source,
						write,
						effectiveControls,
					);
					expect(
						endpointOwnedByGate,
						`${source} ${proof.handler}: ${write} belongs to ${[
							...effectiveControls,
						].join(", ")}`,
					).toBe(true);
				}
			}
			for (const [component, controls] of delegated) {
				const callSites = jsxCallProtections(component);
				expect(
					callSites.length,
					`${component} has a production call site`,
				).toBeGreaterThan(0);
				for (const callSite of callSites) {
					expect(
						callSite.control !== null && controls.has(callSite.control),
						`${callSite.handler} is enclosed by one of ${[...controls].join(", ")}`,
					).toBe(true);
				}
			}
		}
	});

	it("matches every actual write endpoint to its production control floor", () => {
		for (const [source, sourceContract] of MUTATION_SOURCE_ENTRIES) {
			const floors = new Set(
				sourceContract.controls.map(
					(control) => MUTATION_CONTROLS[control].minRole,
				),
			);
			expect(floors.size, `${source} has one effective write floor`).toBe(1);
			const minRole = [...floors][0] as UserRole;
			for (const call of writeCalls(source)) {
				for (const role of ["VIEWER", "OPERATOR", "ADMIN"] as const) {
					expect(
						evaluateRole(role, call.endpoint, call.method).allowed,
						`${source}: ${role} ${call.method} ${call.endpoint}`,
					).toBe(allowedFor(role, minRole));
				}
			}
		}
	});

	it("proves every full-page exclusion has a sufficient page floor", () => {
		for (const [source, contract] of Object.entries(FULL_PAGE_WRITE_SOURCES)) {
			const access = pageAccess(contract.page);
			for (const call of writeCalls(source)) {
				for (const role of ["VIEWER", "OPERATOR", "ADMIN"] as const) {
					const pageAllowed = canAccess(access, { kind: "role", role });
					if (pageAllowed) {
						expect(
							evaluateRole(role, call.endpoint, call.method).allowed,
							`${source}: ${role} reaches ${contract.page} then ${call.method} ${call.endpoint}`,
						).toBe(true);
					}
				}
			}
		}
	});

	it("matches navigation controls and higher-floor reads to their real floors", () => {
		for (const [id, contract] of MUTATION_CONTROL_ENTRIES) {
			for (const destination of contract.destinations ?? []) {
				for (const role of ["VIEWER", "OPERATOR", "ADMIN"] as const) {
					expect(
						canAccess(pageAccess(destination), { kind: "role", role }),
						`${id}: ${role} -> ${destination}`,
					).toBe(allowedFor(role, contract.minRole));
				}
			}
			for (const read of contract.reads ?? []) {
				expect(readFileSync(join(SRC_DIR, read.source), "utf8")).toContain(
					read.api === "/api/live/stream-keys/key-1"
						? "/api/live/stream-keys"
						: read.api,
				);
				for (const role of ["VIEWER", "OPERATOR", "ADMIN"] as const) {
					expect(
						evaluateRole(role, read.api, "GET").allowed,
						`${id}: ${role} GET ${read.api}`,
					).toBe(allowedFor(role, contract.minRole));
				}
			}
		}
	});

	it("renders every catalog gate for ADMIN/OPERATOR/VIEWER and hides all from VIEWER", async () => {
		for (const id of Object.keys(MUTATION_CONTROLS) as MutationControlId[]) {
			const contract = MUTATION_CONTROLS[id];
			for (const role of ["VIEWER", "OPERATOR", "ADMIN"] as const) {
				apiFetch.mockResolvedValueOnce(users(role));
				const rendered = renderWithQuery(
					<RoleAccess control={id}>
						<button type="button">{`${id}:${role}`}</button>
					</RoleAccess>,
				);
				const name = `${id}:${role}`;
				const shouldRender =
					(contract.minRole === "OPERATOR" && role !== "VIEWER") ||
					(contract.minRole === "ADMIN" && role === "ADMIN");
				if (shouldRender) {
					expect(await screen.findByRole("button", { name })).toBeVisible();
				} else {
					await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());
					expect(screen.queryByRole("button", { name })).toBeNull();
				}
				rendered.unmount();
			}
		}
	});

	it("keeps every control available in single-owner mode", async () => {
		for (const id of Object.keys(MUTATION_CONTROLS) as MutationControlId[]) {
			apiFetch.mockResolvedValueOnce({
				mode: "password",
				configured: true,
				authenticated: true,
				loginKind: "password-form",
			} satisfies SessionDto);
			const rendered = renderWithQuery(
				<RoleAccess control={id}>
					<button type="button">{id}</button>
				</RoleAccess>,
			);
			expect(await screen.findByRole("button", { name: id })).toBeVisible();
			rendered.unmount();
		}
	});
});
