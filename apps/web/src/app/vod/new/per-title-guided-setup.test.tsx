import type { PerTitleCodec, PerTitleGoal } from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleGuidedSetup } from "./per-title-guided-setup";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";
import { buildPerTitleStreamSetup } from "./per-title-stream-setup-model";

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
		mode: "Stream mode",
		height: "Height (px)",
		heightHint: "Height hint (px, optional)",
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
		mode: "Streamモード",
		height: "高さ (px)",
		heightHint: "高さのヒント (px・任意)",
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

function addTemplateRows(
	locale: "en" | "ja",
	text: (typeof copy)["en"],
	heights: readonly number[],
) {
	return heights.map((height) => {
		const count = screen.getAllByRole("group", {
			name: locale === "ja" ? /^レンディション \d+$/ : /^Rendition \d+$/,
		}).length;
		click(text.add);
		const row = screen.getByRole("group", {
			name:
				locale === "ja"
					? `レンディション ${count + 1}`
					: `Rendition ${count + 1}`,
		});
		fireEvent.change(within(row).getByRole("combobox", { name: text.mode }), {
			target: { value: "template" },
		});
		fireEvent.change(
			within(row).getByRole("spinbutton", { name: text.heightHint }),
			{
				target: { value: String(height) },
			},
		);
		return row;
	});
}

describe("PerTitleGuidedSetup", () => {
	it.each(
		(["H264", "H265", "VP9"] as const).flatMap((codec) =>
			(["en", "ja"] as const).map((locale) => [locale, codec] as const),
		),
	)("calculates empty bitrate bands and explains unmeasured source conditions (%s, %s)", (locale, codec) => {
		const { text, onComplete } = mount(locale);
		fireEvent.click(screen.getByRole("radio", { name: text.strategies[4] }));
		click(text.next);
		fireEvent.change(screen.getByRole("combobox", { name: text.codec }), {
			target: { value: codec },
		});
		for (const [name, value] of [
			[text.minimum, "160"],
			[text.maximum, "5000"],
			[
				locale === "ja"
					? "入力の高さ (px・任意)"
					: "Source height (px, optional)",
				"1152",
			],
		] as const)
			fireEvent.change(screen.getByRole("spinbutton", { name }), {
				target: { value },
			});
		click(text.add);
		for (const [index, height] of [320, 320, 576, 768].entries()) {
			const row = screen.getByRole("group", {
				name:
					locale === "ja"
						? `レンディション ${index + 1}`
						: `Rendition ${index + 1}`,
			});
			fireEvent.change(
				within(row).getByRole("spinbutton", { name: text.height }),
				{
					target: { value: String(height) },
				},
			);
			expect(
				within(row).getByRole("spinbutton", { name: text.rowMinimum }),
			).toHaveValue(null);
			expect(
				within(row).getByRole("spinbutton", { name: text.rowMaximum }),
			).toHaveValue(null);
		}
		addTemplateRows(locale, text, [160, 960, 1152]);
		expect(screen.getByRole("button", { name: text.next })).toBeEnabled();
		click(text.next);
		expect(
			screen.getAllByRole("region", {
				name: locale === "ja" ? "作成する設定" : "Proposed configuration",
			}),
		).toHaveLength(1);
		expect(
			screen.getByText(
				locale === "ja"
					? "入力した条件からビットレート幅を計算しました。"
					: "Bitrate ranges calculated from your requirements.",
			),
		).toBeVisible();
		const apiElement = screen
			.getByText(text.api)
			.closest("details")
			?.querySelector("pre");
		if (!apiElement) throw new Error("Missing calculated API settings");
		const api = JSON.parse(apiElement.textContent ?? "{}");
		expect(api.streams).toHaveLength(7);
		const fixed = api.streams.filter(
			(row: { mode: string }) =>
				row.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
		);
		expect(fixed.map((row: { height: number }) => row.height)).toEqual([
			320, 320, 576, 768,
		]);
		for (const row of fixed) {
			expect(Number.isSafeInteger(row.perTitleSettings.minBitrate)).toBe(true);
			expect(Number.isSafeInteger(row.perTitleSettings.maxBitrate)).toBe(true);
			expect(row.perTitleSettings.minBitrate).toBeGreaterThanOrEqual(160000);
			expect(row.perTitleSettings.maxBitrate).toBeGreaterThan(
				row.perTitleSettings.minBitrate,
			);
			expect(row.perTitleSettings.maxBitrate).toBeLessThanOrEqual(5000000);
		}
		expect(onComplete).not.toHaveBeenCalled();
		click(text.complete);
		expect(onComplete).toHaveBeenCalledOnce();
		const goal = onComplete.mock.calls[0]?.[0] as PerTitleGoal | undefined;
		if (!goal) throw new Error("Missing completed setup");
		expect(goal.countPolicy).toEqual({ kind: "exact", count: 6 });
		expect(goal.adjustments).toBeUndefined();
		const proposal = tunePerTitleSettings(goal, goal).proposal;
		expect(proposal.api).toEqual(api);
		expect(proposal).toMatchObject({
			status: "candidate",
			applicable: true,
			countGuarantee: false,
		});
		const conditions =
			proposal.derivation?.constraints?.conditionalModel?.sourceConditions;
		if (!conditions) throw new Error("Missing typed source conditions");
		expect(conditions.lowerProbe.status).toBe("not-measured");
		expect(conditions.geometry.status).toBe("not-measured");
		expect(conditions.geometry.postRoundingWidthOrderPreserved.status).toBe(
			"not-measured",
		);
		expect(conditions.fixedProbeOrder.status).toBe("not-measured");
		const sourceLabel =
			locale === "ja" ? "素材で未確認の条件" : "Unmeasured source conditions";
		const source = screen.getByRole("region", { name: sourceLabel });
		const reasoning = screen.getByText(
			locale === "ja" ? "設定の根拠" : "Why these settings",
		);
		expect(reasoning.closest("details")).not.toHaveAttribute("open");
		expect(source).not.toBeVisible();
		fireEvent.click(reasoning);
		expect(reasoning.closest("details")).toHaveAttribute("open");
		expect(source).toBeVisible();
		const format = (value: number) =>
			new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(
				value / 1000,
			);
		expect(source).toHaveTextContent(
			`${format(conditions.lowerProbe.minimum)}–${format(conditions.lowerProbe.maximum)} kbps`,
		);
		expect(source).toHaveTextContent(
			locale === "ja"
				? "出力のビットレート制限ではありません"
				: "not an output bitrate limit",
		);
		expect(source).toHaveTextContent(
			locale === "ja" ? "縦横比" : "aspect ratio",
		);
		expect(source).toHaveTextContent(
			locale === "ja"
				? "丸め後の幅も、指定した解像度の順序と同じ解像度の組を保つ前提です。素材では未確認です。"
				: "Rounded widths must preserve the requested resolution order and groups at the same resolution; this has not been verified.",
		);
		expect(source).toHaveTextContent(
			locale === "ja" ? "同じ解像度" : "same resolution",
		);
		expect(source).not.toHaveTextContent("setup-lower");
		expect(source).not.toHaveTextContent("setup-row-");
	});

	it.each([
		"en",
		"ja",
	] as const)("keeps seven Stream templates separate from six conditional outputs (%s)", (locale) => {
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
		for (const row of addTemplateRows(locale, text, [176, 880, 1056])) {
			expect(
				within(row).getByRole("combobox", { name: text.mode }),
			).toHaveValue("template");
			expect(
				within(row).queryByRole("spinbutton", { name: text.rowMinimum }),
			).toBeNull();
			expect(
				within(row).queryByRole("spinbutton", { name: text.rowMaximum }),
			).toBeNull();
		}
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
			screen.queryByText(/requested upper output|上位の希望本数/),
		).toBeNull();
		const apiElement = screen
			.getByText(text.api)
			.closest("details")
			?.querySelector("pre");
		if (!apiElement) throw new Error("The proposed API settings are missing");
		const api = JSON.parse(apiElement.textContent ?? "{}");
		expect(api.streams).toHaveLength(7);
		expect(
			api.global.fixedResolutionAndBitrateConfiguration
				.forcedRenditionAboveHighestFixedRepresentation,
		).toBe(1);
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
		["en", "0.5"],
		["ja", "0"],
		["en", "-1"],
		["ja", "1056.5"],
	] as const)("keeps an invalid ordinary Stream height visible and blocks review (%s, %s)", (locale, value) => {
		const { text, onComplete } = mount(locale);
		fireEvent.click(screen.getByRole("radio", { name: text.strategies[4] }));
		click(text.next);
		const [row] = addTemplateRows(locale, text, [880]);
		if (!row) throw new Error("Missing ordinary Stream row");
		const height = within(row).getByRole("spinbutton", {
			name: text.heightHint,
		});
		fireEvent.change(height, { target: { value } });
		expect(height).toHaveValue(Number(value));
		expect(screen.getByRole("button", { name: text.next })).toBeDisabled();
		expect(screen.getByRole("alert")).toHaveTextContent(text.heightHint);
		expect(onComplete).not.toHaveBeenCalled();
	});

	it.each([
		"en",
		"ja",
	] as const)("resets explicit Stream rows when switching to the automatic setup (%s)", (locale) => {
		const { text, onComplete } = mount(locale);
		fireEvent.click(screen.getByRole("radio", { name: text.strategies[4] }));
		click(text.next);
		const [, invalid] = addTemplateRows(locale, text, [176, 880]);
		if (!invalid) throw new Error("Missing ordinary Stream row");
		fireEvent.change(
			within(invalid).getByRole("spinbutton", { name: text.heightHint }),
			{
				target: { value: "0" },
			},
		);
		expect(screen.getByRole("button", { name: text.next })).toBeDisabled();
		click(text.back);
		fireEvent.click(screen.getByRole("radio", { name: text.strategies[0] }));
		click(text.next);
		expect(
			screen.getAllByRole("group", {
				name: locale === "ja" ? /^レンディション \d+$/ : /^Rendition \d+$/,
			}),
		).toHaveLength(1);
		expect(screen.getByRole("combobox", { name: text.mode })).toHaveValue(
			"template",
		);
		expect(screen.queryByRole("spinbutton", { name: text.height })).toBeNull();
		expect(
			screen.getByRole("spinbutton", { name: text.heightHint }),
		).toHaveValue(null);
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
		const expected = buildPerTitleStreamSetup(
			{
				strategy: "automatic",
				codec: "H264",
				minBitrate: 150_000,
				maxBitrate: 6_000_000,
				inputHeight: 1080,
				streams: [{ id: "setup-row-1", mode: "PER_TITLE_TEMPLATE" }],
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
	] as const)("distinguishes specified Stream templates from an optional output count (%s)", (locale) => {
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
				locale === "ja" ? "Streamテンプレート：4件" : "Stream templates: 4",
				{ selector: "p" },
			),
		).toBeVisible();
		expect(
			screen.queryByText(/Requested video outputs:|希望する映像出力数：/),
		).toBeNull();
		const apiElement = screen
			.getByText(text.api)
			.closest("details")
			?.querySelector("pre");
		if (!apiElement) throw new Error("Missing proposed Stream settings");
		const api = JSON.parse(apiElement.textContent ?? "{}");
		expect(
			api.streams.filter(
				(row: { mode: string }) =>
					row.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			),
		).toHaveLength(3);
		const templates = api.streams.filter(
			(row: { mode: string }) => row.mode === "PER_TITLE_TEMPLATE",
		);
		expect(templates).toHaveLength(1);
		expect(templates[0].height).toBeUndefined();
		expect(templates[0].width).toBeUndefined();
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
		expect(screen.queryAllByRole("textbox")).toEqual([]);
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
			within(screen.getByRole("group", { name: "Rendition 1" })).getByRole(
				"spinbutton",
				{ name: text.height },
			),
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
