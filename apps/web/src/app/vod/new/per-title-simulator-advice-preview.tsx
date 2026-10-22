"use client";

import type { PerTitleGoal } from "@bitovp/core";
import { useId, useMemo, useState } from "react";
import { useT } from "@/lib/i18n/context";
import type {
	PerTitleAdvice,
	PerTitleAdviceField,
	PerTitleAdviceOptions,
} from "./per-title-simulator-advice";
import { perTitleAdvicePreview } from "./per-title-simulator-advice-preview-model";
import { PerTitleSimulatorBitrateField } from "./per-title-simulator-bitrate-field";
import { PerTitleOutputChart } from "./per-title-simulator-output";

export function PerTitleAdvicePreview({
	goal,
	advice,
	options,
	selected,
	kept,
}: {
	goal: PerTitleGoal;
	advice: PerTitleAdvice;
	options?: PerTitleAdviceOptions;
	selected: readonly PerTitleAdviceField[];
	kept: readonly PerTitleAdviceField[];
}) {
	const { locale } = useT();
	const ja = locale === "ja";
	const id = useId();
	const [analysisInput, setAnalysisInput] = useState<number>();
	const preview = useMemo(
		() => perTitleAdvicePreview(goal, advice, { selected, kept }, options),
		[goal, advice, selected, kept, options],
	);
	const axis = preview.axis ?? {
		minimum: preview.current.api.global.minBitrate,
		maximum: preview.current.api.global.maxBitrate,
	};
	const analysisValue = analysisInput ?? axis.maximum;
	const afterTitle = {
		all: ja ? "すべて反映した場合" : "After applying all changes",
		selected: ja
			? "選択した変更を反映した場合"
			: "After applying selected changes",
		keep: ja ? "現在値を維持する場合" : "Keeping current values",
	}[preview.mode];
	return (
		<section
			aria-labelledby={`${id}-title`}
			className="min-w-0 space-y-3 border-t border-zinc-800 pt-3"
		>
			<h4 id={`${id}-title`} className="font-medium text-xs text-zinc-200">
				{ja ? "ラダーの変化" : "Ladder comparison"}
			</h4>
			<div className="max-w-sm">
				<PerTitleSimulatorBitrateField
					id={`${id}-analysis-input`}
					label={ja ? "解析値の仮定 (kbps)" : "Assumed analysis bitrate (kbps)"}
					value={analysisValue}
					onChange={(value) => setAnalysisInput(value ?? Number.NaN)}
					minimum={1}
					maximum={axis.maximum}
					sliderLabel={
						ja
							? "解析値の仮定のスライダー (kbps)"
							: "Assumed analysis bitrate slider (kbps)"
					}
				/>
			</div>
			<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
				<PerTitleOutputChart
					proposal={preview.current}
					axis={axis}
					analysisInput={analysisValue}
					title={ja ? "現在のラダー" : "Current ladder"}
				/>
				{preview.status === "ready" && preview.after ? (
					<PerTitleOutputChart
						proposal={preview.after}
						axis={axis}
						analysisInput={analysisValue}
						title={afterTitle}
					/>
				) : (
					<p role="status" className="text-amber-300 text-xs">
						{preview.status === "conflict"
							? ja
								? "選択した変更は条件が競合するため、変更後のラダーを表示できません。"
								: "The selected changes conflict; the after ladder is unavailable."
							: ja
								? "現在の設定ではこの調整案を比較できません。再評価してください。"
								: "This adjustment cannot be compared with the current settings. Re-evaluate."}
					</p>
				)}
			</div>
			<p className="text-xs text-zinc-400">
				{ja
					? "実際の本数・解像度・画質は素材で確認します。"
					: "Verify actual rendition count, resolutions and quality with media."}
			</p>
		</section>
	);
}
