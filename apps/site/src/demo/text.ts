import type { SiteLocale } from "../site-config";

const english = {
	title: "Interactive demo — bitovp",
	bannerTitle: "Interactive demo.",
	bannerBody:
		"Sample data and simulated jobs. Nothing is sent to an encoding service.",
	limitsLabel: "Demo limits",
	limitsBody:
		"Media playback, encoding input preparation, scheduled starts, runtime caps, and quality computation require the installed application. Logs, analysis results, and quality scores in the demo are samples.",
	reset: "Reset demo",
	about: "About bitovp",
	workspace: "Public demo workspace",
	scopeTitle: "Explore the demo",
	scopeBody:
		"Try VOD timeline editing, Live and pseudo-live monitoring, AISA scene results, clip editing, and quality reports using sample data.",
	dashboardLink: "View the sample dashboard",
	jobsLink: "Browse VOD jobs",
	newJobLink: "Configure a VOD encoding",
	channelsLink: "Explore Live channels",
	newChannelLink: "Configure a Live channel",
	feedersLink: "Inspect a pseudo-live feed",
	libraryLink: "Browse the sample content library",
	qualityLink: "Inspect illustrative quality reports",
	guideLink: "Read the full user guide",
	createJob: "Create demo job",
	createChannel: "Create demo channel",
	timelinePreviewNotice:
		"Edit the sample timeline here. Playback and encoding input preparation are available in the installed app.",
	screenError: "This demo screen could not be loaded.",
	returnDashboard: "Return to the dashboard",
	loading: "Loading demo screen…",
	limitation:
		"This operation is unavailable in the demo. Scheduled actions and runtime caps require the installed application. No cloud request was sent.",
	downloadError: "This download is unavailable in the demo.",
};

export const DEMO_TEXT: Record<SiteLocale, typeof english> = {
	en: english,
	ja: {
		title: "操作デモ — bitovp",
		bannerTitle: "操作デモ",
		bannerBody: "サンプルデータによるデモです。実際のエンコードは行いません。",
		limitsLabel: "デモで利用できる範囲",
		limitsBody:
			"動画再生、エンコード用素材の準備、スケジュール実行、稼働時間の上限設定、画質測定にはインストール版が必要です。デモのログ、解析結果、画質スコアはサンプルです。",
		reset: "デモを初期状態に戻す",
		about: "bitovp について",
		workspace: "デモ用ワークスペース",
		scopeTitle: "デモで試せる機能",
		scopeBody:
			"サンプルデータで VOD のタイムライン編集、Live・擬似ライブの監視、AISA のシーン解析結果、クリップ編集、画質レポートを試せます。",
		dashboardLink: "サンプルのダッシュボードを見る",
		jobsLink: "VOD ジョブ一覧",
		newJobLink: "VOD の設定画面",
		channelsLink: "Live チャンネル一覧",
		newChannelLink: "Live の設定画面",
		feedersLink: "擬似ライブの配信ログを見る",
		libraryLink: "サンプルのコンテンツライブラリを開く",
		qualityLink: "画質レポートの表示例を見る",
		guideLink: "ユーザーガイド",
		createJob: "デモジョブを作成",
		createChannel: "デモチャンネルを作成",
		timelinePreviewNotice:
			"サンプルのタイムラインを編集できます。動画再生とエンコード用素材の準備はインストール版で利用できます。",
		screenError: "このデモ画面を読み込めませんでした。",
		returnDashboard: "ダッシュボードに戻る",
		loading: "画面を読み込んでいます…",
		limitation:
			"デモでは利用できない操作です。スケジュール実行や稼働時間の上限設定には、インストールしたアプリが必要です。クラウドへの送信は行っていません。",
		downloadError: "このファイルはデモではダウンロードできません。",
	},
};
