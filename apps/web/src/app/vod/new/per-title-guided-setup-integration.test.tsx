import {
	encodingPlanSchema,
	type PerTitleGoal,
	type PerTitleProposal,
	validatePlan,
} from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardState,
} from "./build-plan";
import { buildPerTitleSetup } from "./per-title-guided-setup-model";
import { PerTitleSimulator } from "./per-title-simulator";
import { PerTitleSimulatorLauncher } from "./per-title-simulator-launcher";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";
import { perTitleGoalFromWizard } from "./per-title-simulator-wizard";

function openSetupFromSimulator(locale: "en" | "ja") {
	fireEvent.click(
		screen.getByRole("button", {
			name: locale === "ja" ? "シミュレーターを開く" : "Open simulator",
		}),
	);
	const before = screen.getByTestId("per-title-api-settings").textContent;
	fireEvent.click(
		screen.getByRole("button", {
			name: locale === "ja" ? "新規設定ウィザード" : "New setup wizard",
		}),
	);
	return before;
}

function addTemplateRows(locale: "en" | "ja", heights: readonly number[]) {
	for (const height of heights) {
		const count = screen.getAllByRole("group", {
			name: locale === "ja" ? /^レンディション \d+$/ : /^Rendition \d+$/,
		}).length;
		fireEvent.click(
			screen.getByRole("button", {
				name: locale === "ja" ? "レンディションを追加" : "Add rendition",
			}),
		);
		const row = screen.getByRole("group", {
			name:
				locale === "ja"
					? `レンディション ${count + 1}`
					: `Rendition ${count + 1}`,
		});
		fireEvent.change(
			within(row).getByRole("combobox", {
				name: locale === "ja" ? "Streamモード" : "Stream mode",
			}),
			{ target: { value: "template-resolution" } },
		);
		fireEvent.change(
			within(row).getByRole("spinbutton", {
				name: locale === "ja" ? "高さ (px)" : "Height (px)",
			}),
			{ target: { value: String(height) } },
		);
	}
}

describe("guided setup enters the existing simulator and draft review", () => {
	it("keeps review disabled when extra automatic outputs have no mixed-sequence certificate", () => {
		const result = buildPerTitleSetup({
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 160000,
			maxBitrate: 5000000,
			rows: [320, 320, 576, 768].map((height, index) => ({
				id: `row-${index + 1}`,
				height,
			})),
			automaticEdges: { lowerHeight: 160, upperHeights: [960, 1152] },
		});
		if (!result.goal) throw new Error("Missing calculated setup");
		const onApply = vi.fn();
		renderLocalized(
			<PerTitleSimulator
				initialGoal={{ ...result.goal, autoRepresentations: {} }}
				open
				onOpenChange={vi.fn()}
				onApply={onApply}
			/>,
		);
		const api = JSON.parse(
			screen.getByTestId("per-title-api-settings").textContent ?? "{}",
		);
		expect(api.global.autoRepresentations).toEqual({});
		expect(
			screen.getByRole("button", { name: "Review changes" }),
		).toBeDisabled();
		expect(
			screen.queryByRole("region", { name: "Unmeasured source conditions" }),
		).toBeNull();
		expect(onApply).not.toHaveBeenCalled();
	});

	it.each(
		(["H264", "H265", "VP9"] as const).flatMap((codec) =>
			(["en", "ja"] as const).map((locale) => [locale, codec] as const),
		),
	)("applies one calculated mixed proposal through the real draft review without supplied row bitrates (%s, %s)", (locale, codec) => {
		const state = structuredClone(DEFAULT_WIZARD_STATE);
		const initialVideo = state.videos[0];
		if (!initialVideo) throw new Error("Missing initial video");
		state.videos[0] = {
			...initialVideo,
			codec,
			...(codec === "VP9" ? { muxing: { kind: "WEBM" as const } } : {}),
		};
		if (codec === "VP9") state.manifests = { hls: false, dash: true };
		state.name = "fresh-per-title-setup";
		const input = state.inputFiles[0];
		if (!input) throw new Error("Missing initial input");
		state.inputFiles[0] = {
			...input,
			credentialId: "00000000-0000-4000-8000-000000000001",
			bucket: "input-bucket",
			path: "clip.mp4",
		};
		state.output = {
			...state.output,
			credentialId: "00000000-0000-4000-8000-000000000002",
			bucket: "output-bucket",
			basePath: "simulation/",
		};
		const snapshot = structuredClone(state);
		const onPatch = vi.fn();
		renderLocalized(
			<PerTitleSimulatorLauncher state={state} onPatch={onPatch} />,
			locale,
		);
		openSetupFromSimulator(locale);
		fireEvent.click(
			screen.getByRole("radio", {
				name:
					locale === "ja"
						? "解像度とビットレート幅を指定"
						: "Specify resolutions and bitrate ranges",
			}),
		);
		const next = () =>
			fireEvent.click(
				screen.getByRole("button", {
					name: locale === "ja" ? "次へ" : "Next",
				}),
			);
		next();
		for (const [name, value] of [
			[
				locale === "ja" ? "最小ビットレート (kbps)" : "Minimum bitrate (kbps)",
				"160",
			],
			[
				locale === "ja" ? "最大ビットレート (kbps)" : "Maximum bitrate (kbps)",
				"5000",
			],
			[
				locale === "ja"
					? "画質の基準 (TargetQualityCrf・任意)"
					: "Quality target (TargetQualityCrf, optional)",
				"17",
			],
		] as const)
			fireEvent.change(screen.getByRole("spinbutton", { name }), {
				target: { value },
			});
		expect(
			screen.getByRole("spinbutton", {
				name:
					locale === "ja"
						? "入力の高さ (px・任意)"
						: "Source height (px, optional)",
			}),
		).toHaveValue(null);
		fireEvent.click(
			screen.getByRole("button", {
				name: locale === "ja" ? "レンディションを追加" : "Add rendition",
			}),
		);
		for (const [index, height] of [320, 320, 576, 768].entries()) {
			const row = screen.getByRole("group", {
				name:
					locale === "ja"
						? `レンディション ${index + 1}`
						: `Rendition ${index + 1}`,
			});
			fireEvent.change(
				within(row).getByRole("spinbutton", {
					name: locale === "ja" ? "高さ (px)" : "Height (px)",
				}),
				{ target: { value: String(height) } },
			);
			expect(
				within(row).getByRole("spinbutton", {
					name:
						locale === "ja"
							? "最小ビットレート (kbps・任意)"
							: "Minimum bitrate (kbps, optional)",
				}),
			).toHaveValue(null);
			expect(
				within(row).getByRole("spinbutton", {
					name:
						locale === "ja"
							? "最大ビットレート (kbps・任意)"
							: "Maximum bitrate (kbps, optional)",
				}),
			).toHaveValue(null);
		}
		addTemplateRows(locale, [160, 960, 1152]);
		next();
		expect(onPatch).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", {
				name: locale === "ja" ? "シミュレーターで確認" : "Inspect in simulator",
			}),
		);
		const api = JSON.parse(
			screen.getByTestId("per-title-api-settings").textContent ?? "{}",
		);
		expect(api.streams).toHaveLength(7);
		expect(api.global).toMatchObject({
			minBitrate: 160000,
			maxBitrate: 5000000,
			targetQualityCrf: 17,
		});
		const fixed = api.streams.filter(
			(row: { mode: string }) =>
				row.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
		);
		expect(fixed).toHaveLength(4);
		for (const row of fixed)
			expect(row.perTitleSettings.maxBitrate).toBeGreaterThan(
				row.perTitleSettings.minBitrate,
			);
		expect(
			screen
				.getByRole("figure", {
					name: locale === "ja" ? "想定出力" : "Simulated output",
				})
				.querySelectorAll('[data-testid="per-title-output-row"]'),
		).toHaveLength(6);
		fireEvent.click(
			screen.getByText(
				locale === "ja" ? "パラメータの導出" : "Parameter derivation",
			),
		);
		const sourceConditions = screen.getByRole("region", {
			name:
				locale === "ja" ? "素材で未確認の条件" : "Unmeasured source conditions",
		});
		expect(sourceConditions).toBeVisible();
		expect(sourceConditions).toHaveTextContent(
			locale === "ja" ? "1,152 px 以上" : "at least 1,152 px",
		);
		const review = screen.getByRole("button", {
			name: locale === "ja" ? "差分を確認" : "Review changes",
		});
		expect(review).toBeEnabled();
		fireEvent.click(review);
		expect(
			screen.getByRole("dialog", {
				name:
					locale === "ja" ? "ラダー設定の変更を確認" : "Review ladder changes",
			}),
		).toBeVisible();
		expect(onPatch).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", {
				name: locale === "ja" ? "編集中の設定に反映" : "Apply to draft",
			}),
		);
		expect(onPatch).toHaveBeenCalledOnce();
		const adopted = onPatch.mock.calls[0]?.[0] as WizardState | undefined;
		if (!adopted) throw new Error("Missing adopted draft");
		const beforePlan = encodingPlanSchema.parse(buildPlan(snapshot));
		const afterPlan = encodingPlanSchema.parse(buildPlan(adopted));
		expect(
			validatePlan(afterPlan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		if (codec === "VP9") {
			expect(
				afterPlan.renditions.filter((row) => row.codec === "VP9"),
			).toHaveLength(7);
			expect(
				afterPlan.muxings
					.filter((muxing) =>
						afterPlan.renditions.some(
							(row) => row.key === muxing.streamKey && row.codec === "VP9",
						),
					)
					.every((muxing) => muxing.kind === "WEBM"),
			).toBe(true);
		}
		const audioRows = beforePlan.renditions.filter(
			(row) => row.codec === "AAC",
		);
		const audioKeys = new Set(audioRows.map((row) => row.key));
		expect(afterPlan.renditions.filter((row) => row.codec === "AAC")).toEqual(
			audioRows,
		);
		expect(
			afterPlan.muxings.filter((muxing) => audioKeys.has(muxing.streamKey)),
		).toEqual(
			beforePlan.muxings.filter((muxing) => audioKeys.has(muxing.streamKey)),
		);
		expect(adopted.inputFiles).toEqual(state.inputFiles);
		expect(state).toEqual(snapshot);
		const imported = perTitleGoalFromWizard(adopted, codec);
		const reimported = tunePerTitleSettings(imported, imported).proposal;
		expect(imported.targetQualityCrf).toBe(17);
		expect(reimported.api.global.targetQualityCrf).toBe(17);
		const canonical = (settings: PerTitleProposal["api"]) => ({
			global: settings.global,
			streams: settings.streams
				.map(({ rowId: _rowId, ...row }) => row)
				.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
		});
		expect(canonical(reimported.api)).toEqual(canonical(api));
		expect(reimported.countGuarantee).toBe(false);
	});

	it.each([
		"en",
		"ja",
	] as const)("keeps one form entry and opens setup inside the simulator (%s)", (locale) => {
		const state = structuredClone(DEFAULT_WIZARD_STATE);
		const snapshot = structuredClone(state);
		const onPatch = vi.fn();
		renderLocalized(
			<PerTitleSimulatorLauncher state={state} onPatch={onPatch} />,
			locale,
		);
		expect(screen.getAllByRole("button")).toHaveLength(1);
		expect(
			screen.queryByRole("button", {
				name: locale === "ja" ? "Per-Titleを設定" : "Set up Per-Title",
			}),
		).toBeNull();
		const before = openSetupFromSimulator(locale);
		expect(
			screen.getByRole("dialog", {
				name:
					locale === "ja" ? "Per-Title を新しく設定" : "New Per-Title setup",
			}),
		).toBeVisible();
		fireEvent.click(
			screen.getByRole("button", {
				name: locale === "ja" ? "キャンセル" : "Cancel",
			}),
		);
		expect(screen.getByTestId("per-title-api-settings").textContent).toBe(
			before,
		);
		expect(onPatch).not.toHaveBeenCalled();
		expect(state).toEqual(snapshot);
	});

	it.each([
		"en",
		"ja",
	] as const)("requires the existing plan diff confirmation before applying (%s)", (locale) => {
		const state = structuredClone(DEFAULT_WIZARD_STATE);
		const snapshot = structuredClone(state);
		const onPatch = vi.fn();
		renderLocalized(
			<PerTitleSimulatorLauncher state={state} onPatch={onPatch} />,
			locale,
		);
		openSetupFromSimulator(locale);
		fireEvent.click(
			screen.getByRole("radio", {
				name: locale === "ja" ? "すべて任せる" : "Let the encoder choose",
			}),
		);
		const next = () =>
			fireEvent.click(
				screen.getByRole("button", {
					name: locale === "ja" ? "次へ" : "Next",
				}),
			);
		next();
		fireEvent.change(
			screen.getByRole("spinbutton", {
				name:
					locale === "ja"
						? "最小ビットレート (kbps)"
						: "Minimum bitrate (kbps)",
			}),
			{ target: { value: "250" } },
		);
		fireEvent.change(
			screen.getByRole("spinbutton", {
				name:
					locale === "ja"
						? "最大ビットレート (kbps)"
						: "Maximum bitrate (kbps)",
			}),
			{ target: { value: "6000" } },
		);
		next();
		expect(onPatch).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", {
				name: locale === "ja" ? "シミュレーターで確認" : "Inspect in simulator",
			}),
		);
		const api = JSON.parse(
			screen.getByTestId("per-title-api-settings").textContent ?? "{}",
		);
		expect(api.global).toMatchObject({
			minBitrate: 250_000,
			maxBitrate: 6_000_000,
			autoRepresentations: {},
		});
		expect(onPatch).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", {
				name: locale === "ja" ? "差分を確認" : "Review changes",
			}),
		);
		expect(
			screen.getByRole("dialog", {
				name:
					locale === "ja" ? "ラダー設定の変更を確認" : "Review ladder changes",
			}),
		).toBeVisible();
		expect(onPatch).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", {
				name: locale === "ja" ? "編集中の設定に反映" : "Apply to draft",
			}),
		);
		expect(onPatch).toHaveBeenCalledOnce();
		expect(onPatch.mock.calls[0]?.[0].audios).toEqual(state.audios);
		expect(state).toEqual(snapshot);
	});

	it("can cancel setup from the simulator without losing the existing settings", () => {
		const initial: PerTitleGoal = {
			strategy: "fixed-resolutions",
			codec: "H264",
			minBitrate: 200_000,
			maxBitrate: 4_800_000,
			countPolicy: { kind: "unrestricted" },
			rows: [{ id: "retained", height: 720 }],
			targetQualityCrf: 19,
		};
		const onApply = vi.fn();
		renderLocalized(
			<PerTitleSimulator
				initialGoal={initial}
				open
				onOpenChange={vi.fn()}
				onApply={onApply}
			/>,
		);
		const before = screen.getByTestId("per-title-api-settings").textContent;
		fireEvent.click(screen.getByRole("button", { name: "New setup wizard" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.getByTestId("per-title-api-settings").textContent).toBe(
			before,
		);
		expect(onApply).not.toHaveBeenCalled();
	});
});
