import type { PerTitleCodec, PerTitleGoal } from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleGuidedSetup } from "./per-title-guided-setup";
import { buildPerTitleSetup } from "./per-title-guided-setup-model";

const initialGoal: PerTitleGoal = {
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 150_000,
	maxBitrate: 4_000_000,
	inputHeight: 1080,
	countPolicy: { kind: "exact", count: 9 },
	rows: [
		{
			id: "existing-row",
			height: 270,
			minBitrate: 200_000,
			maxBitrate: 300_000,
		},
	],
	targetQualityCrf: 27,
	fixedResolutionAndBitrateConfiguration: {
		forcedRenditionAboveHighestFixedRepresentation: 3,
	},
	settingLocks: { global: ["maxBitrate"] },
};
const codecs: readonly PerTitleCodec[] = ["H264", "H265", "VP9", "AV1"];
const copy = {
	en: {
		next: "Next",
		back: "Back",
		cancel: "Cancel",
		complete: "Inspect in simulator",
		minimum: "Minimum bitrate (kbps)",
		maximum: "Maximum bitrate (kbps)",
		codec: "Video codec",
		count: "Requested video outputs",
		lowerHeight: "Lower automatic rendition height (px, optional)",
		upperHeights: "Upper rendition candidates (px, optional)",
		height: "Height (px)",
		rowMinimum: "Minimum bitrate (kbps, optional)",
		rowMaximum: "Maximum bitrate (kbps, optional)",
		add: "Add rendition",
		api: "API settings",
		conditions: "Requirements",
		review: "Review",
		strategies: [
			"Let the encoder choose",
			"Specify only the count",
			"Require some resolutions",
			"Specify every resolution",
			"Specify resolutions and bitrate ranges",
		],
	},
	ja: {
		next: "次へ",
		back: "戻る",
		cancel: "キャンセル",
		complete: "シミュレーターで確認",
		minimum: "最小ビットレート (kbps)",
		maximum: "最大ビットレート (kbps)",
		codec: "映像コーデック",
		count: "希望する映像出力数",
		lowerHeight: "下位の自動段の高さ (px・任意)",
		upperHeights: "上位段の候補 (px・任意)",
		height: "高さ (px)",
		rowMinimum: "最小ビットレート (kbps・任意)",
		rowMaximum: "最大ビットレート (kbps・任意)",
		add: "レンディションを追加",
		api: "API 設定",
		conditions: "条件",
		review: "確認",
		strategies: [
			"すべて任せる",
			"本数だけ指定",
			"必要な解像度だけ指定",
			"解像度をすべて指定",
			"解像度とビットレート幅を指定",
		],
	},
};

function mount(locale: "en" | "ja" = "en", allowedCodecs = codecs) {
	const onComplete = vi.fn();
	const onCancel = vi.fn();
	const view = renderLocalized(
		<PerTitleGuidedSetup
			initialGoal={initialGoal}
			allowedCodecs={allowedCodecs}
			onComplete={onComplete}
			onCancel={onCancel}
		/>,
		locale,
	);
	return { ...view, onComplete, onCancel, text: copy[locale] };
}

const click = (name: string) =>
	fireEvent.click(screen.getByRole("button", { name }));

describe("PerTitleGuidedSetup", () => {
	it.each([
		"en",
		"ja",
	] as const)("builds a fresh mixed ladder with one upper choice rather than counting its templates (%s)", (locale) => {
		const { text, onComplete } = mount(locale);
		fireEvent.click(screen.getByRole("radio", { name: text.strategies[4] }));
		click(text.next);
		click(text.add);
		const requested = [
			[320, 250, 320],
			[320, 380, 560],
			[560, 900, 1300],
			[704, 1700, 2500],
		] as const;
		for (const [index, values] of requested.entries()) {
			const group = screen.getByRole("group", {
				name:
					locale === "ja"
						? `レンディション ${index + 1}`
						: `Rendition ${index + 1}`,
			});
			for (const [name, value] of [
				[text.height, values[0]],
				[text.rowMinimum, values[1]],
				[text.rowMaximum, values[2]],
			] as const)
				fireEvent.change(within(group).getByRole("spinbutton", { name }), {
					target: { value: String(value) },
				});
		}
		fireEvent.change(
			screen.getByRole("spinbutton", { name: text.lowerHeight }),
			{
				target: { value: "176" },
			},
		);
		fireEvent.change(screen.getByRole("textbox", { name: text.upperHeights }), {
			target: { value: "880, 1056" },
		});
		expect(
			screen.getByRole("textbox", { name: text.upperHeights }),
		).toHaveAccessibleDescription(
			locale === "ja"
				? "上位1段の候補となる高さをカンマで区切ります。"
				: "Separate heights with commas; choose candidates for one upper output.",
		);
		expect(screen.getByRole("button", { name: text.next })).toBeEnabled();
		const firstMinimum = within(
			screen.getByRole("group", {
				name: locale === "ja" ? "レンディション 1" : "Rendition 1",
			}),
		).getByRole("spinbutton", { name: text.rowMinimum });
		fireEvent.change(firstMinimum, { target: { value: "190" } });
		expect(firstMinimum).toHaveValue(190);
		expect(screen.getByRole("button", { name: text.next })).toBeDisabled();
		expect(screen.getByRole("alert")).toBeVisible();
		fireEvent.change(firstMinimum, { target: { value: "250" } });
		expect(screen.getByRole("button", { name: text.next })).toBeEnabled();
		click(text.next);
		expect(
			screen.getByText(
				locale === "ja"
					? "希望する映像出力数：6本"
					: "Requested video outputs: 6",
			),
		).toBeVisible();
		expect(
			screen.getByText(
				locale === "ja"
					? "上位の希望本数は、候補を合わせて1本です。実際の本数はエンコードして確認してください。"
					: "These candidates share one requested upper output. Confirm the actual count by encoding.",
			),
		).toBeVisible();
		const apiElement = screen
			.getByText(text.api)
			.closest("details")
			?.querySelector("pre");
		if (!apiElement) throw new Error("The proposed API settings are missing");
		const api = JSON.parse(apiElement.textContent ?? "{}");
		expect(api.streams).toHaveLength(7);
		expect(
			api.streams
				.filter((row: { mode: string }) => row.mode === "PER_TITLE_TEMPLATE")
				.map((row: { height: number }) => row.height),
		).toEqual([176, 880, 1056]);
		expect(
			api.streams.filter(
				(row: { mode: string }) =>
					row.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
			),
		).toHaveLength(4);
		expect(onComplete).not.toHaveBeenCalled();
		click(text.complete);
		const goal = onComplete.mock.calls[0]?.[0] as PerTitleGoal | undefined;
		expect(goal?.countPolicy).toEqual({ kind: "exact", count: 6 });
		expect(
			goal?.rows?.map((row) => [row.height, row.minBitrate, row.maxBitrate]),
		).toEqual(
			requested.map(([height, min, max]) => [height, min * 1000, max * 1000]),
		);
		expect(goal?.automaticTemplates?.map((row) => row.height)).toEqual([
			176, 880, 1056,
		]);
	});

	it.each([
		["en", "880, invalid, 1056"],
		["ja", "880,,1056"],
		["en", "880,"],
		["ja", "880, 1056.5"],
	] as const)("keeps malformed upper candidates visible and blocks review (%s, %s)", (locale, value) => {
		const { text, onComplete } = mount(locale);
		fireEvent.click(screen.getByRole("radio", { name: text.strategies[4] }));
		click(text.next);
		fireEvent.change(screen.getByRole("textbox", { name: text.upperHeights }), {
			target: { value },
		});
		expect(
			screen.getByRole("textbox", { name: text.upperHeights }),
		).toHaveValue(value);
		expect(screen.getByRole("button", { name: text.next })).toBeDisabled();
		expect(screen.getByRole("alert")).toHaveTextContent(text.upperHeights);
		expect(onComplete).not.toHaveBeenCalled();
	});

	it.each([
		"en",
		"ja",
	] as const)("omits inactive automatic edges when switching setup strategy (%s)", (locale) => {
		const { text, onComplete } = mount(locale);
		fireEvent.click(screen.getByRole("radio", { name: text.strategies[4] }));
		click(text.next);
		fireEvent.change(
			screen.getByRole("spinbutton", { name: text.lowerHeight }),
			{
				target: { value: "176" },
			},
		);
		fireEvent.change(screen.getByRole("textbox", { name: text.upperHeights }), {
			target: { value: "invalid" },
		});
		click(text.back);
		fireEvent.click(screen.getByRole("radio", { name: text.strategies[0] }));
		click(text.next);
		expect(
			screen.queryByRole("textbox", { name: text.upperHeights }),
		).toBeNull();
		expect(
			screen.queryByRole("spinbutton", { name: text.lowerHeight }),
		).toBeNull();
		expect(screen.getByRole("button", { name: text.next })).toBeEnabled();
		click(text.next);
		click(text.complete);
		expect(onComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				strategy: "automatic",
				countPolicy: { kind: "unrestricted" },
			}),
		);
		expect(onComplete.mock.calls[0]?.[0].automaticTemplates).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ height: 176 })]),
		);
	});

	it("blocks a global minimum below ten kbps", () => {
		const { text } = mount();
		click(text.next);
		fireEvent.change(screen.getByRole("spinbutton", { name: text.minimum }), {
			target: { value: "9.999" },
		});
		expect(screen.getByRole("button", { name: text.next })).toBeDisabled();
		expect(
			screen.getByRole("spinbutton", { name: text.minimum }),
		).toHaveAttribute("min", "10");
	});
	it.each([
		"10.001",
		"10.0010",
		"10.001e0",
	])("preserves an exact integer bitrate entered as %s kbps", (minimum) => {
		const { text, onComplete } = mount();
		click(text.next);
		fireEvent.change(screen.getByRole("spinbutton", { name: text.minimum }), {
			target: { value: minimum },
		});
		fireEvent.change(screen.getByRole("spinbutton", { name: text.maximum }), {
			target: { value: "10.009" },
		});
		expect(screen.getByRole("button", { name: text.next })).toBeEnabled();
		click(text.next);
		click(text.complete);
		expect(onComplete).toHaveBeenCalledWith(
			expect.objectContaining({ minBitrate: 10001, maxBitrate: 10009 }),
		);
	});

	it.each([
		"10.0001",
		"10.0000000000000001",
	])("rejects genuinely fractional bits/s entered as %s kbps", (minimum) => {
		const { text, onComplete } = mount();
		click(text.next);
		fireEvent.change(screen.getByRole("spinbutton", { name: text.minimum }), {
			target: { value: minimum },
		});
		expect(screen.getByRole("button", { name: text.next })).toBeDisabled();
		expect(onComplete).not.toHaveBeenCalled();
	});

	it("preserves exact row limits without rounding fractional bits/s", () => {
		const { text, onComplete } = mount();
		fireEvent.click(screen.getByRole("radio", { name: text.strategies[4] }));
		click(text.next);
		fireEvent.change(screen.getByRole("spinbutton", { name: text.minimum }), {
			target: { value: "10" },
		});
		fireEvent.change(screen.getByRole("spinbutton", { name: text.maximum }), {
			target: { value: "100" },
		});
		click("Remove rendition 3");
		click("Remove rendition 2");
		const minimum = screen.getByRole("spinbutton", {
			name: "Minimum bitrate (kbps, optional)",
		});
		fireEvent.change(minimum, { target: { value: "10.001" } });
		fireEvent.change(
			screen.getByRole("spinbutton", {
				name: "Maximum bitrate (kbps, optional)",
			}),
			{ target: { value: "10.009" } },
		);
		expect(screen.getByRole("button", { name: text.next })).toBeEnabled();
		fireEvent.change(minimum, { target: { value: "10.0000000000000001" } });
		expect(screen.getByRole("button", { name: text.next })).toBeDisabled();
		fireEvent.change(minimum, { target: { value: "10.001" } });
		click(text.next);
		click(text.complete);
		expect(onComplete.mock.calls[0]?.[0].rows).toEqual([
			expect.objectContaining({ minBitrate: 10001, maxBitrate: 10009 }),
		]);
	});

	it.each([
		"en",
		"ja",
	] as const)("starts with five simple choices and no technical controls (%s)", (locale) => {
		const { text } = mount(locale);
		expect(screen.getAllByRole("radio")).toHaveLength(5);
		for (const name of text.strategies)
			expect(screen.getByRole("radio", { name })).toBeVisible();
		expect(screen.queryByRole("spinbutton")).toBeNull();
		expect(document.querySelector('[aria-current="step"]')).toHaveTextContent(
			locale === "ja" ? "設定方法" : "Choose a setup",
		);
		click(text.next);
		expect(document.querySelector('[aria-current="step"]')).toHaveTextContent(
			text.conditions,
		);
		expect(screen.getByRole("spinbutton", { name: text.minimum })).toHaveValue(
			150,
		);
		expect(screen.getByRole("spinbutton", { name: text.maximum })).toHaveValue(
			4000,
		);
		expect(
			screen.queryByText(
				/minBitrateStepSize|complexityFactor|forcedRendition|COMPLEXITY_RANGE/,
			),
		).toBeNull();
	});

	it.each([
		"en",
		"ja",
	] as const)("loads one fresh proposal only after explicit confirmation (%s)", (locale) => {
		const { text, onComplete } = mount(locale);
		click(text.next);
		fireEvent.change(screen.getByRole("spinbutton", { name: text.maximum }), {
			target: { value: "6000" },
		});
		click(text.next);
		expect(document.querySelector('[aria-current="step"]')).toHaveTextContent(
			text.review,
		);
		expect(onComplete).not.toHaveBeenCalled();
		const expected = buildPerTitleSetup(
			{
				strategy: "automatic",
				codec: "H264",
				minBitrate: 150_000,
				maxBitrate: 6_000_000,
				inputHeight: 1080,
				rows: [],
			},
			codecs,
		);
		expect(expected.goal).not.toBeNull();
		const details = screen
			.getByText(locale === "ja" ? "API 設定" : "API settings")
			.closest("details");
		expect(details).not.toHaveAttribute("open");
		expect(
			screen.getByText(
				locale === "ja"
					? "本数と画質は、素材をエンコードして確認してください。"
					: "Confirm output count and quality by encoding your source.",
			),
		).toBeVisible();
		click(text.complete);
		click(text.complete);
		expect(onComplete).toHaveBeenCalledOnce();
		expect(onComplete).toHaveBeenCalledWith(expected.goal);
		expect(onComplete.mock.calls[0]?.[0]).not.toHaveProperty("settingLocks");
		expect(onComplete.mock.calls[0]?.[0]).not.toHaveProperty(
			"targetQualityCrf",
		);
		expect(onComplete.mock.calls[0]?.[0]).not.toHaveProperty(
			"fixedResolutionAndBitrateConfiguration",
		);
	});

	it.each([
		{ strategy: "required-resolutions", choice: 2 },
		{ strategy: "fixed-resolutions", choice: 3 },
		{ strategy: "fixed-ranges", choice: 4 },
	] as const)("inspects editable fresh rows for $strategy", ({
		strategy,
		choice,
	}) => {
		const { text, onComplete } = mount();
		fireEvent.click(
			screen.getByRole("radio", { name: text.strategies[choice] }),
		);
		click(text.next);
		if (strategy === "required-resolutions")
			expect(
				screen.getByRole("spinbutton", {
					name: "Requested video outputs (optional)",
				}),
			).toHaveValue(null);
		click(text.next);
		expect(
			screen.getByRole("region", { name: "Proposed configuration" }),
		).toBeVisible();
		expect(onComplete).not.toHaveBeenCalled();
		click(text.complete);
		expect(onComplete).toHaveBeenCalledOnce();
		const goal = onComplete.mock.calls[0]?.[0] as PerTitleGoal;
		expect(goal.strategy).toBe(strategy);
		expect(goal.rows?.map((row) => row.height)).toEqual([360, 720, 1080]);
		expect(goal.countPolicy).toEqual(
			strategy === "required-resolutions"
				? { kind: "unrestricted" }
				: { kind: "exact", count: 3 },
		);
		if (strategy === "fixed-ranges")
			for (const row of goal.rows ?? []) {
				expect(row.minBitrate).toBeGreaterThanOrEqual(goal.minBitrate);
				expect(row.maxBitrate).toBeLessThanOrEqual(goal.maxBitrate);
				expect(row.bitrateSelectionMode).toBe("COMPLEXITY_RANGE");
			}
	});

	it.each([
		"en",
		"ja",
	] as const)("labels the requested count as video outputs (%s)", (locale) => {
		const { text } = mount(locale);
		fireEvent.click(screen.getByRole("radio", { name: text.strategies[1] }));
		click(text.next);
		fireEvent.change(screen.getByRole("spinbutton", { name: text.count }), {
			target: { value: "4" },
		});
		click(text.next);
		expect(
			screen.getByText(
				locale === "ja"
					? "希望する映像出力数：4本"
					: "Requested video outputs: 4",
			),
		).toBeVisible();
	});

	it.each([
		"en",
		"ja",
	] as const)("distinguishes required renditions from an optional output count (%s)", (locale) => {
		const { text } = mount(locale);
		fireEvent.click(screen.getByRole("radio", { name: text.strategies[2] }));
		click(text.next);
		expect(
			screen.getByRole("spinbutton", {
				name:
					locale === "ja"
						? "希望する映像出力数（任意）"
						: "Requested video outputs (optional)",
			}),
		).toHaveValue(null);
		click(text.next);
		expect(
			screen.getByText(
				locale === "ja"
					? "必須のレンディション（3本）"
					: "Required renditions: 3",
			),
		).toBeVisible();
	});

	it("preserves edits when going back and never completes on cancellation", () => {
		const { text, onComplete, onCancel } = mount();
		fireEvent.click(screen.getByRole("radio", { name: text.strategies[1] }));
		click(text.next);
		fireEvent.change(screen.getByRole("spinbutton", { name: text.count }), {
			target: { value: "4" },
		});
		fireEvent.change(screen.getByRole("spinbutton", { name: text.maximum }), {
			target: { value: "5500" },
		});
		click(text.back);
		expect(
			screen.getByRole("radio", { name: text.strategies[1] }),
		).toBeChecked();
		click(text.next);
		expect(screen.getByRole("spinbutton", { name: text.count })).toHaveValue(4);
		expect(screen.getByRole("spinbutton", { name: text.maximum })).toHaveValue(
			5500,
		);
		click(text.cancel);
		expect(onCancel).toHaveBeenCalledOnce();
		expect(onComplete).not.toHaveBeenCalled();
	});

	it.each([
		"",
		"-1",
		"8000",
	])("blocks an invalid global minimum %j with a correction message", (value) => {
		const { text, onComplete } = mount();
		click(text.next);
		fireEvent.change(screen.getByRole("spinbutton", { name: text.minimum }), {
			target: { value },
		});
		expect(screen.getByRole("alert")).toBeVisible();
		expect(screen.getByRole("button", { name: text.next })).toBeDisabled();
		click(text.next);
		expect(screen.queryByRole("button", { name: text.complete })).toBeNull();
		expect(onComplete).not.toHaveBeenCalled();
	});

	it("requires a valid count and drops it when the user switches to automatic", () => {
		const { text, onComplete } = mount();
		fireEvent.click(screen.getByRole("radio", { name: text.strategies[1] }));
		click(text.next);
		const count = screen.getByRole("spinbutton", { name: text.count });
		for (const value of ["", "0", "2.5", "257"]) {
			fireEvent.change(count, { target: { value } });
			expect(screen.getByRole("alert")).toBeVisible();
			expect(screen.getByRole("button", { name: text.next })).toBeDisabled();
		}
		click(text.back);
		fireEvent.click(screen.getByRole("radio", { name: text.strategies[0] }));
		click(text.next);
		expect(screen.queryByRole("spinbutton", { name: text.count })).toBeNull();
		click(text.next);
		click(text.complete);
		expect(onComplete.mock.calls[0]?.[0].countPolicy).toEqual({
			kind: "unrestricted",
		});
	});

	it("keeps row identifiers internal and allows duplicate heights to be edited", () => {
		const { text } = mount();
		fireEvent.click(screen.getByRole("radio", { name: text.strategies[4] }));
		click(text.next);
		const rows = screen.getAllByRole("group", { name: /^Rendition \d+$/ });
		expect(rows.length).toBeGreaterThan(1);
		const [firstRow, secondRow] = rows;
		if (!firstRow || !secondRow)
			throw new Error("Expected editable starter rows.");
		const firstHeight = within(firstRow).getByRole("spinbutton", {
			name: "Height (px)",
		});
		const secondHeight = within(secondRow).getByRole("spinbutton", {
			name: "Height (px)",
		});
		fireEvent.change(secondHeight, {
			target: { value: String((firstHeight as HTMLInputElement).value) },
		});
		expect(secondHeight).toHaveValue(
			Number((firstHeight as HTMLInputElement).value),
		);
		expect(
			within(firstRow).getByRole("spinbutton", {
				name: "Minimum bitrate (kbps, optional)",
			}),
		).toHaveValue(null);
		expect(screen.getAllByRole("textbox")).toEqual([
			screen.getByRole("textbox", { name: copy.en.upperHeights }),
		]);
		expect(screen.queryByDisplayValue("existing-row")).toBeNull();
		click("Add rendition");
		expect(
			screen.getAllByRole("group", { name: /^Rendition \d+$/ }),
		).toHaveLength(rows.length + 1);
		click(`Remove rendition ${rows.length + 1}`);
		expect(
			screen.getAllByRole("group", { name: /^Rendition \d+$/ }),
		).toHaveLength(rows.length);
	});

	it.each([
		"en",
		"ja",
	] as const)("identifies the row and field that need correction (%s)", (locale) => {
		const { text } = mount(locale);
		fireEvent.click(screen.getByRole("radio", { name: text.strategies[4] }));
		click(text.next);
		const row = screen.getByRole("group", {
			name: locale === "ja" ? "レンディション 2" : "Rendition 2",
		});
		const heightLabel = locale === "ja" ? "高さ (px)" : "Height (px)";
		fireEvent.change(
			within(row).getByRole("spinbutton", { name: heightLabel }),
			{ target: { value: "" } },
		);
		expect(screen.getByRole("alert")).toHaveTextContent(
			`${locale === "ja" ? "レンディション 2" : "Rendition 2"} · ${heightLabel}:`,
		);
		expect(screen.getByRole("button", { name: text.next })).toBeDisabled();
	});

	it("does not leave a stale review enabled after a row becomes invalid", () => {
		const { text, onComplete } = mount();
		fireEvent.click(screen.getByRole("radio", { name: text.strategies[3] }));
		click(text.next);
		click(text.next);
		expect(screen.getByRole("button", { name: text.complete })).toBeEnabled();
		click(text.back);
		fireEvent.change(
			screen
				.getByRole("group", { name: "Rendition 1" })
				.querySelector("input") as HTMLInputElement,
			{ target: { value: "" } },
		);
		expect(screen.getByRole("alert")).toBeVisible();
		expect(screen.getByRole("button", { name: text.next })).toBeDisabled();
		expect(onComplete).not.toHaveBeenCalled();
	});

	it("only offers codecs allowed by the current account", () => {
		const { text } = mount("en", ["H265", "AV1"]);
		click(text.next);
		const codec = screen.getByRole("combobox", { name: text.codec });
		expect(
			within(codec)
				.getAllByRole("option")
				.map((option) => option.getAttribute("value")),
		).toEqual(["H265", "AV1"]);
		expect(codec).toHaveValue("H265");
	});

	it("blocks review when the selected codec is no longer allowed", () => {
		const { rerender, text, onComplete, onCancel } = mount();
		click(text.next);
		rerender(
			<PerTitleGuidedSetup
				initialGoal={initialGoal}
				allowedCodecs={["AV1"]}
				onComplete={onComplete}
				onCancel={onCancel}
			/>,
		);
		expect(screen.getByRole("alert")).toBeVisible();
		expect(screen.getByRole("button", { name: text.next })).toBeDisabled();
		expect(onComplete).not.toHaveBeenCalled();
	});

	it("supports the strategy choices and navigation from the keyboard", async () => {
		const user = userEvent.setup();
		const { text } = mount();
		const first = screen.getByRole("radio", { name: text.strategies[0] });
		first.focus();
		await user.keyboard("{ArrowDown}");
		expect(
			screen.getByRole("radio", { name: text.strategies[1] }),
		).toBeChecked();
		screen.getByRole("button", { name: text.next }).focus();
		await user.keyboard("{Enter}");
		expect(screen.getByRole("spinbutton", { name: text.count })).toBeVisible();
		expect(
			screen.getByRole("heading", { name: text.conditions }),
		).toHaveFocus();
	});
});
