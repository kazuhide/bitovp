import type { PerTitleGoal } from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleGuidedSetup } from "./per-title-guided-setup";

const copy = {
	en: {
		next: "Next",
		back: "Back",
		complete: "Inspect in simulator",
		ranges: "Specify resolutions and bitrate ranges",
		mode: "Stream mode",
		add: "Add rendition",
		row: (n: number) => `Rendition ${n}`,
		height: "Height (px)",
		heightHint: "Height hint (px, optional)",
		minimum: "Minimum bitrate (kbps, optional)",
		maximum: "Maximum bitrate (kbps, optional)",
		api: "API settings",
	},
	ja: {
		next: "次へ",
		back: "戻る",
		complete: "シミュレーターで確認",
		ranges: "解像度とビットレート幅を指定",
		mode: "Streamモード",
		add: "レンディションを追加",
		row: (n: number) => `レンディション ${n}`,
		height: "高さ (px)",
		heightHint: "高さのヒント (px・任意)",
		minimum: "最小ビットレート (kbps・任意)",
		maximum: "最大ビットレート (kbps・任意)",
		api: "API 設定",
	},
};

function mount(locale: "en" | "ja") {
	const onComplete = vi.fn();
	const goal: PerTitleGoal = {
		strategy: "automatic",
		codec: "H264",
		minBitrate: 160_000,
		maxBitrate: 5_000_000,
		countPolicy: { kind: "unrestricted" },
	};
	renderLocalized(
		<PerTitleGuidedSetup
			initialGoal={goal}
			allowedCodecs={["H264", "H265", "VP9", "AV1"]}
			onComplete={onComplete}
			onCancel={vi.fn()}
		/>,
		locale,
	);
	return { text: copy[locale], onComplete };
}
function change(element: HTMLElement, value: string) {
	fireEvent.change(element, { target: { value } });
}
const click = (name: string) =>
	fireEvent.click(screen.getByRole("button", { name }));
function api(text: (typeof copy)["en"]) {
	const pre = screen
		.getByText(text.api, { exact: true })
		.closest("details")
		?.querySelector("pre");
	if (!pre) throw new Error("Expected proposed API settings.");
	return JSON.parse(pre.textContent ?? "{}");
}

describe("unified Stream requirements", () => {
	it.each([
		"en",
		"ja",
	] as const)("uses one template mode with an optional resolution hint (%s)", (locale) => {
		const { text } = mount(locale);
		click(text.next);
		const row = () => within(screen.getByRole("group", { name: text.row(1) }));
		const hint = () => row().getByRole("spinbutton", { name: text.heightHint });
		expect(hint()).toHaveValue(null);
		expect(
			row()
				.getAllByRole("option")
				.map((option) => option.textContent),
		).toEqual([
			"PER_TITLE_TEMPLATE",
			"PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
		]);
		click(text.next);
		expect(api(text).streams[0]).not.toHaveProperty("height");
		expect(api(text).streams[0]).not.toHaveProperty("width");
		click(text.back);
		change(hint(), "480");
		change(
			row().getByRole("combobox", { name: text.mode }),
			"fixed-resolution",
		);
		expect(row().getByRole("spinbutton", { name: text.height })).toHaveValue(
			480,
		);
		change(row().getByRole("combobox", { name: text.mode }), "template");
		expect(hint()).toHaveValue(480);
		click(text.next);
		expect(api(text).streams).toMatchObject([
			{ mode: "PER_TITLE_TEMPLATE", height: 480 },
		]);
		click(text.back);
		change(hint(), "");
		click(text.next);
		expect(api(text).streams[0]).not.toHaveProperty("height");
		expect(api(text).streams[0]).not.toHaveProperty("width");
	});

	it.each([
		"en",
		"ja",
	] as const)("authors all Stream modes with optional template hints in the same list (%s)", (locale) => {
		const { text, onComplete } = mount(locale);
		fireEvent.click(screen.getByRole("radio", { name: text.ranges }));
		click(text.next);
		click(text.add);
		const choices = ["template", "template", "fixed-resolution", "fixed-range"];
		for (const [index, choice] of choices.entries()) {
			const row = within(
				screen.getByRole("group", { name: text.row(index + 1) }),
			);
			change(row.getByRole("combobox", { name: text.mode }), choice);
			change(
				row.getByRole("spinbutton", {
					name: choice === "template" ? text.heightHint : text.height,
				}),
				index === 0 ? "" : String([0, 320, 576, 768][index]),
			);
			if (choice !== "fixed-range") {
				expect(
					row.queryByRole("spinbutton", { name: text.minimum }),
				).toBeNull();
				expect(
					row.queryByRole("spinbutton", { name: text.maximum }),
				).toBeNull();
			} else {
				change(row.getByRole("spinbutton", { name: text.minimum }), "2000");
				change(row.getByRole("spinbutton", { name: text.maximum }), "2800");
			}
		}
		expect(
			screen.queryByLabelText(
				/Lower automatic|下位の自動段|Upper rendition candidates|上位段の候補/,
			),
		).toBeNull();
		click(text.next);
		const proposed = api(text);
		expect(proposed.streams).toHaveLength(4);
		expect(
			proposed.streams
				.filter((row: { mode: string }) => row.mode === "PER_TITLE_TEMPLATE")
				.map((row: { height?: number }) => row.height)
				.sort(),
		).toEqual([320, undefined]);
		expect(
			proposed.streams.find(
				(row: { mode: string }) =>
					row.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			),
		).toMatchObject({ height: 576 });
		expect(
			proposed.streams.find(
				(row: { mode: string }) =>
					row.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
			),
		).toMatchObject({
			height: 768,
			perTitleSettings: { minBitrate: 2_000_000, maxBitrate: 2_800_000 },
		});
		click(text.complete);
		expect(onComplete).toHaveBeenCalledOnce();
	});

	it("shows the same Stream selector for an encoder-selected configuration", () => {
		const { text } = mount("en");
		click(text.next);
		const row = within(screen.getByRole("group", { name: text.row(1) }));
		expect(row.getByRole("combobox", { name: text.mode })).toHaveValue(
			"template",
		);
		expect(row.getByRole("spinbutton", { name: text.heightHint })).toHaveValue(
			null,
		);
		change(row.getByRole("spinbutton", { name: text.heightHint }), "480");
		click(text.next);
		expect(api(text).streams).toMatchObject([
			{ mode: "PER_TITLE_TEMPLATE", height: 480 },
		]);
		click(text.back);
		const same = within(screen.getByRole("group", { name: text.row(1) }));
		change(same.getByRole("spinbutton", { name: text.heightHint }), "");
		click(text.next);
		expect(api(text).streams[0]).not.toHaveProperty("height");
		expect(api(text).streams[0]).not.toHaveProperty("width");
	});
});
