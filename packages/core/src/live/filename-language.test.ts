import { expect, it } from "vitest";
import {
	createFilenameMatcher,
	filenameLanguagesOverlap,
	literalFilenameLanguage,
	outputFilenameLanguage,
} from "./filename-language";

it.each([
	["seg_%number%.ts", "seg_12.ts", "MATCH"],
	["seg_%number%.ts", "seg_word.ts", "NO_MATCH"],
	["media/%provider%.m4s", "media/custom-value.m4s", "MATCH"],
	["media/%time%.m4s", "media/provider-value.m4s", "MATCH"],
	["media/%provider%.m4s", "media/nested/value.m4s", "NO_MATCH"],
] as const)("keeps filename-policy membership for %s against %s", (pattern, value, result) => {
	expect(
		createFilenameMatcher(pattern, { policyTokens: true, randomTokens: false })(
			value,
		),
	).toBe(result);
});

it("keeps init-template numeric tokens literal while expanding random tokens", () => {
	const match = createFilenameMatcher(
		"headers/init_{rand_chars:8}_%number%.mp4",
		{ policyTokens: false, randomTokens: true },
	);
	expect(match("headers/init_Ab12Cd34_%number%.mp4")).toBe("MATCH");
	expect(match("headers/init_Ab12Cd34_1.mp4")).toBe("NO_MATCH");
	expect(match("foreign/headers/init_Ab12Cd34_%number%.mp4")).toBe("NO_MATCH");
});

it("reports exhausted parsing and membership budgets without claiming a match", () => {
	expect(
		createFilenameMatcher("init-{rand_chars:2049}.mp4", {
			policyTokens: false,
			randomTokens: true,
		})(`init-${"A".repeat(2049)}.mp4`),
	).toBe("UNVERIFIED");
	expect(
		createFilenameMatcher(`${"%number%".repeat(300)}.ts`, {
			policyTokens: true,
			randomTokens: false,
		})(`${"1".repeat(700)}.ts`),
	).toBe("UNVERIFIED");
});

it.each([
	["init_%number%.mp4", "init_%number%.mp4", false, false, true],
	["init_%number%.mp4", "init_1.mp4", false, false, false],
	["archive_%provider%.mp4", "archive_custom.mp4", false, false, false],
	["init_{rand_chars:8}.mp4", "init_Ab12Cd34.mp4", false, false, false],
	["init_{rand_chars:8}.mp4", "init_Ab12Cd34.mp4", false, true, true],
	[
		"init_{rand_chars:8}_%number%.mp4",
		"init_Ab12Cd34_%number%.mp4",
		false,
		true,
		true,
	],
	[
		"init_{rand_chars:8}_%number%.mp4",
		"init_Ab12Cd34_1.mp4",
		false,
		true,
		false,
	],
	["seg_%number%.m4s", "seg_12.m4s", true, false, true],
	["seg_{rand_chars:8}_%number%.m4s", "seg_Ab12Cd34_12.m4s", true, true, true],
	["seg_%provider%.m4s", "seg_custom.m4s", true, false, true],
] as const)("keeps admission and runtime token provenance aligned for %s against %s", (pattern, name, policyTokens, randomTokens, matches) => {
	const tokens = { policyTokens, randomTokens };
	const folder = "literal/%number%/{rand_chars:8}";
	expect(createFilenameMatcher(pattern, tokens)(name)).toBe(
		matches ? "MATCH" : "NO_MATCH",
	);
	expect(
		filenameLanguagesOverlap(
			outputFilenameLanguage(folder, pattern, tokens),
			literalFilenameLanguage(`${folder}/${name}`),
		),
	).toBe(matches);
	expect(
		filenameLanguagesOverlap(
			outputFilenameLanguage(folder, pattern, tokens),
			literalFilenameLanguage(`literal/1/Ab12Cd34/${name}`),
		),
	).toBe(false);
});
