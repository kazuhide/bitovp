import type { PerTitleGoal } from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleSimulator } from "./per-title-simulator";
import {
	applySelectedPerTitleAdvice,
	perTitleAdvice,
} from "./per-title-simulator-advice";

const initial: PerTitleGoal = {
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
			id: "required",
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
};

const api = () =>
	JSON.parse(screen.getByTestId("per-title-api-settings").textContent ?? "{}");
const range = (minimum: number, maximum: number, locale: "en" | "ja") => {
	const f = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
	return `${locale === "ja" ? "設定範囲" : "Configured"} ${f.format(minimum / 1000)}–${f.format(maximum / 1000)}`;
};

describe("advice ladder preview before adoption", () => {
	it.each([
		"en",
		"ja",
	] as const)("compares full and selected changes without changing the draft until review (%s)", (locale) => {
		const onApply = vi.fn();
		renderLocalized(
			<PerTitleSimulator
				initialGoal={initial}
				open
				onOpenChange={vi.fn()}
				onApply={onApply}
			/>,
			locale,
		);
		fireEvent.change(
			screen.getByRole("spinbutton", {
				name:
					locale === "en"
						? "Maximum bitrate (kbps)"
						: "最大ビットレート (kbps)",
			}),
			{ target: { value: "8000" } },
		);
		const edited = api();
		const currentGoal = { ...initial, maxBitrate: 8_000_000 };
		const offered = perTitleAdvice(initial, currentGoal, {
			scope: "global",
			key: "maxBitrate",
		})[0];
		if (!offered) throw new Error("Expected advice.");
		const target = offered.proposal.api.streams.find(
			(row) => row.rowId === "required",
		)?.perTitleSettings;
		if (!target?.minBitrate || !target.maxBitrate)
			throw new Error("Expected proposed range.");
		const comparison = screen.getByRole("region", {
			name: locale === "en" ? "Ladder comparison" : "ラダーの変化",
		});
		expect(
			within(comparison).getByRole("figure", {
				name: locale === "en" ? "Current ladder" : "現在のラダー",
			}),
		).toHaveTextContent(range(1_000_000, 1_600_000, locale));
		expect(
			within(comparison).getByRole("figure", {
				name:
					locale === "en" ? "After applying all changes" : "すべて反映した場合",
			}),
		).toHaveTextContent(range(target.minBitrate, target.maxBitrate, locale));
		expect(api()).toEqual(edited);
		fireEvent.change(
			within(comparison).getByRole("spinbutton", {
				name:
					locale === "en"
						? "Assumed analysis bitrate (kbps)"
						: "解析値の仮定 (kbps)",
			}),
			{ target: { value: "2000" } },
		);
		for (const figure of within(comparison).getAllByRole("figure")) {
			expect(figure).toHaveTextContent(
				locale === "en"
					? "Upper input assumed at 2,000 kbps"
					: "解析値を 2,000 kbps と仮定",
			);
		}
		fireEvent.change(
			screen.getByRole("combobox", {
				name:
					locale === "en"
						? "Decision: Minimum bitrate (kbps), rendition 1"
						: "選択: 最小ビットレート (kbps), 段 1",
			}),
			{ target: { value: "keep" } },
		);
		fireEvent.change(
			screen.getByRole("combobox", {
				name:
					locale === "en"
						? "Decision: Maximum bitrate (kbps), rendition 1"
						: "選択: 最大ビットレート (kbps), 段 1",
			}),
			{ target: { value: "apply" } },
		);
		expect(
			within(comparison).getByRole("figure", {
				name:
					locale === "en"
						? "After applying selected changes"
						: "選択した変更を反映した場合",
			}),
		).toHaveTextContent(range(1_000_000, target.maxBitrate, locale));
		expect(api()).toEqual(edited);
		expect(onApply).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", {
				name: locale === "en" ? "Clear decisions" : "選択をクリア",
			}),
		);
		expect(
			within(comparison).getByRole("figure", {
				name:
					locale === "en" ? "After applying all changes" : "すべて反映した場合",
			}),
		).toHaveTextContent(range(target.minBitrate, target.maxBitrate, locale));
		fireEvent.change(
			screen.getByRole("combobox", {
				name:
					locale === "en"
						? "Decision: Maximum bitrate (kbps), rendition 1"
						: "選択: 最大ビットレート (kbps), 段 1",
			}),
			{ target: { value: "apply" } },
		);
		const selected = applySelectedPerTitleAdvice(currentGoal, offered, [
			{ scope: "stream", rowId: "required", key: "maxBitrate" },
		]);
		expect(selected?.rows?.[0]?.minBitrate).toBe(1_000_000);
		fireEvent.click(
			screen.getByRole("button", {
				name:
					locale === "en"
						? "Re-evaluate selected decisions"
						: "選択した内容で再評価",
			}),
		);
		expect(
			api().streams.find((row: { rowId: string }) => row.rowId === "required")
				.perTitleSettings,
		).toMatchObject({
			minBitrate: 1_000_000,
			maxBitrate: selected?.rows?.[0]?.maxBitrate,
		});
		expect(onApply).not.toHaveBeenCalled();
	});
});
