import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * A form row must not move its boxes around when one field grows.
 *
 * `Field` is a label/control/hint stack whose height depends on STATE. Put two
 * of them in a flex row and bottom-align it, and the taller one pins the bottom
 * edge — so the shorter one's label AND control slide down. Measured in Chrome
 * against the built app the day the owner reported it (2026-08-20): choosing
 * Per-Title on VOD step 3 put a hint under Bitrate and dropped Codec and Height
 * by 38px; adding a delivery mirror on step 4 misaligned Provider and Bucket
 * by 30px.
 *
 * WHY THIS IS A SOURCE-READING TEST AND NOT A RENDER TEST. jsdom computes no
 * layout, so no amount of `render` can measure this — the misalignment is
 * pure geometry. What a test CAN do is hold the structural rule that produces
 * correct geometry, over every row in the tree rather than the handful someone
 * remembers.  met this exact defect, fixed the one row it was
 * reported on, and the pattern survived at fifteen others; a rule that has to
 * be remembered is the thing that failed.
 *
 * WHAT IT CANNOT SEE, stated so the green is not read as more than it is:
 * a row whose className is computed at runtime (all of today's are literals),
 * a row built by a component this file does not know is a row, and the actual
 * rendered pixels — those come from `align-probe`, run by hand against a real
 * browser. Two instruments, different blind spots.
 */

const REPO = path.resolve(__dirname, "../../../../..");

/** Every non-test component in the app. Derived, so new files are covered. */
function componentFiles(): string[] {
	return execSync(
		"git ls-files 'apps/web/src/**/*.tsx' | grep -v '\\.test\\.tsx$'",
		{ encoding: "utf8", cwd: REPO },
	)
		.trim()
		.split("\n")
		.filter(Boolean);
}

function tagOf(node: ts.Node): string | null {
	if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
	if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
	return null;
}

function classNameOf(node: ts.Node): string | null {
	const attrs = ts.isJsxElement(node)
		? node.openingElement.attributes
		: ts.isJsxSelfClosingElement(node)
			? node.attributes
			: null;
	if (!attrs) return null;
	for (const attr of attrs.properties) {
		if (!ts.isJsxAttribute(attr) || attr.name.getText() !== "className") {
			continue;
		}
		const init = attr.initializer;
		if (init && ts.isStringLiteral(init)) return init.text;
	}
	return null;
}

function containsField(node: ts.Node): boolean {
	let found = false;
	const walk = (n: ts.Node) => {
		if (tagOf(n) === "Field") found = true;
		ts.forEachChild(n, walk);
	};
	ts.forEachChild(node, walk);
	return found;
}

/** Controls that act on the ROW, not on one field. */
const ROW_ACTIONS = new Set(["Button", "RowRemoveButton", "button"]);

type Row = { file: string; line: number; align: string; actions: string[] };

function fieldRows(): Row[] {
	const rows: Row[] = [];
	for (const file of componentFiles()) {
		const full = path.join(REPO, file);
		const src = ts.createSourceFile(
			full,
			readFileSync(full, "utf8"),
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TSX,
		);
		const visit = (node: ts.Node) => {
			const cls = classNameOf(node);
			/**
			 * TOKENS, not substrings. `includes("flex")` also matches `flex-1` —
			 * a grow utility on a CHILD — and while building this that slip
			 * reported twenty `<div className="flex-1">` wrappers as broken rows.
			 * An instrument that over-reports buries the real hits as surely as
			 * one that under-reports hides them.
			 */
			const tokens = cls ? cls.split(/\s+/) : [];
			const isRow =
				(tokens.includes("flex") || tokens.includes("inline-flex")) &&
				!tokens.includes("flex-col");
			if (isRow && containsField(node) && ts.isJsxElement(node)) {
				const actions: string[] = [];
				for (const child of node.children) {
					const tag = tagOf(child);
					if (tag && ROW_ACTIONS.has(tag)) actions.push(tag);
				}
				rows.push({
					file,
					line: src.getLineAndCharacterOfPosition(node.getStart()).line + 1,
					align:
						tokens.find((t) => t.startsWith("items-")) ?? "(none → stretch)",
					actions,
				});
			}
			ts.forEachChild(node, visit);
		};
		visit(src);
	}
	return rows;
}

describe("a flex row of Fields stays aligned when one field grows", () => {
	/**
	 * The population guard, and it is not ceremony. Every assertion below is a
	 * loop over `fieldRows`; if the parser silently stopped matching — a
	 * changed class name, a TS API change, a bad glob — every loop would run
	 * zero times and the suite would report the tree CLEAN. That is the failure
	 * mode this file exists to prevent, so it is checked first and by count.
	 */
	it("finds the rows it claims to check", () => {
		const rows = fieldRows();
		expect(
			rows.length,
			"parser matched nothing — the checks below would all vacuously pass",
		).toBeGreaterThanOrEqual(15);
		expect(componentFiles().length).toBeGreaterThan(100);
	});

	it("top-aligns every one of them", () => {
		const wrong = fieldRows().filter((r) => r.align !== "items-start");
		expect(
			wrong.map((r) => `${r.file}:${r.line} is ${r.align}`),
			"a Field's height depends on state, so any alignment but start moves the row's boxes when a hint or error appears — use FieldRow, or items-start",
		).toEqual([]);
	});

	it("puts row-level controls on the control line, not the label line", () => {
		// `items-start` alone leaves a bare button up beside the LABELS. It looked
		// right under the old `items-end` only because the row happened to be flat.
		const bare = fieldRows().filter((r) => r.actions.length > 0);
		expect(
			bare.map((r) => `${r.file}:${r.line} has bare <${r.actions.join(",")}>`),
			"wrap it in <FieldRowAction> (row-level), or pass it as Field's `trailing` (belongs to one field)",
		).toEqual([]);
	});

	/**
	 * The GRID form of the same defect, which the flex checks above cannot see.
	 *
	 * A grid of Fields is safe by default — cells stretch, content starts at the
	 * top. What is not safe is a cell that bottom-aligns its own content: it
	 * parks on the row's last line, which is the tallest Field's hint or error.
	 * Found at `esam-panel.tsx`, where neither Field carries a hint today, so
	 * the drift would have arrived with the first validation error and looked
	 * like a new bug.
	 */
	it("never bottom-aligns an action cell inside a grid of Fields", () => {
		const offenders: string[] = [];
		for (const file of componentFiles()) {
			const full = path.join(REPO, file);
			const src = ts.createSourceFile(
				full,
				readFileSync(full, "utf8"),
				ts.ScriptTarget.Latest,
				true,
				ts.ScriptKind.TSX,
			);
			const visit = (node: ts.Node) => {
				const cls = classNameOf(node);
				const tokens = cls ? cls.split(/\s+/) : [];
				if (tokens.includes("grid") && containsField(node)) {
					const walk = (n: ts.Node) => {
						const inner = classNameOf(n);
						const innerTokens = inner ? inner.split(/\s+/) : [];
						if (
							innerTokens.some(
								(t) =>
									t === "items-end" ||
									t === "self-end" ||
									t === "items-baseline",
							) &&
							!containsField(n)
						) {
							offenders.push(
								`${file}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}`,
							);
						}
						ts.forEachChild(n, walk);
					};
					ts.forEachChild(node, walk);
				}
				ts.forEachChild(node, visit);
			};
			visit(src);
		}
		expect(
			offenders,
			"a stretched grid cell that bottom-aligns lands on the row's hint line — use <FieldRowAction>",
		).toEqual([]);
	});
});
