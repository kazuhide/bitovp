"use client";
import { useT } from "@/lib/i18n/context";

const en = {
	open: "Revise this proposal",
	title: "Revise the edit",
	currentFraming: "Change this edit's framing",
	framingHelp:
		"Keep the selected scenes and captions. You can undo the change.",
	fill: "Crop to fill",
	auto: "Full image + blurred background",
	fit: "Full image + black bars",
	newTitle: "Create another proposal",
	newHelp:
		"Use the source video and AISA again. Your current edit stays in the library.",
	create: "Create another proposal",
	saveCreate: "Save and create another proposal",
	savingHelp: "Current changes will be saved before the new proposal starts.",
	missingAnalysis:
		"Choose a source with AISA metadata to create another proposal.",
	loading: "Checking the editing source…",
	loadFailed: "The editing source could not be checked.",
	sourceUnavailable:
		"The video or AISA metadata used by this edit is no longer available for a new proposal.",
	retry: "Try again",
};
const ja: Record<keyof typeof en, string> = {
	open: "編集案を作り直す",
	title: "編集案を作り直す",
	currentFraming: "この編集の構図を変える",
	framingHelp: "場面と字幕を保って変更します。元に戻す操作もできます。",
	fill: "切り抜いて画面いっぱい",
	auto: "全体表示＋ぼかし背景",
	fit: "全体表示＋黒帯",
	newTitle: "設定を変えて別案を作成",
	newHelp: "元映像とAISAから再提案します。現在の編集案はライブラリに残ります。",
	create: "別案を作成",
	saveCreate: "保存して別案を作成",
	savingHelp: "現在の変更を保存してから、別案の作成を開始します。",
	missingAnalysis:
		"別案の作成には、AISAメタデータが関連付けられた映像が必要です。",
	loading: "編集元の映像を確認中…",
	loadFailed: "編集元の映像を確認できませんでした。",
	sourceUnavailable:
		"この編集で使った映像またはAISAメタデータを、別案の作成に利用できません。",
	retry: "再試行",
};
export function useReproposalCopy() {
	return useT().locale === "ja" ? ja : en;
}
