import { expect, it } from "vitest";
import { createFilenameMatcher } from "./filename-language";

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
