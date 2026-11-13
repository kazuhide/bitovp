import { ApiError } from "@/lib/api";
import { useT } from "@/lib/i18n/context";

export function favoriteErrorCode(error: unknown) {
	if (
		error instanceof ApiError &&
		error.details &&
		typeof error.details === "object" &&
		"code" in error.details
	)
		return String(error.details.code);
	return error instanceof Error ? error.message : "FAVORITES_REQUEST_FAILED";
}
export function useFavoriteLabels() {
	const ja = useT().locale === "ja";
	return {
		title: ja ? "固定素材" : "Fixed sources",
		add: ja ? "固定素材を追加" : "Add fixed source",
		saveTitle: ja ? "固定素材を保存" : "Save fixed source",
		label: ja ? "表示名" : "Display name",
		kind: ja ? "素材の種類" : "Source type",
		save: ja ? "保存" : "Save",
		cancel: ja ? "キャンセル" : "Cancel",
		retry: ja ? "再試行" : "Retry",
		video: ja ? "映像" : "Video",
		audio: ja ? "音声" : "Audio",
		image: ja ? "画像" : "Image",
		empty: ja ? "固定素材はありません" : "No fixed sources",
		pin: (name: string) =>
			ja ? `${name}を固定素材へ保存` : `Save ${name} as a fixed source`,
		pinned: (name: string) =>
			ja ? `${name}は固定素材に保存済み` : `${name} is already a fixed source`,
		use: (name: string) =>
			ja ? `${name}を素材へ追加` : `Add ${name} to sources`,
		logo: (name: string) =>
			ja ? `${name}を出力ロゴに使用` : `Use ${name} as an output logo`,
		imageClip: (name: string) =>
			ja ? `${name}をV1に配置` : `Place ${name} on V1`,
		placeImage: ja ? "V1へ配置" : "V1",
		logoAction: ja ? "ロゴ" : "Logo",
		remove: (name: string) =>
			ja ? `${name}を固定素材から外す` : `Remove ${name} from fixed sources`,
		logoInfo: ja
			? "出力ロゴはフィルター設定で調整できます。入力プレビューには表示されません。"
			: "Adjust output logos in the filter settings. Input previews do not display them.",
		unavailable: ja ? "資格情報がありません" : "Credential unavailable",
		unsupported: ja ? "このストレージは未対応です" : "Storage is unsupported",
		needsVideo: ja
			? "先に映像素材を追加してください"
			: "Add a video source first",
		cap: ja ? "素材の上限に達しています" : "Source limit reached",
		error: (code: string) => {
			switch (code) {
				case "FAVORITES_INVALID":
					return ja
						? "固定素材の保存データを読み取れません。管理者に確認してください。"
						: "Stored fixed source data is invalid. Ask an administrator to check it.";
				case "FAVORITES_LIMIT":
					return ja
						? "固定素材は64件まで保存できます"
						: "You can save up to 64 fixed sources";
				case "FAVORITES_CONFLICT":
					return ja
						? "別の変更と重なりました。もう一度操作してください。"
						: "Another update overlapped. Try again.";
				case "SOURCE_CREDENTIAL_NOT_FOUND":
				case "FAVORITE_UNAVAILABLE":
					return ja ? "資格情報がありません" : "Credential unavailable";
				case "FAVORITE_PROVIDER_UNSUPPORTED":
					return ja
						? "このストレージの画像ロゴには対応していません"
						: "Image logos are unsupported for this storage";
				case "LOGO_NEEDS_VIDEO":
					return ja
						? "先に映像素材を追加してください"
						: "Add a video source first";
				case "FAVORITE_SOURCE_LIMIT":
					return ja ? "素材の上限に達しています" : "Source limit reached";
				default:
					return ja
						? "固定素材を読み込めませんでした"
						: "Could not load fixed sources";
			}
		},
	};
}
