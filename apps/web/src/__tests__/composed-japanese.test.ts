import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ja } from "@/lib/i18n/messages/ja";

/* Catalog values alone cannot detect spaces introduced when JSX composes a sentence. Inspect rendered Japanese text across component boundaries. */

const SRC = join(import.meta.dirname, "..");

/** Elements whose body is prose. A `<button>` label is not joined into a sentence. */
const PROSE_TAGS = /<(p|li|h[1-6])\b/g;
/* Include Japanese punctuation in the character range so spaces beside punctuation are detected too. */
const JAPANESE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;
/**
 * Japanese, one or more RENDERED SPACES, Japanese.
 *
 * `\0` is the marker `renderJapanese` emits for a space, escaped rather than written as
 * a literal NUL byte in the source, which is what it was on first commit.
 */
const SPLIT =
	/[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]\0+[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

const CATALOGUE = ja as unknown as Record<string, Record<string, string>>;

function value(key: string): string | undefined {
	const [ns, leaf] = key.split(".") as [string, string];
	return CATALOGUE[ns]?.[leaf];
}

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

/* Mark rendered spaces explicitly, including JSX spaces, source whitespace and literal spaces, while preserving placeholders and component structure. */
function renderJapanese(body: string): string {
	const parts: string[] = [];
	let last = 0;
	const TOKEN =
		/t\("([\w.]+)"[^)]*\)|\{" "\}|<(code|em|strong|span)\b[^>]*>([^<{]+)<\/\2>/g;
	for (const match of body.matchAll(TOKEN)) {
		const gap = body.slice(last, match.index);
		// A `t` inside an ATTRIBUTE (`label={t(…)}`, `text={t(…)}`) is not inline text —
		// an InfoHint's aria-label is a button, and treating it as prose reported six
		// 「。␠「」 splits that do not exist.
		if (/=\{?\s*$/.test(gap)) {
			last = (match.index as number) + match[0].length;
			continue;
		}
		const emitsSpace =
			last > 0 &&
			(/^[^\S\n]+$/.test(gap) ||
				/<\/(code|em|strong|span)>[^\S\n]+$/.test(gap));
		if (emitsSpace) {
			parts.push("\0");
		}
		// A non-`t` `{expression}` between two tokens renders SOMETHING — a joined list,
		// a number — so the spaces around it are legitimate. Stand in for it with a
		// character that is neither Japanese nor a space.
		if (last > 0 && /\{[^}]/.test(gap)) {
			parts.push("x");
		}
		if (match[0] === '{" "}') {
			parts.push("\0");
		} else if (match[1] !== undefined) {
			parts.push(value(match[1]) ?? "");
		} else {
			parts.push((match[3] as string).trim());
		}
		last = (match.index as number) + match[0].length;
	}
	return parts.join("");
}

type Split = { file: string; line: number; around: string };

function splitSentences(path: string): Split[] {
	const src = readFileSync(path, "utf8");
	const found: Split[] = [];
	for (const open of src.matchAll(PROSE_TAGS)) {
		const tag = open[1] as string;
		const start = (open.index as number) + open[0].length;
		const close = src.indexOf(`</${tag}>`, start);
		if (close < 0 || close - start > 1600) {
			continue;
		}
		const body = src.slice(start, close);
		// A nested same-tag element means the naive close is the wrong one.
		if (body.includes(`<${tag}`)) {
			continue;
		}
		if ((body.match(/t\("/g) ?? []).length < 2) {
			continue;
		}
		const rendered = renderJapanese(body);
		if (!JAPANESE.test(rendered)) {
			continue;
		}
		const hit = SPLIT.exec(rendered);
		if (hit) {
			found.push({
				file: relative(SRC, path),
				line: src.slice(0, open.index).split("\n").length,
				around: (hit[0] as string).replace(/\0/g, "␠"),
			});
		}
	}
	return found;
}

/**
 * `storage-client.tsx`'s credentials error is `{apiMessage ?? t(…)}{" "}{t(tail)}`. The
 * left side is a RAW API message in either locale, so it genuinely needs a separator —
 * moving the space into the English tail would run an English error straight into the
 * Japanese sentence. The cost is one space after 「。」 on an error line.
 */
const EXEMPT = ["app/storage/storage-client.tsx:413"];

describe("composed Japanese sentences", () => {
	const all = tsxFiles(SRC).flatMap(splitSentences);

	it("has no JSX space between two Japanese characters", () => {
		expect(
			all
				.map((s) => `${s.file}:${s.line}  ${s.around}`)
				.filter((s) => !EXEMPT.some((e) => s.startsWith(e))),
			'delete the {" "} and put the space English needs inside its English value',
		).toEqual([]);
	});

	it("still finds the exempt split, so the scan cannot pass over nothing", () => {
		// Same reason as `untranslated-jsx-text.test.ts`: an empty population reports
		// clean. This one has exactly one known instance, so it doubles as the smoke test.
		expect(all.map((s) => `${s.file}:${s.line}`)).toContain(
			"app/storage/storage-client.tsx:413",
		);
	});
});
