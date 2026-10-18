import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/lib/i18n";
import { renderLocalized } from "@/test/render";
import { DEFAULT_LIVE_WIZARD_STATE } from "./build-live-plan";
import { LiveManifestsSection } from "./manifests-section";

describe("HLS publication buffer help", () => {
	it.each([
		"ja",
		"en",
	] as const)("opens upstream-default guidance beside its input (%s)", (locale) => {
		const onPatch = vi.fn();
		const state = structuredClone(DEFAULT_LIVE_WIZARD_STATE);
		state.manifests.hls.enabled = true;
		state.manifests.hls.liveEdgeOffset = undefined;
		state.manifests.dash.enabled = false;
		renderLocalized(
			<LiveManifestsSection state={state} onPatch={onPatch} />,
			locale,
		);
		const defaultText =
			locale === "ja"
				? /空欄は配信サービスの既定値（120秒）/
				: /Empty uses the service default \(120 seconds\)/;
		expect(screen.queryByText(defaultText)).not.toBeInTheDocument();
		const copy = messagesFor(locale);
		fireEvent.click(
			screen.getByRole("button", {
				name: copy.uiX.moreInformationFor.replace(
					"{label}",
					copy.ui.liveEdgeOffsetS,
				),
			}),
		);
		const help = screen.getByRole("note");
		expect(help).toHaveTextContent(defaultText);
		expect(help).toHaveTextContent(
			locale === "ja" ? /開始前に秒数を入力/ : /Enter seconds before starting/,
		);
		const input = screen.getByLabelText(
			locale === "ja"
				? "ライブエッジのオフセット (秒)"
				: "Live edge offset (s)",
		);
		expect(input).toHaveValue(null);
		expect(onPatch).not.toHaveBeenCalled();
		fireEvent.change(input, { target: { value: "6" } });
		expect(onPatch).toHaveBeenLastCalledWith({
			manifests: {
				...state.manifests,
				hls: { ...state.manifests.hls, liveEdgeOffset: 6 },
			},
		});
	});
	it.each([
		"ja",
		"en",
	] as const)("keeps HLS and DASH meanings separate (%s)", (locale) => {
		const copy = messagesFor(locale).uiX;
		expect(copy.hlsLiveEdgeOffsetTooltip).toMatch(
			locale === "ja" ? /マニフェスト.*公開/ : /manifest.*publication/,
		);
		expect(copy.hlsTimeshiftDefaultHelp).toMatch(
			locale === "ja" ? /DVRなしの指定ではありません/ : /does not mean no DVR/,
		);
		const state = structuredClone(DEFAULT_LIVE_WIZARD_STATE);
		state.manifests.hls.enabled = false;
		state.manifests.dash.enabled = true;
		renderLocalized(
			<LiveManifestsSection state={state} onPatch={vi.fn()} />,
			locale,
		);
		expect(screen.queryByText(/120/)).not.toBeInTheDocument();
		expect(copy.liveEdgeOffsetTooltip).toBe(
			locale === "ja"
				? "プレイヤーが最新セグメントからどれだけ後ろで再生を始めるか。推奨は ~10–12 秒(セグメント約 2–3 個分 — Bitmovin のリファレンスサンプルは 10–12 を使用)。大きいほど遅延は増えるが ingest/CDN ジッタへのバッファ余裕が増し、小さいほど低遅延だがライブエッジ付近でのリバッファリスクが上がります。"
				: "How far behind the newest segment players start. Recommended ~10–12s (about 2–3 segment durations — Bitmovin's reference samples use 10–12). Larger = more latency but more buffer headroom against ingest/CDN jitter; smaller = lower latency but higher rebuffer risk near the live edge.",
		);
	});
});
