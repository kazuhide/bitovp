"use client";
import { useT } from "@/lib/i18n/context";

const en = {
	sourceTitle: "Source",
	resultTitle: "Edited result",
	chooseClip: "Select a clip on the timeline to view its source.",
	help: "Drag inside to move; use corners to resize.",
	tools: "Crop tool",
	moveTool: "Move",
	sizeTool: "Size",
	moveHelp: "Drag inside to move.",
	sizeHelp: "Drag a corner to resize.",
	details: "Crop controls",
	scope:
		"Adjust the crop in the selected scene. Tracked ranges use the existing movement; untracked ranges use a fixed crop.",
	keyboard:
		"Focus the crop or a corner and use the arrow keys. Hold Shift for larger steps. Release the key to apply; Escape cancels the adjustment.",
	lockedHelp:
		"Some display settings or access permissions allow viewing only. Pause on a ready source frame before editing.",
	paused: "Pause the video to adjust the crop.",
	waiting: "Preparing the source frame.",
	locked: "The crop cannot be changed in this view.",
	move: "Move crop",
	nw: "Resize crop from top left",
	ne: "Resize crop from top right",
	sw: "Resize crop from bottom left",
	se: "Resize crop from bottom right",
	changed: "Crop adjustment applied.",
	canceled: "Crop adjustment canceled.",
};
const ja: typeof en = {
	sourceTitle: "元映像",
	resultTitle: "編集結果",
	chooseClip: "タイムラインで場面を選択すると、元映像を表示します。",
	help: "枠内で移動、四隅で拡縮。",
	tools: "切り抜き操作",
	moveTool: "移動",
	sizeTool: "サイズ",
	moveHelp: "枠内をドラッグして移動。",
	sizeHelp: "四隅をドラッグして拡縮。",
	details: "切り抜き操作の詳細",
	scope:
		"選択中の場面の切り抜きを調整します。追跡区間では既存の動きを使い、未追跡区間では固定構図を変えます。",
	keyboard:
		"枠や四隅にフォーカスして矢印キーで調整できます。Shiftで大きく動かし、キーを離すと確定します。Escapeで調整を取り消します。",
	lockedHelp:
		"表示設定や権限によっては、枠の確認だけができます。編集するときは、元映像の準備ができた位置で一時停止してください。",
	paused: "一時停止すると切り抜きを調整できます。",
	waiting: "元映像のフレームを準備しています。",
	locked: "この表示では切り抜き枠を変更できません。",
	move: "切り抜き枠を移動",
	nw: "左上から切り抜き枠を拡縮",
	ne: "右上から切り抜き枠を拡縮",
	sw: "左下から切り抜き枠を拡縮",
	se: "右下から切り抜き枠を拡縮",
	changed: "切り抜きの調整を反映しました。",
	canceled: "切り抜きの調整を取り消しました。",
};
export function useSourceCropCopy() {
	return useT().locale === "ja" ? ja : en;
}
