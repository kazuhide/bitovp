import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No English copy may sit in a component as a bare JSX text node.
 *
 * `i18n.test.ts` proves the two catalogues agree and `t-call-sites.test.ts` proves
 * every `t()` call fills its placeholders — but neither can see a string that never
 * went through `t()` at all. Three shipped that way and rendered English inside a
 * Japanese page:
 *
 *   - `storage-client.tsx` wrote `Loading more failed —` as a text node, directly
 *     above a translated sibling.
 *   - `resources-tab.tsx` rendered the label `Copy as cURL` while the SAME button's
 *     `aria-label` used `t("jobDetail.copyAsCurl")` — the key existed; the visible
 *     text just did not use it.
 *   - `webhooks-client.tsx` had `cond ? "signature verification on" : t(…)`: one
 *     branch translated, the other not.
 *
 * This guards the text-node shape. A line is in an element when the previous line
 * closes a tag, the next line opens a closing tag, or the previous line was itself
 * text (a wrapped paragraph); text is then read three ways — the whole line, the
 * `>…<` / `>…{` / `}…<` windows within it, and what is left of an in-element line once
 * its balanced `{expressions}` are stripped. Copy means letters, spaces and sentence
 * punctuation only, with at least two space-separated words: two words is what
 * separates copy from an identifier, since `aria-hidden` and `WizardMuxingKind` have
 * no space and `Copy as cURL` does.
 *
 * Measured against six deliberately planted leaks, it catches five:
 *
 *   caught  `This channel needs attention`            (whole line)
 *   caught  `<span>Needs attention now</span>`         (`>…<` window)
 *   caught  `Needs attention {1}` / `{1} needs …`      (expression residue)
 *   caught  `{1} needs {2} attention now`              (two expressions)
 *   MISSED  `Attention`                                (one word)
 *
 * The one-word miss is the cost of the two-word rule, and it is the right trade here:
 * dropping to one word floods the population with `neutral`, `aria-hidden` and every
 * enum member, which is what the first draft of this scan did. A one-word English
 * label is the residual risk; nothing in this tree currently has one.
 */

const SRC = join(import.meta.dirname, "..");

/** `{" "}` is JSX spacing, not an expression — a text line keeps its shape without it. */
const SPACER = /\{"\s*"\}|\{`\s*`\}/g;
const CODEY = /[{}<>="`;()[\]|&$#@\\]/;
const PROSE = /^[A-Za-z][A-Za-z'’.,!?:/–—\- ]*$/;
const TWO_WORDS = /[A-Za-z]{2,} +[A-Za-z]{2,}/;

/**
 * `app/global-error.tsx` is the handler for "the i18n layer itself threw". It renders
 * outside every provider, so `useT()` would throw there — the one place English is the
 * correct output. Ledgered in STATUS.md #35.
 */
const EXEMPT = ["app/global-error.tsx"];

function tsxFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...tsxFiles(path));
		} else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) {
			out.push(path);
		}
	}
	return out;
}

type Finding = { file: string; line: number; text: string };

/** Copy, as opposed to an identifier or a type annotation. */
function isCopy(text: string): boolean {
	return (
		text !== "" && !CODEY.test(text) && PROSE.test(text) && TWO_WORDS.test(text)
	);
}

/**
 * Text sharing a line with its tags or with an expression.
 *
 * A whole-line rule alone missed the two commonest shapes in this tree — the first
 * version of this test let `<span>Needs attention now</span>` and `Needs attention
 * {count}` both through, and the second is the very shape this file exists for: a
 * sentence split by an `{expression}`. `>…<`, `>…{` and `}…<` are the three windows
 * where JSX text can sit next to something else on one line.
 */
function inlineText(line: string): string[] {
	const windows = [/>([^<>{}]+)</g, />([^<>{}]+)\{/g, /\}([^<>{}]+)</g];
	return windows.flatMap((rx) =>
		[...line.matchAll(rx)].map((m) => (m[1] as string).trim()),
	);
}

/**
 * What is left of an in-element line once its `{expressions}` are removed.
 *
 * `{count} items remaining` has no `>` or `<` on its own line, so neither the
 * whole-line rule nor `inlineText` sees it — and a sentence split by an expression is
 * exactly the shape that broke the Japanese here. Only BALANCED spans are stripped: a
 * line that opens a brace it does not close (`{items.map((i) => (`) is a continuation,
 * and its residue would be code.
 */
function withoutExpressions(line: string): string | null {
	let depth = 0;
	let out = "";
	for (const char of line) {
		if (char === "{") {
			depth += 1;
		} else if (char === "}") {
			depth -= 1;
			if (depth < 0) {
				return null;
			}
		} else if (depth === 0) {
			out += char;
		}
	}
	return depth === 0 ? out.trim() : null;
}

function bareTextNodes(path: string): Finding[] {
	const lines = readFileSync(path, "utf8").split("\n");
	const found: Finding[] = [];
	let inBlockComment = false;
	let previousWasText = false;
	let previousCode = "";
	for (const [index, raw] of lines.entries()) {
		const trimmed = (raw as string).trim();
		if (inBlockComment) {
			if (trimmed.includes("*/")) {
				inBlockComment = false;
			}
			continue;
		}
		if (trimmed.startsWith("/*")) {
			inBlockComment = !trimmed.includes("*/");
			continue;
		}
		if (!trimmed || trimmed.startsWith("//")) {
			continue;
		}
		const text = (raw as string).replace(SPACER, "").trim();
		const next =
			lines.slice(index + 1).find((line) => (line as string).trim() !== "") ??
			"";
		// A whole line is text when it sits inside an element: the line above closes a
		// tag, the line below opens a closing tag, or the line above was itself text
		// (a wrapped paragraph).
		const insideElement: boolean =
			previousCode.endsWith(">") ||
			(next as string).trim().startsWith("</") ||
			previousWasText;
		const isText: boolean = insideElement && isCopy(text);
		const residue = insideElement ? withoutExpressions(text) : null;
		const leaked = isText
			? [text]
			: [
					...inlineText(text),
					...(residue !== null && !text.includes("<") ? [residue] : []),
				].filter(isCopy);
		for (const leakedText of leaked) {
			found.push({
				file: relative(SRC, path),
				line: index + 1,
				text: leakedText,
			});
		}
		previousWasText = isText;
		previousCode = trimmed;
	}
	return found;
}

describe("untranslated JSX text", () => {
	const all = tsxFiles(SRC).flatMap(bareTextNodes);

	it("finds the exempt file's English, so a broken matcher cannot pass over nothing", () => {
		// The detector's own smoke test. An earlier version of this scan reported a
		// clean zero because its brace matcher counted braces inside string literals
		// and blanked whole files: the population, not the code, was empty.
		//
		// Deep-equal, not a count with slack. Review showed `>= 4` survived deleting
		// `previousCode.endsWith(">")` — the load-bearing clause, which still left 4 —
		// and survived dropping the `previousWasText` chaining, which left 5. Only a
		// mutation that zeroed EVERY file was caught.
		//
		// Deep-equal pins two of the three in-element clauses: dropping
		// `previousCode.endsWith(">")` or `previousWasText` now fails this. Measured, not
		// assumed — and the measurement corrected a first draft of this comment:
		// `startsWith("</")` is NOT exercised here, because global-error's button labels
		// are also reachable through `endsWith(">")`. That clause earned its place on
		// `resources-tab.tsx`'s `Copy as cURL`, whose preceding line was `)}` — there is
		// no live instance left to pin it with, and planting one would mean adding
		// English to the tree to test the test.
		expect(
			all.filter((f) => EXEMPT.includes(f.file)).map((f) => f.text),
		).toEqual([
			"Something broke while rendering this page",
			"The error is below. It came from the app shell rather than one",
			"screen, so retrying may not clear it — the server logs will have",
			"the stack.",
			"Try again",
			"Back to the dashboard",
		]);
	});

	it("has no bare English text node outside the exempt file", () => {
		const leaked = all.filter((f) => !EXEMPT.includes(f.file));
		expect(
			leaked.map((f) => `${f.file}:${f.line}  ${f.text}`),
			"wrap these in t(); English here renders inside a Japanese page",
		).toEqual([]);
	});
});
