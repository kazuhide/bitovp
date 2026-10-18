import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 's durable half (review-231 N2). The drift class: `Field`
 * stacks label+input+hint, so END-aligning a control against a hinted
 * Field parks the control on the HINT line, one row below its input.
 * The PR converted the drifted sites to `Field.trailing` — but the
 * residual was enumerated in PROSE, and prose rotted twice in one
 * review round (a row named hint-free carried a hint; two drifted rows
 * were missing; one named row wasn't an instance at all). This scan is
 * the enumeration as a pin: the set of end-aligned blocks holding a
 * hinted Field plus a control must equal the allowlist below, in BOTH
 * directions — a new drifted row fails (convert it to `trailing`
 * instead), and a converted row's stale entry fails too.
 *
 * Two shapes are covered:
 *  R1 — the wrapper itself contains the hinted Field and the control
 *       (`flex items-end` around Field + Button).
 *  R2 — the control sits alone in an end-aligned cell whose PARENT
 *       block holds the hinted Field (the grid-cell variant
 *       content-insertion had before #101 converted it).
 *
 * What it cannot see: runtime-only hints (none exist today — even the
 * per-title conditional is a static `hint={` expression and is caught);
 * end-alignment expressed without the items-end/self-end/baseline
 * utilities; and two drifted rows in ONE file sharing the same first
 * hint key collapse to one signature (review-231 N2) — fixing one would
 * leave the pin green with the other still drifting. jsdom does no
 * layout, so BYTES are the instrument here — the ja render-sweep
 * remains the eyes for what actually paints.
 */

const WEB_ROOT = resolve(__dirname, "../..");

/**
 * file + first hint/error key in the block — line numbers churn, keys don't.
 *
 * EMPTY SINCE 2026-08-20, and the reason the last entry could finally go is
 * worth keeping. It was deferred for a real cause, stated right here: the row's
 * control is a whole-row remove, and `Field.trailing` puts a control on ONE
 * field's input row, which is the wrong owner. There was no way to say "this
 * control belongs to the ROW and sits on the control line" — so the row stayed
 * end-aligned and this list carried it.
 *
 * `FieldRowAction` is that missing way. With it the last deferral is a fix, not
 * a trade, and the class is now prevented structurally by
 * `components/ui/field-row-alignment.test.ts` rather than enumerated here.
 *
 * The entry was the owner's report, five days later: choosing Per-Title on VOD
 * step 3 dropped Codec and Height by 38px. It was on this list the whole time —
 * a recorded deferral is not a fixed defect, and the person using the app is
 * the one who finds out.
 *
 * Keep the scan. It reads LINES with regexes where the alignment guard reads an
 * AST, and it models a shape that one does not: a control alone in an end-
 * aligned cell whose PARENT holds the hinted Field. Two mechanisms, two blind
 * spots, and a new drifted row still has to get past both.
 */
const ALLOWED_DRIFT = new Set<string>([]);

const END_ALIGN = /\bitems-end\b|\bself-end\b|\bitems-baseline\b/;
const FIELD_OPEN = /<Field\b/;
// Expression hints AND literal hints (`hint="≥30s"` exists in the tree —
// review-231 round C N1; a literal in a drifted row signs as <no-key>).
const HINT_PROP = /(?:^|[\s{])(?:hint|error)=[{"]/m;
// Every control spelling: raw <button> (52 uses), <Button> (209), and every
// capitalized *Button component (RowRemove/DeleteResource/Copy/CopyCurl…).
// The first version enumerated four names, one of which did not exist, and
// review-231 round C DEMONSTRATED the gap: renaming a drifted row's control
// to <button> turned the scan green. Pattern over enumeration — and the
// pattern's own first cut (`[A-Z]\w*Button`) failed to match bare <Button>
// because the class consumed its B; caught by the stale direction going
// red on the clean tree, which is the pin working as designed.
const CONTROL = /<(?:[A-Z]\w*)?[Bb]utton\b/;
const HINT_KEY = /(?:^|[\s{])(?:hint|error)=\{[^}]*?t\("([^"]+)"/ms;

function trackedTsx(): string[] {
	const out = execFileSync("git", ["ls-files", "-z", "--", "src/**/*.tsx"], {
		cwd: WEB_ROOT,
		encoding: "utf8",
	});
	return out.split("\0").filter((f) => f.length > 0 && !f.includes(".test."));
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/**
 * The wrapper's JSX block: opening tag through the element's CLOSING tag.
 * A multiline opening tag ends with a bare `>` at the wrapper's own
 * indentation — that is not the element's end, so only `</`-lines (or a
 * self-closing `/>`) at the wrapper's depth terminate the block. The
 * first version broke on exactly this and classified attribute-styled
 * parents as empty (caught by kill-verify, not by the green run).
 */
function blockAt(lines: string[], start: number): string {
	const depth = indentOf(lines[start] ?? "");
	let end = start + 1;
	while (end < lines.length) {
		const line = lines[end] ?? "";
		const trimmed = line.trim();
		if (trimmed.length > 0 && indentOf(line) <= depth) {
			if (trimmed.startsWith("</") || trimmed === "/>") {
				break;
			}
			// The bare `>` closing a multiline opening tag — children follow.
			if (trimmed !== ">") {
				break;
			}
		}
		end += 1;
	}
	return lines.slice(start, end + 1).join("\n");
}

/** Nearest enclosing element-opening line above, one indent shallower. */
function elementAbove(lines: string[], start: number): number | null {
	const depth = indentOf(lines[start] ?? "");
	for (let i = start - 1; i >= 0; i -= 1) {
		const line = lines[i] ?? "";
		if (
			line.trim().startsWith("<") &&
			!line.trim().startsWith("</") &&
			indentOf(line) < depth
		) {
			return i;
		}
	}
	return null;
}

function parentBlock(lines: string[], start: number): string | null {
	const owner = elementAbove(lines, start);
	return owner === null ? null : blockAt(lines, owner);
}

function driftedRows(): string[] {
	const found: string[] = [];
	for (const rel of trackedTsx()) {
		const lines = readFileSync(join(WEB_ROOT, rel), "utf8").split("\n");
		for (let i = 0; i < lines.length; i += 1) {
			const raw = lines[i] ?? "";
			const lead = raw.trim();
			// The utility must sit in a className on THIS line — prose in a
			// comment quoting "items-end" is not a wrapper (self-caught: the
			// first run flagged cloud-connect's own #101 comment).
			if (
				!END_ALIGN.test(raw) ||
				!raw.includes("className=") ||
				lead.startsWith("{/*") ||
				lead.startsWith("*") ||
				lead.startsWith("//")
			) {
				continue;
			}
			// items-end on an attribute line (multiline opening tag): the
			// block belongs to the OWNING element, one walk up.
			const owner = (lines[i] ?? "").trim().startsWith("<")
				? i
				: (elementAbove(lines, i) ?? i);
			const block = blockAt(lines, owner);
			const direct =
				FIELD_OPEN.test(block) && HINT_PROP.test(block) && CONTROL.test(block);
			let viaParent = false;
			let keySource = block;
			if (!direct && CONTROL.test(block) && !FIELD_OPEN.test(block)) {
				const parent = parentBlock(lines, owner);
				if (parent && FIELD_OPEN.test(parent) && HINT_PROP.test(parent)) {
					viaParent = true;
					keySource = parent;
				}
			}
			if (!direct && !viaParent) {
				continue;
			}
			const key = HINT_KEY.exec(keySource)?.[1] ?? "<no-key>";
			found.push(`${rel}#${key}`);
		}
	}
	return found;
}

describe("Field drift scan (ledger #101)", () => {
	it("every end-aligned block with a hinted Field + control is on the allowlist, and every allowlist entry still drifts", () => {
		const found = new Set(driftedRows());
		const unexpected = [...found].filter((row) => !ALLOWED_DRIFT.has(row));
		const stale = [...ALLOWED_DRIFT].filter((row) => !found.has(row));
		expect(
			unexpected,
			"NEW drifted row(s) — convert to Field.trailing instead of end-aligning against a hinted Field",
		).toEqual([]);
		expect(
			stale,
			"allowlist entry no longer drifts — delete it here and update LEDGER row 101's residual",
		).toEqual([]);
	});
});
