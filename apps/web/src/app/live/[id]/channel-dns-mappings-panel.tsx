"use client";

import { useQuery } from "@tanstack/react-query";
import type { LiveChannelStatus } from "@/app/live/live-shared";
import { CopyableId } from "@/components/copyable-id";
import { apiFetch } from "@/lib/api";
import { localizedCustomerError } from "@/lib/customer-error";
import { useT } from "@/lib/i18n/context";
import {
	type DnsMappingDto,
	LIST_LIMIT_MAX,
	type PageDto,
} from "@/lib/live-runtime/schemas";

/**
 * Read-only: which DNS hostnames currently resolve to THIS channel's encoder.
 * Creating/deleting mappings lives on the account-level Live settings surface —
 * a mapping outlives any single channel view, so managing it here would invite
 * deleting one another channel still points at.
 */
export function ChannelDnsMappingsPanel({
	channelId,
	status,
	bitmovinAccountId,
}: {
	channelId: string;
	status: LiveChannelStatus;
	bitmovinAccountId: string | null;
}) {
	const { t } = useT();
	const enabled = status === "RUNNING" && bitmovinAccountId !== null;
	const list = useQuery({
		queryKey: ["live-channel-dns-mappings", channelId],
		enabled,
		queryFn: () =>
			apiFetch<PageDto<DnsMappingDto>>(
				`/api/live-channels/${channelId}/dns-mappings?bitmovinAccountId=${bitmovinAccountId}&limit=${LIST_LIMIT_MAX}`,
			),
	});

	if (!enabled) {
		return (
			<p className="mt-2 text-sm text-zinc-500">{t("dns.needsRunning")}</p>
		);
	}
	if (list.isLoading) {
		return (
			<div
				role="status"
				aria-busy="true"
				aria-label={t("dns.loading")}
				className="mt-2 h-12 animate-pulse rounded-md bg-zinc-900"
			/>
		);
	}
	if (list.isError) {
		return (
			<p role="alert" className="mt-2 text-red-400 text-sm">
				{t("uiX.failedToLoadDnsMappings")}
				{` ${localizedCustomerError(t, list.error, "common.requestFailed")}`}
			</p>
		);
	}
	const items = list.data?.items ?? [];
	if (items.length === 0) {
		return (
			<p role="status" className="mt-2 text-sm text-zinc-500">
				{t("prose.dnsNoMapping")}
			</p>
		);
	}
	return (
		<ul className="mt-2 divide-y divide-zinc-800 rounded-md border border-zinc-800">
			{items.map((mapping) => (
				<li key={mapping.id} className="flex items-center gap-3 px-3 py-2">
					<span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200">
						{mapping.hostname ?? mapping.subdomain}
					</span>
					{mapping.ip ? (
						<span className="shrink-0 font-mono text-[11px] text-zinc-500">
							→ {mapping.ip}
						</span>
					) : null}
					{mapping.hostname ? (
						<CopyableId value={mapping.hostname} label={t("dns.hostname")} />
					) : null}
				</li>
			))}
		</ul>
	);
}
