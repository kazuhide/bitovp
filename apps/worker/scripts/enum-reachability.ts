/**
 * Which values can the PLAN express that no form control offers?
 *
 * The generalisation of 's defect. `AKAMAI_MSL` was a member of the
 * plan's output-kind union with a compiler, a golden fixture and a constraint
 * checker behind it — and no dropdown offered it, so an Akamai customer had no
 * destination. Every check the repo had starts from a plan that ALREADY holds
 * the value; none started from the list of values and asked whether a person
 * can pick each one.
 *
 * Usage (no server, no browser — it reads the tree):
 *   pnpm --filter @bitovp/worker exec tsx scripts/enum-reachability.ts
 *
 * A WORKLIST, NOT A GATE, and deliberately not a vitest. Some schema enums are
 * server-side by nature (step status, job state) and were never meant to be
 * picked; some are set by a checkbox rather than a select. Deciding which is
 * which is a human read, and freezing today's answer into an allowlist is how
 * 's deferral quietly became a defect nobody looked at again.
 *
 * TRIAGED BASELINE, 2026-08-21 — 8 reported, 0 defects, 3 real gaps:
 *   - paddingSequence `unit`: FRAMES unreachable. The concatenation form
 *     exposes `duration` only and its label hardcodes seconds.
 *   - streamCondition: only `audioGuard` (AUDIOSTREAMCOUNT > 0) is offered;
 *     the six comparison operators have no control.
 *   - delivery `onDeviation`: REFUSE/WARN had no control. (The triage wrote
 *     "watchFolder" here — wrong name for the right field. It is the PLAN's
 *     delivery commitment, enforced for EVERY submitter at the submit
 *     boundary (submit.ts, skippable only for re-run); the watch sweep is
 *     just the unattended submitter the refusal message was designed for.
 *     Closed 2026-08-21: the wizard's spec strip offers
 *     banner-only/WARN/REFUSE — .)
 *   The other five are false positives: acl is a checkbox, jitPlacement IS
 *   offered via a mapped component, stepStatus is server-side, cenc ivSize is
 *   derived from the mode (C9), and genericS3 signing is forced to V4 (C10).
 *
 * TWO WAYS THIS TOOL LIED WHILE BEING BUILT, both worth knowing before trusting
 * a run:
 *  - Requiring `as const` on option arrays missed every declarative field spec
 *    (`control: { options: ["MAIN", "MAIN10"] }`) and reported 35 unreachable
 *    enums that were all offered.
 *  - Widening it then let the core pass harvest the `z.enum([...])` arrays
 *    THEMSELVES, so every enum found its own declaration as a control and the
 *    count went to 0. A clean bill of health from a tool grading its own
 *    homework. Enum argument spans are now excluded via the AST.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ls = (glob: string) =>
	execSync(`git ls-files '${glob}'`, { encoding: "utf8", cwd: ROOT })
		.trim()
		.split("\n")
		.filter(Boolean);

/** ---- 1. schema enums ---------------------------------------------- */
type EnumDecl = { file: string; name: string; values: string[] };
const enums: EnumDecl[] = [];

for (const file of ls("packages/core/src/**/*.ts").filter(
	(f) => !f.includes(".test.") && !f.includes("__fixtures__"),
)) {
	const text = readFileSync(`${ROOT}/${file}`, "utf8");
	const src = ts.createSourceFile(
		file,
		text,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const visit = (node: ts.Node) => {
		// z.enum([...]) — take the array literal's string members.
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === "enum" &&
			node.arguments[0] &&
			ts.isArrayLiteralExpression(node.arguments[0])
		) {
			const values = node.arguments[0].elements
				.filter(ts.isStringLiteral)
				.map((e) => e.text);
			if (values.length >= 2) {
				// Name it by the nearest variable declaration, for readability.
				let named = "(anonymous)";
				let p: ts.Node | undefined = node.parent;
				while (p) {
					if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
						named = p.name.text;
						break;
					}
					p = p.parent;
				}
				enums.push({ file, name: named, values });
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(src);
}

/** ---- 2. option value-sets offered by the UI ------------------------ */
const optionSets: { file: string; values: Set<string> }[] = [];
for (const file of ls("apps/web/src/**/*.tsx").filter(
	(f) => !f.includes(".test."),
)) {
	const text = readFileSync(`${ROOT}/${file}`, "utf8");
	// Every literal option value in the file. Per FILE, not per select: a
	// select built by .map over a constant has no literal options, and the
	// constant usually sits in the same file.
	const values = new Set<string>();
	for (const m of text.matchAll(/<option\s+[^>]*value=["']([^"']+)["']/g)) {
		if (m[1]) values.add(m[1]);
	}
	/*
	 * ANY array of string literals in the file, not just `as const` ones.
	 * The wizards describe fields declaratively — `control: { options: ["MAIN",
	 * "MAIN10"] }` — and requiring `as const` missed every one of them, so the
	 * first run reported MAIN/MAIN10 as unreachable while `rendition-editors`
	 * had offered them all along. An instrument that over-reports buries the
	 * real hits exactly as thoroughly as one that under-reports.
	 */
	for (const m of text.matchAll(/\[([^\][{}]*)\]/g)) {
		const body = m[1] ?? "";
		if (!/["']/.test(body)) continue;
		for (const lit of body.matchAll(/["']([A-Za-z0-9_]{2,})["']/g)) {
			if (lit[1]) values.add(lit[1]);
		}
	}
	if (values.size) optionSets.push({ file, values });
}

/**
 * Core constant lists the UI maps over (CREDENTIAL_PROVIDERS, …) — but NOT the
 * `z.enum([...])` arrays themselves.
 *
 * This distinction is the whole instrument. Harvesting core with a plain regex
 * made every enum find its OWN declaration as a control, and the report went to
 * zero unreachable — a clean bill of health from a tool grading its own
 * homework. Positions of the enum arguments are collected from the AST and any
 * literal inside one is skipped.
 */
for (const file of ls("packages/core/src/**/*.ts").filter(
	(f) => !f.includes(".test.") && !f.includes("__fixtures__"),
)) {
	const text = readFileSync(`${ROOT}/${file}`, "utf8");
	const src = ts.createSourceFile(
		file,
		text,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const enumSpans: [number, number][] = [];
	const mark = (node: ts.Node) => {
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === "enum" &&
			node.arguments[0]
		) {
			enumSpans.push([
				node.arguments[0].getStart(),
				node.arguments[0].getEnd(),
			]);
		}
		ts.forEachChild(node, mark);
	};
	mark(src);
	const insideEnum = (i: number) => enumSpans.some(([a, b]) => i >= a && i < b);

	const values = new Set<string>();
	for (const m of text.matchAll(/\[([^\][{}]*)\]/g)) {
		const body = m[1] ?? "";
		if (!/["']/.test(body) || insideEnum(m.index ?? 0)) continue;
		for (const lit of body.matchAll(/["']([A-Za-z0-9_]{2,})["']/g)) {
			if (lit[1]) values.add(lit[1]);
		}
	}
	if (values.size) optionSets.push({ file, values });
}

/** ---- 3. compare ---------------------------------------------------- */
const seen = new Map<string, EnumDecl>();
for (const e of enums) {
	const key = [...e.values].sort().join("|");
	if (!seen.has(key)) seen.set(key, e);
}

const unreachable: { decl: EnumDecl; missing: string[]; best: string }[] = [];
for (const decl of seen.values()) {
	let best = "(nothing)";
	let bestMissing = decl.values.slice();
	for (const set of optionSets) {
		const missing = decl.values.filter((v) => !set.values.has(v));
		if (missing.length < bestMissing.length) {
			bestMissing = missing;
			best = set.file;
		}
	}
	if (bestMissing.length > 0) {
		unreachable.push({ decl, missing: bestMissing, best });
	}
}

console.log(`schema enums (distinct value-sets): ${seen.size}`);
console.log(`files contributing option values:   ${optionSets.length}`);
console.log(`enums NOT fully offered anywhere:   ${unreachable.length}\n`);

unreachable.sort((a, b) => a.missing.length - b.missing.length);
for (const u of unreachable.slice(0, 40)) {
	console.log(
		`  ${u.decl.name}  [${u.decl.values.length} values]  missing ${u.missing.length}: ${u.missing.slice(0, 6).join(", ")}`,
	);
	console.log(`      declared in ${u.decl.file}`);
	console.log(`      closest control set: ${u.best}`);
}
