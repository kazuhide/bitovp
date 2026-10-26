import {
	type PerTitleGoal,
	type PerTitleProposal,
	previewPerTitleOutput,
} from "@bitovp/core";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleSimulator } from "./per-title-simulator";
import { PerTitleOutputChart } from "./per-title-simulator-output";
import {
	perTitleGlobalFields,
	perTitleStreamFields,
} from "./per-title-simulator-tuning";

const source = (): PerTitleGoal => ({
	strategy: "automatic",
	codec: "H264",
	minBitrate: 128_000,
	maxBitrate: 4_000_000,
	minBitrateStepSize: 1.5,
	maxBitrateStepSize: 1.9,
	countPolicy: { kind: "unrestricted" },
	autoRepresentations: {},
	automaticTemplates: [{ id: "automatic" }],
});

describe("global SDK bitrate floor in the simulator", () => {
	it.each([
		"H264",
		"H265",
		"H265V2",
		"VP9",
		"AV1",
	] as const)("distinguishes the global %s minimum from stream bounds", (codec) => {
		for (const key of ["minBitrate", "maxBitrate"]) {
			expect(
				perTitleGlobalFields(codec).find((field) => field.key === key)?.minimum,
			).toBe(10_000);
			expect(
				perTitleStreamFields(codec).find((field) => field.key === key)?.minimum,
			).toBe(1);
		}
	});

	it.each([
		"en",
		"ja",
	] as const)("shows the global floor, preserves invalid edits and focuses the reported field (%s)", async (locale) => {
		const ja = locale === "ja",
			goal = source(),
			before = structuredClone(goal),
			onApply = vi.fn();
		await act(async () =>
			renderLocalized(
				<PerTitleSimulator
					initialGoal={goal}
					open
					onOpenChange={vi.fn()}
					onApply={onApply}
				/>,
				locale,
			),
		);
		const minimum = screen.getByRole("spinbutton", {
			name: ja ? "最小ビットレート (kbps)" : "Minimum bitrate (kbps)",
		});
		const maximum = screen.getByRole("spinbutton", {
			name: ja ? "最大ビットレート (kbps)" : "Maximum bitrate (kbps)",
		});
		const lowerSlider = screen.getByRole("slider", {
			name: ja
				? "最小ビットレートのスライダー (kbps)"
				: "Minimum bitrate slider (kbps)",
		});
		const upperSlider = screen.getByRole("slider", {
			name: ja
				? "最大ビットレートのスライダー (kbps)"
				: "Maximum bitrate slider (kbps)",
		});
		expect(minimum).toHaveAttribute("min", "10");
		expect(maximum).toHaveAttribute("min", "10");
		expect(maximum).toHaveAttribute("max", "2147483.647");
		expect(minimum).toHaveAttribute("step", "0.001");
		expect(lowerSlider).toHaveAttribute("min", "10");
		expect(Number(upperSlider.getAttribute("min"))).toBeGreaterThanOrEqual(10);
		fireEvent.change(minimum, { target: { value: "5" } });
		expect(minimum).toHaveValue(5);
		expect(minimum).toHaveAttribute("aria-invalid", "true");
		expect(lowerSlider).toBeDisabled();
		expect(lowerSlider).toHaveAttribute("min", "10");
		expect(
			screen.getByRole("button", {
				name: ja ? "差分を確認" : "Review changes",
			}),
		).toBeDisabled();
		fireEvent.click(
			screen.getByRole("button", { name: ja ? "評価する" : "Evaluate" }),
		);
		const panel = screen.getByRole("region", {
			name: ja ? "現在の設定を評価" : "Evaluate current settings",
		});
		expect(panel).toHaveTextContent("10,000");
		fireEvent.click(
			within(panel).getByRole("button", {
				name: ja
					? "設定を確認: 最小ビットレート (kbps)"
					: "Review setting: Minimum bitrate (kbps)",
			}),
		);
		expect(minimum).toHaveFocus();
		expect(minimum).toHaveValue(5);
		fireEvent.change(minimum, { target: { value: "128" } });
		fireEvent.change(maximum, { target: { value: "9.999" } });
		expect(maximum).toHaveValue(9.999);
		expect(maximum).toHaveAttribute("aria-invalid", "true");
		expect(upperSlider).toBeDisabled();
		expect(Number(upperSlider.getAttribute("min"))).toBeGreaterThanOrEqual(10);
		expect(
			screen.getByRole("button", {
				name: ja ? "差分を確認" : "Review changes",
			}),
		).toBeDisabled();
		expect(
			JSON.parse(
				screen.getByTestId("per-title-api-settings").textContent ?? "{}",
			).global.maxBitrate,
		).toBe(9_999);
		fireEvent.click(
			screen.getByRole("button", { name: ja ? "評価する" : "Evaluate" }),
		);
		fireEvent.click(
			within(panel).getByRole("button", {
				name: ja
					? "設定を確認: 最大ビットレート (kbps)"
					: "Review setting: Maximum bitrate (kbps)",
			}),
		);
		expect(maximum).toHaveFocus();
		expect(maximum).toHaveValue(9.999);
		fireEvent.change(maximum, { target: { value: "4000" } });
		fireEvent.change(minimum, { target: { value: "10.0001" } });
		expect(minimum).toHaveValue(10.0001);
		expect(minimum).toHaveAttribute("aria-invalid", "true");
		expect(
			screen.getByRole("button", {
				name: ja ? "差分を確認" : "Review changes",
			}),
		).toBeDisabled();
		fireEvent.change(minimum, { target: { value: "128" } });
		fireEvent.change(maximum, { target: { value: "2147483.648" } });
		expect(maximum).toHaveValue(2147483.648);
		expect(maximum).toHaveAttribute("aria-invalid", "true");
		expect(
			screen.getByRole("button", {
				name: ja ? "差分を確認" : "Review changes",
			}),
		).toBeDisabled();
		fireEvent.change(maximum, { target: { value: "4000" } });
		const assumption = screen.getByRole("spinbutton", {
			name: ja
				? "解析後の最大ビットレート（仮定、kbps）"
				: "Assumed top bitrate (kbps)",
		});
		fireEvent.change(assumption, { target: { value: "0.001" } });
		expect(assumption).toHaveValue(0.001);
		expect(assumption).toHaveAttribute("min", "0.001");
		expect(assumption).toHaveAttribute("step", "0.001");
		expect(assumption).not.toHaveAttribute("aria-invalid", "true");
		expect(
			screen.getByRole("slider", {
				name: ja
					? "解析後の最大ビットレート（仮定）のスライダー (kbps)"
					: "Assumed top bitrate slider (kbps)",
			}),
		).toHaveAttribute("min", "0.001");
		expect(
			JSON.parse(
				screen.getByTestId("per-title-api-settings").textContent ?? "{}",
			).global,
		).toMatchObject({ minBitrate: 128_000, maxBitrate: 4_000_000 });
		expect(goal).toEqual(before);
		expect(onApply).not.toHaveBeenCalled();
	});

	it.each(
		(
			[
				{
					scenario: "ordinary",
					mode: "PER_TITLE_TEMPLATE",
					factor: undefined,
					floor: 100_000,
					fixedOrigin: false,
				},
				{
					scenario: "fixed resolution only",
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
					factor: 0.25,
					floor: 100_000,
					fixedOrigin: false,
				},
				{
					scenario: "fixed bitrate floor below global minimum",
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
					factor: 0.25,
					floor: 50_000,
					fixedOrigin: true,
				},
				{
					scenario: "fixed bitrate floor equal to global minimum",
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
					factor: 0.5,
					floor: 100_000,
					fixedOrigin: true,
				},
				{
					scenario: "fixed bitrate floor above global minimum",
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
					factor: 1,
					floor: 200_000,
					fixedOrigin: true,
				},
			] as const
		).flatMap((value) =>
			(["en", "ja"] as const).map((locale) => ({ ...value, locale })),
		),
	)("attributes the analysis floor to its actual source: $scenario ($locale)", ({
		mode,
		factor,
		floor,
		fixedOrigin,
		locale,
	}) => {
		const proposal: PerTitleProposal = {
			id: "baseline",
			codec: "H264",
			status: "unknown",
			applicable: false,
			evidence: "model-only",
			countGuarantee: false,
			api: {
				global: {
					minBitrate: 100_000,
					maxBitrate: 1_000_000,
					minBitrateStepSize: 1.5,
					maxBitrateStepSize: 1.9,
					...(factor === undefined
						? {}
						: {
								fixedResolutionAndBitrateConfiguration: {
									forcedRenditionAboveHighestFixedRepresentation: 1,
									forcedRenditionAboveHighestFixedRepresentationFactor: factor,
									forcedRenditionAboveHighestFixedRepresentationCalculationMode:
										"LAST_CALCULATED_BITRATE" as const,
								},
							}),
				},
				streams: [
					{
						rowId: "source",
						height: 720,
						mode,
						...(mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE"
							? {
									perTitleSettings: {
										minBitrate: 200_000,
										maxBitrate: 200_000,
									},
								}
							: {}),
					},
				],
			},
			scenarios: [],
			diagnostics: [],
		};
		const before = structuredClone(proposal);
		expect(
			previewPerTitleOutput(proposal, { analysisInput: 1_000 }),
		).toMatchObject({ floor, complexityInput: floor, analysisInput: 1_000 });
		renderLocalized(
			<PerTitleOutputChart proposal={proposal} analysisInput={1_000} />,
			locale,
		);
		const expected =
			locale === "ja"
				? `複雑度の計算値 1 → ${floor / 1000} kbps（${fixedOrigin ? "固定段" : "全体"}の下限を適用）。`
				: `Complexity input 1 → ${floor / 1000} kbps (${fixedOrigin ? "fixed-rendition floor" : "overall minimum"}).`;
		expect(screen.getByText(expected)).toBeVisible();
		expect(
			screen.queryByText(
				locale === "ja"
					? new RegExp(`${fixedOrigin ? "全体" : "固定段"}の下限を適用`)
					: new RegExp(
							fixedOrigin ? "overall minimum" : "fixed-rendition floor",
						),
			),
		).toBeNull();
		expect(proposal).toEqual(before);
	});

	it("keeps typed bitrate limits separate from the loaded chart and slider domains", async () => {
		await act(async () =>
			renderLocalized(
				<PerTitleSimulator
					initialGoal={{
						...source(),
						strategy: "fixed-ranges",
						automaticTemplates: [],
						autoRepresentations: false,
						rows: [
							{
								id: "required",
								height: 720,
								minBitrate: 500_000,
								maxBitrate: 1_000_000,
							},
						],
					}}
					open
					onOpenChange={vi.fn()}
					onApply={vi.fn()}
				/>,
			),
		);
		const globalMaximum = screen.getByRole("spinbutton", {
			name: "Maximum bitrate (kbps)",
		});
		const rowMaximum = screen.getByRole("spinbutton", {
			name: "Maximum bitrate (kbps), rendition 1",
		});
		expect(rowMaximum).toHaveAttribute("min", "0.001");
		expect(rowMaximum).toHaveAttribute("max", "2147483.647");
		expect(rowMaximum).toHaveAttribute("step", "0.001");
		fireEvent.change(globalMaximum, { target: { value: "40000" } });
		fireEvent.change(rowMaximum, { target: { value: "40000" } });
		expect(globalMaximum).toHaveValue(40000);
		expect(rowMaximum).toHaveValue(40000);
		expect(globalMaximum).not.toHaveAttribute("aria-invalid", "true");
		expect(rowMaximum).not.toHaveAttribute("aria-invalid", "true");
		const api = JSON.parse(
			screen.getByTestId("per-title-api-settings").textContent ?? "{}",
		);
		expect(api.global.maxBitrate).toBe(40_000_000);
		expect(api.streams[0].perTitleSettings.maxBitrate).toBe(40_000_000);
		expect(
			within(
				screen.getByRole("figure", { name: "Simulated output" }),
			).getByText(/Outside scale/),
		).toBeVisible();
	});
});
