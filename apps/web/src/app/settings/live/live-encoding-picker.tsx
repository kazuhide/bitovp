"use client";

import { useQuery } from "@tanstack/react-query";
import {
	LIVE_STATUS_TONE,
	type LiveChannelListItem,
} from "@/app/live/live-shared";
import {
	type ResourceIdCandidate,
	ResourceIdPicker,
} from "@/components/resource-id-picker";
import { ApiError, apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";

const CHANNEL_PAGE = 100;

/**
 * Candidate source: this app's OWN `LiveChannel` rows (`GET /api/live-channels`),
 * not a Bitmovin list call.
 *
 * `bitmovinEncodingId` is written by the channel worker when it provisions the
 * encoding and is `@unique` in Postgres, so for every channel this app
 * provisioned the local row is exactly as authoritative as the API — and it
 * additionally carries the operator-chosen NAME and our own status, which is
 * what makes an id identifiable. Listing encodings from Bitmovin instead would
 * cost a round-trip (plus a 502 when the key's standing is off) to return
 * *less*: encoding names the API assigns, with no link back to the channel the
 * operator is thinking about.
 *
 * It is not the complete set of live encodings in the account, which is why the
 * paste fallback stays: a standby-pool encoding acquired outside a managed
 * channel has no local row , nor does anything created in
 * another org or in Bitmovin's own dashboard.
 */
export function LiveEncodingPicker({
	inputId,
	value,
	onChange,
	/** Extra ids the caller already knows are relevant (deduped, local rows win). */
	extraCandidates = [],
	listLabel,
	placeholder,
}: {
	inputId: string;
	value: string;
	onChange: (value: string) => void;
	extraCandidates?: ResourceIdCandidate[];
	listLabel?: string;
	placeholder?: string;
}) {
	const { t } = useT();
	const list = listLabel ?? t("settingsX.liveChannelsInThisApp");
	const inputPlaceholder = placeholder ?? t("settingsX.encodingIdOrPasteOne");
	const channels = useQuery({
		queryKey: ["live-channels-picker"],
		queryFn: () =>
			apiFetch<{ items: LiveChannelListItem[]; nextCursor?: string }>(
				`/api/live-channels?limit=${CHANNEL_PAGE}`,
			),
	});

	const rows = channels.data?.items ?? [];
	const local: ResourceIdCandidate[] = rows
		.filter(
			(row): row is LiveChannelListItem & { bitmovinEncodingId: string } =>
				row.bitmovinEncodingId !== null,
		)
		// RUNNING channels first — both callers act on a live encoder — then the
		// route's own createdAt-desc order.
		.sort(
			(a, b) => Number(b.status === "RUNNING") - Number(a.status === "RUNNING"),
		)
		.map((row) => ({
			id: row.bitmovinEncodingId,
			label: row.name,
			badge: row.status,
			tone: LIVE_STATUS_TONE[row.status],
		}));

	const localIds = new Set(local.map((candidate) => candidate.id));
	const candidates = [
		...local,
		...extraCandidates.filter((candidate) => !localIds.has(candidate.id)),
	];

	return (
		<ResourceIdPicker
			inputId={inputId}
			value={value}
			onChange={onChange}
			candidates={candidates}
			isLoading={channels.isLoading}
			{...(channels.isError
				? {
						errorMessage:
							t("settingsX.couldNotListChannels") +
							(channels.error instanceof ApiError
								? ` (${channels.error.message})`
								: ""),
					}
				: {})}
			emptyMessage={t("settingsX.noLiveChannelWithEncoding")}
			listLabel={list}
			copyLabel={t("settingsX.encodingIdCopyLabel")}
			placeholder={inputPlaceholder}
			{...(channels.data?.nextCursor
				? {
						truncatedMessage: t("settingsX.showingRecentChannels", {
							count: CHANNEL_PAGE,
						}),
					}
				: {})}
		/>
	);
}
