import { useT } from "@/lib/i18n/context";

const en = {
	title: "Place image on V1",
	duration: "Display duration (seconds)",
	placement: "Placement",
	append: "Append to program",
	overwrite: "Overwrite video from playhead",
	folder: "Prepared source folder",
	chooseFolder: "Choose folder",
	noFolder: "Choose where to save the prepared source.",
	folderHint:
		"The prepared clip is saved here for preview and encoding. The original image is retained.",
	place: "Place",
	preparing: "Preparing image…",
	retry: "Retry",
	cancel: "Cancel",
	range:
		"Use 1–60 seconds. An overwrite must fit within the remaining program.",
	appendHint: "Adds the image and silence after the program.",
	overwriteHint: "Replaces V1 only; A1 is retained.",
	failure:
		"Image preparation failed. Check the source and destination access, then retry.",
	changed:
		"The edit changed while preparing this image. Close this dialog and select the image again.",
	tooLarge: "Use a PNG/JPEG up to 32 MiB and 8.8 million pixels.",
	unverified:
		"The source version could not be verified. Select the image again.",
	unsupported:
		"Choose supported S3-compatible or GCS HMAC storage with read and write access.",
};
const ja: typeof en = {
	title: "画像をV1に配置",
	duration: "表示時間（秒）",
	placement: "配置方法",
	append: "末尾に追加",
	overwrite: "再生位置から映像を上書き",
	folder: "準備した素材の保存先",
	chooseFolder: "保存先を選択",
	noFolder: "準備した素材を保存するフォルダーを選択してください。",
	folderHint:
		"プレビューとエンコードで使う素材をここへ保存します。元の画像は保持します。",
	place: "配置",
	preparing: "画像を準備中…",
	retry: "再試行",
	cancel: "キャンセル",
	range:
		"1〜60秒で指定してください。上書きはシーケンスの残り時間内に収めます。",
	appendHint: "シーケンスの末尾へ画像と無音を追加します。",
	overwriteHint: "V1だけを差し替え、A1は維持します。",
	failure:
		"画像を準備できませんでした。素材と保存先のアクセス権限を確認して再試行してください。",
	changed:
		"準備中に編集内容が変わりました。この画面を閉じ、画像を選び直してください。",
	tooLarge: "32MiB・約880万画素以内のPNG／JPEGを選択してください。",
	unverified:
		"素材のバージョンを確認できませんでした。画像を選び直してください。",
	unsupported: "読み書き可能なS3互換またはGCS HMACの保存先を選択してください。",
};
export function useImagePlacementLabels() {
	const { locale } = useT();
	const labels = locale === "ja" ? ja : en;
	return {
		...labels,
		error: (code: string) => {
			if (["SOURCE_READ_LIMIT", "IMAGE_UNSUPPORTED"].includes(code))
				return labels.tooLarge;
			if (["SOURCE_CHANGED", "SOURCE_UNVERIFIED"].includes(code))
				return labels.unverified;
			if (code === "IMAGE_OUTPUT_UNSUPPORTED") return labels.unsupported;
			if (code === "IMAGE_EDIT_CHANGED") return labels.changed;
			return labels.failure;
		},
	};
}
