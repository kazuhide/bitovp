"use client";

import {
	ChevronRight,
	Cloud,
	Layers,
	Link2,
	type LucideIcon,
	Play,
	UserRound,
	UsersRound,
} from "lucide-react";
import Link from "next/link";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { InfoHint } from "@/components/ui/info-hint";
import { canAccess, pageAccess } from "@/lib/auth/audience";
import { useRoleView } from "@/lib/auth/use-session";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";

type Area = {
	titleKey: MessageKey;
	href: string;
	captionKey?: MessageKey;
	/** Single-owner installs have no user membership management. */
	usersModeOnly?: boolean;
};

const CONNECTIONS: readonly Area[] = [
	{
		titleKey: "settings.bitmovinAccounts",
		href: "/settings/bitmovin",
		captionKey: "settingsCatalog.accountsCaption",
	},
	{
		titleKey: "settings.storageCredentials",
		href: "/settings/credentials",
		captionKey: "settingsCatalog.credentialsCaption",
	},
	{
		titleKey: "settingsCatalog.infrastructure",
		href: "/settings/infrastructure",
		captionKey: "settingsCatalog.infrastructureCaption",
	},
	{
		titleKey: "settingsCatalog.live",
		href: "/settings/live",
		captionKey: "settingsCatalog.liveCaption",
	},
];

const PLAYBACK: readonly Area[] = [
	{
		titleKey: "settingsX.player",
		href: "/settings/player",
		captionKey: "settingsCatalog.playerCaption",
	},
	{
		titleKey: "settingsCatalog.quality",
		href: "/settings/features",
		captionKey: "settingsCatalog.qualityCaption",
	},
];

const AUTOMATION: readonly Area[] = [
	{
		titleKey: "watch.title",
		href: "/settings/watch-folders",
		captionKey: "settingsCatalog.watchCaption",
	},
	{
		titleKey: "settingsCatalog.notifications",
		href: "/settings/notifications",
		captionKey: "settingsCatalog.notificationsCaption",
	},
	{
		titleKey: "settingsCatalog.events",
		href: "/settings/webhooks",
		captionKey: "settingsCatalog.eventsCaption",
	},
];

const ACCESS: readonly Area[] = [
	{
		titleKey: "settingsCatalog.organizations",
		href: "/settings/organizations",
		captionKey: "settingsCatalog.organizationsCaption",
		usersModeOnly: true,
	},
	{
		titleKey: "settingsCatalog.branding",
		href: "/settings/branding",
		captionKey: "settingsCatalog.brandingCaption",
	},
	{
		titleKey: "settingsX.users",
		href: "/settings/users",
		captionKey: "settingsCatalog.usersCaption",
		usersModeOnly: true,
	},
	{
		titleKey: "settingsX.apiTokens",
		href: "/settings/tokens",
		captionKey: "settingsCatalog.tokensCaption",
	},
	{
		titleKey: "tenant.accessAudit",
		href: "/settings/access-audit",
		captionKey: "settingsCatalog.auditCaption",
		usersModeOnly: true,
	},
];

const DIAGNOSTICS: readonly Area[] = [
	{
		titleKey: "settingsX.apiCoverage",
		href: "/settings/api-coverage",
	},
];

export function SettingsAreas() {
	const { t } = useT();
	const { view } = useRoleView();
	// The same floors as direct URLs and navigation; unresolved sessions fail closed.
	const visible = (area: Area) =>
		canAccess(pageAccess(area.href), view) &&
		(!area.usersModeOnly || view.kind === "role");
	return (
		<section>
			<div className="flex items-center gap-2">
				<h1 className="font-semibold text-2xl text-zinc-50">
					{t("nav.settings")}
				</h1>
				<InfoHint
					labelFor={t("nav.settings")}
					text={t("settings.workspaceConfiguration")}
				/>
			</div>
			<section
				aria-labelledby="settings-personal"
				className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3"
			>
				<PanelHeading
					id="settings-personal"
					icon={UserRound}
					titleKey="settingsCatalog.personal"
				/>
				<div className="grid grid-cols-1 gap-5 px-2 pt-2 sm:grid-cols-2 sm:gap-8 sm:px-10">
					<LocaleSwitcher select />
					<ThemeSwitcher />
				</div>
			</section>
			<div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
				<div className="min-w-0 space-y-6">
					<Category
						id="settings-connections"
						icon={Cloud}
						titleKey="settingsCatalog.connections"
						areas={CONNECTIONS.filter(visible)}
					/>
					<Category
						id="settings-automation"
						icon={Link2}
						titleKey="settingsCatalog.automation"
						areas={AUTOMATION.filter(visible)}
					/>
				</div>
				<div className="min-w-0 space-y-6">
					<Category
						id="settings-playback"
						icon={Play}
						titleKey="settingsCatalog.playback"
						areas={PLAYBACK.filter(visible)}
					/>
					<Category
						id="settings-access"
						icon={UsersRound}
						titleKey="settingsCatalog.access"
						areas={ACCESS.filter(visible)}
					/>
				</div>
			</div>
			<div className="mt-6">
				<Category
					id="settings-diagnostics"
					icon={Layers}
					titleKey="settingsCatalog.diagnostics"
					areas={DIAGNOSTICS.filter(visible)}
				/>
			</div>
			{canAccess(pageAccess("/settings/reset"), view) ? (
				<div className="mt-6 border-t border-zinc-800 pt-3">
					<Link
						href="/settings/reset"
						className="inline-flex min-h-11 items-center gap-2 rounded-md px-1 text-red-400 text-sm transition-colors hover:text-red-300 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red-400"
					>
						{t("settingsX.reset")}
						<ChevronRight aria-hidden className="h-4 w-4" />
					</Link>
				</div>
			) : null}
		</section>
	);
}

function PanelHeading({
	id,
	icon: Icon,
	titleKey,
}: {
	id: string;
	icon: LucideIcon;
	titleKey: MessageKey;
}) {
	const { t } = useT();
	return (
		<h2
			id={id}
			className="flex items-center gap-3 border-zinc-800 border-b px-2 pb-2 font-semibold text-lg text-zinc-100"
		>
			<Icon
				aria-hidden
				className="h-5 w-5 shrink-0 text-emerald-400"
				strokeWidth={1.5}
			/>
			{t(titleKey)}
		</h2>
	);
}

function Category({
	id,
	icon,
	titleKey,
	areas,
}: {
	id: string;
	icon: LucideIcon;
	titleKey: MessageKey;
	areas: readonly Area[];
}) {
	const { t } = useT();
	if (areas.length === 0) return null;
	return (
		<section
			aria-labelledby={id}
			className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3"
		>
			<PanelHeading id={id} icon={icon} titleKey={titleKey} />
			<ul className="divide-y divide-zinc-800">
				{areas.map((area) => (
					<li key={area.href}>
						<Link
							href={area.href}
							className="flex min-h-12 items-center justify-between gap-3 rounded-md px-3 py-1.5 transition-colors hover:bg-zinc-800/60 focus-visible:outline-2 focus-visible:outline-emerald-400 focus-visible:outline-offset-2"
						>
							<div className="min-w-0">
								<h3 className="break-words font-medium text-base text-zinc-100">
									{t(area.titleKey)}
								</h3>
								{area.captionKey ? (
									<p className="mt-0.5 break-words text-sm text-zinc-400">
										{t(area.captionKey)}
									</p>
								) : null}
							</div>
							<ChevronRight
								aria-hidden
								className="h-4 w-4 shrink-0 text-zinc-400"
							/>
						</Link>
					</li>
				))}
			</ul>
		</section>
	);
}
