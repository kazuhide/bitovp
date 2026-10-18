import type { UserRole } from "@bitovp/db";
import {
	Activity,
	Film,
	HardDrive,
	LayoutDashboard,
	LayoutTemplate,
	type LucideIcon,
	Radio,
	RefreshCcw,
	Settings,
} from "lucide-react";
import { type Audience, pageAccess } from "@/lib/auth/audience";
import type { MessageKey } from "@/lib/i18n";

export type NavItem = {
	/** A catalogue key, not copy — see lib/i18n. */
	labelKey: MessageKey;
	href: string;
	icon: LucideIcon;
	/**
	 * Who the destination is for, and the role floor its data sits behind —
	 * READ from `PAGE_ACCESS_RULES` by `navItem` below rather than typed here,
	 * so the link and the page it opens cannot disagree about who may enter
	 * (audit 5c3d97ca MEDIUM-5). `nav-list.tsx` filters on them; the values
	 * are pinned per item in nav-list.test.tsx.
	 */
	audience: Audience;
	minRole: UserRole;
};

export type NavSection = {
	labelKey: MessageKey;
	items: NavItem[];
};

function navItem(
	labelKey: MessageKey,
	href: string,
	icon: LucideIcon,
): NavItem {
	const { audience, minRole } = pageAccess(href);
	return { labelKey, href, icon, audience, minRole };
}

/** Information architecture per  §1. */
export const NAV_SECTIONS: NavSection[] = [
	{
		labelKey: "nav.sectionPlatform",
		items: [
			navItem("nav.dashboard", "/", LayoutDashboard),
			navItem("nav.vodJobs", "/vod/jobs", Film),
			navItem("nav.liveChannels", "/live", Radio),
			navItem("nav.pseudoLiveFeeds", "/live/feeders", RefreshCcw),
			navItem("nav.vmafLab", "/qc", Activity),
		],
	},
	{
		labelKey: "nav.sectionLibrary",
		items: [
			navItem("nav.contentLibrary", "/library", Film),
			navItem("nav.storage", "/storage", HardDrive),
			navItem("nav.templates", "/presets", LayoutTemplate),
		],
	},
	{
		labelKey: "nav.sectionSystem",
		items: [navItem("nav.settings", "/settings", Settings)],
	},
];
