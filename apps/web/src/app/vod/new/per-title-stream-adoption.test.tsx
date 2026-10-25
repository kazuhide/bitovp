import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleSimulator } from "./per-title-simulator";
import { buildPerTitleStreamSetup } from "./per-title-stream-setup-model";

describe("four Stream modes reach draft review", () => {
	it.each(
		(["H264", "H265", "VP9"] as const).flatMap((codec) =>
			(["en", "ja"] as const).map((locale) => [codec, locale] as const),
		),
	)("reviews the generated unrestricted configuration (%s, %s)", (codec, locale) => {
		const result = buildPerTitleStreamSetup({
			strategy: "fixed-ranges",
			codec,
			minBitrate: 160_000,
			maxBitrate: 5_000_000,
			targetQualityCrf: 17,
			streams: [
				{ id: "unconstrained", mode: "PER_TITLE_TEMPLATE" },
				{ id: "probe", mode: "PER_TITLE_TEMPLATE", height: 320 },
				{
					id: "resolution",
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
					height: 576,
				},
				{
					id: "range",
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
					height: 768,
					minBitrate: 2_000_000,
					maxBitrate: 2_800_000,
				},
			],
		});
		if (!result.goal)
			throw new Error("Expected a generated Stream configuration.");
		const onApply = vi.fn();
		renderLocalized(
			<PerTitleSimulator
				initialGoal={result.goal}
				open
				onOpenChange={vi.fn()}
				onApply={onApply}
			/>,
			locale,
		);
		const review = screen.getByRole("button", {
			name: locale === "ja" ? "差分を確認" : "Review changes",
		});
		expect(review).toBeEnabled();
		fireEvent.click(review);
		expect(onApply).toHaveBeenCalledOnce();
		const proposal = onApply.mock.calls[0]?.[0];
		expect(proposal.api.streams).toHaveLength(4);
		expect(proposal.api.global.targetQualityCrf).toBe(17);
		expect(proposal.countGuarantee).toBe(false);
		expect(
			proposal.api.streams.find(
				(row: { rowId: string }) => row.rowId === "unconstrained",
			),
		).not.toHaveProperty("height");
		expect(
			proposal.api.streams.find(
				(row: { rowId: string }) => row.rowId === "resolution",
			),
		).toMatchObject({
			mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			height: 576,
		});
		expect(
			proposal.api.streams.find(
				(row: { rowId: string }) => row.rowId === "range",
			),
		).toMatchObject({
			mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
			perTitleSettings: { minBitrate: 2_000_000, maxBitrate: 2_800_000 },
		});
	});
});
