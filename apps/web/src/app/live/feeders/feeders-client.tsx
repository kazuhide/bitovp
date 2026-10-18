"use client";

import { ingestConnectedTriState, type LiveChannelPlan } from "@bitovp/core";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import {
	FeederPanel,
	type FeederSource,
	FeederSourcePicker,
} from "@/app/live/[id]/feeder-panel";
import { DeleteResourceButton } from "@/components/delete-resource-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { SelectNative } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { localizedCustomerError } from "@/lib/customer-error";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/context";
import { isActiveChannelStatus } from "../live-shared";
import { FeederPhaseChip } from "./feeder-phase-chip";
import {
	FEEDER_STATUS_TONE,
	type FeederSessionListItem,
	isActiveFeederStatus,
	isStoppableFeederSession,
} from "./feeder-shared";

type Page = { items: FeederSessionListItem[]; nextCursor?: string };

/**
 * All feeder sessions across channels (lean list — loop counts and log
 * tails live on the detail view; sessions are created from a channel's
 * detail page where the target prefills apply).
 */
export function FeedersClient() {
	const { t } = useT();
	const queryClient = useQueryClient();
	const sessions = useInfiniteQuery({
		queryKey: ["feeder-sessions"],
		queryFn: ({ pageParam }) =>
			apiFetch<Page>(
				pageParam
					? `/api/feeder-sessions?cursor=${encodeURIComponent(pageParam)}`
					: "/api/feeder-sessions",
			),
		initialPageParam: "",
		getNextPageParam: (last: Page) => last.nextCursor ?? null,
		refetchInterval: (query) =>
			query.state.data?.pages[0]?.items.some((session) =>
				isActiveFeederStatus(session.status),
			)
				? 10_000
				: 60_000,
	});
	const items = sessions.data?.pages.flatMap((p) => p.items) ?? [];

	// Per-row delete (terminal-only AND process-free — disabled while
	// CREATED/DOWNLOADING/PUSHING, and while a terminal row still records an
	// ffmpeg pid nobody has proven gone, mirroring the route's two 409 guards).
	// LOCAL record only; refetch on success.
	const remove = useMutation({
		mutationFn: (id: string) =>
			apiFetch(`/api/feeder-sessions/${id}`, { method: "DELETE" }),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["feeder-sessions"] }),
	});

	return (
		<section>
			<header>
				<div className="flex items-center gap-2">
					<h1 className="font-semibold text-xl text-zinc-50">
						{t("feeder.title")}
					</h1>
					<HelpOverlay labelFor={t("feeder.title")}>
						{t("liveHelp.feeders")}
					</HelpOverlay>
				</div>
			</header>

			{/* : creation from THIS screen — static ingest  makes the target knowable before provisioning, so the nav
			    slot earns itself. Channel select → detail fetch → the SAME
			    FeederPanel channel detail mounts (maximal reuse, zero forked
			    form logic). */}
			<RoleAccess control="live.feeders.list">
				<CreateSessionSection />
			</RoleAccess>

			{remove.isError ? (
				<p role="alert" className="mt-3 text-red-400 text-sm">
					{localizedCustomerError(t, remove.error, "live.deleteFailed")}
				</p>
			) : null}

			{sessions.isError ? (
				<div className="mt-6 space-y-2">
					<p role="alert" className="text-red-400 text-sm">
						{t("feeder.loadFailed")}
					</p>
					<Button
						variant="secondary"
						size="sm"
						disabled={sessions.isFetching}
						onClick={() =>
							sessions.isFetchNextPageError
								? sessions.fetchNextPage()
								: sessions.refetch()
						}
					>
						{t("common.retry")}
					</Button>
				</div>
			) : null}
			{!sessions.isError || sessions.data ? (
				<div className="mt-6 overflow-x-auto rounded-lg border border-zinc-800">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-zinc-800 border-b text-left text-xs text-zinc-500">
								<th className="px-3 py-2 font-medium">{t("feeder.session")}</th>
								<th className="px-3 py-2 font-medium">{t("common.status")}</th>
								<th className="px-3 py-2 font-medium">{t("feeder.channel")}</th>
								<th className="px-3 py-2 font-medium">
									{t("feeder.protocol")}
								</th>
								<th className="px-3 py-2 font-medium">{t("feeder.source")}</th>
								<th className="px-3 py-2 font-medium">{t("feeder.started")}</th>
								<th className="px-3 py-2 text-right font-medium">
									{t("common.actions")}
								</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-zinc-800/70">
							{items.map((session) => {
								const channelName = session.liveChannel?.name.trim();
								return (
									<tr key={session.id} className="hover:bg-zinc-900/40">
										<td className="px-3 py-2">
											<Link
												href={`/live/feeders/${session.id}`}
												aria-label={`${t("feeder.session")} ${session.id}`}
												className="font-mono text-xs text-zinc-200 hover:text-emerald-400"
											>
												{session.id.slice(0, 8)}…
											</Link>
										</td>
										<td className="px-3 py-2">
											<Badge tone={FEEDER_STATUS_TONE[session.status]}>
												{session.status}
											</Badge>
											<FeederPhaseChip session={session} />
										</td>
										<td className="px-3 py-2">
											<Link
												href={`/live/${session.liveChannelId}`}
												aria-label={
													channelName
														? `${channelName} (${session.liveChannelId})`
														: session.liveChannelId
												}
												className="block max-w-64 text-xs text-zinc-200 hover:text-emerald-400"
											>
												{channelName ? (
													<span className="block break-words">
														{channelName}
													</span>
												) : null}
												<span className="block font-mono text-zinc-500">
													{session.liveChannelId.slice(0, 8)}…
												</span>
											</Link>
										</td>
										<td className="px-3 py-2 text-xs text-zinc-300">
											{session.protocol}
										</td>
										<td className="max-w-64 truncate px-3 py-2 font-mono text-xs text-zinc-400">
											{session.sourceBucket}/{session.sourceKey}
										</td>
										<td className="px-3 py-2 text-xs text-zinc-400">
											{formatDateTime(session.startedAt ?? undefined)}
										</td>
										<td className="px-3 py-2 text-right">
											<RoleAccess control="live.feeders.list">
												<DeleteResourceButton
													resourceLabel={`session ${session.id.slice(0, 8)}`}
													disabled={isStoppableFeederSession(session)}
													disabledReason={t("feeder.stopBeforeDeleting")}
													confirmTitle={t("feeder.deleteTitle")}
													confirmDescription={t("feeder.deleteConfirm")}
													pending={
														remove.isPending && remove.variables === session.id
													}
													onConfirm={() => remove.mutate(session.id)}
												/>
											</RoleAccess>
										</td>
									</tr>
								);
							})}
							{!sessions.isLoading && items.length === 0 ? (
								<tr>
									<td
										colSpan={7}
										className="px-3 py-10 text-center text-sm text-zinc-500"
									>
										{t("empty.noFeederSessions")}
									</td>
								</tr>
							) : null}
						</tbody>
					</table>
					{sessions.hasNextPage ? (
						<div className="border-zinc-800 border-t p-2">
							<Button
								variant="secondary"
								size="sm"
								disabled={sessions.isFetching}
								onClick={() => sessions.fetchNextPage()}
							>
								{sessions.isFetchingNextPage
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

type ChannelListRow = { id: string; name: string; status: string };
type ChannelPickerPage = { items: ChannelListRow[]; nextCursor?: string };
type ChannelDetail = {
	currentRun?: {
		bitmovinEncodingId: string | null;
		streamKey: string | null;
		encoderIp: string | null;
		/** The run's persisted heartbeat sample — the detail page's first choice. */
		lastHeartbeat?: unknown;
	} | null;
	id: string;
	/** The enum, not a string: `isActiveChannelStatus` takes it without a cast (review-331). */
	status: Parameters<typeof isActiveChannelStatus>[0];
	plan: LiveChannelPlan;
	bitmovinAccountId: string | null;
	bitmovinEncodingId: string | null;
	streamKey: string | null;
	encoderIp: string | null;
	lastHeartbeat?: unknown;
	/**
	 * The server's clock at the response (the detail route stamps it). Freshness
	 * compares WORKER-stamped sample times, so the comparison clock must be
	 * the server's —  / review-260 127-A5: a viewer 90 s fast read
	 * a healthy channel as disconnected. The detail page anchors to it; so
	 * does this picker (review-331).
	 */
	serverNow?: string;
};

function CreateSessionSection() {
	const { t } = useT();
	const [open, setOpen] = useState(false);
	const [source, setSource] = useState<FeederSource>({
		credentialId: "",
		bucket: "",
		key: "",
	});
	const [channelId, setChannelId] = useState("");
	const sourceSelected = source.credentialId !== "" && source.key !== "";
	const channels = useInfiniteQuery({
		// Keep the picker independent from the operations list's cached pages.
		queryKey: ["live-channels", "feeder-picker"],
		queryFn: ({ pageParam }) =>
			apiFetch<ChannelPickerPage>(
				pageParam
					? `/api/live-channels?cursor=${encodeURIComponent(pageParam)}`
					: "/api/live-channels",
			),
		initialPageParam: "",
		getNextPageParam: (last: ChannelPickerPage) => last.nextCursor ?? null,
		enabled: open && sourceSelected,
	});
	const detail = useQuery({
		queryKey: ["live-channel", channelId],
		queryFn: () => apiFetch<ChannelDetail>(`/api/live-channels/${channelId}`),
		enabled: open && channelId !== "",
		// review-334: the ingest verdict below is judged on this response's
		// `serverNow`; without polling it was frozen at pick time, and a channel
		// going stale while the operator filled in the form kept reading
		// "connected" — the false all-clear, the worse direction. 15 s against a
		// 90 s freshness window bounds the lag.
		refetchInterval: open && channelId !== "" ? 15_000 : false,
	});
	return (
		<div className="mt-4">
			<Button
				variant="secondary"
				size="sm"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
			>
				{t("feeder.newSession")}
			</Button>
			{open ? (
				<div className="mt-3 space-y-3 rounded-md border border-zinc-800 bg-zinc-900/40 p-4">
					<FeederSourcePicker
						id="feeders-source"
						value={source}
						onChange={(next) => {
							setSource(next);
							setChannelId("");
						}}
					/>
					{sourceSelected ? (
						<Field label={t("feeder.pickChannel")} htmlFor="feeders-channel">
							<SelectNative
								id="feeders-channel"
								disabled={channels.isPending}
								value={channelId}
								onChange={(e) => setChannelId(e.target.value)}
							>
								<option value="">
									{t(channels.isPending ? "common.loading" : "common.select")}
								</option>
								{(channels.data?.pages.flatMap((page) => page.items) ?? []).map(
									(c) => (
										<option key={c.id} value={c.id}>
											{c.name}
										</option>
									),
								)}
							</SelectNative>
							{channels.isError ? (
								<div className="space-y-2">
									<p role="alert" className="text-red-400 text-xs">
										{t("live.loadFailed")}
									</p>
									<Button
										variant="secondary"
										size="sm"
										disabled={channels.isFetching}
										onClick={() => channels.refetch()}
									>
										{t("common.retry")}
									</Button>
								</div>
							) : null}
							{channels.hasNextPage ? (
								<Button
									variant="secondary"
									size="sm"
									disabled={channels.isFetching}
									onClick={() => channels.fetchNextPage()}
								>
									{t(
										channels.isFetchingNextPage
											? "common.loading"
											: "live.loadMore",
									)}
								</Button>
							) : null}
						</Field>
					) : null}
					{channelId && detail.isPending ? (
						<p role="status" className="text-sm text-zinc-400">
							{t("live.loadingChannel")}
						</p>
					) : null}
					{detail.isError ? (
						<div className="space-y-2">
							<p role="alert" className="text-red-400 text-sm">
								{t("live.channelLoadFailed")}
							</p>
							<Button
								variant="secondary"
								size="sm"
								disabled={detail.isFetching}
								onClick={() => detail.refetch()}
							>
								{t("common.retry")}
							</Button>
						</div>
					) : null}
					{detail.data && !detail.isError ? (
						<FeederPanel
							channelId={detail.data.id}
							channelStatus={detail.data.status}
							plan={detail.data.plan}
							//  PR2b: currentRun-first — after a restart the
							// NEW run's encoder owns the coordinates; the channel
							// columns are the never-ran fallback.
							streamKey={
								detail.data.currentRun == null
									? detail.data.streamKey
									: detail.data.currentRun.streamKey
							}
							encoderIp={
								detail.data.currentRun == null
									? detail.data.encoderIp
									: detail.data.currentRun.encoderIp
							}
							bitmovinAccountId={detail.data.bitmovinAccountId}
							bitmovinEncodingId={
								detail.data.currentRun == null
									? detail.data.bitmovinEncodingId
									: detail.data.currentRun.bitmovinEncodingId
							}
							bitmovinEncodingPending={
								detail.data.currentRun != null &&
								detail.data.currentRun.bitmovinEncodingId === null
							}
							preselectedSource={source}
							embeddedForm
							//  (review-331): this panel used to get NO ingest
							// prop, which after #213's first cut read as "unconfirmed"
							// for EVERY picked channel — a standing false alarm. The same
							// derivation as the detail page, from the same row.
							ingestConnected={ingestConnectedTriState(
								isActiveChannelStatus(detail.data.status),
								detail.data.currentRun == null
									? detail.data.lastHeartbeat
									: detail.data.currentRun.lastHeartbeat,
								// As of the server's answer, on the server's clock (#127).
								detail.data.serverNow
									? Date.parse(detail.data.serverNow)
									: Date.now(),
							)}
						/>
					) : null}
				</div>
			) : null}
		</div>
	);
}
