"use client";

import { useQuery } from "@tanstack/react-query";
import { ApiError, apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import {
	type ResourceIdCandidate,
	ResourceIdPicker,
} from "./resource-id-picker";

/**
 * : the wizard's infrastructureId / staticIpId fields were free-text
 * ids with "manage in Settings" copy. These wrap `ResourceIdPicker` over the
 * infra proxy routes — candidates to click in the common case, paste-an-id as
 * the unchanged fallback (the picker's contract: every list is incomplete by
 * construction).
 *
 * Both take the SELECTED Bitmovin account: candidates are meaningless across
 * accounts, and an empty account id disables the query rather than listing
 * the default account's resources under a different account's plan.
 */

type InfrastructuresWire = {
	/** Same defence as `skipped`: absence must not crash the render
	    (review-179 N7 — the guard covered one field of the population). */
	items?: { id: string; name: string | null; kind: string }[];
	/** Optional on the wire: a payload without it must not crash the render
	    (review-178 O1 — an unguarded `.length` blanked the whole wizard). */
	skipped?: string[];
};

export function InfrastructureIdPicker({
	inputId,
	value,
	onChange,
	bitmovinAccountId,
}: {
	inputId: string;
	value: string;
	onChange: (value: string) => void;
	bitmovinAccountId: string | undefined;
}) {
	const { t } = useT();
	const list = useQuery({
		queryKey: ["infrastructures", bitmovinAccountId],
		enabled: Boolean(bitmovinAccountId),
		queryFn: () =>
			apiFetch<InfrastructuresWire>(
				`/api/infrastructure/infrastructures?bitmovinAccountId=${encodeURIComponent(
					bitmovinAccountId ?? "",
				)}`,
			),
	});
	const candidates: ResourceIdCandidate[] = (list.data?.items ?? []).map(
		(item) => ({
			id: item.id,
			label: item.name ?? item.id,
			badge: item.kind,
		}),
	);
	return (
		<ResourceIdPicker
			inputId={inputId}
			value={value}
			onChange={onChange}
			candidates={candidates}
			isLoading={list.isLoading && Boolean(bitmovinAccountId)}
			{...(list.isError
				? {
						errorMessage:
							t("ui.couldNotListInfrastructures") +
							(list.error instanceof ApiError
								? ` (${list.error.message})`
								: ""),
					}
				: {})}
			{...(list.data && (list.data.skipped?.length ?? 0) > 0
				? {
						truncatedMessage: t("ui.infrastructureFamiliesSkipped", {
							families: (list.data.skipped ?? []).join(", "),
						}),
					}
				: {})}
			emptyMessage={t("ui.noInfrastructuresInAccount")}
			listLabel={t("ui.infrastructuresInAccount")}
			copyLabel={t("ui.infrastructureIdCopyLabel")}
		/>
	);
}

type StaticIpsWire = {
	items?: { id: string; ipAddress?: string | null; status?: string | null }[];
	totalCount?: number;
};

export function StaticIpIdPicker({
	inputId,
	value,
	onChange,
	bitmovinAccountId,
}: {
	inputId: string;
	value: string;
	onChange: (value: string) => void;
	bitmovinAccountId: string | undefined;
}) {
	const { t } = useT();
	const list = useQuery({
		queryKey: ["static-ips", bitmovinAccountId],
		enabled: Boolean(bitmovinAccountId),
		queryFn: () =>
			// limit=100 (C6 max): the route's schema DEFAULTS to 25, which capped
			// the picker silently (review of PR #176, I2 — PrewarmedPoolPicker
			// already sent 100).
			apiFetch<StaticIpsWire>(
				`/api/infrastructure/static-ips?bitmovinAccountId=${encodeURIComponent(
					bitmovinAccountId ?? "",
				)}&limit=100`,
			),
	});
	const candidates: ResourceIdCandidate[] = (list.data?.items ?? []).map(
		(item) => ({
			id: item.id,
			label: item.ipAddress ?? item.id,
			...(item.status ? { badge: item.status } : {}),
		}),
	);
	return (
		<ResourceIdPicker
			inputId={inputId}
			value={value}
			onChange={onChange}
			candidates={candidates}
			isLoading={list.isLoading && Boolean(bitmovinAccountId)}
			{...(list.isError
				? {
						errorMessage:
							t("ui.couldNotListStaticIps") +
							(list.error instanceof ApiError
								? ` (${list.error.message})`
								: ""),
					}
				: {})}
			{...(list.data &&
			list.data.totalCount !== undefined &&
			list.data.totalCount > (list.data.items?.length ?? 0)
				? {
						truncatedMessage: t("ui.staticIpsTruncated", {
							shown: list.data.items?.length ?? 0,
							total: list.data.totalCount,
						}),
					}
				: {})}
			emptyMessage={t("ui.noStaticIpsInAccount")}
			listLabel={t("ui.staticIpsInAccount")}
			copyLabel={t("ui.staticIpIdCopyLabel")}
		/>
	);
}
