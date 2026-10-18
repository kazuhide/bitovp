import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/messages/en";
import { ja } from "@/lib/i18n/messages/ja";

/* Both wizards expose their most visible step labels through typed message keys and resolve them in each supported locale. */

const APP = join(import.meta.dirname, "..", "app");

function stepKeys(file: string): string[] {
	const src = readFileSync(join(APP, file), "utf8");
	const block = /const STEPS: MessageKey\[\] = \[([^\]]*)\]/.exec(src);
	if (!block) {
		throw new Error(`no MessageKey[] STEPS array in ${file}`);
	}
	return [...(block[1] as string).matchAll(/"([\w.]+)"/g)].map(
		(m) => m[1] as string,
	);
}

function value(catalogue: typeof en | typeof ja, key: string): string {
	const [ns, leaf] = key.split(".") as [string, string];
	const section = (
		catalogue as unknown as Record<string, Record<string, string>>
	)[ns];
	const text = section?.[leaf];
	if (text === undefined) {
		throw new Error(`missing key ${key}`);
	}
	return text;
}

describe("wizard step labels", () => {
	const WIZARDS = [
		{
			file: "vod/new/wizard.tsx",
			expected: [
				"Basics",
				"Sources",
				"Ladder",
				"Output",
				"Packaging",
				"Encoding",
				"Manifests",
				"Review",
			],
		},
		{
			file: "live/new/live-wizard.tsx",
			// the AWS MediaLive vocabulary, as
			// live-specific keys — "Start" named a step that never started
			// anything (the channel provisions at creation; the step holds the
			// automatic restart / stop settings).
			expected: [
				"Basics",
				"Input",
				"Video and audio encodes",
				"Destinations",
				"Output groups and manifests",
				"Automatic restart and stop",
				// Ledger #94: the broadcast slot, before review.
				"Schedule actions",
				"Review",
			],
		},
	];

	for (const { file, expected } of WIZARDS) {
		it(`${file} keeps its English step names, capitalised`, () => {
			const keys = stepKeys(file);
			expect(keys).toHaveLength(expected.length);
			expect(keys.map((key) => value(en, key))).toEqual(expected);
		});

		it(`${file} translates every step`, () => {
			for (const key of stepKeys(file)) {
				const english = value(en, key);
				const japanese = value(ja, key);
				expect(japanese, key).not.toBe(english);
				// A step label is a heading, never a path segment or an identifier.
				expect(english[0], key).toBe(english[0]?.toUpperCase());
			}
		});
	}
});
