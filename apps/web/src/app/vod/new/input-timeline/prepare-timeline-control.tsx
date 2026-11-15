"use client";
import {
	getVodInputTimelineDurationMs,
	MAX_VOD_INPUT_PREPARATION_DURATION_MS,
	type VodInputTimelineDocument,
	vodInputTimelineNeedsPreparation,
} from "@bitovp/core/vod-input-timeline";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/context";
import type { ImageOutputLocation } from "./image-placement-dialog";
import type { TimelinePreparation } from "./timeline-preparation";
import { usePreviewTask } from "./use-preview-task";

export function PrepareTimelineControl({
	document,
	probeId,
	output,
	preparationKey,
	ready,
	disabled,
	onChange,
}: {
	document: VodInputTimelineDocument;
	probeId: string | null;
	output?: ImageOutputLocation;
	preparationKey: string;
	ready: boolean;
	disabled: boolean;
	onChange?: (value: TimelinePreparation | null) => void;
}) {
	const { locale } = useT();
	const ja = locale === "ja";
	const [armed, setArmed] = useState<string | null>(null);
	const request =
		armed === preparationKey && ready && probeId && output
			? {
					kind: "TIMELINE_PREPARE" as const,
					probeId,
					document,
					output,
				}
			: null;
	const work = usePreviewTask(request, { debounceMs: 0 });
	const callback = useRef(onChange);
	callback.current = onChange;
	useEffect(() => {
		callback.current?.(
			work.ready ? { key: preparationKey, task: work.ready } : null,
		);
	}, [work.ready, preparationKey]);
	const required = vodInputTimelineNeedsPreparation(document);
	if (!required) return null;
	const missingOutput = !output?.credentialId || !output.bucket;
	const tooLong =
		getVodInputTimelineDurationMs(document) >
		MAX_VOD_INPUT_PREPARATION_DURATION_MS;
	const errors: Record<string, string> = {
		PREPARATION_SOURCE_UNSUPPORTED:
			"色特性を確認できる8bit・BT.709 SDRの映像が必要です。HDR・10bit・回転付き・アナモルフィック素材は今回の準備に対応していません。",
		PREPARATION_OUTPUT_UNSUPPORTED:
			"読み書きできるS3互換またはGCS HMACの出力ストレージが必要です。",
		PREPARATION_OUTPUT_UNVERIFIED:
			"保存した素材を検証できませんでした。再準備してください。",
		SOURCE_CHANGED:
			"素材が更新されています。素材を再解析して準備してください。",
		OUTPUT_LIMIT:
			"準備する素材が32GiBの上限に達しました。タイムラインを短くしてください。",
		PREPARATION_INTERVAL_TOO_SHORT:
			"1フレームより短い映像区間があります。区間を伸ばしてください。",
		TIMED_OUT:
			"準備が制限時間を超えました。タイムラインを短くして再試行してください。",
	};
	return (
		<div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
			<Button
				type="button"
				variant="secondary"
				disabled={
					disabled ||
					!ready ||
					missingOutput ||
					tooLong ||
					work.pending ||
					!!work.ready
				}
				onClick={() => {
					setArmed(preparationKey);
					if (armed === preparationKey) work.retry();
				}}
			>
				{work.ready
					? ja
						? "エンコード用素材：準備済み"
						: "Encoding input ready"
					: work.pending
						? ja
							? "エンコード用素材を準備中…"
							: "Preparing encoding input…"
						: ja
							? "エンコード用素材を準備"
							: "Prepare encoding input"}
			</Button>
			{work.pending && (
				<Button type="button" variant="ghost" onClick={() => setArmed(null)}>
					{ja ? "キャンセル" : "Cancel"}
				</Button>
			)}
			{missingOutput && (
				<span className="text-zinc-500">
					{ja ? "出力ストレージを選択してください。" : "Choose output storage."}
				</span>
			)}
			{tooLong && (
				<span role="status" className="text-amber-400">
					{ja
						? "エンコード用素材の準備は1時間までです。"
						: "Encoding input preparation supports up to one hour."}
				</span>
			)}
			{work.error && (
				<span role="status" className="text-amber-400">
					{ja
						? (errors[work.error] ??
							"準備できませんでした。素材と出力ストレージを確認して再試行してください。")
						: work.error}
				</span>
			)}
			<details className="text-xs text-zinc-500">
				<summary className="cursor-pointer">
					{ja ? "準備の仕様" : "Preparation details"}
				</summary>
				<p className="max-w-xl whitespace-normal pt-1">
					{ja
						? "V1とA1を結合し、出力ストレージへ保存します。主映像の解像度とFPSを保ち、8bit・BT.709 SDRをH.264 CRF12／AAC 320kbpsで再エンコードします（ロスレスではありません）。最大1時間・32GiB。編集を変更すると再準備が必要です。"
						: "Combines V1 and A1 in output storage at the primary video's resolution and FPS. Supports 8-bit BT.709 SDR, re-encoded as H.264 CRF12 / AAC 320kbps (not lossless). Maximum 1 hour / 32GiB. Editing invalidates this preparation."}
				</p>
			</details>
		</div>
	);
}
