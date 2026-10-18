"use client";

import Link from "next/link";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { InfoHint } from "@/components/ui/info-hint";
import { canAccess, pageAccess } from "@/lib/auth/audience";
import { useRoleView } from "@/lib/auth/use-session";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";

/** Direct settings areas. Personal preferences live on the landing page;
 * pageAccess remains the authority for each card's role visibility. */
type Area = {
	titleKey: MessageKey;
	href: string;
	captionKey: MessageKey;
	/** User management exists only when AUTH_MODE=users. Its ADMIN floor is
	 * supplied by `pageAccess`, alongside every other restricted child. */
	usersModeOnly?: boolean;
};

const WORKSPACE: ReadonlyArray<Area> = [
	{
		titleKey: "branding.title",
		href: "/settings/branding",
		captionKey: "branding.scope",
	},
	{
		titleKey: "settings.bitmovinAccounts",
		href: "/settings/bitmovin",
		captionKey: "settings.apiKeyWriteOnlyOrgId",
	},
	{
		titleKey: "settingsX.features",
		href: "/settings/features",
		captionKey: "settingsX.featuresCaption",
	},
	{
		titleKey: "settingsX.player",
		href: "/settings/player",
		captionKey: "settingsX.playerCaption",
	},
	{
		titleKey: "settingsX.notifications",
		href: "/settings/notifications",
		captionKey: "settings.notificationsCaption",
	},

	{
		titleKey: "vmafSettings.title",
		href: "/settings/vmaf",
		captionKey: "vmafSettings.intro",
	},
	{
		titleKey: "settings.storageCredentials",
		href: "/settings/credentials",
		captionKey: "settings.s3S3RoleGenericS3Akamai",
	},
	{
		titleKey: "settingsX.webhooks",
		href: "/settings/webhooks",
		captionKey: "settings.bitmovinNotificationReceiverSignatureVerificatio",
	},
	{
		titleKey: "settingsX.infrastructure",
		href: "/settings/infrastructure",
		captionKey: "settings.cloudConnectAwsGceAzureAkamai",
	},
	{
		// "Live", not "Live Channels" — the channel LIST is at /live; this card is the
		// account-level live resources page (review catch).
		titleKey: "settingsX.live",
		href: "/settings/live",
		captionKey: "settings.reservedStreamKeysCreateDeleteUnassign",
	},
	{
		titleKey: "watch.title",
		href: "/settings/watch-folders",
		captionKey: "watch.explainer",
	},
	{
		titleKey: "settingsX.apiCoverage",
		href: "/settings/api-coverage",
		captionKey: "settingsX.apiCoverageCaption",
	},
];

const ACCESS: ReadonlyArray<Area> = [
	{
		titleKey: "tenant.organizations",
		href: "/settings/organizations",
		captionKey: "tenant.organizationsCaption",
		usersModeOnly: true,
	},
	{
		titleKey: "tenant.accessAudit",
		href: "/settings/access-audit",
		captionKey: "tenant.accessCaption",
		usersModeOnly: true,
	},
	{
		titleKey: "settingsX.apiTokens",
		href: "/settings/tokens",
		captionKey: "settings.apiTokensCaption",
	},
	{
		titleKey: "settingsX.users",
		href: "/settings/users",
		captionKey: "settingsX.usersCaption",
		usersModeOnly: true,
	},
];

// : destructive, so it sits last rather than beside the
// everyday configuration areas.
const DANGER: ReadonlyArray<Area> = [
	{
		titleKey: "settingsX.reset",
		href: "/settings/reset",
		captionKey: "settingsX.resetCaption",
	},
];

export function SettingsAreas() {
	const { t } = useT();
	const { view } = useRoleView();
	const visible = (area: Area) =>
		canAccess(pageAccess(area.href), view) &&
		// review-286 M5: password/none are single-owner and can enter every
		// role floor, but Users would still dead-end because no user model
		// exists there. Preserve that availability rule independently.
		(!area.usersModeOnly || view.kind === "role");
	const access = ACCESS.filter(visible);
	return (
		<section>
			<div className="flex items-center gap-2">
				<h1 className="font-semibold text-xl text-zinc-50">
					{t("nav.settings")}
				</h1>
				<InfoHint
					labelFor={t("nav.settings")}
					text={t("settings.workspaceConfiguration")}
				/>
			</div>
			<div className="mt-6 grid grid-cols-1 gap-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-5 md:grid-cols-2">
				<LocaleSwitcher select />
				<ThemeSwitcher />
			</div>
			<Grid areas={WORKSPACE.filter(visible)} />
			{access.length > 0 ? (
				<>
					<h2 className="mt-8 font-medium text-sm text-zinc-300">
						{t("settingsX.groupAccess")}
					</h2>
					<Grid areas={access} />
				</>
			) : null}
			<Grid areas={DANGER.filter(visible)} className="mt-8" />
		</section>
	);
}

function Grid({
	areas,
	className = "mt-4",
}: {
	areas: ReadonlyArray<Area>;
	className?: string;
}) {
	const { t } = useT();
	return (
		<div className={`${className} grid grid-cols-1 gap-4 md:grid-cols-2`}>
			{areas.map((area) => (
				<Link
					key={area.href}
					href={area.href}
					className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-5 transition-colors hover:border-zinc-600 hover:bg-zinc-900"
				>
					<h2 className="font-medium text-sm text-zinc-100">
						{t(area.titleKey)}
					</h2>
					{area.href === "/settings/reset" ? (
						<p className="mt-3 text-xs text-zinc-500">{t(area.captionKey)}</p>
					) : null}
				</Link>
			))}
		</div>
	);
}
