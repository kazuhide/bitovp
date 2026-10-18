import { SAMPLE_PRESET_FAMILIES, SAMPLE_PRESETS } from "@bitovp/core/presets";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { en } from "@/lib/i18n/messages/en";
import { ja } from "@/lib/i18n/messages/ja";
import {
	presetDescriptionKey,
	presetFamilyKey,
	presetTitleKey,
} from "@/lib/preset-copy";
import { renderWithQuery as renderLocalized } from "@/test/render";
import { PresetGallery } from "./preset-gallery";

vi.mock("@/lib/api", () => ({
	apiFetch: () =>
		Promise.resolve({
			mode: "password",
			configured: true,
			authenticated: true,
			loginKind: "password-form",
		}),
}));

/**
 * The ALL-OR-NOTHING bar for 's `/presets` pass, and the licence for
 * the casts in `preset-copy.ts`: every SAMPLE_PRESETS entry and every family
 * id must resolve to a non-empty string in BOTH locales. Adding a preset to
 * core without its two catalogue pairs fails here by name — the trickle this
 * row forbade cannot restart silently.
 *
 * `ja satisfies Messages` already makes the locales structurally identical,
 * so the per-locale walk is redundant the day it is written — it exists for
 * the day someone weakens that type relationship.
 */

function lookup(
	catalogue: Record<string, unknown>,
	dottedKey: string,
): unknown {
	// Preset names contain dots-free kebab segments, so splitting on "." is
	// exact — pinned by the resolution test below rather than assumed.
	return dottedKey
		.split(".")
		.reduce<unknown>(
			(node, part) =>
				typeof node === "object" && node !== null
					? (node as Record<string, unknown>)[part]
					: undefined,
			catalogue,
		);
}

describe("preset gallery copy — totality over both locales", () => {
	it("has a corpus to check against", () => {
		expect(SAMPLE_PRESETS.length).toBe(56);
		expect(SAMPLE_PRESET_FAMILIES.length).toBe(12);
	});

	it("no preset name contains a dot, so the dotted-path lookup is exact", () => {
		expect(SAMPLE_PRESETS.filter((p) => p.name.includes("."))).toEqual([]);
	});

	for (const [locale, catalogue] of [
		["en", en],
		["ja", ja],
	] as const) {
		it(`resolves every preset's title and description in ${locale}`, () => {
			const missing = SAMPLE_PRESETS.flatMap((preset) =>
				[presetTitleKey(preset.name), presetDescriptionKey(preset.name)].filter(
					(key) => {
						const value = lookup(catalogue, key);
						return typeof value !== "string" || value.length === 0;
					},
				),
			);
			expect(missing).toEqual([]);
		});

		it(`resolves every family label in ${locale}`, () => {
			const missing = SAMPLE_PRESET_FAMILIES.map((family) =>
				presetFamilyKey(family.id),
			).filter((key) => {
				const value = lookup(catalogue, key);
				return typeof value !== "string" || value.length === 0;
			});
			expect(missing).toEqual([]);
		});
	}

	it("every ja DESCRIPTION is actually Japanese, not English left in place", () => {
		// Titles are allowed to be identifier-only ("Per-Title H264 → Smooth
		// Streaming + PlayReady" has nothing to translate); descriptions are
		// sentences and a sentence without a single Japanese character is the
		// exact "English left in place" failure #35 existed for.
		const japanese = /[぀-ヿ㐀-鿿]/;
		const english = SAMPLE_PRESETS.map((preset) =>
			presetDescriptionKey(preset.name),
		).filter((key) => !japanese.test(String(lookup(ja, key))));
		expect(english).toEqual([]);
	});
});

describe("preset gallery — rendered in ja", () => {
	it("every card's ops badge is the PEEK trigger, not a plain badge (review-179 I1)", () => {
		// Swapping <PresetOpsPeek/> back to the old <Badge> survived the whole
		// suite: the peek's own tests render the COMPONENT. The gallery is the
		// only caller, so the trigger role from THIS render is the slot pin.
		// The gallery's role-aware action does call useQuery; the shared wrapper
		// provides the same query context as the application shell.
		renderLocalized(
			<PresetGallery
				families={SAMPLE_PRESET_FAMILIES}
				presets={SAMPLE_PRESETS}
			/>,
		);
		expect(screen.getAllByRole("button", { name: /^\d+ ops$/ })).toHaveLength(
			56,
		);
	});

	it("renders all 56 cards through the catalogue, Japanese where Japanese exists", () => {
		// The class #35 existed for is invisible to catalogue checks (the strings
		// never were keys), so the proof is the RENDERED page: every card present,
		// the starter's translated title on screen, and its English original NOT.
		renderLocalized(
			<PresetGallery
				families={SAMPLE_PRESET_FAMILIES}
				presets={SAMPLE_PRESETS}
			/>,
			"ja",
		);
		expect(screen.getAllByRole("listitem")).toHaveLength(56);
		expect(
			screen.getByText("固定ビットレート H264+AAC → HLS(AWS S3)"),
		).toBeTruthy();
		expect(
			screen.queryByText("Fixed-bitrate H264+AAC → HLS (AWS S3)"),
		).toBeNull();
		// A translated family heading, and the WebVTT family's prose label.
		expect(screen.getByRole("heading", { name: "WebVTT 字幕" })).toBeTruthy();
		// The C4 tokens render WITH their braces — the catalogue value spells
		// them and the call site feeds the literals (the pass-braces-as-values
		// idiom). A regression here is a THROW, not a wrong string: an unfed
		// braced value takes the whole gallery down, which is what the first
		// version of this pass hit and papered over by deleting the braces
		// (review finding: C4 is about the tokens, whose syntax IS the braces).
		expect(screen.getByText(/\{height\}\/\{bitrate\}\/\{uuid\}/)).toBeTruthy();
	});

	it("survives TYPING in ja — the search path interpolates every description too", async () => {
		// The reviewer's mutation C: feeding C4_TOKENS at the render site but not
		// the SEARCH site passed every test, because no test ever typed a
		// character — the filter short-circuits on the empty query, so the search
		// path's t calls never executed. That miss is the worse of the two: a
		// page-load throw is caught instantly; this one fires the first time a
		// Japanese operator types, and takes the whole gallery down.
		renderLocalized(
			<PresetGallery
				families={SAMPLE_PRESET_FAMILIES}
				presets={SAMPLE_PRESETS}
			/>,
			"ja",
		);
		await userEvent.type(screen.getByRole("searchbox"), "ラダー");
		// The grid survived the keystroke (no interpolator throw) and the filter
		// actually ran: a strict subset of the 56 remains.
		const remaining = screen.getAllByRole("listitem").length;
		expect(remaining).toBeGreaterThan(0);
		expect(remaining).toBeLessThan(56);
	});
});
