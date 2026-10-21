import type { PerTitleGoal } from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
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
		expect(
			screen.getByText(
				"Counts are requirements checked here. The API has no total-count parameter.",
			),
		).toBeVisible();
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
		expect(
			screen.getByText("No actual encoding results have been loaded."),
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

	it("uses Japanese labels and explicitly separates examples from encoding results", () => {
		show(initialGoal, "ja");
		expect(
			screen.getByRole("dialog", { name: "Per-Title の設定を検討" }),
		).toBeVisible();
		expect(
			screen.getByText("実際のエンコード結果は読み込んでいません。"),
		).toBeVisible();
		expect(screen.getByText(/素材の複雑度の実測値ではなく/)).toBeVisible();
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
		await user.click(screen.getByRole("radio", { name: "Adjusted steps" }));
		await user.selectOptions(codec, "H265");
		expect(
			screen.getByRole("radio", { name: "Current conditions" }),
		).toBeChecked();
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
		expect(screen.getByRole("radio", { name: "Adjusted steps" })).toBeChecked();
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

	it("shows why a step adjustment was proposed and reviews the selected alternative", async () => {
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
		await user.click(screen.getByRole("radio", { name: "Adjusted steps" }));
		expect(
			screen.getByText(
				"Only the bitrate steps change. Requested resolutions and bitrate intervals are preserved.",
			),
		).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Review changes" }));
		const proposal = onApply.mock.calls[0]?.[0];
		expect(proposal).toMatchObject({ id: "step-adjusted", applicable: true });
		expect(proposal.api.global.minBitrateStepSize).toBeGreaterThan(1.5);
		expect(
			proposal.api.streams.map((stream: { height: number }) => stream.height),
		).toEqual([360, 720]);
	});

	it("retains explicit per-row ranges and complexity settings in the proposed configuration", async () => {
		const { onApply } = show({
			...initialGoal,
			strategy: "fixed-ranges",
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
				lowComplexityBoundaryForMaxBitrate: 1_000_000,
				highComplexityBoundaryForMaxBitrate: 6_000_000,
			},
		});
	});

	it("retains the reviewed draft and selected alternative when the dialog is hidden and reopened", async () => {
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
		await user.click(screen.getByRole("radio", { name: "Adjusted steps" }));
		await user.click(screen.getByRole("button", { name: "Review changes" }));
		expect(props.onApply).toHaveBeenCalledTimes(1);
		rerender(<PerTitleSimulator {...props} open={false} />);
		rerender(<PerTitleSimulator {...props} open />);
		expect(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
		).toHaveValue(7000);
		expect(screen.getByRole("radio", { name: "Adjusted steps" })).toBeChecked();
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

	it("updates the labelled linear example when a complexity boundary changes", async () => {
		show({
			...initialGoal,
			strategy: "fixed-ranges",
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
		const user = userEvent.setup();
		await user.click(screen.getByText("Bitrate selection"));
		const summary = screen.getAllByText("Show example renditions")[0];
		if (!summary?.parentElement) throw new Error("missing example details");
		await user.click(summary);
		expect(within(summary.parentElement).getByText("822.5")).toBeVisible();
		expect(
			within(summary.parentElement).getByText("(Linear example)"),
		).toBeVisible();
		fireEvent.change(
			screen.getByRole("spinbutton", {
				name: "High complexity boundary (kbps)",
			}),
			{ target: { value: "8000" } },
		);
		expect(within(summary.parentElement).queryByText("822.5")).toBeNull();
		expect(within(summary.parentElement).getByText("730.357")).toBeVisible();
	});
});
