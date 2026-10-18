"use client";

import { deriveProviderLifecycle } from "@bitovp/core";
import {
	useInfiniteQuery,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CopyableId } from "@/components/copyable-id";
import { DeleteResourceButton } from "@/components/delete-resource-button";
import { Button } from "@/components/ui/button";
import { Input, SelectNative } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { localizedCustomerError } from "@/lib/customer-error";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/context";
import {
	arrangeChannels,
	DEFAULT_LIVE_LIST_PREFS,
	type LiveListFilter,
	type LiveListSort,
	readLiveListPrefs,
	writeLiveListPrefs,
} from "./channel-health";
import { HealthCell, NextEventCell, RuntimeCell } from "./channel-row-cells";
import { isActiveChannelStatus, type LiveChannelListItem } from "./live-shared";
import { LiveStatusBadge } from "./live-status-badge";

type Page = {
	items: LiveChannelListItem[];
	nextCursor?: string;
	/** The route's own clock — every age and countdown is anchored to it. */
	serverNow?: string;
};

/** Columns before the row menu; the empty-state row spans all of them. */
const COLUMN_COUNT = 7;

/**
 * The live channel list as an OPERATIONS COCKPIT

 *
 * It used to be Name / Status / Encoding ID / Created / Delete with the next
 * schedule as a footnote — which means that with several channels up, "which
 * RUNNING one has a stale ingest, an open alert, a stalled origin or a failed
 * feeder" could only be answered by opening every detail page in turn. Health,
 * Next event and elapsed/remaining are promoted into columns; the long
 * encoding id drops to a copy affordance under the name, and the destructive
 * per-row Delete moves behind a row menu so a mis-click cannot be one pixel
 * from a row link.
 *
 * The route still returns a LEAN payload (no plan/stepLog/streamKey, and a
 * heartbeat DIGEST rather than the column) — the health values are derived
 * server-side in one query, never fanned out per row from here.
 *
 * Auto-refreshes fast while any channel is PROVISIONING/RUNNING/STOPPING.
 */
export function ChannelsClient() {
	const { t } = useT();
	const queryClient = useQueryClient();
	/**
	 * Freshness and countdowns are functions of TIME, and nothing re-renders
	 * when only time passes: a dead sweep produces byte-identical payloads,
	 * TanStack skips the re-render, and a stale channel never turns amber
	 * (review-260 127-A7). One 10s tick — the list's own fast poll cadence —
	 * re-evaluates the health verdicts and the schedule countdown.
	 */
	const [nowMs, setNowMs] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNowMs(Date.now()), 10_000);
		return () => clearInterval(id);
	}, []);
	/**
	 * Heartbeat stamps are written by the WORKER, so the comparison clock must
	 * be the server's, not the viewer's (review-260 127-A5): each poll measures
	 * the offset between the response stamp and the browser clock, and the
	 * ticking `nowMs` is corrected by it.
	 */
	const [serverSkewMs, setServerSkewMs] = useState(0);
	const [prefs, setPrefs] = useState(DEFAULT_LIVE_LIST_PREFS);
	/**
	 * Read AFTER mount, never during render: the server renders this component
	 * too, and seeding state from localStorage would hydrate-mismatch every row
	 * for any viewer whose stored filter is not the default.
	 */
	useEffect(() => {
		setPrefs(readLiveListPrefs());
	}, []);
	// Not persisted, deliberately (see readLiveListPrefs): a half-typed name
	// that silently hides nine of ten channels on the next visit is a bug
	// report, not a remembered preference.
	const [query, setQuery] = useState("");
	const [openMenuId, setOpenMenuId] = useState<string | null>(null);

	const channels = useInfiniteQuery({
		queryKey: ["live-channels"],
		queryFn: ({ pageParam }) =>
			apiFetch<Page>(
				pageParam
					? `/api/live-channels?cursor=${encodeURIComponent(pageParam)}`
					: "/api/live-channels",
			),
		initialPageParam: "",
		getNextPageParam: (last: Page) => last.nextCursor ?? null,
		// Refetching re-loads every accumulated page — poll fast only while
		// the first page shows transitional or running channels.
		refetchInterval: (query_) =>
			query_.state.data?.pages[0]?.items.some((channel) =>
				isActiveChannelStatus(channel.status),
			)
				? 10_000
				: 60_000,
	});
	const items = useMemo(
		() => channels.data?.pages.flatMap((p) => p.items) ?? [],
		[channels.data],
	);
	// Page 0 is refetched on every poll, so its stamp is the freshest one.
	const serverNow = channels.data?.pages[0]?.serverNow;
	useEffect(() => {
		if (serverNow) {
			setServerSkewMs(Date.parse(serverNow) - Date.now());
		}
	}, [serverNow]);
	const anchoredNowMs = nowMs + serverSkewMs;

	const rows = useMemo(
		() =>
			arrangeChannels(
				items,
				{ filter: prefs.filter, query, sort: prefs.sort },
				anchoredNowMs,
			),
		[items, prefs.filter, prefs.sort, query, anchoredNowMs],
	);

	const setFilter = (filter: LiveListFilter) => {
		const next = { ...prefs, filter };
		setPrefs(next);
		writeLiveListPrefs(next);
	};
	const setSort = (sort: LiveListSort) => {
		const next = { ...prefs, sort };
		setPrefs(next);
		writeLiveListPrefs(next);
	};

	// Per-row delete (terminal-only — disabled while PROVISIONING/RUNNING/
	// STOPPING, mirroring the route's 409 guard). Deletes the channel + its
	// feeders/heartbeats/live VMAF (LOCAL only); refetch on success.
	const remove = useMutation({
		mutationFn: (id: string) =>
			apiFetch(`/api/live-channels/${id}`, { method: "DELETE" }),
		onSuccess: () => {
			setOpenMenuId(null);
			queryClient.invalidateQueries({ queryKey: ["live-channels"] });
		},
	});

	return (
		<section>
			<header className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h1 className="font-semibold text-xl text-zinc-50">
						{t("live.title")}
					</h1>
				</div>
				<RoleAccess control="live.channels.create">
					<Link
						href="/live/new"
						// #101: nowrap + shrink-0 — the ja label used to wrap to two
						// lines inside the fixed h-9 at narrow widths and burst the
						// pill; the header row wraps as a whole instead.
						className="inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-md bg-emerald-600 px-4 font-medium text-sm text-white transition-colors hover:bg-emerald-500"
					>
						{t("live.newChannel")}
					</Link>
				</RoleAccess>
			</header>

			<div className="mt-6 flex flex-wrap items-center gap-3">
				<div className="flex items-center gap-2 text-xs text-zinc-400">
					<label htmlFor="live-list-filter">{t("live.list.filter")}</label>
					<SelectNative
						id="live-list-filter"
						className="w-44"
						value={prefs.filter}
						onChange={(e) => setFilter(e.target.value as LiveListFilter)}
					>
						<option value="all">{t("live.list.filterAll")}</option>
						<option value="active">{t("live.list.filterActive")}</option>
						<option value="error">{t("live.list.filterError")}</option>
						<option value="soon">{t("live.list.filterSoon")}</option>
					</SelectNative>
				</div>
				<div className="flex items-center gap-2 text-xs text-zinc-400">
					<label htmlFor="live-list-sort">{t("live.list.sort")}</label>
					<SelectNative
						id="live-list-sort"
						className="w-44"
						value={prefs.sort}
						onChange={(e) => setSort(e.target.value as LiveListSort)}
					>
						<option value="anomaly">{t("live.list.sortAnomaly")}</option>
						<option value="created">{t("live.list.sortCreated")}</option>
					</SelectNative>
				</div>
				<div className="flex items-center gap-2 text-xs text-zinc-400">
					<label htmlFor="live-list-search">{t("common.name")}</label>
					<Input
						id="live-list-search"
						className="w-48"
						placeholder={t("live.list.searchPlaceholder")}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
				</div>
				{prefs.filter !== "all" || query ? (
					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							setFilter("all");
							setQuery("");
						}}
					>
						{t("common.clear")}
					</Button>
				) : null}
			</div>
			{/* The definition, where the operator meets it — "Error" here is
			 * wider than the ERROR status, and a filter whose population you
			    have to guess is one you stop trusting. */}
			{prefs.filter === "error" ? (
				<p className="mt-2 text-xs text-zinc-500">
					{t("live.list.filterErrorHint")}
				</p>
			) : null}
			{/* Honest about scope: sorting and filtering see the LOADED rows,
			    not the whole table — the route pages by createdAt. */}
			{channels.hasNextPage ? (
				<p className="mt-2 text-xs text-zinc-500">
					{t("live.list.scopeNote", { count: items.length })}
				</p>
			) : null}

			{remove.isError ? (
				<p role="alert" className="mt-3 text-red-400 text-sm">
					{localizedCustomerError(t, remove.error, "live.deleteFailed")}
				</p>
			) : null}

			{channels.isError ? (
				<div className="mt-6 space-y-2">
					<p role="alert" className="text-red-400 text-sm">
						{t("live.loadFailed")}
					</p>
					<Button
						variant="secondary"
						size="sm"
						disabled={channels.isFetching}
						onClick={() =>
							channels.isFetchNextPageError
								? channels.fetchNextPage()
								: channels.refetch()
						}
					>
						{t("common.retry")}
					</Button>
				</div>
			) : null}
			{!channels.isError || channels.data ? (
				<div className="mt-4 overflow-x-auto rounded-lg border border-zinc-800">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-zinc-800 border-b text-left text-xs text-zinc-500">
								<th className="px-3 py-2 font-medium">{t("common.name")}</th>
								<th className="px-3 py-2 font-medium">{t("common.status")}</th>
								<th className="px-3 py-2 font-medium">
									{t("live.list.health")}
								</th>
								<th className="px-3 py-2 font-medium">
									{t("live.list.nextEvent")}
								</th>
								<th className="px-3 py-2 font-medium">
									{t("live.list.runtime")}
								</th>
								<th className="px-3 py-2 font-medium">{t("common.created")}</th>
								<th className="px-3 py-2 text-right font-medium">
									{t("common.actions")}
								</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-zinc-800/70">
							{rows.map(({ item: channel, health }) => (
								<tr key={channel.id} className="hover:bg-zinc-900/40">
									{/*
									 * w-full + max-w-0 (owner report 2026-08-21): the name
									 * column absorbs the table's slack, and max-w-0 is what
									 * lets `truncate` actually bite — in an auto-layout cell
									 * a long ERROR SENTENCE set the column's intrinsic width
									 * and squeezed status/encoding-id into slivers. The full
									 * explanation stays on the linked detail page.
									 */}
									<td className="w-full min-w-48 max-w-0 px-3 py-2 align-top">
										<Link
											href={`/live/${channel.id}`}
											className="block truncate text-zinc-200 hover:text-emerald-400"
										>
											{channel.name}
										</Link>
										{/* Demoted from its own column : identity, not a
										 * monitoring value — one click from the clipboard,
										    and no longer competing with Health for width. */}
										{channel.bitmovinEncodingId ? (
											<CopyableId
												value={channel.bitmovinEncodingId}
												label={t("live.encodingId")}
												className="mt-0.5"
											/>
										) : null}
									</td>
									<td className="whitespace-nowrap px-3 py-2 align-top">
										<LiveStatusBadge
											status={channel.status}
											providerLifecycle={deriveProviderLifecycle(
												channel.health?.provider ?? null,
												anchoredNowMs,
											)}
										/>
									</td>
									<td className="px-3 py-2 align-top">
										<HealthCell health={health} />
									</td>
									<td className="whitespace-nowrap px-3 py-2 align-top">
										<NextEventCell
											nextSchedule={channel.nextSchedule}
											nowMs={anchoredNowMs}
										/>
									</td>
									<td className="whitespace-nowrap px-3 py-2 align-top">
										<RuntimeCell health={health} />
									</td>
									<td className="whitespace-nowrap px-3 py-2 align-top text-xs text-zinc-400">
										{formatDateTime(channel.createdAt)}
									</td>
									<td className="px-3 py-2 text-right align-top">
										<RoleAccess control="live.channels.delete">
											<RowMenu
												channel={channel}
												open={openMenuId === channel.id}
												onOpenChange={(next) =>
													setOpenMenuId(next ? channel.id : null)
												}
												pending={
													remove.isPending && remove.variables === channel.id
												}
												onDelete={() => remove.mutate(channel.id)}
											/>
										</RoleAccess>
									</td>
								</tr>
							))}
							{!channels.isLoading && items.length === 0 ? (
								<tr>
									<td
										colSpan={COLUMN_COUNT}
										className="px-3 py-10 text-center text-sm text-zinc-500"
									>
										{t("live.emptyHint")}
									</td>
								</tr>
							) : null}
							{items.length > 0 && rows.length === 0 ? (
								<tr>
									<td
										colSpan={COLUMN_COUNT}
										className="px-3 py-10 text-center text-sm text-zinc-500"
									>
										{t("live.list.matchNone")}
									</td>
								</tr>
							) : null}
						</tbody>
					</table>
					{channels.hasNextPage ? (
						<div className="border-zinc-800 border-t p-2">
							<Button
								variant="secondary"
								size="sm"
								disabled={channels.isFetching}
								onClick={() => channels.fetchNextPage()}
							>
								{channels.isFetchingNextPage
									? t("common.loading")
									: t("live.loadMore")}
							</Button>
						</div>
					) : null}
				</div>
			) : null}
		</section>
	);
}

/**
 * Per-row overflow menu — where the destructive action lives now.
 *
 * A real `<button>` with `aria-expanded`/`aria-controls` and a panel that
 * closes on Escape: keyboard-operable without a portal, which matters because
 * the delete confirmation inside it is itself a portalled dialog (a popover
 * that unmounts its children on outside-click would take the open dialog with
 * it — the "portal children mount after parent effects" shape, from the other
 * end).
 *
 * The panel is CONDITIONALLY RENDERED rather than hidden with CSS, so "the
 * delete button is not in the primary columns" is a fact about the DOM and not
 * a claim about a stylesheet jsdom never applies.
 */
function RowMenu({
	channel,
	open,
	onOpenChange,
	pending,
	onDelete,
}: {
	channel: LiveChannelListItem;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	pending: boolean;
	onDelete: () => void;
}) {
	const { t } = useT();
	const panelId = `live-row-menu-${channel.id}`;
	// One handler, bound to the two elements that can actually hold focus —
	// the trigger and the panel — rather than to a wrapper div, which would be
	// an interaction handler on an element with no role to explain it.
	const closeOnEscape = (e: { key: string }) => {
		if (e.key === "Escape" && open) {
			onOpenChange(false);
		}
	};
	return (
		<div className="relative inline-block text-left">
			<Button
				variant="secondary"
				size="sm"
				aria-expanded={open}
				aria-controls={panelId}
				aria-label={t("live.list.rowMenu", { name: channel.name })}
				onClick={() => onOpenChange(!open)}
				onKeyDown={closeOnEscape}
			>
				⋯
			</Button>
			{open ? (
				// A fieldset, not a div with role="group": the panel IS a group of
				// controls, and the semantic element carries the grouping without
				// an ARIA promise the markup then has to keep.
				<fieldset
					id={panelId}
					aria-label={t("live.list.rowMenu", { name: channel.name })}
					onKeyDown={closeOnEscape}
					className="absolute right-0 z-20 mt-1 flex w-56 flex-col items-start gap-2 rounded-md border border-zinc-800 bg-zinc-950 p-2 text-left shadow-lg"
				>
					<Link
						href={`/live/${channel.id}`}
						className="w-full rounded px-1.5 py-1 text-xs text-zinc-300 hover:bg-zinc-900 hover:text-emerald-400"
					>
						{t("live.list.openChannel")}
					</Link>
					<DeleteResourceButton
						resourceLabel={channel.name}
						disabled={isActiveChannelStatus(channel.status)}
						disabledReason={t("live.stopBeforeDeleting")}
						confirmTitle={t("live.deleteNamed", { name: channel.name })}
						confirmDescription={t("live.deleteConfirm")}
						pending={pending}
						onConfirm={onDelete}
					/>
				</fieldset>
			) : null}
		</div>
	);
}
