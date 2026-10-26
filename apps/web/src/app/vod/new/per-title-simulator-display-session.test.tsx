import type { PerTitleGoal } from "@bitovp/core";
import {
	act,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api";
import { renderLocalized } from "@/test/render";
import { PerTitleSimulator } from "./per-title-simulator";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

const source = (): PerTitleGoal => ({
	strategy: "automatic",
	codec: "H264",
	minBitrate: 128_000,
	maxBitrate: 4_000_000,
	minBitrateStepSize: 1.5,
	maxBitrateStepSize: 1.9,
	countPolicy: { kind: "exact", count: 6 },
	autoRepresentations: {},
	automaticTemplates: [{ id: "automatic-template" }],
});

const copy = {
	en: {
		analysis: "Assumed top bitrate (kbps)",
		codec: "Codec",
		ranges: "Allowed ranges",
		output: "Simulated output",
		load: "Load requirements file",
		loaded: "Requirements loaded.",
		evaluate: "Evaluate",
		comparisonAnalysis: "Assumed analysis bitrate (kbps)",
	},
	ja: {
		analysis: "解析後の最大ビットレート（仮定、kbps）",
		codec: "コーデック",
		ranges: "許容範囲",
		output: "想定出力",
		load: "要件ファイルを読み込む",
		loaded: "要件ファイルを読み込みました。",
		evaluate: "評価する",
		comparisonAnalysis: "解析値の仮定 (kbps)",
	},
};

const api = () =>
	JSON.parse(screen.getByTestId("per-title-api-settings").textContent ?? "{}");
const analysis = (locale: "en" | "ja" = "en") =>
	screen.getByRole("spinbutton", { name: copy[locale].analysis });
const setAnalysis = (value: string, locale: "en" | "ja" = "en") =>
	fireEvent.change(analysis(locale), { target: { value } });
const setup = () => screen.getByRole("button", { name: "New setup wizard" });

function show(locale: "en" | "ja" = "en", initialGoal = source()) {
	const onApply = vi.fn();
	renderLocalized(
		<PerTitleSimulator
			initialGoal={initialGoal}
			goalsByCodec={{
				H265: { ...source(), codec: "H265", maxBitrate: 3_200_000 },
			}}
			open
			onOpenChange={vi.fn()}
			onApply={onApply}
		/>,
		locale,
	);
	return { onApply };
}

beforeEach(() => {
	vi.mocked(apiFetch).mockReset();
});

describe("simulator display sessions", () => {
	it("retains an explicit analysis assumption through ordinary global and row edits", () => {
		show("en", {
			...source(),
			strategy: "fixed-ranges",
			autoRepresentations: false,
			automaticTemplates: [],
			countPolicy: { kind: "unrestricted" },
			rows: [
				{
					id: "required",
					height: 720,
					minBitrate: 500_000,
					maxBitrate: 1_000_000,
				},
			],
		});
		setAnalysis("512");
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
			{
				target: { value: "5000" },
			},
		);
		fireEvent.change(
			screen.getByRole("spinbutton", {
				name: "Maximum bitrate (kbps), rendition 1",
			}),
			{
				target: { value: "900" },
			},
		);
		expect(analysis()).toHaveValue(512);
		expect(api().global.maxBitrate).toBe(5_000_000);
		expect(api().streams[0].perTitleSettings.maxBitrate).toBe(900_000);
	});

	it.each([
		"en",
		"ja",
	] as const)("resets an explicit assumption for another codec and its restored draft (%s)", (locale) => {
		show(locale);
		setAnalysis("128", locale);
		fireEvent.change(
			screen.getByRole("combobox", { name: copy[locale].codec }),
			{
				target: { value: "H265" },
			},
		);
		expect(analysis(locale)).toHaveValue(3200);
		setAnalysis("256", locale);
		fireEvent.change(
			screen.getByRole("combobox", { name: copy[locale].codec }),
			{
				target: { value: "H264" },
			},
		);
		expect(analysis(locale)).toHaveValue(4000);
	});

	it.each([
		"en",
		"ja",
	] as const)("starts a fresh display session when the identical requirements file is loaded again (%s)", async (locale) => {
		const { onApply } = show(locale);
		const user = userEvent.setup();
		const original = api();
		fireEvent.click(
			screen.getByText(
				locale === "ja"
					? "要件ファイルの読み書き"
					: "Import or export requirements",
			),
		);
		for (const value of ["128", "256"]) {
			setAnalysis(value, locale);
			fireEvent.click(
				screen.getByRole("button", { name: copy[locale].ranges }),
			);
			await user.upload(
				screen.getByLabelText(copy[locale].load),
				new File(
					[JSON.stringify({ version: 1, goal: source() })],
					"session-requirements.json",
					{ type: "application/json" },
				),
			);
			await waitFor(() =>
				expect(screen.getByText(copy[locale].loaded)).toBeVisible(),
			);
			expect(analysis(locale)).toHaveValue(4000);
			expect(
				screen.getByRole("button", { name: copy[locale].output }),
			).toHaveAttribute("aria-pressed", "true");
			expect(api()).toEqual(original);
		}
		expect(onApply).not.toHaveBeenCalled();
	});

	it("resets display assumptions when a new wizard setup is completed", () => {
		show();
		setAnalysis("128");
		fireEvent.click(setup());
		fireEvent.click(screen.getByRole("button", { name: "Next" }));
		fireEvent.click(screen.getByRole("button", { name: "Next" }));
		fireEvent.click(
			screen.getByRole("button", { name: "Inspect in simulator" }),
		);
		expect(analysis()).toHaveValue(4000);
	});

	it.each([
		"en",
		"ja",
	] as const)("clears display and comparison assumptions when the same encoding is loaded again (%s)", async (locale) => {
		const goal = {
			...source(),
			countPolicy: { kind: "unrestricted" as const },
		};
		vi.mocked(apiFetch).mockImplementation(async (path) =>
			path === "/api/bitmovin-accounts"
				? [{ id: "saved-account", label: "Saved account" }]
				: {
						configurations: [
							{
								codec: "H264",
								goal,
								reference: {
									codec: "H264",
									global: {
										minBitrate: 128_000,
										maxBitrate: 4_000_000,
										minBitrateStepSize: 1.5,
										maxBitrateStepSize: 1.9,
										autoRepresentations: {},
									},
									streams: [
										{ id: "automatic-template", mode: "PER_TITLE_TEMPLATE" },
									],
								},
							},
						],
						issues: [],
					},
		);
		const { onApply } = show(locale);
		const original = api();
		for (const value of ["512", "768"]) {
			setAnalysis(value, locale);
			fireEvent.click(
				screen.getByRole("button", {
					name: copy[locale].evaluate,
				}),
			);
			fireEvent.change(
				screen.getByRole("spinbutton", {
					name: copy[locale].comparisonAnalysis,
				}),
				{
					target: { value: "2500" },
				},
			);
			fireEvent.click(
				screen.getByRole("button", {
					name:
						locale === "ja"
							? "Encoding IDから読み込む"
							: "Load from Encoding ID",
				}),
			);
			await screen.findByRole("option", { name: "Saved account" });
			fireEvent.change(
				screen.getByRole("combobox", {
					name: locale === "ja" ? "Bitmovinアカウント" : "Bitmovin account",
				}),
				{ target: { value: "saved-account" } },
			);
			fireEvent.change(screen.getByLabelText("Encoding ID"), {
				target: { value: "11111111-1111-4111-8111-111111111111" },
			});
			fireEvent.click(
				screen.getByRole("button", {
					name: locale === "ja" ? "設定を取得" : "Fetch settings",
				}),
			);
			await screen.findByRole("checkbox", { name: /H264/ });
			fireEvent.click(
				screen.getByRole("button", {
					name:
						locale === "ja"
							? "選択した設定を読み込む"
							: "Load selected settings",
				}),
			);
			expect(analysis(locale)).toHaveValue(4000);
			expect(
				screen.queryByRole("spinbutton", {
					name: copy[locale].comparisonAnalysis,
				}),
			).toBeNull();
			expect(api()).toEqual(original);
			// Provider settings do not contain the user's desired output count.
			fireEvent.change(
				screen.getByRole("combobox", {
					name: locale === "ja" ? "レンディションの本数" : "Rendition count",
				}),
				{ target: { value: "exact" } },
			);
			fireEvent.change(
				screen.getByRole("spinbutton", {
					name: locale === "ja" ? "希望する本数" : "Desired count",
				}),
				{ target: { value: "6" } },
			);
			fireEvent.click(
				screen.getByRole("button", {
					name: copy[locale].evaluate,
				}),
			);
			expect(
				screen.getByRole("spinbutton", {
					name: copy[locale].comparisonAnalysis,
				}),
			).toHaveValue(4000);
		}
		expect(onApply).not.toHaveBeenCalled();
		expect(apiFetch).toHaveBeenCalledTimes(4);
	});

	it("preserves evaluated advice, staged decisions and both analysis assumptions when setup is canceled", () => {
		const { onApply } = show();
		setAnalysis("512");
		fireEvent.click(screen.getByRole("button", { name: "Evaluate" }));
		fireEvent.change(
			screen.getByRole("spinbutton", {
				name: "Assumed analysis bitrate (kbps)",
			}),
			{
				target: { value: "3000" },
			},
		);
		fireEvent.change(
			screen.getByRole("combobox", { name: "Decision: Minimum bitrate ratio" }),
			{
				target: { value: "keep" },
			},
		);
		const original = api();
		const trigger = setup();
		trigger.focus();
		fireEvent.click(trigger);
		expect(screen.queryByRole("button", { name: "Evaluate" })).toBeNull();
		expect(
			screen.queryByRole("spinbutton", { name: copy.en.analysis }),
		).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Next" }));
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
			{
				target: { value: "6000" },
			},
		);
		fireEvent.click(screen.getByRole("button", { name: "Next" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(analysis()).toHaveValue(512);
		expect(
			screen.getByRole("spinbutton", {
				name: "Assumed analysis bitrate (kbps)",
			}),
		).toHaveValue(3000);
		expect(
			screen.getByRole("combobox", { name: "Decision: Minimum bitrate ratio" }),
		).toHaveValue("keep");
		expect(setup()).toHaveFocus();
		expect(api()).toEqual(original);
		expect(onApply).not.toHaveBeenCalled();
		expect(apiFetch).not.toHaveBeenCalled();
	});

	it("preserves maintained values and the selected chart view when setup is canceled", () => {
		show();
		fireEvent.click(screen.getByRole("button", { name: "Evaluate" }));
		fireEvent.change(
			screen.getByRole("combobox", { name: "Decision: Minimum bitrate ratio" }),
			{
				target: { value: "keep" },
			},
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Re-evaluate selected decisions" }),
		);
		expect(
			within(
				screen.getByRole("region", { name: "Maintained values" }),
			).getAllByRole("button"),
		).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: "Allowed ranges" }));
		fireEvent.click(setup());
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(
			screen.getByRole("button", { name: "Allowed ranges" }),
		).toHaveAttribute("aria-pressed", "true");
		expect(
			within(
				screen.getByRole("region", { name: "Maintained values" }),
			).getAllByRole("button"),
		).toHaveLength(1);
	});

	it("returns focus to the setup button when a pointer click did not focus it", async () => {
		await act(async () => show());
		analysis().focus();
		fireEvent.click(setup());
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(setup()).toHaveFocus();
	});

	it("clears display and advice state when the simulator closes and reopens", () => {
		function Harness() {
			const [open, setOpen] = useState(true);
			return (
				<>
					<button type="button" onClick={() => setOpen(true)}>
						Reopen simulator fixture
					</button>
					<PerTitleSimulator
						initialGoal={source()}
						open={open}
						onOpenChange={setOpen}
						onApply={vi.fn()}
					/>
				</>
			);
		}
		renderLocalized(<Harness />);
		setAnalysis("128");
		fireEvent.click(screen.getByRole("button", { name: "Evaluate" }));
		fireEvent.click(screen.getByRole("button", { name: "Allowed ranges" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		fireEvent.click(
			screen.getByRole("button", { name: "Reopen simulator fixture" }),
		);
		expect(analysis()).toHaveValue(4000);
		expect(
			screen.queryByRole("region", { name: "Suggested adjustment" }),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: "Simulated output" }),
		).toHaveAttribute("aria-pressed", "true");
	});
});
