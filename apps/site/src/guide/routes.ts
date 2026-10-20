import { type SiteLocale, USER_GUIDE_URLS } from "../site-config";

export const GUIDE_CHAPTERS = [
	"getting-started",
	"overview",
	"basic-operations",
	"vod-encoding",
	"vod-settings",
	"vod-jobs",
	"live-encoding",
	"live-operations",
	"programs-and-recording",
	"pseudo-live",
	"quality",
	"usage",
	"content-and-storage",
	"presets-and-automation",
	"settings",
	"access-and-administration",
	"troubleshooting",
	"appendix",
] as const;
export type GuideChapterId = (typeof GUIDE_CHAPTERS)[number];

export function guidePath(locale: SiteLocale, chapter?: GuideChapterId) {
	return `${USER_GUIDE_URLS[locale]}${chapter ? `${chapter}/` : ""}`;
}
