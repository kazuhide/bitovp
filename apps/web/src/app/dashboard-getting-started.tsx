"use client";

import type { CredentialSummaryWire } from "@bitovp/core";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { ArrowRight, Check } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useId } from "react";
import {
	liveOutputKindForProvider,
	outputKindForProvider,
} from "@/app/vod/new/stream-model";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { canAccess, pageAccess } from "@/lib/auth/audience";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useRoleView } from "@/lib/auth/use-session";
import { useT } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

type WorkPage = { items: { id: string }[] };

/** Initial setup is organization-wide, independent of provider usage/date filters. */
export function DashboardGettingStarted({
	accounts,
}: {
	accounts: UseQueryResult<{ id: string }[], Error>;
}) {
	const { t } = useT();
	const headingId = useId();
	const permissions = useRoleView();
	const canRegisterAccount = useMutationAccess("settings.bitmovin");
	const canRegisterOutput = useMutationAccess("settings.credentials");
	const jobs = useQuery({
		queryKey: ["encoding-jobs", "getting-started"],
		refetchOnMount: "always",
		refetchOnWindowFocus: "always",
		refetchOnReconnect: "always",
		queryFn: ({ signal }) =>
			apiFetch<WorkPage>("/api/encoding-jobs?limit=1", { signal }),
	});
	const channels = useQuery({
		queryKey: ["live-channels", "getting-started"],
		refetchOnMount: "always",
		refetchOnWindowFocus: "always",
		refetchOnReconnect: "always",
		queryFn: ({ signal }) =>
			apiFetch<WorkPage>("/api/live-channels?limit=1", { signal }),
	});
	// One known job/channel is sufficient, even if the other request fails.
	const hasWork = !!(jobs.data?.items.length || channels.data?.items.length);
	const credentials = useQuery({
		queryKey: ["credentials"],
		queryFn: () => apiFetch<CredentialSummaryWire[]>("/api/credentials"),
		enabled: !hasWork && jobs.isSuccess && channels.isSuccess,
	});
	// Account retrieval already has an error and retry in DashboardHome.
	if (hasWork || accounts.isError) return null;

	const queries = [accounts, jobs, channels, credentials];
	if (queries.some((query) => query.isError)) {
		return (
			<section className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900/40 p-5">
				<p role="alert" className="text-sm text-zinc-300">
					{t("dashboard.setupLoadFailed")}
				</p>
				<Button
					className="mt-3"
					variant="secondary"
					disabled={queries.some((query) => query.isFetching)}
					onClick={() => {
						for (const query of queries) {
							if (query.isError) void query.refetch();
						}
					}}
				>
					{t("common.retry")}
				</Button>
			</section>
		);
	}
	// A creation wizard may have just created the first job without invalidating
	// this cache. Reconfirm empty history before presenting the initial steps.
	if (
		jobs.fetchStatus !== "idle" ||
		channels.fetchStatus !== "idle" ||
		queries.some((query) => !query.isSuccess)
	) {
		return (
			<p role="status" className="mt-6 text-sm text-zinc-400">
				{t("dashboard.setupLoading")}
			</p>
		);
	}

	const hasAccount = !!accounts.data?.length;
	const hasVodOutput = !!credentials.data?.some(
		(credential) => outputKindForProvider(credential.provider) !== null,
	);
	const hasLiveOutput = !!credentials.data?.some(
		(credential) => liveOutputKindForProvider(credential.provider) !== null,
	);
	const hasOutput = hasVodOutput || hasLiveOutput;
	const canCreateVod = canAccess(pageAccess("/vod/new"), permissions.view);
	const canCreateLive = canAccess(pageAccess("/live/new"), permissions.view);
	const unresolved = permissions.view.kind === "unresolved";
	const registerHint = unresolved ? null : t("dashboard.setupAskAdministrator");

	return (
		<section
			aria-labelledby={headingId}
			className="mt-6 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40"
		>
			<div className="grid gap-6 p-5 sm:p-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] xl:gap-10">
				<div className="min-w-0">
					<p className="font-medium text-emerald-400 text-xs">
						{t("dashboard.setupEyebrow")}
					</p>
					<h2
						id={headingId}
						className="mt-2 font-semibold text-xl text-zinc-50"
					>
						{t("dashboard.setupHeading")}
					</h2>
					<p className="mt-3 max-w-prose text-sm text-zinc-400 leading-relaxed">
						{t("dashboard.setupIntro")}
					</p>
				</div>
				<ol className="min-w-0 divide-y divide-zinc-800">
					<SetupStep
						number={1}
						complete={hasAccount}
						current={!hasAccount}
						title={t("dashboard.setupAccount")}
						description={t("dashboard.setupAccountDescription")}
						action={
							!hasAccount && canRegisterAccount ? (
								<SetupLink href="/settings/bitmovin" primary>
									{t("dashboard.setupAddAccount")}
								</SetupLink>
							) : !hasAccount ? (
								registerHint
							) : null
						}
					/>
					<SetupStep
						number={2}
						complete={hasOutput}
						current={hasAccount && !hasOutput}
						title={t("dashboard.setupOutput")}
						description={t("dashboard.setupOutputDescription")}
						action={
							canRegisterOutput ? (
								<SetupLink
									href="/settings/credentials"
									primary={hasAccount && !hasOutput}
								>
									{t(
										hasOutput
											? "dashboard.setupManageOutputs"
											: "dashboard.setupAddOutput",
									)}
								</SetupLink>
							) : !hasOutput ? (
								registerHint
							) : null
						}
					/>
					<SetupStep
						number={3}
						current={hasAccount && hasOutput}
						title={t("dashboard.setupEncode")}
						description={t("dashboard.setupEncodeDescription")}
						action={
							<div className="space-y-3">
								{hasAccount && hasOutput ? (
									<div className="flex flex-wrap gap-2">
										{hasVodOutput && canCreateVod ? (
											<SetupLink href="/vod/new" primary>
												{t("dashboard.setupCreateVod")}
											</SetupLink>
										) : null}
										{hasLiveOutput && canCreateLive ? (
											<SetupLink href="/live/new" primary={!hasVodOutput}>
												{t("dashboard.setupCreateLive")}
											</SetupLink>
										) : null}
										{!unresolved && !canCreateVod && !canCreateLive
											? t("dashboard.setupAskOperator")
											: null}
									</div>
								) : (
									t("dashboard.setupPrepareFirst")
								)}
								{hasAccount && hasLiveOutput && !hasVodOutput ? (
									<p>{t("dashboard.setupLiveOnly")}</p>
								) : null}
							</div>
						}
					/>
				</ol>
			</div>
			<div className="border-zinc-800 border-t px-5 py-4 text-xs text-zinc-400 leading-relaxed sm:px-6">
				{unresolved ? (
					<p role="status" className="mb-2">
						{t(
							permissions.status === "pending"
								? "dashboard.setupPermissionsLoading"
								: "dashboard.setupPermissionsFailed",
						)}
						{permissions.status === "error" ? (
							<Button size="sm" variant="ghost" onClick={permissions.refetch}>
								{t("common.retry")}
							</Button>
						) : null}
					</p>
				) : null}
				<p>{t("dashboard.setupUsageNote")}</p>
			</div>
		</section>
	);
}

function SetupStep({
	number,
	title,
	description,
	complete = false,
	current = false,
	action,
}: {
	number: number;
	title: string;
	description: string;
	complete?: boolean;
	current?: boolean;
	action: ReactNode;
}) {
	const { t } = useT();
	return (
		<li
			aria-current={current ? "step" : undefined}
			className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-3 py-5 first:pt-0 last:pb-0"
		>
			<span
				aria-hidden="true"
				className={cn(
					"flex h-8 w-8 items-center justify-center rounded-full border font-medium text-xs",
					complete || current
						? "border-emerald-800 bg-emerald-950 text-emerald-300"
						: "border-zinc-700 text-zinc-400",
				)}
			>
				{complete ? <Check className="h-4 w-4" /> : number}
			</span>
			<div className="min-w-0">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
					<h3 className="font-medium text-sm text-zinc-100">{title}</h3>
					{complete ? (
						<span className="text-emerald-400 text-xs">
							{t("dashboard.setupRegistered")}
						</span>
					) : current ? (
						<span className="text-emerald-400 text-xs">
							{t("dashboard.setupNext")}
						</span>
					) : null}
				</div>
				<p className="mt-1 text-sm text-zinc-400 leading-relaxed">
					{description}
				</p>
			</div>
			{action ? (
				<div className="col-start-2 text-sm text-zinc-400 leading-relaxed">
					{action}
				</div>
			) : null}
		</li>
	);
}

function SetupLink({
	href,
	primary = false,
	children,
}: {
	href: string;
	primary?: boolean;
	children: ReactNode;
}) {
	return (
		<Link
			href={href}
			className={cn(
				"inline-flex min-h-11 max-w-full items-center justify-center gap-2 whitespace-normal rounded-md px-3 py-2 font-medium text-sm transition-colors focus-visible:outline-2 focus-visible:outline-emerald-500 focus-visible:outline-offset-2",
				primary
					? "bg-emerald-600 text-white hover:bg-emerald-500"
					: "border border-zinc-700 text-zinc-200 hover:bg-zinc-800",
			)}
		>
			{children}
			<ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0" />
		</Link>
	);
}
