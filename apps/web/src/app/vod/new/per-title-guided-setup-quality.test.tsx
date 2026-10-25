import type { PerTitleCodec, PerTitleGoal } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleGuidedSetup } from "./per-title-guided-setup";

const publicCodecs: readonly PerTitleCodec[] = ["H264", "H265", "VP9", "AV1"];
const copy = {
	en: {
		next: "Next",
		back: "Back",
		complete: "Inspect in simulator",
		codec: "Video codec",
		quality: "Quality target (TargetQualityCrf, optional)",
		hint: "Lower values favor quality; bitrate ranges are set separately.",
		api: "API settings",
	},
	ja: {
		next: "次へ",
		back: "戻る",
		complete: "シミュレーターで確認",
		codec: "映像コーデック",
		quality: "画質の基準 (TargetQualityCrf・任意)",
		hint: "小さい値ほど画質を優先します。ビットレート幅は別に指定します。",
		api: "API 設定",
	},
};

function mount(
	codec: PerTitleCodec = "H264",
	locale: "en" | "ja" = "en",
	allowedCodecs = publicCodecs,
) {
	const initialGoal: PerTitleGoal = {
		strategy: "automatic",
		codec,
		minBitrate: 150_000,
		maxBitrate: 4_000_000,
		countPolicy: { kind: "unrestricted" },
		targetQualityCrf: 27,
	};
	const onComplete = vi.fn();
	renderLocalized(
		<PerTitleGuidedSetup
			initialGoal={initialGoal}
			allowedCodecs={allowedCodecs}
			onComplete={onComplete}
			onCancel={vi.fn()}
		/>,
		locale,
	);
	const text = copy[locale];
	fireEvent.click(screen.getByRole("button", { name: text.next }));
	return { onComplete, text };
}

function click(name: string) {
	fireEvent.click(screen.getByRole("button", { name }));
}

function readApi(text: (typeof copy)["en"]) {
	const pre = screen
		.getByText(text.api)
		.closest("details")
		?.querySelector("pre");
	if (!pre) throw new Error("Missing proposed API settings");
	return JSON.parse(pre.textContent ?? "{}");
}

describe("PerTitleGuidedSetup quality requirement", () => {
	it.each(
		publicCodecs.flatMap((codec) =>
			(["en", "ja"] as const).map((locale) => [codec, locale] as const),
		),
	)("preserves explicit quality through review, back and completion (%s, %s)", (codec, locale) => {
		const { onComplete, text } = mount(codec, locale);
		const input = screen.getByRole("spinbutton", { name: text.quality });
		expect(input).toHaveValue(null);
		expect(input).toHaveAttribute("min", "0");
		expect(input).toHaveAccessibleDescription(text.hint);
		fireEvent.change(input, { target: { value: "17" } });
		click(text.next);
		expect(readApi(text).global.targetQualityCrf).toBe(17);
		click(text.back);
		expect(screen.getByRole("spinbutton", { name: text.quality })).toHaveValue(
			17,
		);
		click(text.back);
		click(text.next);
		expect(screen.getByRole("spinbutton", { name: text.quality })).toHaveValue(
			17,
		);
		click(text.next);
		click(text.complete);
		expect(onComplete).toHaveBeenCalledOnce();
		expect(onComplete.mock.calls[0]?.[0]).toMatchObject({
			codec,
			targetQualityCrf: 17,
		});
	});

	it.each(
		publicCodecs,
	)("does not inherit quality when left blank (%s)", (codec) => {
		const { onComplete, text } = mount(codec);
		expect(screen.getByRole("spinbutton", { name: text.quality })).toHaveValue(
			null,
		);
		click(text.next);
		expect(readApi(text).global).not.toHaveProperty("targetQualityCrf");
		click(text.complete);
		expect(onComplete).toHaveBeenCalledOnce();
		expect(onComplete.mock.calls[0]?.[0]).not.toHaveProperty(
			"targetQualityCrf",
		);
	});

	it("retains an explicit zero and removes a cleared quality requirement", () => {
		const { onComplete, text } = mount();
		fireEvent.change(screen.getByRole("spinbutton", { name: text.quality }), {
			target: { value: "0" },
		});
		click(text.next);
		expect(readApi(text).global.targetQualityCrf).toBe(0);
		click(text.back);
		fireEvent.change(screen.getByRole("spinbutton", { name: text.quality }), {
			target: { value: "" },
		});
		click(text.next);
		expect(readApi(text).global).not.toHaveProperty("targetQualityCrf");
		click(text.complete);
		expect(onComplete.mock.calls[0]?.[0]).not.toHaveProperty(
			"targetQualityCrf",
		);
	});

	it("excludes a previous CRF requirement when switching to HEVC v2", () => {
		const { onComplete, text } = mount("H264", "en", ["H264", "H265V2"]);
		fireEvent.change(screen.getByRole("spinbutton", { name: text.quality }), {
			target: { value: "17" },
		});
		fireEvent.change(screen.getByRole("combobox", { name: text.codec }), {
			target: { value: "H265V2" },
		});
		expect(screen.queryByRole("spinbutton", { name: text.quality })).toBeNull();
		click(text.next);
		expect(readApi(text).global).not.toHaveProperty("targetQualityCrf");
		click(text.complete);
		expect(onComplete).toHaveBeenCalledOnce();
		expect(onComplete.mock.calls[0]?.[0]).toMatchObject({ codec: "H265V2" });
		expect(onComplete.mock.calls[0]?.[0]).not.toHaveProperty(
			"targetQualityCrf",
		);
		expect(onComplete.mock.calls[0]?.[0]).not.toHaveProperty("targetQualityQp");
	});
});
