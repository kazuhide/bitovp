import { type PerTitleGoal, recommendPerTitleSettings } from "@bitovp/core";
import {
	act,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleSimulator } from "./per-title-simulator";

const initialGoal: PerTitleGoal = {
	strategy: "automatic",
	codec: "H265",
	minBitrate: 100_000,
	maxBitrate: 8_000_000,
	minBitrateStepSize: 1.5,
	maxBitrateStepSize: 1.9,
	countPolicy: { kind: "unrestricted" },
	rows: [{ id: "first", height: 360 }],
};

const codecGoals: Partial<Record<PerTitleGoal["codec"], PerTitleGoal>> = {
	H264: {
		...initialGoal,
		codec: "H264",
		strategy: "fixed-resolutions",
		rows: [{ id: "existing-avc-row", height: 360 }],
	},
	H265: {
		...initialGoal,
		codec: "H265",
		strategy: "fixed-ranges",
		minBitrate: 200_000,
		maxBitrate: 10_000_000,
		rows: [
			{
				id: "existing-hevc-row",
				height: 720,
				minBitrate: 500_000,
				maxBitrate: 2_000_000,
			},
		],
	},
};

function showCodecGoals() {
	const onApply = vi.fn();
	const onOpenChange = vi.fn();
	const goal = codecGoals.H264;
	if (!goal) throw new Error("missing H264 seed");
	const props = {
		initialGoal: goal,
		goalsByCodec: codecGoals,
		onApply,
		onOpenChange,
	};
	return {
		...renderLocalized(<PerTitleSimulator {...props} open />),
		props,
		onApply,
	};
}

function show(goal = initialGoal, locale: "en" | "ja" = "en") {
	const onApply = vi.fn();
	const onOpenChange = vi.fn();
	const result = renderLocalized(
		<PerTitleSimulator
			open
			onOpenChange={onOpenChange}
			initialGoal={goal}
			onApply={onApply}
		/>,
		locale,
	);
	return { ...result, onApply, onOpenChange };
}

describe("Per-Title simulator", () => {
	it.each([
		"en",
		"ja",
	] as const)("does not invent a required-row number for an automatic-template warning (%s)", (locale) => {
		show(
			{
				...initialGoal,
				strategy: "fixed-ranges",
				rows: [
					{
						id: "required",
						height: 480,
						minBitrate: 50000,
						maxBitrate: 200000,
					},
				],
				automaticTemplates: [
					{ id: "candidate", height: 960, minBitrate: 600000 },
				],
			},
			locale,
		);
		fireEvent.change(
			screen.getByRole("spinbutton", {
				name:
					locale === "en"
						? "Minimum bitrate (kbps), rendition 1"
						: "最小ビットレート (kbps), レンディション 1",
			}),
			{ target: { value: "50" } },
		);
		fireEvent.click(
			screen.getByText(
				locale === "en"
					? "Comparison and calculation details"
					: "比較・計算の詳細",
			),
		);
		const diagnostics = screen.getByRole("region", {
			name: locale === "en" ? "Conditions to check" : "確認が必要な条件",
		});
		const rowLabel = locale === "en" ? "Rendition" : "レンディション";
		expect(diagnostics).not.toHaveTextContent(new RegExp(`${rowLabel}\\s+0`));
		expect(diagnostics).toHaveTextContent(new RegExp(`${rowLabel}\\s+1`));
	});
	it.each([
		"en",
		"ja",
	] as const)("keeps analysis cases internal and reviews one unchanged API proposal (%s)", (locale) => {
		const goal = { ...initialGoal, scenarioFractions: [1, 0.25, 0.5] };
		const automaticGoal = { ...goal };
		delete automaticGoal.minBitrateStepSize;
		delete automaticGoal.maxBitrateStepSize;
		const expected = recommendPerTitleSettings(automaticGoal);
		const { onApply } = show(goal, locale);
		fireEvent.click(
			screen.getByText(
				locale === "en"
					? "Comparison and calculation details"
					: "比較・計算の詳細",
			),
		);
		expect(
			screen.queryByRole("region", {
				name: locale === "en" ? "Illustrative scenarios" : "仮定したシナリオ",
			}),
		).toBeNull();
		expect(screen.queryByText(locale === "en" ? /^Low\b/ : "低め")).toBeNull();
		expect(
			screen.queryByText(locale === "en" ? /^Middle\b/ : "中間"),
		).toBeNull();
		expect(screen.queryByText(locale === "en" ? /^High\b/ : "高め")).toBeNull();
		fireEvent.click(
			screen.getByRole("button", {
				name: locale === "en" ? "Review changes" : "差分を確認",
			}),
		);
		expect(onApply).toHaveBeenCalledOnce();
		expect(onApply.mock.calls[0]?.[0]).toEqual(expected);
		expect(expected.scenarios.map((scenario) => scenario.fraction)).toEqual([
			1, 0.25, 0.5,
		]);
	});

	it.each([
		"bitrate",
		"codec",
	])("discards a delayed file read after a newer %s edit", (field) => {
		const readers: DelayedReader[] = [];
		class DelayedReader {
			static LOADING = 1;
			readyState = 0;
			result = JSON.stringify({
				version: 1,
				goal: { ...initialGoal, maxBitrate: 4_000_000 },
			});
			onload?: () => void;
			onerror?: () => void;
			constructor() {
				readers.push(this);
			}
			readAsText() {
				this.readyState = 1;
			}
			abort() {
				this.readyState = 2;
			}
		}
		vi.stubGlobal("FileReader", DelayedReader);
		try {
			const { onApply } = show();
			fireEvent.change(screen.getByLabelText("Load requirements file"), {
				target: {
					files: [new File(["{}"], "slow.json", { type: "application/json" })],
				},
			});
			if (field === "bitrate")
				fireEvent.change(
					screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
					{ target: { value: "9000" } },
				);
			else
				fireEvent.change(screen.getByRole("combobox", { name: "Codec" }), {
					target: { value: "VP9" },
				});
			act(() => readers[0]?.onload?.());
			expect(
				screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
			).toHaveValue(field === "bitrate" ? 9000 : 8000);
			expect(screen.getByRole("combobox", { name: "Codec" })).toHaveValue(
				field === "codec" ? "VP9" : "H265",
			);
			expect(onApply).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("offers a verified count change that preserves required rows and waits for explicit selection", async () => {
		const { onApply } = show({
			...initialGoal,
			strategy: "fixed-resolutions",
			countPolicy: { kind: "maximum", count: 2 },
			rows: [
				{ id: "first", height: 360 },
				{ id: "second", height: 720 },
				{ id: "third", height: 1080 },
			],
		});
		expect(
			screen.getByRole("spinbutton", { name: "Desired count" }),
		).toHaveValue(2);
		const rationale = screen.getByText(
			"Keep every required rendition and raise the count goal to accommodate them.",
		);
		expect(rationale).not.toBeVisible();
		fireEvent.click(screen.getByText("Why these settings"));
		expect(rationale).toBeVisible();
		expect(onApply).not.toHaveBeenCalled();
		await userEvent
			.setup()
			.click(screen.getByRole("button", { name: "Use 3 renditions" }));
		expect(
			screen.getByRole("spinbutton", { name: "Desired count" }),
		).toHaveValue(3);
		expect(
			screen.getByRole("spinbutton", { name: "Height (px), rendition 3" }),
		).toHaveValue(1080);
		expect(onApply).not.toHaveBeenCalled();
		expect(
			screen.getByRole("button", { name: "Review changes" }),
		).toBeEnabled();
	});

	it("edits automatic candidates separately from required bitrate ranges", async () => {
		const { onApply } = show({
			...initialGoal,
			strategy: "fixed-ranges",
			rows: [
				{
					id: "required",
					height: 480,
					minBitrate: 200_000,
					maxBitrate: 600_000,
				},
			],
		});
		const user = userEvent.setup();
		await user.click(
			screen.getByRole("button", { name: "Add automatic template" }),
		);
		fireEvent.change(
			screen.getByRole("spinbutton", {
				name: "Height (px, optional), automatic template 1",
			}),
			{ target: { value: "1080" } },
		);
		expect(
			screen.queryByRole("spinbutton", {
				name: "Minimum bitrate (kbps), automatic template 1",
			}),
		).toBeNull();
		expect(
			screen.queryByRole("spinbutton", {
				name: "Maximum bitrate (kbps), automatic template 1",
			}),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: "Review changes" }),
		).toBeDisabled();
		expect(onApply).not.toHaveBeenCalled();
		const api = JSON.parse(
			screen.getByTestId("per-title-api-settings").textContent ?? "",
		);
		expect(api.global.autoRepresentations).toEqual({});
		expect(api.streams).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					rowId: "required",
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
					height: 480,
					perTitleSettings: expect.objectContaining({
						minBitrate: 200_000,
						maxBitrate: 600_000,
					}),
				}),
				expect.objectContaining({
					mode: "PER_TITLE_TEMPLATE",
					height: 1080,
				}),
			]),
		);
		expect(
			api.streams.find(
				(stream: { mode: string }) => stream.mode === "PER_TITLE_TEMPLATE",
			),
		).not.toHaveProperty("perTitleSettings");
		await user.click(screen.getByText("Comparison and calculation details"));
		const counts = screen.getByRole("table", {
			name: "Requirements by resolution",
		});
		expect(within(counts).queryByRole("row", { name: /1080/ })).toBeNull();
	});

	it("loads a local mixed reference for comparison and retains its original settings after editing", async () => {
		const { onApply } = show();
		const user = userEvent.setup();
		const reference = {
			codec: "H265",
			global: {
				minBitrate: 100_000,
				maxBitrate: 6_000_000,
				fixedResolutionAndBitrateConfiguration: {
					forcedRenditionAboveHighestFixedRepresentation: 1,
				},
			},
			streams: [
				{
					id: "reference-fixed",
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
					height: 480,
					perTitleSettings: {
						minBitrate: 200_000,
						maxBitrate: 600_000,
						bitrateSelectionMode: "OPTIMIZED",
					},
				},
				{
					id: "reference-auto",
					mode: "PER_TITLE_TEMPLATE",
					height: 1080,
					bitrate: null,
				},
			],
		};
		await user.upload(
			screen.getByLabelText("Load requirements file"),
			new File(
				[JSON.stringify({ version: 1, reference })],
				"local-reference.json",
				{ type: "application/json" },
			),
		);
		await waitFor(() =>
			expect(screen.getByText("Requirements loaded.")).toBeVisible(),
		);
		expect(screen.getByText("Comparison only")).toBeVisible();
		const recommendation = screen.getByRole("region", {
			name: "Recommended settings",
		});
		expect(
			within(within(recommendation).getByRole("status")).getByText(
				"Not established",
			),
		).toBeVisible();
		expect(
			screen.getByText("Parameter derivation").closest("details"),
		).not.toHaveAttribute("open");
		expect(
			screen.getByText("Joint conditions not established"),
		).not.toBeVisible();
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Minimum bitrate (kbps)" }),
			{ target: { value: "7000" } },
		);
		expect(screen.getByText("Comparison only")).toBeVisible();
		expect(screen.getByText("Needs adjustment")).toBeVisible();
		expect(
			screen.getByRole("button", { name: "Review changes" }),
		).toBeDisabled();
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Minimum bitrate (kbps)" }),
			{ target: { value: "100" } },
		);
		const referenceHint = screen.getByText(
			/This reference includes template and quality settings/,
		);
		expect(referenceHint).not.toBeVisible();
		expect(
			screen.getByRole("spinbutton", { name: "Height (px), rendition 1" }),
		).toHaveValue(480);
		expect(
			screen.getByRole("spinbutton", {
				name: "Height (px, optional), automatic template 1",
			}),
		).toHaveValue(1080);
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
			{ target: { value: "10000" } },
		);
		await user.click(screen.getByText("Comparison and calculation details"));
		expect(referenceHint).toBeVisible();
		const table = screen.getByRole("table", { name: "Compare settings" });
		expect(
			within(table).getByRole("row", {
				name: "Maximum bitrate (kbps) 6,000 10,000",
			}),
		).toBeVisible();
		expect(
			screen.queryByRole("checkbox", {
				name: "Include original additional-rendition rules",
			}),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: "Review changes" }),
		).toBeDisabled();
		await user.selectOptions(
			screen.getByRole("combobox", { name: "Codec" }),
			"AV1",
		);
		expect(screen.getByRole("combobox", { name: "Codec" })).toHaveValue("H265");
		expect(screen.getByRole("alert")).toHaveTextContent(
			"A reference file cannot be converted to another codec here.",
		);
		expect(screen.queryByText("Original template settings")).toBeNull();
		const createObjectURL = vi.fn((_blob: Blob) => "blob:requirements");
		const originalUrl = URL;
		vi.stubGlobal(
			"URL",
			class extends originalUrl {
				static createObjectURL = createObjectURL;
				static revokeObjectURL = vi.fn();
			},
		);
		const click = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(() => {});
		try {
			await user.click(
				screen.getByRole("button", { name: "Download requirements" }),
			);
			const blob = createObjectURL.mock.calls[0]?.[0];
			if (!blob) throw new Error("missing requirements download");
			const contents = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result));
				reader.onerror = reject;
				reader.readAsText(blob);
			});
			expect(JSON.parse(contents).reference).toEqual(reference);
		} finally {
			click.mockRestore();
			vi.unstubAllGlobals();
		}
		expect(onApply).not.toHaveBeenCalled();
	});

	it("reserves imported automatic IDs when adding required rows", async () => {
		const goal: PerTitleGoal = {
			...initialGoal,
			strategy: "fixed-ranges",
			rows: [
				{ id: "first", height: 360, minBitrate: 100_000, maxBitrate: 800_000 },
			],
		};
		const { onApply } = show(goal);
		const height = screen.getByRole("spinbutton", {
			name: "Height (px), rendition 1",
		});
		const prefix = height.id.slice(0, -"-first-height".length);
		const imported = {
			...goal,
			automaticTemplates: [{ id: `${prefix}-new-1`, height: 1080 }],
		};
		const user = userEvent.setup();
		await user.upload(
			screen.getByLabelText("Load requirements file"),
			new File(
				[JSON.stringify({ version: 1, goal: imported })],
				"requirements.json",
				{ type: "application/json" },
			),
		);
		await waitFor(() =>
			expect(screen.getByText("Requirements loaded.")).toBeVisible(),
		);
		await user.click(screen.getByRole("button", { name: "Add rendition" }));
		expect(
			screen.getByRole("button", { name: "Review changes" }),
		).toBeDisabled();
		expect(onApply).not.toHaveBeenCalled();
		const api = JSON.parse(
			screen.getByTestId("per-title-api-settings").textContent ?? "",
		);
		const ids = api.streams.map((stream: { rowId: string }) => stream.rowId);
		expect(ids).toHaveLength(3);
		expect(new Set(ids).size).toBe(3);
	});

	it("rejects an invalid local file without replacing the current draft", async () => {
		show();
		await userEvent.setup().upload(
			screen.getByLabelText("Load requirements file"),
			new File(['{"version":1,"apiKey":"example"}'], "invalid.json", {
				type: "application/json",
			}),
		);
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent(
				"This requirements file could not be loaded.",
			),
		);
		expect(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
		).toHaveValue(8000);
	});

	it("derives bitrate steps from the desired count without requiring ratio inputs", async () => {
		const { onApply } = show({
			...initialGoal,
			strategy: "count",
			countPolicy: { kind: "exact", count: 6 },
		});
		expect(
			screen.queryByRole("spinbutton", { name: "Minimum bitrate step" }),
		).toBeNull();
		expect(
			screen.queryByRole("spinbutton", { name: "Maximum bitrate step" }),
		).toBeNull();
		expect(screen.queryByRole("radio")).toBeNull();
		await userEvent
			.setup()
			.click(screen.getByRole("button", { name: "Review changes" }));
		const proposal = onApply.mock.calls[0]?.[0];
		expect(proposal.applicable).toBe(true);
		expect(screen.getByText("Why these settings")).toBeVisible();
		await userEvent.setup().click(screen.getByText("Why these settings"));
		await userEvent
			.setup()
			.click(screen.getByText("Calculation and assumptions"));
		expect(screen.getByText(/s\^N > U\/L/)).toBeVisible();
		expect(proposal.api.global.minBitrateStepSize ** 6).toBeGreaterThan(80);
		expect(
			proposal.scenarios.find(
				(scenario: { id: string }) => scenario.id === "high",
			).modelCountRange.maximum,
		).toBeLessThanOrEqual(6);
	});

	it("compares the loaded maximum with an edited maximum without changing the reference", () => {
		show();
		fireEvent.click(screen.getByText("Comparison and calculation details"));
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
			{
				target: { value: "12000" },
			},
		);
		const comparison = screen.getByRole("table", { name: "Compare settings" });
		expect(
			within(comparison).getByRole("columnheader", { name: "Loaded settings" }),
		).toBeVisible();
		expect(
			within(comparison).getByRole("columnheader", { name: "Edited settings" }),
		).toBeVisible();
		const maximum = within(comparison).getByRole("row", {
			name: "Maximum bitrate (kbps) 8,000 12,000",
		});
		expect(maximum).toBeVisible();
	});

	it("offers the five intent modes and shows rows only for resolution constraints", async () => {
		show();
		const user = userEvent.setup();
		const strategy = screen.getByRole("combobox", {
			name: "What should Per-Title choose?",
		});
		expect(within(strategy).getAllByRole("option")).toHaveLength(5);
		for (const value of ["automatic", "count"]) {
			await user.selectOptions(strategy, value);
			expect(
				screen.queryByRole("button", { name: "Add rendition" }),
			).toBeNull();
		}
		for (const value of [
			"required-resolutions",
			"fixed-resolutions",
			"fixed-ranges",
		]) {
			await user.selectOptions(strategy, value);
			expect(
				screen.getByRole("button", { name: "Add rendition" }),
			).toBeVisible();
			expect(
				screen.getByRole("spinbutton", { name: "Height (px), rendition 1" }),
			).toHaveValue(360);
		}
		expect(
			screen.getByRole("spinbutton", {
				name: "Minimum bitrate (kbps), rendition 1",
			}),
		).toBeVisible();
	});

	it("keeps duplicate resolutions as separate rows and removes only the chosen row", async () => {
		show({ ...initialGoal, strategy: "fixed-resolutions" });
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Add rendition" }));
		const second = screen.getByRole("spinbutton", {
			name: "Height (px), rendition 2",
		});
		fireEvent.change(second, { target: { value: "360" } });
		expect(
			screen.getByRole("spinbutton", { name: "Height (px), rendition 1" }),
		).toHaveValue(360);
		expect(second).toHaveValue(360);
		await user.click(
			screen.getByRole("button", { name: "Remove rendition 1" }),
		);
		expect(
			screen.getByRole("spinbutton", { name: "Height (px), rendition 1" }),
		).toHaveValue(360);
		expect(
			screen.queryByRole("spinbutton", { name: "Height (px), rendition 2" }),
		).toBeNull();
	});

	it("discards draft edits on cancel without changing the supplied goal or applying", async () => {
		const original = structuredClone(initialGoal);
		const { onApply, onOpenChange } = show();
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
			{ target: { value: "5000" } },
		);
		await userEvent
			.setup()
			.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(onApply).not.toHaveBeenCalled();
		expect(initialGoal).toEqual(original);
	});

	it.each([
		"automatic",
		"count",
	])("keeps added row identities unique after switching through %s", async (strategy) => {
		const { onApply } = show({
			...initialGoal,
			strategy: "fixed-resolutions",
			countPolicy: { kind: "maximum", count: 20 },
		});
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Add rendition" }));
		const purpose = screen.getByRole("combobox", {
			name: "What should Per-Title choose?",
		});
		await user.selectOptions(purpose, strategy);
		await user.selectOptions(purpose, "fixed-resolutions");
		await user.click(screen.getByRole("button", { name: "Add rendition" }));
		expect(
			screen.getByRole("spinbutton", { name: "Height (px), rendition 3" }),
		).toHaveValue(720);
		const review = screen.getByRole("button", { name: "Review changes" });
		expect(review).toBeEnabled();
		await user.click(review);
		const rowIds = onApply.mock.calls[0]?.[0].api.streams.map(
			(stream: { rowId: string }) => stream.rowId,
		);
		expect(rowIds).toHaveLength(3);
		expect(new Set(rowIds).size).toBe(3);
	});

	it("keeps desired counts separate from the proposed API settings", async () => {
		show({
			...initialGoal,
			strategy: "count",
			countPolicy: { kind: "maximum", count: 20 },
		});
		expect(
			screen.getByRole("spinbutton", { name: "Desired count" }),
		).toHaveValue(20);
		const countHint = screen.getByText(
			"Counts are requirements checked here. The API has no total-count parameter.",
		);
		expect(countHint).not.toBeVisible();
		fireEvent.click(screen.getByText("Comparison and calculation details"));
		expect(countHint).toBeVisible();
		await userEvent.setup().click(screen.getByText("Proposed settings"));
		const settings = JSON.parse(
			screen.getByTestId("per-title-api-settings").textContent ?? "",
		);
		expect(settings).toHaveProperty("global.autoRepresentations", {});
		expect(settings).not.toHaveProperty("countPolicy");
		expect(settings).not.toHaveProperty("maxRenditions");
		expect(settings).not.toHaveProperty("count");
	});

	it("requests review only after an explicit action and preserves model-only evidence", async () => {
		const { onApply } = show();
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
			{ target: { value: "5000" } },
		);
		expect(onApply).not.toHaveBeenCalled();
		await userEvent
			.setup()
			.click(screen.getByRole("button", { name: "Review changes" }));
		expect(onApply).toHaveBeenCalledTimes(1);
		expect(onApply.mock.calls[0]?.[0]).toMatchObject({
			applicable: true,
			evidence: "model-only",
			countGuarantee: false,
			api: { global: { maxBitrate: 5_000_000 } },
		});
		await userEvent
			.setup()
			.click(screen.getByText("Comparison and calculation details"));
		expect(
			screen.getByText("Final outputs depend on content analysis."),
		).not.toBeVisible();
		fireEvent.click(screen.getByText("API parameters"));
		expect(
			screen.getByText("Final outputs depend on content analysis."),
		).toBeVisible();
	});

	it("disables review for invalid numeric input instead of replacing it with a default", async () => {
		const { onApply } = show();
		const minimum = screen.getByRole("spinbutton", {
			name: "Minimum bitrate (kbps)",
		});
		fireEvent.change(minimum, { target: { value: "" } });
		expect(minimum).toHaveValue(null);
		expect(minimum).toHaveAttribute("aria-invalid", "true");
		expect(
			screen.getByRole("button", { name: "Review changes" }),
		).toBeDisabled();
		expect(onApply).not.toHaveBeenCalled();
	});

	it("uses Japanese labels and keeps the content-analysis limitation concise", () => {
		show(initialGoal, "ja");
		fireEvent.click(screen.getByText("比較・計算の詳細"));
		expect(
			screen.getByRole("dialog", { name: "Per-Title シミュレーター" }),
		).toBeVisible();
		expect(
			screen.getByText("実際の出力は素材解析で決まります。"),
		).not.toBeVisible();
		fireEvent.click(screen.getByText("APIパラメータ"));
		expect(
			screen.getByText("実際の出力は素材解析で決まります。"),
		).toBeVisible();
		expect(
			screen.getByText(/素材の解析や、エンコーダの出力の予測は行いません/),
		).toBeVisible();
		expect(screen.getByRole("button", { name: "差分を確認" })).toBeVisible();
	});

	it("binds a changed public codec to the selected proposal without exposing restricted codecs", async () => {
		const { onApply } = show();
		const codec = screen.getByRole("combobox", { name: "Codec" });
		expect(within(codec).getAllByRole("option")).toHaveLength(4);
		expect(within(codec).queryByRole("option", { name: "H265V2" })).toBeNull();
		await userEvent.setup().selectOptions(codec, "VP9");
		await userEvent
			.setup()
			.click(screen.getByRole("button", { name: "Review changes" }));
		expect(onApply.mock.calls[0]?.[0]).toMatchObject({ codec: "VP9" });
	});

	it("includes a restricted codec only when the supplied goal already uses it", () => {
		show({ ...initialGoal, codec: "H265V2" });
		const codec = screen.getByRole("combobox", { name: "Codec" });
		expect(
			within(codec).getByRole("option", { name: "H265V2" }),
		).toBeInTheDocument();
		expect(codec).toHaveValue("H265V2");
	});

	it("loads the target codec's existing rows, strategy and global settings", async () => {
		const { onApply } = showCodecGoals();
		const user = userEvent.setup();
		await user.selectOptions(
			screen.getByRole("combobox", { name: "Codec" }),
			"H265",
		);
		expect(
			screen.getByRole("combobox", { name: "What should Per-Title choose?" }),
		).toHaveValue("fixed-ranges");
		expect(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
		).toHaveValue(10000);
		expect(
			screen.getByRole("spinbutton", { name: "Height (px), rendition 1" }),
		).toHaveValue(720);
		await user.click(screen.getByRole("button", { name: "Review changes" }));
		expect(onApply.mock.calls[0]?.[0]).toMatchObject({
			codec: "H265",
			api: {
				streams: [
					{
						rowId: "existing-hevc-row",
						height: 720,
						perTitleSettings: { minBitrate: 500_000, maxBitrate: 2_000_000 },
					},
				],
			},
		});
	});

	it("retains independent drafts while switching between codecs", async () => {
		showCodecGoals();
		const user = userEvent.setup();
		const codec = screen.getByRole("combobox", { name: "Codec" });
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
			{ target: { value: "5500" } },
		);
		expect(screen.queryByRole("radio")).toBeNull();
		await user.selectOptions(codec, "H265");
		expect(screen.queryByRole("radio")).toBeNull();
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
			{ target: { value: "9000" } },
		);
		await user.selectOptions(codec, "H264");
		expect(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
		).toHaveValue(5500);
		expect(
			screen.getByRole("spinbutton", { name: "Height (px), rendition 1" }),
		).toHaveValue(360);
		expect(screen.queryByRole("radio")).toBeNull();
		await user.selectOptions(codec, "H265");
		expect(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
		).toHaveValue(9000);
		expect(
			screen.getByRole("spinbutton", { name: "Height (px), rendition 1" }),
		).toHaveValue(720);
	});

	it("uses fresh row identities when no target codec seed is supplied", async () => {
		const { onApply } = show({
			...initialGoal,
			codec: "H264",
			strategy: "fixed-resolutions",
			rows: [
				{ id: "avc-a", height: 360 },
				{ id: "avc-b", height: 720 },
			],
		});
		const user = userEvent.setup();
		await user.selectOptions(
			screen.getByRole("combobox", { name: "Codec" }),
			"H265",
		);
		await user.click(screen.getByRole("button", { name: "Review changes" }));
		const proposal = onApply.mock.calls[0]?.[0];
		expect(proposal.codec).toBe("H265");
		const ids = proposal.api.streams.map(
			(stream: { rowId: string }) => stream.rowId,
		);
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
		expect(ids).not.toContain("avc-a");
		expect(ids).not.toContain("avc-b");
	});

	it("exposes a restricted codec only when its seed was explicitly supplied", () => {
		renderLocalized(
			<PerTitleSimulator
				open
				onOpenChange={vi.fn()}
				onApply={vi.fn()}
				initialGoal={initialGoal}
				goalsByCodec={{ H265V2: { ...initialGoal, codec: "H265V2" } }}
			/>,
		);
		const codec = screen.getByRole("combobox", { name: "Codec" });
		expect(
			within(codec).getByRole("option", { name: "H265V2" }),
		).toBeInTheDocument();
	});

	it("discards all codec drafts on cancel", async () => {
		const { props, rerender } = showCodecGoals();
		const user = userEvent.setup();
		await user.selectOptions(
			screen.getByRole("combobox", { name: "Codec" }),
			"H265",
		);
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
			{ target: { value: "9000" } },
		);
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		rerender(<PerTitleSimulator {...props} open={false} />);
		rerender(<PerTitleSimulator {...props} open />);
		expect(screen.getByRole("combobox", { name: "Codec" })).toHaveValue("H264");
		await user.selectOptions(
			screen.getByRole("combobox", { name: "Codec" }),
			"H265",
		);
		expect(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
		).toHaveValue(10000);
		expect(props.onApply).not.toHaveBeenCalled();
	});

	it("loads an automatic target seed without importing another codec's fixed rows", async () => {
		const goal = codecGoals.H264;
		if (!goal) throw new Error("missing H264 seed");
		const onApply = vi.fn();
		renderLocalized(
			<PerTitleSimulator
				open
				onOpenChange={vi.fn()}
				onApply={onApply}
				initialGoal={goal}
				goalsByCodec={{ VP9: { ...initialGoal, codec: "VP9", rows: [] } }}
			/>,
		);
		const user = userEvent.setup();
		await user.selectOptions(
			screen.getByRole("combobox", { name: "Codec" }),
			"VP9",
		);
		expect(
			screen.getByRole("combobox", { name: "What should Per-Title choose?" }),
		).toHaveValue("automatic");
		expect(screen.queryByRole("button", { name: "Add rendition" })).toBeNull();
		await user.click(screen.getByRole("button", { name: "Review changes" }));
		expect(onApply.mock.calls[0]?.[0]).toMatchObject({
			codec: "VP9",
			api: { streams: [{ mode: "PER_TITLE_TEMPLATE" }] },
		});
	});

	it("automatically reviews count-driven settings while preserving required resolutions", async () => {
		const { onApply } = show({
			...initialGoal,
			strategy: "fixed-resolutions",
			countPolicy: { kind: "exact", count: 2 },
			rows: [
				{ id: "small", height: 360 },
				{ id: "large", height: 720 },
			],
		});
		const user = userEvent.setup();
		expect(screen.queryByRole("radio")).toBeNull();
		expect(
			screen.getByText(/Bitrate spacing is selected automatically/),
		).not.toBeVisible();
		fireEvent.click(screen.getByText("Comparison and calculation details"));
		expect(
			screen.getByText(/Bitrate spacing is selected automatically/),
		).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Review changes" }));
		const proposal = onApply.mock.calls[0]?.[0];
		expect(proposal).toMatchObject({ applicable: true });
		expect(proposal.api.global.minBitrateStepSize).toBeGreaterThan(1.5);
		expect(
			proposal.api.streams.map((stream: { height: number }) => stream.height),
		).toEqual([360, 720]);
	});

	it("retains loaded ranges and derives complexity settings automatically", async () => {
		const { onApply } = show({
			...initialGoal,
			strategy: "fixed-ranges",
			countPolicy: { kind: "exact", count: 1 },
			rows: [
				{
					id: "ranged",
					height: 720,
					minBitrate: 500_000,
					maxBitrate: 2_000_000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 1_000_000,
					highComplexityBoundaryForMaxBitrate: 6_000_000,
				},
			],
		});
		await userEvent
			.setup()
			.click(screen.getByRole("button", { name: "Review changes" }));
		expect(onApply.mock.calls[0]?.[0].api.streams[0]).toMatchObject({
			height: 720,
			mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
			perTitleSettings: {
				minBitrate: 500_000,
				maxBitrate: 2_000_000,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 500_000,
				highComplexityBoundaryForMaxBitrate: 8_000_000,
			},
		});
	});

	it("retains the reviewed draft when the dialog is hidden and reopened", async () => {
		const props = {
			initialGoal: {
				...initialGoal,
				strategy: "fixed-resolutions" as const,
				countPolicy: { kind: "exact" as const, count: 2 },
				rows: [
					{ id: "low", height: 360 },
					{ id: "high", height: 720 },
				],
			},
			onApply: vi.fn(),
			onOpenChange: vi.fn(),
		};
		const { rerender } = renderLocalized(<PerTitleSimulator {...props} open />);
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
			{ target: { value: "7000" } },
		);
		const user = userEvent.setup();
		expect(screen.queryByRole("radio")).toBeNull();
		await user.click(screen.getByRole("button", { name: "Review changes" }));
		expect(props.onApply).toHaveBeenCalledTimes(1);
		rerender(<PerTitleSimulator {...props} open={false} />);
		rerender(<PerTitleSimulator {...props} open />);
		expect(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
		).toHaveValue(7000);
		expect(screen.queryByRole("radio")).toBeNull();
	});

	it("resets the draft after the user cancels and then reopens the dialog", async () => {
		const props = { initialGoal, onApply: vi.fn(), onOpenChange: vi.fn() };
		const { rerender } = renderLocalized(<PerTitleSimulator {...props} open />);
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
			{ target: { value: "5000" } },
		);
		await userEvent
			.setup()
			.click(screen.getByRole("button", { name: "Cancel" }));
		expect(props.onOpenChange).toHaveBeenCalledWith(false);
		rerender(<PerTitleSimulator {...props} open={false} />);
		rerender(<PerTitleSimulator {...props} open />);
		expect(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
		).toHaveValue(8000);
		expect(props.onApply).not.toHaveBeenCalled();
	});

	it("starts a fresh draft for a new component session", () => {
		const props = { initialGoal, onApply: vi.fn(), onOpenChange: vi.fn() };
		const { rerender } = renderLocalized(
			<PerTitleSimulator {...props} key="first" open />,
		);
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
			{ target: { value: "5000" } },
		);
		rerender(<PerTitleSimulator {...props} key="second" open />);
		expect(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
		).toHaveValue(8000);
		expect(props.onApply).not.toHaveBeenCalled();
	});

	it("counts repeated heights as requirements and leaves per-resolution capacity undetermined", () => {
		show({
			...initialGoal,
			strategy: "fixed-resolutions",
			rows: [
				{ id: "low", height: 360 },
				{ id: "second-low", height: 360 },
				{ id: "high", height: 720 },
			],
		});
		fireEvent.click(screen.getByText("Comparison and calculation details"));
		const table = screen.getByRole("table", {
			name: "Requirements by resolution",
		});
		const duplicate = within(table).getByRole("row", {
			name: "360 2 Not evaluated per resolution",
		});
		expect(within(duplicate).getByRole("cell", { name: "2" })).toBeVisible();
		expect(
			within(table).getByRole("row", {
				name: "720 1 Not evaluated per resolution",
			}),
		).toBeVisible();
	});

	it("recomputes complexity boundaries from the maximum without exposing technical inputs", () => {
		show({
			...initialGoal,
			strategy: "fixed-ranges",
			countPolicy: { kind: "exact", count: 1 },
			rows: [
				{
					id: "ranged",
					height: 720,
					minBitrate: 500_000,
					maxBitrate: 2_000_000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 1_000_000,
					highComplexityBoundaryForMaxBitrate: 6_000_000,
				},
			],
		});
		const before = JSON.parse(
			screen.getByTestId("per-title-api-settings").textContent ?? "",
		);
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
			{ target: { value: "16000" } },
		);
		const after = JSON.parse(
			screen.getByTestId("per-title-api-settings").textContent ?? "",
		);
		expect(
			before.streams[0].perTitleSettings.highComplexityBoundaryForMaxBitrate,
		).toBe(8_000_000);
		expect(
			after.streams[0].perTitleSettings.highComplexityBoundaryForMaxBitrate,
		).toBe(16_000_000);
		expect(
			screen.queryByRole("spinbutton", {
				name: "High complexity boundary (kbps)",
			}),
		).toBeNull();
		expect(screen.queryByText("(Linear example)")).toBeNull();
	});
});
