export const SITE_BASE = "/bitovp/";
export const SITE_ORIGIN = "https://kazuhide.github.io";
export const SITE_LOCALES = ["en", "ja"] as const;
export type SiteLocale = (typeof SITE_LOCALES)[number];

export function localePath(locale: SiteLocale): string {
	return locale === "ja" ? `${SITE_BASE}ja/` : SITE_BASE;
}

export function localeFromPath(pathname: string): SiteLocale {
	const japanese = localePath("ja");
	return pathname === japanese.slice(0, -1) || pathname.startsWith(japanese)
		? "ja"
		: "en";
}

export const SITE_METADATA = {
	en: {
		title: "bitovp — VOD and Live encoding, in a graphical workspace",
		description:
			"A self-hosted graphical application for Bitmovin VOD and Live encoding. Explore the workflows, screenshots, and account-free interactive demo.",
	},
	ja: {
		title: "bitovp — VOD・Liveエンコードを設定するGUIアプリケーション",
		description:
			"BitmovinのVOD・Liveエンコードをブラウザで設定・管理するbitovp。設定画面や監視機能をスクリーンショットで紹介します。アカウント不要のデモも利用できます。",
	},
} satisfies Record<SiteLocale, { title: string; description: string }>;
