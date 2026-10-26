import type { PerTitleGoal } from "@bitovp/core";
import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { applySelectedPerTitleAdvice } from "./per-title-simulator-advice";
import { PerTitleAdvisor } from "./per-title-simulator-advisor";

const source = (): PerTitleGoal => ({
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 100_000,
	maxBitrate: 4_000_000,
	minBitrateStepSize: 1.25,
	maxBitrateStepSize: 4,
	countPolicy: { kind: "unrestricted" },
	autoRepresentations: false,
	rows: [
		{
			id: "lower",
			height: 240,
			minBitrate: 200_000,
			maxBitrate: 400_000,
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			lowComplexityBoundaryForMaxBitrate: 1_250_000,
			highComplexityBoundaryForMaxBitrate: 4_000_000,
		},
		{
			id: "upper",
			height: 720,
			minBitrate: 1_000_000,
			maxBitrate: 1_600_000,
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			lowComplexityBoundaryForMaxBitrate: 1_250_000,
			highComplexityBoundaryForMaxBitrate: 4_000_000,
		},
	],
	automaticTemplates: [
		{ id: "base", height: 120 },
		{ id: "top", height: 1080 },
	],
});

describe("advice selection identity and acknowledgement", () => {
	it.each([
		"lower",
		"upper",
	] as const)("returns an applied %s boundary to advice after release and another driver edit", (boundary) => {
		const session = source(),
			onAdopt = vi.fn();
		const low = boundary === "lower";
		const driver = low ? "minBitrateStepSize" : "maxBitrate";
		const label = `${low ? "Lower" : "Upper"} complexity boundary (kbps)`;
		let current = { ...session, [driver]: low ? 1.5 : 3_000_000 };
		const view = renderLocalized(
			<PerTitleAdvisor goal={session} session={session} onAdopt={onAdopt} />,
		);
		view.rerender(
			<PerTitleAdvisor goal={current} session={session} onAdopt={onAdopt} />,
		);
		fireEvent.change(
			screen.getByRole("combobox", {
				name: `Decision: ${label}, rendition 1`,
			}),
			{ target: { value: "apply" } },
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Re-evaluate selected decisions",
			}),
		);
		const [advice, options, fields] = onAdopt.mock.calls[0] ?? [];
		const accepted = applySelectedPerTitleAdvice(
			current,
			advice,
			fields,
			options,
		);
		if (!accepted) throw new Error("Expected selected boundary draft.");
		view.rerender(
			<PerTitleAdvisor goal={accepted} session={session} onAdopt={onAdopt} />,
		);
		current = { ...accepted, [driver]: low ? 1.6 : 3_500_000 };
		view.rerender(
			<PerTitleAdvisor goal={current} session={session} onAdopt={onAdopt} />,
		);
		expect(
			screen.queryByRole("combobox", {
				name: `Decision: ${label}, rendition 1`,
			}),
		).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: `Release: ${label}, rendition 1` }),
		);
		expect(
			screen.getByRole("combobox", {
				name: `Decision: ${label}, rendition 1`,
			}),
		).toHaveValue("skip");
		expect(
			screen.getByRole("combobox", {
				name: `Decision: ${label}, rendition 2`,
			}),
		).toBeInTheDocument();
	});
	it("selects one row independently when multiple upper boundaries have the same values", () => {
		const session = source(),
			current = { ...session, maxBitrate: 8_000_000 },
			onAdopt = vi.fn();
		const view = renderLocalized(
			<PerTitleAdvisor goal={session} session={session} onAdopt={onAdopt} />,
		);
		view.rerender(
			<PerTitleAdvisor goal={current} session={session} onAdopt={onAdopt} />,
		);
		const first = screen.getByRole("combobox", {
			name: "Decision: Upper complexity boundary (kbps), rendition 1",
		});
		const second = screen.getByRole("combobox", {
			name: "Decision: Upper complexity boundary (kbps), rendition 2",
		});
		fireEvent.change(first, { target: { value: "apply" } });
		expect(first).toHaveValue("apply");
		expect(second).toHaveValue("skip");
		fireEvent.click(
			screen.getByRole("button", {
				name: "Re-evaluate selected decisions",
			}),
		);
		expect(onAdopt).toHaveBeenCalledTimes(1);
		expect(onAdopt.mock.calls[0]?.[2]).toEqual([
			{
				scope: "stream",
				rowId: "lower",
				key: "highComplexityBoundaryForMaxBitrate",
			},
		]);
		expect(
			screen.queryByRole("region", { name: "Maintained values" }),
		).toBeNull();
		view.rerender(
			<PerTitleAdvisor
				goal={{ ...current, maxBitrate: 9_000_000 }}
				session={session}
				onAdopt={onAdopt}
			/>,
		);
		expect(
			screen.queryByRole("region", { name: "Maintained values" }),
		).toBeNull();
		expect(
			screen.getByRole("button", {
				name: "Re-evaluate selected decisions",
			}),
		).toBeDisabled();
	});
	it("commits staged keeps with a selected change once and rejects a repeated stale batch", () => {
		const session = source(),
			current = { ...session, maxBitrate: 8_000_000 },
			onAdopt = vi.fn();
		const view = renderLocalized(
			<PerTitleAdvisor goal={session} session={session} onAdopt={onAdopt} />,
		);
		view.rerender(
			<PerTitleAdvisor goal={current} session={session} onAdopt={onAdopt} />,
		);
		fireEvent.change(
			screen.getByRole("combobox", {
				name: "Decision: Minimum bitrate (kbps), rendition 1",
			}),
			{ target: { value: "apply" } },
		);
		const apply = screen.getByRole("button", {
			name: "Re-evaluate selected decisions",
		});
		const keep = screen.getByRole("combobox", {
			name: "Decision: Maximum bitrate (kbps), rendition 1",
		});
		fireEvent.change(keep, { target: { value: "keep" } });
		expect(onAdopt).not.toHaveBeenCalled();
		expect(
			screen.queryByRole("region", { name: "Maintained values" }),
		).toBeNull();
		act(() => {
			fireEvent.click(apply);
			fireEvent.click(apply);
		});
		expect(onAdopt).toHaveBeenCalledTimes(1);
		expect(onAdopt.mock.calls[0]?.[2]).toEqual([
			{ scope: "stream", key: "minBitrate", rowId: "lower" },
		]);
		expect(
			screen.getByRole("button", {
				name: "Release: Maximum bitrate (kbps), rendition 1",
			}),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", {
				name: "Release: Minimum bitrate (kbps), rendition 1",
			}),
		).toBeNull();
		expect(
			screen.getByRole("button", {
				name: "Re-evaluate selected decisions",
			}),
		).toBeDisabled();
		const loaded = source();
		view.rerender(
			<PerTitleAdvisor goal={loaded} session={loaded} onAdopt={onAdopt} />,
		);
		expect(screen.queryByRole("combobox", { name: /Decision:/ })).toBeNull();
	});
});
