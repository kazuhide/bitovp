"use client";

import type { CredentialSummaryWire, LiveChannelPlan } from "@bitovp/core";
import { FEEDER_SUPPORTED_PROVIDERS } from "@bitovp/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { FeederPhaseChip } from "@/app/live/feeders/feeder-phase-chip";
import {
	FEEDER_STATUS_TONE,
	type FeederSessionListItem,
	feederCreateBody,
	feederFailureMessage,
	feederTargetFields,
	isActiveFeederStatus,
	isOccupyingFeederSession,
	isStoppableFeederSession,
	reseedFeederTarget,
} from "@/app/live/feeders/feeder-shared";
import { StopFeederSessionDialog } from "@/app/live/feeders/stop-feeder-dialog";
import { StoragePicker } from "@/components/storage-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/context";

export type FeederSource = {
	credentialId: string;
	bucket: string;
	key: string;
};

/**
 * The one source-object control used by both entry points. The global page
 * places it before channel selection; the channel detail keeps it inside the
 * shared FeederPanel form. Selection semantics therefore cannot drift while
 * the global workflow still follows source -> channel -> destination.
 */
export function FeederSourcePicker({
	value,
	onChange,
	id = "fd-source",
}: {
	value: FeederSource;
	onChange: (source: FeederSource) => void;
	id?: string;
}) {
	const { t } = useT();
	const [open, setOpen] = useState(false);
	return (
		<>
			<Field
				label={t("feeder.sourceObject")}
				htmlFor={id}
				help={t("ui.browseStorageFillsCredentialBucketKeyThe")}
				trailing={
					<Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
						{t("feeder.browseStorage")}
					</Button>
				}
			>
				<Input
					id={id}
					readOnly
					value={value.bucket ? `${value.bucket}/${value.key}` : ""}
					placeholder={t("feeder.pickViaBrowse")}
				/>
			</Field>
			<StoragePicker
				open={open}
				mode="object"
				providers={[...FEEDER_SUPPORTED_PROVIDERS]}
				onClose={() => setOpen(false)}
				onSelect={({ credentialId, bucket, path }) => {
					onChange({ credentialId, bucket, key: path });
					setOpen(false);
				}}
			/>
		</>
	);
}

/**
 * Pseudo-live feeder panel on the channel detail: create form (source MP4
 * via the storage browser, RTMP/SRT-caller target prefilled from the
 * channel's encoderIp/streamKey — suggested but editable) plus the
 * channel's session list. The create route enforces the
 * FEEDER_MAX_ACTIVE_SESSIONS stop-slot cap with a 409 surfaced verbatim.
 *
 * The streamKey prefill references the channel's readable column (the
 * ledgered exception); the value is persisted only inside the session's
 * own target (same exception) — never logged.
 */
export function FeederPanel({
	channelId,
	channelStatus,
	plan,
	streamKey,
	encoderIp,
	ingestConnected,
	bitmovinAccountId,
	bitmovinEncodingId,
	bitmovinEncodingPending = false,
	preselectedSource,
	embeddedForm = false,
}: {
	channelId: string;
	channelStatus: string;
	plan: LiveChannelPlan;
	streamKey: string | null;
	encoderIp: string | null;
	/** : encoder-side ingest state, for the pushing-not-bound banner. */
	/**
	 * : `true` = a fresh heartbeat says CONNECTED; `false` = a fresh
	 * sample says otherwise (or the channel is inactive); `undefined` = nothing
	 * can vouch — rendered as "unconfirmed", never as "not bound". Derive it
	 * with core's `ingestConnectedTriState`: a bare boolean here makes the
	 * unconfirmed notice unreachable (review-331).
	 */
	ingestConnected?: boolean;
	/** : the reveal-and-fill pair — a static ingest point's real
	 * key is a Bitmovin StreamKey resource assigned to THIS encoding, and its
	 * value is reachable only through the per-key reveal GET. */
	bitmovinAccountId?: string | null;
	bitmovinEncodingId?: string | null;
	/** A current run exists, but its provider encoding is not assigned yet. */
	bitmovinEncodingPending?: boolean;
	/** Global-flow source chosen before the channel. It remains immutable here. */
	preselectedSource?: FeederSource;
	/** Show the shared form directly, without its channel-detail disclosure. */
	embeddedForm?: boolean;
}) {
	const { t } = useT();
	const queryClient = useQueryClient();
	const srtListenerPort =
		plan.liveInput.kind === "SRT" && plan.liveInput.mode === "LISTENER"
			? plan.liveInput.port
			: undefined;
	// A redundant input's points carry their OWN application name and stream key
	// : `rtmp://<ip>/live` + the channel key is the simple-RTMP
	// convention and reaches nothing on an encoder listening at `liveA/primaryFeed`.
	const redundant =
		plan.liveInput.kind === "REDUNDANT_RTMP" ? plan.liveInput : undefined;
	const prefill = feederTargetFields({
		encoderIp,
		streamKey,
		srtListenerPort,
		ingestPoints: redundant?.ingestPoints,
		staticIngestPoints: redundant?.staticIngestPoints,
	});

	const [showForm, setShowForm] = useState(false);
	const formOpen = embeddedForm || showForm;
	const [source, setSource] = useState<FeederSource>({
		credentialId: "",
		bucket: "",
		key: "",
	});
	const effectiveSource = preselectedSource ?? source;
	const [protocol, setProtocol] = useState<"RTMP" | "SRT_CALLER">("RTMP");
	const [rtmpUrl, setRtmpUrl] = useState(prefill.rtmpUrl);
	const [feedStreamKey, setFeedStreamKey] = useState(prefill.streamKey);
	const [srtHost, setSrtHost] = useState(prefill.srtHost);
	const [srtPort, setSrtPort] = useState(prefill.srtPort);
	const [passphraseCredentialId, setPassphraseCredentialId] = useState("");
	const [showFeedStreamKey, setShowFeedStreamKey] = useState(false);
	// : the operator's choice to make this create a two-phase SWITCH
	// from the channel's active feeder. Offered only while one is active.
	const [switchFromActive, setSwitchFromActive] = useState(false);
	// Re-sync the editable prefills when the channel coordinates arrive late
	// (encoderIp lands only once RUNNING). reseedFeederTarget updates only
	// fields still equal to the PREVIOUS prefill — a user's in-progress
	// custom target is never clobbered by the arrival.
	const [lastPrefill, setLastPrefill] = useState(prefill);
	const [prefillChannelId, setPrefillChannelId] = useState(channelId);
	const seed = `${encoderIp ?? ""}:${streamKey ?? ""}`;
	const [prefillSeed, setPrefillSeed] = useState(seed);
	if (channelId !== prefillChannelId) {
		// Static-ingest channels can share the same URL and both prefill an empty
		// key. A channel switch must therefore reset even a user-edited/revealed
		// value; otherwise channel A's secret can be submitted to channel B.
		setPrefillChannelId(channelId);
		setPrefillSeed(seed);
		setLastPrefill(prefill);
		setRtmpUrl(prefill.rtmpUrl);
		setFeedStreamKey(prefill.streamKey);
		setShowFeedStreamKey(false);
		setSrtHost(prefill.srtHost);
		setSrtPort(prefill.srtPort);
		setPassphraseCredentialId("");
		setSwitchFromActive(false);
	} else if (seed !== prefillSeed) {
		setPrefillSeed(seed);
		setLastPrefill(prefill);
		const next = reseedFeederTarget(
			{ rtmpUrl, streamKey: feedStreamKey, srtHost, srtPort },
			lastPrefill,
			prefill,
		);
		setRtmpUrl(next.rtmpUrl);
		setFeedStreamKey(next.streamKey);
		setShowFeedStreamKey(false);
		setSrtHost(next.srtHost);
		setSrtPort(next.srtPort);
	}

	const credentials = useQuery({
		queryKey: ["credentials"],
		queryFn: () => apiFetch<CredentialSummaryWire[]>("/api/credentials"),
		enabled: formOpen,
	});
	const srtPassphrases = (credentials.data ?? []).filter(
		(c) => c.provider === "SRT_PASSPHRASE",
	);

	const sessions = useQuery({
		queryKey: ["feeder-sessions", channelId],
		queryFn: () =>
			apiFetch<{ items: FeederSessionListItem[] }>(
				`/api/feeder-sessions?liveChannelId=${encodeURIComponent(channelId)}`,
			),
		refetchInterval: (query) =>
			query.state.data?.items.some((s) => isActiveFeederStatus(s.status))
				? 5_000
				: false,
	});

	// "is there something to switch from" is the
	// channel's OCCUPANCY — the same three facts the route's admission counts
	// — not the status alone, or a channel held by a terminal row whose
	// ffmpeg is not proven gone would refuse the create and offer no switch.
	const hasActiveFeeder = (sessions.data?.items ?? []).some((s) =>
		isOccupyingFeederSession(s),
	);

	const create = useMutation({
		mutationFn: () =>
			apiFetch<{ id: string }>("/api/feeder-sessions", {
				method: "POST",
				body: JSON.stringify(
					feederCreateBody({
						channelId,
						source: effectiveSource,
						protocol,
						rtmpUrl,
						streamKey: feedStreamKey,
						srtHost,
						srtPort,
						passphraseCredentialId,
						switchFromActive,
						hasActiveFeeder,
					}),
				),
			}),
		onSuccess: () => {
			if (!embeddedForm) {
				setShowForm(false);
			}
			queryClient.invalidateQueries({
				// review-257 121-A1: the FAMILY prefix — this panel now also mounts
				// above /live/feeders' all-sessions list, which the channel-scoped
				// key could never reach (prefix matching runs the other way).
				queryKey: ["feeder-sessions"],
			});
		},
	});

	// : static ingest points take a StreamKey resource's VALUE —
	// the plan's own start.streamKey is refused with ffmpeg 255 ("not
	// ingestible"), measured 2026-08-21. The prefill is deliberately blank
	// for them (#151); this button is the missing forward path, and the
	// reveal is an explicit operator action (the stream-keys screen's
	// write-only-plus-reveal posture). The reveal itself persists nothing —
	// the value lands in the editable field, and SUBMITTING the session
	// stores it in FeederSession.target under that column's ledgered
	// redaction exception (plaintext at rest, masked by redactSecrets in
	// every snapshot/log; review-uibatch #3 records the scope note).
	//
	// Two arms (review-uibatch #2): an ASSIGN point NAMES its key in the
	// plan, so the reveal is one deterministic GET — no list, no guess. A
	// GENERATE point's key is TEMPORARY and discoverable only through the
	// assigned-to-this-encoding LIST; the type filter keeps account-level
	// RESERVED keys out of that arm entirely.
	const staticPoints =
		plan.liveInput.kind === "REDUNDANT_RTMP"
			? (plan.liveInput.staticIngestPoints ?? [])
			: [];
	const staticIngest = staticPoints.length > 0;
	const revealContextReady =
		Boolean(bitmovinAccountId) &&
		Boolean(bitmovinEncodingId) &&
		!bitmovinEncodingPending;
	// The prefilled URL is point[0]'s (the shared static FQDN) — the key must
	// be point[0]'s too.
	const assignedKeyId =
		staticPoints[0]?.streamKeyConfiguration?.type === "ASSIGN"
			? (staticPoints[0].streamKeyConfiguration.streamKeyId ?? null)
			: null;
	const reveal = useMutation({
		mutationFn: async () => {
			if (!bitmovinAccountId || !bitmovinEncodingId) {
				throw new Error("missing-account");
			}
			const account = encodeURIComponent(bitmovinAccountId);
			let keyId = assignedKeyId;
			if (!keyId) {
				const assigned = await apiFetch<{
					items?: { id?: string }[];
				}>(
					`/api/live/stream-keys?bitmovinAccountId=${account}&assignedEncodingId=${encodeURIComponent(bitmovinEncodingId)}&type=TEMPORARY&limit=100`,
				);
				const items = assigned.items ?? [];
				// A redundant input may run TWO static points (primary +
				// backup, schema min(1) with no max), each with its own
				// assigned key — and the static URL is the same FQDN for
				// both, so the KEY is what selects the point. Silently
				// filling items[0] could aim the feed at the backup; fill
				// only when the assignment is unambiguous and send the
				// operator to the stream-keys screen otherwise (per-point
				// reveal lives there).
				if (items.length > 1) {
					throw new Error("multiple-assigned-keys");
				}
				keyId = items[0]?.id ?? null;
			}
			if (!keyId) {
				throw new Error("no-assigned-key");
			}
			const revealed = await apiFetch<{ value?: string }>(
				`/api/live/stream-keys/${keyId}?bitmovinAccountId=${account}`,
			);
			if (!revealed.value) {
				throw new Error("no-assigned-key");
			}
			return revealed.value;
		},
		onSuccess: (value) => {
			setFeedStreamKey(value);
			setShowFeedStreamKey(false);
		},
	});

	// Session id awaiting stop confirmation (shared dialog with the feeder
	// detail — stopping is irreversible, sessions are one-shot).
	const [confirmingStopId, setConfirmingStopId] = useState<string | null>(null);
	const stop = useMutation({
		mutationFn: (sessionId: string) =>
			apiFetch(`/api/feeder-sessions/${sessionId}/actions`, {
				method: "POST",
				body: JSON.stringify({ action: "stop" }),
			}),
		onSuccess: () => {
			setConfirmingStopId(null);
			queryClient.invalidateQueries({
				// review-257 121-A1: the FAMILY prefix — this panel now also mounts
				// above /live/feeders' all-sessions list, which the channel-scoped
				// key could never reach (prefix matching runs the other way).
				queryKey: ["feeder-sessions"],
			});
		},
		// The error surfaces in the table's stop-failure alert.
		onError: () => setConfirmingStopId(null),
	});

	const items = sessions.data?.items ?? [];
	const channelAcceptsFeeders =
		channelStatus === "RUNNING" || channelStatus === "PROVISIONING";

	return (
		<div className="mt-2 space-y-3">
			{!embeddedForm ? (
				<div className="flex items-center justify-end gap-3">
					{/* This toggle is the pattern the rest of the
				    page now copies (`Disclosure`), and it was the one missing the
				    ARIA that makes it a disclosure rather than a button that
				    happens to change what is on screen. The controlled region
				    below is always in the DOM so `aria-controls` never dangles. */}
					<RoleAccess control="live.channel.feeder">
						<Button
							variant="secondary"
							size="sm"
							aria-expanded={showForm}
							aria-controls="feeder-new-session-form"
							onClick={() => setShowForm((v) => !v)}
						>
							{showForm ? t("feeder.hideForm") : t("feeder.newSession")}
						</Button>
					</RoleAccess>
				</div>
			) : null}

			{/* : a PUSHING feeder against an encoder that reports no
			    bound input is the incident shape — ffmpeg healthy for 9.5
			    minutes in a session the encoder never bound. The worker's
			    bind-watchdog now recycles such pushes automatically; this
			    banner tells the operator what is happening and what to check
			    if it persists. */}
			{ingestConnected === false &&
			(sessions.data?.items ?? []).some((s) => s.status === "PUSHING") ? (
				<p
					role="alert"
					className="rounded border border-amber-700 bg-amber-950/40 p-2 text-amber-300 text-xs"
				>
					{t("feeder.pushingNotBound")}
				</p>
			) : null}
			{/*  (paid audit MODERATE-15): a PUSHING badge with NO
			    heartbeat information is not "pushing" — it is "unconfirmed". The
			    bound-input banner above fires only on an explicit `false`; a
			    missing or stale heartbeat left the badge reading as healthy. */}
			{ingestConnected === undefined &&
			(sessions.data?.items ?? []).some((s) => s.status === "PUSHING") ? (
				<p
					role="status"
					className="rounded border border-zinc-700 bg-zinc-900 p-2 text-xs text-zinc-300"
				>
					{t("feeder.pushingUnconfirmed")}
				</p>
			) : null}
			{ingestConnected === true &&
			(sessions.data?.items ?? []).some((s) => s.status === "PUSHING") ? (
				<p
					role="status"
					className="rounded border border-emerald-800 bg-emerald-950/30 p-2 text-emerald-300 text-xs"
				>
					{t("feeder.inputConfirmed")}
				</p>
			) : null}

			<RoleAccess control="live.channel.feeder">
				<div
					id="feeder-new-session-form"
					hidden={!formOpen}
					className={
						formOpen
							? "space-y-3 rounded-md border border-zinc-800 p-3"
							: undefined
					}
				>
					{formOpen ? (
						<>
							{!channelAcceptsFeeders ? (
								<p role="alert" className="text-amber-400 text-xs">
									{t("uiX.feedersAttachRunningOnly", {
										status: channelStatus,
									})}
								</p>
							) : null}
							{preselectedSource ? null : (
								<FeederSourcePicker value={source} onChange={setSource} />
							)}
							<Field
								label={t("feeder.protocol")}
								htmlFor="fd-protocol"
								help={t("ui.srtIsCallerOnlyTheFeederDials")}
							>
								<SelectNative
									id="fd-protocol"
									value={protocol}
									onChange={(e) =>
										setProtocol(e.target.value as "RTMP" | "SRT_CALLER")
									}
								>
									<option value="RTMP">{t("feeder.rtmpPush")}</option>
									<option value="SRT_CALLER">{t("feeder.srtCaller")}</option>
								</SelectNative>
							</Field>
							{protocol === "RTMP" ? (
								<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
									<Field
										label={t("feeder.rtmpUrl")}
										htmlFor="fd-rtmp-url"
										hint={
											staticIngest
												? t("ingest.staticIngestPointHint")
												: encoderIp
													? t("feeder.prefilledFromEncoderIp")
													: t("feeder.encoderIpUnknownRunning")
										}
									>
										<Input
											id="fd-rtmp-url"
											placeholder={t("ui.rtmpEncoderIpLive")}
											value={rtmpUrl}
											onChange={(e) => setRtmpUrl(e.target.value)}
										/>
									</Field>
									<Field
										label={t("feeder.streamKey")}
										htmlFor="fd-rtmp-key"
										hint={
											staticIngest
												? t("feeder.staticKeyHint")
												: t("ui.suggestedFromTheChannelEditable")
										}
										trailing={
											staticIngest || feedStreamKey ? (
												<div className="flex flex-wrap items-center gap-2">
													{staticIngest ? (
														<Button
															variant="secondary"
															size="sm"
															onClick={() => reveal.mutate()}
															disabled={reveal.isPending || !revealContextReady}
														>
															{reveal.isPending
																? t("feeder.revealing")
																: t("feeder.revealFill")}
														</Button>
													) : null}
													{feedStreamKey ? (
														<Button
															variant="secondary"
															size="sm"
															onClick={() =>
																setShowFeedStreamKey((visible) => !visible)
															}
														>
															{showFeedStreamKey
																? t("feeder.hideKey")
																: t("feeder.showKey")}
														</Button>
													) : null}
												</div>
											) : undefined
										}
									>
										<Input
											id="fd-rtmp-key"
											type={showFeedStreamKey ? "text" : "password"}
											value={feedStreamKey}
											onChange={(e) => setFeedStreamKey(e.target.value)}
										/>
									</Field>
									{bitmovinEncodingPending ? (
										<p
											role="status"
											className="text-amber-300 text-xs sm:col-span-2"
										>
											{t("feeder.inputDestinationPreparing")}
										</p>
									) : staticIngest && !revealContextReady ? (
										<p
											role="status"
											className="text-amber-300 text-xs sm:col-span-2"
										>
											{t("feeder.keyContextUnavailable")}
										</p>
									) : null}
									{reveal.isError ? (
										<p
											role="alert"
											className="text-amber-400 text-xs sm:col-span-2"
										>
											{reveal.error instanceof Error &&
											reveal.error.message === "no-assigned-key"
												? t("feeder.revealNone")
												: reveal.error instanceof Error &&
														reveal.error.message === "multiple-assigned-keys"
													? t("feeder.revealMultiple")
													: t("feeder.revealFailed")}
										</p>
									) : null}
								</div>
							) : (
								<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
									<Field
										label={t("feeder.srtHost")}
										htmlFor="fd-srt-host"
										hint={
											encoderIp
												? t("feeder.prefilledFromEncoderIpShort")
												: t("feeder.encoderIpUnknown")
										}
									>
										<Input
											id="fd-srt-host"
											value={srtHost}
											onChange={(e) => setSrtHost(e.target.value)}
										/>
									</Field>
									<Field
										label={t("feeder.srtPort")}
										htmlFor="fd-srt-port"
										hint={
											srtListenerPort !== undefined
												? t("feeder.prefilledFromSrtPort")
												: t("feeder.srtPortRange")
										}
									>
										<Input
											id="fd-srt-port"
											type="number"
											value={srtPort}
											onChange={(e) => setSrtPort(e.target.value)}
										/>
									</Field>
									<Field
										label={t("feeder.passphraseCredential")}
										htmlFor="fd-srt-pass"
										help={t("ui.vaultSrtPassphraseRefResolvedAtSpawn")}
									>
										<SelectNative
											id="fd-srt-pass"
											value={passphraseCredentialId}
											onChange={(e) =>
												setPassphraseCredentialId(e.target.value)
											}
										>
											<option value="">{t("feeder.noPassphrase")}</option>
											{srtPassphrases.map((c) => (
												<option key={c.id} value={c.id}>
													{c.label}
												</option>
											))}
										</SelectNative>
									</Field>
								</div>
							)}
							{hasActiveFeeder ? (
								<div className="space-y-1">
									<label className="flex items-center gap-2 text-sm text-zinc-200">
										<input
											type="checkbox"
											checked={switchFromActive}
											onChange={(e) => setSwitchFromActive(e.target.checked)}
										/>
										{t("feeder.switchFromActive")}
									</label>
									<p className="text-xs text-zinc-500">
										{t("feeder.switchFromActiveHint")}
									</p>
								</div>
							) : null}
							{create.isError ? (
								<p role="alert" className="text-red-400 text-xs">
									{feederFailureMessage(t, t("ui.create"), create.error)}
								</p>
							) : null}
							<Button
								size="sm"
								disabled={
									create.isPending ||
									effectiveSource.credentialId === "" ||
									effectiveSource.key === "" ||
									(protocol === "RTMP"
										? rtmpUrl === "" || feedStreamKey === ""
										: srtHost === "" || srtPort === "")
								}
								onClick={() => create.mutate()}
							>
								{create.isPending
									? t("feeder.creating")
									: switchFromActive && hasActiveFeeder
										? t("feeder.switchSession")
										: t("feeder.startSession")}
							</Button>
						</>
					) : null}
				</div>
			</RoleAccess>

			{sessions.isError ? (
				<p role="alert" className="text-red-400 text-sm">
					{t("feeder.loadFailed")}
				</p>
			) : items.length > 0 ? (
				<div className="overflow-x-auto rounded-md border border-zinc-800">
					<table className="w-full text-xs">
						<thead>
							<tr className="border-zinc-800 border-b text-left text-[11px] text-zinc-500">
								<th className="px-2 py-1.5 font-medium">
									{t("feeder.session")}
								</th>
								<th className="px-2 py-1.5 font-medium">
									{t("common.status")}
								</th>
								<th className="px-2 py-1.5 font-medium">
									{t("feeder.protocol")}
								</th>
								<th className="px-2 py-1.5 font-medium">
									{t("feeder.source")}
								</th>
								<th className="px-2 py-1.5 font-medium">
									{t("feeder.started")}
								</th>
								<th className="px-2 py-1.5 font-medium" />
							</tr>
						</thead>
						<tbody className="divide-y divide-zinc-800/70">
							{items.map((session) => (
								<tr key={session.id} className="hover:bg-zinc-900/40">
									<td className="px-2 py-1.5">
										<Link
											href={`/live/feeders/${session.id}`}
											className="font-mono text-zinc-300 hover:text-emerald-400"
										>
											{session.id.slice(0, 8)}…
										</Link>
									</td>
									<td className="px-2 py-1.5">
										<Badge tone={FEEDER_STATUS_TONE[session.status]}>
											{session.status}
										</Badge>
										<FeederPhaseChip session={session} />
									</td>
									<td className="px-2 py-1.5 text-zinc-300">
										{session.protocol}
									</td>
									<td className="max-w-48 truncate px-2 py-1.5 font-mono text-zinc-400">
										{session.sourceBucket}/{session.sourceKey}
									</td>
									<td className="px-2 py-1.5 text-zinc-400">
										{formatDateTime(session.startedAt ?? undefined)}
									</td>
									<td className="px-2 py-1.5 text-right">
										{/*
										 * Also offered for a terminal row that still records
										 * an ffmpeg pid nobody has proven gone: that stop is
										 * the only path to the worker's kill ladder (audit
										 * 2026-08-29 CRITICAL-2).
										 */}
										<RoleAccess control="live.channel.feeder">
											{isStoppableFeederSession(session) ? (
												<Button
													variant="destructive"
													size="sm"
													disabled={stop.isPending}
													onClick={() => setConfirmingStopId(session.id)}
												>
													{t("feeder.stop")}
												</Button>
											) : null}
										</RoleAccess>
									</td>
								</tr>
							))}
						</tbody>
					</table>
					{stop.isError ? (
						<p
							role="alert"
							className="border-zinc-800 border-t p-2 text-red-400 text-xs"
						>
							{feederFailureMessage(t, t("ui.stop"), stop.error)}
						</p>
					) : null}
				</div>
			) : (
				<p className="text-xs text-zinc-500">{t("feeder.noSessions")}</p>
			)}

			<RoleAccess control="live.channel.feeder">
				<StopFeederSessionDialog
					open={confirmingStopId !== null}
					stopping={stop.isPending}
					onCancel={() => setConfirmingStopId(null)}
					onConfirm={() => {
						if (confirmingStopId !== null) {
							stop.mutate(confirmingStopId);
						}
					}}
				/>
			</RoleAccess>
		</div>
	);
}
