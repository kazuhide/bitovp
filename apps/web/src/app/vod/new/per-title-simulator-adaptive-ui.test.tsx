import type { PerTitleGoal } from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleSimulator } from "./per-title-simulator";
import { PerTitleAdvisor } from "./per-title-simulator-advisor";

const ordinary = (): PerTitleGoal => ({
	strategy: "automatic",
	codec: "H264",
	minBitrate: 300000,
	maxBitrate: 4000000,
	minBitrateStepSize: 1.5,
	maxBitrateStepSize: 6,
	countPolicy: { kind: "unrestricted" },
	autoRepresentations: {},
	automaticTemplates: [{ id: "ordinary" }],
	targetQualityCrf: 20,
});

describe("content-adaptive Per-Title evaluation", () => {
	it.each([
		"en",
		"ja",
	] as const)("offers one adaptive default and three visible purposes (%s)", (locale) => {
		const goal = ordinary();
		renderLocalized(
			<PerTitleAdvisor goal={goal} session={goal} onAdopt={vi.fn()} />,
			locale,
		);
		const purpose = screen.getByRole("combobox", {
			name: locale === "ja" ? "目的" : "Goal",
		});
		expect(purpose).toHaveValue("adaptive");
		expect(
			within(purpose)
				.getAllByRole("option")
				.map((option) => (option as HTMLOptionElement).value),
		).toEqual(["adaptive", "preserve", "count"]);
		expect(
			within(purpose).getByRole("option", {
				name:
					locale === "ja"
						? "素材に合わせて帯域を調整"
						: "Adapt bitrate to the content",
			}),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("option", {
				name:
					locale === "ja"
						? "複雑な素材で上限まで使う"
						: "Use the maximum for complex content",
			}),
		).toBeNull();
		expect(
			screen.queryByRole("option", {
				name:
					locale === "ja"
						? "画質を保って転送量を減らす"
						: "Reduce bandwidth while keeping quality",
			}),
		).toBeNull();
		expect(purpose).toHaveAccessibleDescription(
			locale === "ja"
				? "単純な素材では低く、複雑な素材では必要に応じて上限まで選べるかを確認します。画質関連の設定は維持します。"
				: "Check whether simple content can use less bitrate and complex content can use the ceiling when needed. Quality settings are retained.",
		);
	});

	it.each([
		"en",
		"ja",
	] as const)("evaluates and adopts one maximum-four adjustment without turning it into an exact count (%s)", (locale) => {
		const ja = locale === "ja",
			goal = ordinary(),
			onApply = vi.fn();
		renderLocalized(
			<PerTitleSimulator
				initialGoal={goal}
				open
				onOpenChange={vi.fn()}
				onApply={onApply}
			/>,
			locale,
		);
		const countPolicy = screen.getByRole("combobox", {
			name: ja ? "レンディションの本数" : "Rendition count",
		});
		fireEvent.change(countPolicy, { target: { value: "maximum" } });
		const count = screen.getByRole("spinbutton", {
			name: ja ? "希望する本数" : "Desired count",
		});
		fireEvent.change(count, { target: { value: "4" } });
		const purpose = screen.getByRole("combobox", {
			name: ja ? "目的" : "Goal",
		});
		expect(purpose).toHaveValue("adaptive");
		const readApi = () =>
			JSON.parse(
				screen.getByTestId("per-title-api-settings").textContent ?? "{}",
			);
		const before = readApi();
		fireEvent.click(
			screen.getByRole("button", { name: ja ? "評価する" : "Evaluate" }),
		);
		const suggestions = screen.getAllByRole("region", {
			name: ja ? "調整案" : "Suggested adjustment",
		});
		expect(suggestions).toHaveLength(1);
		const suggestion = suggestions[0];
		if (!suggestion) throw new Error("Missing adaptive adjustment");
		expect(readApi()).toEqual(before);
		fireEvent.click(
			within(suggestion).getByRole("button", {
				name: ja ? "この調整を採用" : "Use this adjustment",
			}),
		);
		const after = readApi();
		expect(after.global.minBitrate).toBe(300000);
		expect(after.global.maxBitrate).toBe(4000000);
		expect(after.global.targetQualityCrf).toBe(20);
		expect(after.global.minBitrateStepSize).toBeGreaterThan(
			before.global.minBitrateStepSize,
		);
		expect(after.streams).toEqual(before.streams);
		expect(countPolicy).toHaveValue("maximum");
		expect(count).toHaveValue(4);
		const output = screen.getByRole("figure", {
			name: ja ? "想定出力" : "Simulated output",
		});
		expect(
			within(output).getByText(
				ja ? "最大4本（本数未確定）" : "At most 4 renditions; count unresolved",
			),
		).toBeVisible();
		expect(
			output.querySelectorAll('[data-testid="per-title-output-row"]'),
		).toHaveLength(1);
		fireEvent.click(
			screen.getByRole("button", { name: ja ? "評価する" : "Evaluate" }),
		);
		expect(countPolicy).toHaveValue("maximum");
		expect(count).toHaveValue(4);
		expect(readApi()).toEqual(after);
		expect(onApply).not.toHaveBeenCalled();
	});

	it.each([
		"en",
		"ja",
	] as const)("shows a partial spacing conflict without replacing a maintained maximum (%s)", (locale) => {
		const ja = locale === "ja",
			onApply = vi.fn();
		renderLocalized(
			<PerTitleSimulator
				initialGoal={{
					...ordinary(),
					maxBitrateStepSize: 1.9,
					countPolicy: { kind: "maximum", count: 4 },
				}}
				open
				onOpenChange={vi.fn()}
				onApply={onApply}
			/>,
			locale,
		);
		const readApi = () =>
			JSON.parse(
				screen.getByTestId("per-title-api-settings").textContent ?? "{}",
			);
		const before = readApi();
		const evaluate = () =>
			fireEvent.click(
				screen.getByRole("button", { name: ja ? "評価する" : "Evaluate" }),
			);
		evaluate();
		for (const [label, value] of [
			[ja ? "ビットレート間隔の下限" : "Minimum bitrate ratio", "apply"],
			[ja ? "ビットレート間隔の上限" : "Maximum bitrate ratio", "keep"],
		] as const) {
			fireEvent.change(
				screen.getByRole("combobox", {
					name: `${ja ? "選択" : "Decision"}: ${label}`,
				}),
				{ target: { value } },
			);
		}
		expect(
			screen.getByText(
				ja
					? "選択した変更は条件が競合するため、変更後のラダーを表示できません。"
					: "The selected changes conflict; the after ladder is unavailable.",
			),
		).toBeVisible();
		expect(
			screen.queryByRole("figure", {
				name: ja
					? "選択した変更を反映した場合"
					: "After applying selected changes",
			}),
		).toBeNull();
		expect(readApi()).toEqual(before);
		fireEvent.click(
			screen.getByRole("button", {
				name: ja ? "選択した内容で再評価" : "Re-evaluate selected decisions",
			}),
		);
		const partial = readApi();
		expect(partial.global.minBitrateStepSize).toBeGreaterThan(1.9);
		expect(partial.global.maxBitrateStepSize).toBe(1.9);
		const review = screen.getByRole("button", {
			name: ja ? "差分を確認" : "Review changes",
		});
		expect(review).toBeDisabled();
		const maintained = screen.getByRole("region", {
			name: ja ? "維持する値" : "Maintained values",
		});
		expect(maintained).toHaveTextContent(
			ja ? "ビットレート間隔の上限: 1.9" : "Maximum bitrate ratio: 1.9",
		);
		expect(
			screen.getByRole("combobox", {
				name: ja ? "レンディションの本数" : "Rendition count",
			}),
		).toHaveValue("maximum");
		expect(
			screen.getByRole("spinbutton", {
				name: ja ? "希望する本数" : "Desired count",
			}),
		).toHaveValue(4);
		evaluate();
		expect(readApi().global.maxBitrateStepSize).toBe(1.9);
		expect(review).toBeDisabled();
		expect(onApply).not.toHaveBeenCalled();
	});
});
