/** Bounded grammar for the official SDK generator. Unknown statements fail closed. */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(
	join(dirname(fileURLToPath(import.meta.url)), "../apps/web/package.json"),
);
const ts = require("typescript");
const verbs = new Set(["get", "post", "put", "patch", "delete"]);
const id = (node, name) =>
	node && ts.isIdentifier(node) && (name === undefined || node.text === name);
const property = (node, name) =>
	node &&
	ts.isPropertyAccessExpression(node) &&
	!node.questionDotToken &&
	node.name.text === name;
const empty = (node) =>
	node && ts.isObjectLiteralExpression(node) && node.properties.length === 0;
const args = (node) => node.arguments ?? [];
const leaf = (node) =>
	id(node) ||
	(node &&
		ts.isPropertyAccessExpression(node) &&
		!node.questionDotToken &&
		id(node.expression));

export function canonicalSdkMethods(file, source) {
	const ast = ts.createSourceFile(
		file,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.JS,
	);
	const fail = () => {
		throw new Error(`Unresolved SDK transport or parameter grammar: ${file}`);
	};
	if (ast.parseDiagnostics.length)
		throw new Error(`Cannot parse SDK source: ${file}`);
	const methods = [];
	const namespaces = [];
	const classes = ast.statements.filter(ts.isClassDeclaration);
	const classNames = new Set(classes.map((c) => c.name?.text));
	const aliases = new Set([
		...classNames,
		...ast.statements
			.filter(ts.isVariableStatement)
			.flatMap((statement) =>
				statement.declarationList.declarations
					.filter((d) => id(d.name))
					.map((d) => d.name.text),
			),
	]);
	const importPaths = new Map(
		ast.statements
			.filter(ts.isVariableStatement)
			.flatMap((statement) =>
				statement.declarationList.declarations
					.filter(
						(d) =>
							id(d.name) &&
							d.initializer &&
							ts.isCallExpression(d.initializer) &&
							id(d.initializer.expression, "require") &&
							args(d.initializer).length === 1 &&
							ts.isStringLiteral(args(d.initializer)[0]),
					)
					.map((d) => [d.name.text, args(d.initializer)[0].text]),
			),
	);
	function bindingNames(parameters) {
		const names = parameters.map((p) =>
			id(p.name) &&
			!p.initializer &&
			!p.dotDotDotToken &&
			!p.type &&
			!p.questionToken &&
			!p.modifiers?.length
				? p.name.text
				: fail(),
		);
		if (
			new Set(names).size !== names.length ||
			names.some((name) => aliases.has(name))
		)
			fail();
		return names;
	}
	const declaration = (statement, flags, name) => {
		if (
			!statement ||
			!ts.isVariableStatement(statement) ||
			(statement.declarationList.flags &
				(ts.NodeFlags.Const | ts.NodeFlags.Let)) !==
				flags ||
			statement.declarationList.declarations.length !== 1
		)
			return undefined;
		const d = statement.declarationList.declarations[0];
		return id(d.name, name) && !d.exclamationToken ? d : undefined;
	};
	const oneReturn = (block) =>
		block &&
		ts.isBlock(block) &&
		block.statements.length === 1 &&
		ts.isReturnStatement(block.statements[0])
			? block.statements[0].expression
			: undefined;
	const assignment = (block, left) => {
		if (
			!block ||
			!ts.isBlock(block) ||
			block.statements.length !== 1 ||
			!ts.isExpressionStatement(block.statements[0])
		)
			return undefined;
		const expression = block.statements[0].expression;
		return ts.isBinaryExpression(expression) &&
			expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			id(expression.left, left)
			? expression.right
			: undefined;
	};
	function constructor(member, owner, methodNames) {
		const names = bindingNames(member.parameters);
		const [first, ...statements] = member.body.statements;
		if (
			names.length !== 1 ||
			!first ||
			!ts.isExpressionStatement(first) ||
			!ts.isCallExpression(first.expression) ||
			first.expression.expression.kind !== ts.SyntaxKind.SuperKeyword ||
			args(first.expression).length !== 1 ||
			!id(args(first.expression)[0], names[0])
		)
			fail();
		const slots = new Set([
			"restClient",
			"prototype",
			"__proto__",
			"constructor",
			...methodNames,
		]);
		for (const statement of statements) {
			if (!ts.isExpressionStatement(statement)) fail();
			const e = statement.expression;
			if (
				!ts.isBinaryExpression(e) ||
				e.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
				!ts.isPropertyAccessExpression(e.left) ||
				e.left.expression.kind !== ts.SyntaxKind.ThisKeyword ||
				e.left.questionDotToken ||
				!id(e.left.name) ||
				slots.has(e.left.name.text)
			)
				fail();
			if (
				!ts.isNewExpression(e.right) ||
				!property(e.right.expression, "default") ||
				!id(e.right.expression.expression) ||
				!importPaths.has(e.right.expression.expression.text) ||
				names.includes(e.right.expression.expression.text) ||
				args(e.right).length !== 1 ||
				!id(args(e.right)[0], names[0])
			)
				fail();
			slots.add(e.left.name.text);
			namespaces.push({
				owner,
				slot: e.left.name.text,
				importPath: importPaths.get(e.right.expression.expression.text),
			});
		}
	}

	function responseMapping(callback, names) {
		if (
			!callback ||
			!ts.isArrowFunction(callback) ||
			callback.parameters.length !== 1 ||
			!id(callback.parameters[0].name) ||
			callback.parameters[0].initializer ||
			callback.parameters[0].dotDotDotToken
		)
			fail();
		const response = bindingNames(callback.parameters)[0];
		if (names.includes(response)) fail();
		if (
			["Mapper_1", "PaginationResponse_1"].includes(response) ||
			callback.modifiers?.length
		)
			fail();
		const mapped = oneReturn(callback.body);
		if (
			!mapped ||
			!(ts.isCallExpression(mapped) || ts.isNewExpression(mapped)) ||
			mapped.questionDotToken ||
			!id(args(mapped)[0], response)
		)
			fail();
		let callee = mapped.expression;
		if (ts.isParenthesizedExpression(callee)) {
			const comma = callee.expression;
			if (
				!ts.isBinaryExpression(comma) ||
				comma.operatorToken.kind !== ts.SyntaxKind.CommaToken ||
				!ts.isNumericLiteral(comma.left) ||
				comma.left.text !== "0"
			)
				fail();
			callee = comma.right;
		}
		if (ts.isCallExpression(mapped)) {
			if (
				!(property(callee, "map") || property(callee, "mapArray")) ||
				!id(callee.expression, "Mapper_1") ||
				names.includes("Mapper_1")
			)
				fail();
			if (args(mapped).length !== 1 && args(mapped).length !== 2) fail();
		} else if (
			!property(callee, "default") ||
			!id(callee.expression, "PaginationResponse_1") ||
			names.includes("PaginationResponse_1") ||
			args(mapped).length !== 2
		)
			fail();
		if (
			args(mapped).length === 2 &&
			(!property(args(mapped)[1], "default") ||
				!id(args(mapped)[1].expression) ||
				names.includes(args(mapped)[1].expression.text))
		)
			fail();
	}
	function operation(member) {
		if (
			!ts.isMethodDeclaration(member) ||
			!id(member.name) ||
			!member.body ||
			member.asteriskToken ||
			member.modifiers?.length
		)
			fail();
		const names = bindingNames(member.parameters);
		const locals = member.body.statements
			.filter(ts.isVariableStatement)
			.flatMap((statement) =>
				statement.declarationList.declarations
					.filter((d) => id(d.name))
					.map((d) => d.name.text),
			);
		if (
			new Set([...names, ...locals]).size !== names.length + locals.length ||
			locals.some((name) => aliases.has(name))
		)
			fail();
		const statements = [...member.body.statements];
		const returned = statements.pop();
		if (!returned || !ts.isReturnStatement(returned) || !returned.expression)
			fail();
		let call = returned.expression;
		if (ts.isCallExpression(call) && property(call.expression, "then")) {
			if (
				args(call).length !== 1 ||
				!ts.isCallExpression(call.expression.expression)
			)
				fail();
			responseMapping(args(call)[0], [...names, ...locals]);
			call = call.expression.expression;
		}
		if (
			!ts.isCallExpression(call) ||
			call.questionDotToken ||
			!ts.isPropertyAccessExpression(call.expression) ||
			call.expression.questionDotToken ||
			!verbs.has(call.expression.name.text) ||
			!property(call.expression.expression, "restClient") ||
			call.expression.expression.expression.kind !== ts.SyntaxKind.ThisKeyword
		)
			fail();
		const verb = call.expression.name.text;
		const path = args(call)[0];
		if (
			!path ||
			!ts.isStringLiteralLike(path) ||
			!path.text.startsWith("/encoding/")
		)
			throw new Error(`Non-literal or unexpected SDK transport path: ${file}`);
		if (args(call).length > 3) fail();
		let pathMap = args(call)[1];
		if (id(pathMap)) {
			const d = declaration(
				statements.shift(),
				ts.NodeFlags.Const,
				pathMap.text,
			);
			if (!d || !d.initializer || !ts.isObjectLiteralExpression(d.initializer))
				fail();
			pathMap = d.initializer;
		}
		if (
			pathMap &&
			(!ts.isObjectLiteralExpression(pathMap) ||
				pathMap.properties.some(
					(p) =>
						!(
							(ts.isPropertyAssignment(p) &&
								id(p.name) &&
								id(p.initializer) &&
								names.includes(p.initializer.text)) ||
							(ts.isShorthandPropertyAssignment(p) &&
								names.includes(p.name.text))
						),
				))
		)
			fail();
		let queryParameter;
		const input = args(call)[2];
		if (input) {
			if (!id(input)) fail();
			if (!names.includes(input.text)) {
				if (verb !== "get") fail();
				const d = declaration(statements.shift(), ts.NodeFlags.Let, input.text);
				const branch = statements.shift();
				if (!d || !empty(d.initializer) || !branch || !ts.isIfStatement(branch))
					fail();
				const condition = branch.expression;
				if (
					!ts.isBinaryExpression(condition) ||
					condition.operatorToken.kind !==
						ts.SyntaxKind.EqualsEqualsEqualsToken ||
					!ts.isTypeOfExpression(condition.left) ||
					!id(condition.left.expression) ||
					!names.includes(condition.left.expression.text) ||
					!ts.isStringLiteral(condition.right) ||
					condition.right.text !== "function"
				)
					fail();
				queryParameter = condition.left.expression.text;
				const built = assignment(branch.thenStatement, input.text);
				const otherwise = branch.elseStatement;
				if (
					!built ||
					!ts.isCallExpression(built) ||
					!property(built.expression, "buildQueryParams") ||
					args(built).length !== 0 ||
					!ts.isCallExpression(built.expression.expression)
				)
					fail();
				const builder = built.expression.expression;
				if (
					!id(builder.expression, queryParameter) ||
					args(builder).length !== 1 ||
					!ts.isNewExpression(args(builder)[0]) ||
					!leaf(args(builder)[0].expression) ||
					args(args(builder)[0]).length !== 0 ||
					[...names, ...locals].includes(
						id(args(builder)[0].expression)
							? args(builder)[0].expression.text
							: args(builder)[0].expression.expression.text,
					)
				)
					fail();
				if (
					!otherwise ||
					!ts.isIfStatement(otherwise) ||
					!id(otherwise.expression, queryParameter) ||
					otherwise.elseStatement ||
					!id(assignment(otherwise.thenStatement, input.text), queryParameter)
				)
					fail();
			}
		}
		if (statements.length) fail();
		return { method: member, call, verb, pathMap, queryParameter };
	}
	for (const statement of ast.statements) {
		if (ts.isClassDeclaration(statement)) {
			if (!id(statement.name) || statement.modifiers?.length) fail();
			const heritage = statement.heritageClauses;
			if (
				heritage?.length &&
				(heritage.length !== 1 ||
					heritage[0].token !== ts.SyntaxKind.ExtendsKeyword ||
					heritage[0].types.length !== 1 ||
					!property(heritage[0].types[0].expression, "BaseAPI") ||
					!id(heritage[0].types[0].expression.expression, "BaseAPI_1"))
			)
				fail();
			if (statement.members.filter(ts.isConstructorDeclaration).length > 1)
				fail();
			const methodNames = statement.members
				.filter(ts.isMethodDeclaration)
				.filter((member) => id(member.name))
				.map((member) => member.name.text);
			for (const member of statement.members) {
				if (ts.isConstructorDeclaration(member)) {
					constructor(member, statement.name.text, methodNames);
					continue;
				}
				methods.push(operation(member));
			}
			continue;
		}
		const imported = declaration(statement, ts.NodeFlags.Const);
		if (
			imported &&
			imported.initializer &&
			ts.isCallExpression(imported.initializer) &&
			id(imported.initializer.expression, "require") &&
			args(imported.initializer).length === 1 &&
			ts.isStringLiteral(args(imported.initializer)[0])
		)
			continue;
		if (ts.isExpressionStatement(statement)) {
			const e = statement.expression;
			if (ts.isStringLiteral(e) && e.text === "use strict") continue;
			if (
				ts.isCallExpression(e) &&
				property(e.expression, "defineProperty") &&
				id(e.expression.expression, "Object") &&
				args(e).length === 3 &&
				id(args(e)[0], "exports") &&
				ts.isStringLiteral(args(e)[1]) &&
				args(e)[1].text === "__esModule" &&
				ts.isObjectLiteralExpression(args(e)[2]) &&
				args(e)[2].properties.length === 1 &&
				ts.isPropertyAssignment(args(e)[2].properties[0]) &&
				id(args(e)[2].properties[0].name, "value") &&
				args(e)[2].properties[0].initializer.kind === ts.SyntaxKind.TrueKeyword
			)
				continue;
			if (
				ts.isBinaryExpression(e) &&
				e.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
				property(e.left, "default") &&
				id(e.left.expression, "exports") &&
				id(e.right) &&
				classNames.has(e.right.text)
			)
				continue;
		}
		fail();
	}
	return { ast, methods, namespaces };
}
