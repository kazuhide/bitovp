import type { SiteLocale } from "../site-config";

const english = {
	title: "Interactive demo — bitovp",
	bannerTitle: "Interactive demo.",
	bannerBody:
		"Sample data and simulated jobs. Nothing is sent to an encoding service.",
	limitsLabel: "Demo limits",
	limitsBody:
		"You can configure and create simulated VOD jobs and immediate Live channels. Scheduled starts, runtime caps, media playback, and quality computation require the installed application. Quality scores here are illustrative.",
	reset: "Reset demo",
	about: "About bitovp",
	workspace: "Public demo workspace",
	scopeTitle: "Explore the demo",
	scopeBody:
		"This demo includes the dashboard, VOD jobs, Live channels, quality reports, and their encoding forms. Other workspace tools are available in the installed application.",
	dashboardLink: "View the sample dashboard",
	jobsLink: "Browse VOD jobs",
	newJobLink: "Configure a VOD encoding",
	channelsLink: "Explore Live channels",
	newChannelLink: "Configure a Live channel",
	qualityLink: "Inspect illustrative quality reports",
	guideLink: "Read the full user guide",
	createJob: "Create demo job",
	createChannel: "Create demo channel",
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
		bannerBody:
			"サンプルデータで画面を試せます。ジョブはシミュレーションで、エンコードサービスには送信しません。",
		limitsLabel: "デモで利用できる範囲",
		limitsBody:
			"VODジョブと、すぐに開始するLiveチャンネルの設定・作成を試せます。スケジュール実行、稼働時間の上限設定、動画の再生、画質の計測は、インストールしたアプリで利用します。ここで表示する画質スコアは説明用の例です。",
		reset: "デモを初期状態に戻す",
		about: "bitovpについて",
		workspace: "デモ用ワークスペース",
		scopeTitle: "デモで試せる機能",
		scopeBody:
			"ダッシュボード、VODジョブ、Liveチャンネル、画質レポートを閲覧し、エンコードの設定を試せます。それ以外の機能は、インストールしたアプリで利用できます。",
		dashboardLink: "サンプルのダッシュボードを見る",
		jobsLink: "VODジョブを見る",
		newJobLink: "VODエンコードを設定する",
		channelsLink: "Liveチャンネルを見る",
		newChannelLink: "Liveチャンネルを設定する",
		qualityLink: "画質レポートの表示例を見る",
		guideLink: "ユーザーガイドを読む（英語）",
		createJob: "デモジョブを作成",
		createChannel: "デモチャンネルを作成",
		screenError: "このデモ画面を読み込めませんでした。",
		returnDashboard: "ダッシュボードに戻る",
		loading: "画面を読み込んでいます…",
		limitation:
			"この操作はデモでは利用できません。スケジュール実行や稼働時間の上限設定は、インストールしたアプリでお試しください。クラウドには何も送信していません。",
		downloadError: "このファイルはデモではダウンロードできません。",
	},
};
