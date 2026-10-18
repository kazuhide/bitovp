import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/messages/en";

/**
 * Every `t()` call site must supply the placeholders its key declares.
 *
 * `i18n.test.ts` pins placeholder parity BETWEEN locales. Nothing pinned the call
 * sites, and `translate()` throws on an unfilled `{placeholder}` — deliberately, so
 * a half-filled string cannot render as copy. The consequence is that a key
 * carrying `{count}` invoked as `t("k")` is a runtime crash on whatever screen
 * renders it, and only on the code path that renders it: the suite stays green
 * because no test walks that path, and the throw escapes to `global-error` as a
 * blank "Application error" page rather than a degraded control.
 *
 * That is not hypothetical. `ui.theChannelNameIsAppendedAutomaticallyOutputs`
 * shipped invoked bare while its text names two Bitmovin output-path tokens,
 * `{height}` and `{bitrate}`. `translate()` cannot tell a path token from a
 * placeholder, so the live wizard's Output step threw — 3,203 tests, a clean
 * typecheck and a clean build all passed over it. This test is the check that would
 * have caught it.
 */

const SRC = join(import.meta.dirname, "..");
const PLACEHOLDER = /\{(\w+)\}/g;
/**
 * `t(` as a whole identifier — `expect(`, `getByText(` and `split(` all end in `t`,
 * and matching those made the first draft of this check report 390 false problems.
 */
const CALL = /(?<![\w$.])t\(\s*"([\w.]+)"\s*(,\s*\{)?/g;
/** Property names in an object literal, lookaround so adjacent keys both match. */
const GIVEN = /(?<=[{,])\s*(\w+)\s*(?=[:,}])/g;

function sources(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry.startsWith(".") || entry === "node_modules") {
			continue;
		}
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			out.push(...sources(path));
		} else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
			out.push(path);
		}
	}
	return out;
}

/** `dotted.key -> the placeholder names its English text declares`. */
function declared(): Map<string, Set<string>> {
	const out = new Map<string, Set<string>>();
	// RECURSIVE: the catalogue was two levels deep until `presetGallery`
	// introduced a third (presetGallery.<name>.title) — the flat walk called
	// .match on a nested object and crashed the whole suite file.
	const walk = (node: Record<string, unknown>, prefix: string) => {
		for (const [key, value] of Object.entries(node)) {
			const path = prefix === "" ? key : `${prefix}.${key}`;
			if (typeof value === "string") {
				out.set(path, new Set(value.match(PLACEHOLDER)?.map(strip) ?? []));
			} else if (typeof value === "object" && value !== null) {
				walk(value as Record<string, unknown>, path);
			}
		}
	};
	walk(en as unknown as Record<string, unknown>, "");
	return out;
}

const strip = (token: string) => token.slice(1, -1);

/** The object literal that follows `t("k",` — brace-matched, not regex-matched. */
function valuesLiteral(src: string, from: number): string {
	const start = src.indexOf("{", from);
	let depth = 0;
	for (let i = start; i < src.length; i += 1) {
		if (src[i] === "{") {
			depth += 1;
		} else if (src[i] === "}") {
			depth -= 1;
			if (depth === 0) {
				return src.slice(start, i + 1);
			}
		}
	}
	return src.slice(start);
}

type TranslationKeyLiteral = {
	readonly key: string;
	readonly line: number;
};

/**
 * Literal alternatives in the first argument of a real `t(...)` call.
 *
 * The earlier repository-wide string regex happened to work until mutation
 * controls introduced ids such as `qc.jobs` and `settings.credentials`.
 * Those are deliberately shaped like namespaced identifiers but are not
 * translation calls. Walking only the first argument preserves coverage of
 * conditional keys (`t(condition ? "a" : "b")`) without treating unrelated
 * component props or catalogue entries as translations.
 */
function translationKeyLiterals(
	file: string,
	source: string,
): TranslationKeyLiteral[] {
	const sourceFile = ts.createSourceFile(
		file,
		source,
		ts.ScriptTarget.Latest,
		true,
		file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const literals: TranslationKeyLiteral[] = [];

	const collectArgumentLiterals = (node: ts.Node) => {
		if (ts.isStringLiteralLike(node)) {
			literals.push({
				key: node.text,
				line:
					sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
						.line + 1,
			});
			return;
		}
		if (ts.isParenthesizedExpression(node)) {
			collectArgumentLiterals(node.expression);
			return;
		}
		if (ts.isConditionalExpression(node)) {
			collectArgumentLiterals(node.whenTrue);
			collectArgumentLiterals(node.whenFalse);
			return;
		}
		if (
			ts.isBinaryExpression(node) &&
			(node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
				node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
		) {
			collectArgumentLiterals(node.left);
			collectArgumentLiterals(node.right);
			return;
		}
		if (
			ts.isAsExpression(node) ||
			ts.isTypeAssertionExpression(node) ||
			ts.isNonNullExpression(node) ||
			ts.isSatisfiesExpression(node)
		) {
			collectArgumentLiterals(node.expression);
		}
	};

	const visit = (node: ts.Node) => {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "t" &&
			node.arguments[0] !== undefined
		) {
			collectArgumentLiterals(node.arguments[0]);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return literals;
}

describe("t() call sites", () => {
	const keys = declared();

	it("fills every placeholder the key declares", () => {
		const unfilled: string[] = [];
		for (const file of sources(SRC)) {
			const src = readFileSync(file, "utf8");
			for (const match of src.matchAll(CALL)) {
				const key = match[1] as string;
				const wanted = keys.get(key);
				if (wanted === undefined || wanted.size === 0) {
					continue;
				}
				const rel = file.slice(SRC.length + 1);
				if (!match[2]) {
					unfilled.push(`${rel}: t("${key}") passes no values`);
					continue;
				}
				const literal = valuesLiteral(src, match.index + match[0].length - 1);
				const given = new Set(
					[...literal.matchAll(GIVEN)].map((m) => m[1] as string),
				);
				const missing = [...wanted].filter((name) => !given.has(name));
				if (missing.length > 0) {
					unfilled.push(`${rel}: t("${key}") omits ${missing.join(", ")}`);
				}
			}
		}
		expect(unfilled).toEqual([]);
	});

	it("names a key that exists", () => {
		// A typo'd key is a typecheck error, so this only guards the dynamic form
		// (`t(cond ? "a" : "b")`), where the literals still have to resolve.
		const unknown: string[] = [];
		for (const file of sources(SRC)) {
			const src = readFileSync(file, "utf8");
			for (const { key, line } of translationKeyLiterals(file, src)) {
				if (!keys.has(key)) {
					unknown.push(`${file.slice(SRC.length + 1)}:${line}: ${key}`);
				}
			}
		}
		expect(unknown).toEqual([]);
	});

	it("inspects conditional t() branches but ignores unrelated dotted ids", () => {
		expect(
			translationKeyLiterals(
				"probe.tsx",
				'const control = "qc.jobs"; t(ok ? "common.cancel" : "common.save");',
			),
		).toEqual([
			{ key: "common.cancel", line: 1 },
			{ key: "common.save", line: 1 },
		]);
	});

	it("finds enough call sites to be measuring anything", () => {
		// Otherwise a broken matcher reports a clean run over nothing — the failure
		// mode that made an earlier counter report finished screens as finished.
		let sites = 0;
		for (const file of sources(SRC)) {
			sites += [...readFileSync(file, "utf8").matchAll(CALL)].length;
		}
		expect(sites).toBeGreaterThan(1500);
	});
});
