import type { PerTitleGoal } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { DEFAULT_WIZARD_STATE } from "./build-plan";
import { PerTitleSimulator } from "./per-title-simulator";
import { PerTitleSimulatorLauncher } from "./per-title-simulator-launcher";

describe("guided setup enters the existing simulator and draft review", () => {
	it.each([
		"en",
		"ja",
	] as const)("opens from the encoding form without changing the draft (%s)", (locale) => {
		const state = structuredClone(DEFAULT_WIZARD_STATE);
		const snapshot = structuredClone(state);
		const onPatch = vi.fn();
		renderLocalized(
			<PerTitleSimulatorLauncher state={state} onPatch={onPatch} />,
			locale,
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: locale === "ja" ? "Per-Titleを設定" : "Set up Per-Title",
			}),
		);
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
		fireEvent.click(
			screen.getByRole("button", {
				name: locale === "ja" ? "Per-Titleを設定" : "Set up Per-Title",
			}),
		);
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
		fireEvent.click(
			screen.getByRole("button", { name: "Create from requirements" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.getByTestId("per-title-api-settings").textContent).toBe(
			before,
		);
		expect(onApply).not.toHaveBeenCalled();
	});
});
