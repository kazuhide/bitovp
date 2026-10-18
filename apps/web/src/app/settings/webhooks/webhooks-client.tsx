"use client";

import { INGRESS_RESOLVE_INTERVAL_MS, type IngressMode } from "@bitovp/core";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DetailPopover } from "@/components/ui/detail-popover";
import { Dialog } from "@/components/ui/dialog";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { formatDateTime } from "@/lib/format";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";
import { RegistrationPanel } from "./registration-panel";

type WebhookEventListItem = {
	id: string;
	eventType: string | null;
	externalEventId: string | null;
	signatureValid: boolean;
	receivedAt: string;
	processedAt: string | null;
};

type AuditLogListItem = {
	id: string;
	at: string;
	method: string;
	path: string;
	statusCode: number | null;
	durationMs: number | null;
	error: string | null;
};

type Page<T> = { items: T[]; nextCursor?: string };

/** The persisted ingress, as the page reads it (WP-G G-1) — no secrets. */
export type IngressWire = {
	mode: IngressMode;
	baseUrl: string | null;
	source: string | null;
	observedAt: string | null;
	checkedAt: string;
	reason: string | null;
};

type WebhooksClientProps = {
	/** null = the worker has not persisted a snapshot yet. */
	ingress: IngressWire | null;
	/** The signed account-level receiver; null without a public ingress. */
	receiverEndpoint: string | null;
	/** Where the signature master comes from; the key itself never reaches here. */
	secretSource: "env" | "generated" | "unavailable";
};

/** Every mode has a label — a mode added to core without one is a tsc error. */
const MODE_KEY: Record<IngressMode, MessageKey> = {
	none: "ingress.modeNone",
	static: "ingress.modeStatic",
	"quick-tunnel": "ingress.modeQuickTunnel",
	"named-tunnel": "ingress.modeNamedTunnel",
};

/** A snapshot older than two resolve intervals means the worker stopped writing. */
function ingressIsStale(checkedAt: string, now: number): boolean {
	const at = Date.parse(checkedAt);
	return Number.isNaN(at) || now - at > 2 * INGRESS_RESOLVE_INTERVAL_MS;
}

function usePagedList<T>(
	key: string,
	path: string,
	refetchInterval?: number,
	enabled = true,
) {
	return useInfiniteQuery({
		queryKey: [key],
		queryFn: ({ pageParam }) =>
			apiFetch<Page<T>>(
				pageParam ? `${path}?cursor=${encodeURIComponent(pageParam)}` : path,
			),
		initialPageParam: "",
		getNextPageParam: (last: Page<T>) => last.nextCursor ?? null,
		refetchInterval,
		enabled,
	});
}

export function WebhooksClient({
	ingress,
	receiverEndpoint,
	secretSource,
}: WebhooksClientProps) {
	const { t } = useT();
	const canReadAudit = useMutationAccess("settings.webhook-audit");
	const [payloadForId, setPayloadForId] = useState<string | null>(null);
	// Ingress is a page-load snapshot. The explicit document refresh below
	// reloads both its data and this clock; a ticker alone would age an old
	// snapshot even while the background service is healthy.
	// Server and initial browser render must agree, even across time zones or
	// the stale threshold. Local dates and the snapshot clock start after hydration.
	const [renderedAt, setRenderedAt] = useState<number | null>(null);
	useEffect(() => setRenderedAt(Date.now()), []);
	const stale =
		ingress !== null &&
		renderedAt !== null &&
		ingressIsStale(ingress.checkedAt, renderedAt);
	const ingressDate = (iso: string) =>
		renderedAt === null ? "—" : formatDateTime(iso);

	const events = usePagedList<WebhookEventListItem>(
		"webhook-events",
		"/api/webhook-events",
		15_000,
	);
	const audit = usePagedList<AuditLogListItem>(
		"audit-logs",
		"/api/audit-logs",
		undefined,
		canReadAudit,
	);

	const payload = useQuery({
		queryKey: ["webhook-event", payloadForId],
		queryFn: () =>
			apiFetch<{ raw: unknown; eventType: string | null; receivedAt: string }>(
				`/api/webhook-events/${payloadForId}`,
			),
		enabled: payloadForId !== null,
	});

	const eventItems = events.data?.pages.flatMap((p) => p.items) ?? [];
	const auditItems = audit.data?.pages.flatMap((p) => p.items) ?? [];

	return (
		<section>
			<div className="flex items-center gap-2">
				<h1 className="font-semibold text-xl text-zinc-50">
					{t("settingsForms.webhooks")}
				</h1>
				<HelpOverlay labelFor={t("settingsForms.webhooks")}>
					{t("settings.bitmovinNotificationReceiverAutoRegistrationOn")}
				</HelpOverlay>
			</div>

			<p
				role="note"
				className="mt-4 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-amber-200/90 text-xs"
			>
				{t("settings.webhookEventsAreReceivedAndVerified")}
			</p>

			{/* WP-G G-1: the public ingress as the WORKER resolved it, and the
			    signed receiver derived from it. Read from the persisted row, so
			    this card and the registration below cannot disagree. */}
			<section
				aria-labelledby="ingress-heading"
				className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900/40 p-5"
			>
				<div className="flex flex-wrap items-start gap-3">
					<div className="min-w-0 flex-1">
						<h2
							id="ingress-heading"
							className="font-medium text-sm text-zinc-200"
						>
							{t("ingress.title")}
						</h2>
						<p className="mt-1 text-xs text-zinc-400">
							{t("ingress.snapshotNote")}
							<a
								href="/settings/webhooks"
								className="rounded text-emerald-400 underline underline-offset-2 hover:text-emerald-300 focus-visible:outline-2 focus-visible:outline-emerald-500"
							>
								{t("common.refresh")}
							</a>
						</p>
						{ingress === null ? (
							<p role="alert" className="mt-1 text-amber-400 text-xs">
								{t("ingress.notReported")}
							</p>
						) : (
							<>
								<p className="mt-1 text-xs text-zinc-400">
									{t("ingress.mode")}: {t(MODE_KEY[ingress.mode])}
									{ingress.baseUrl ? (
										<>
											{" · "}
											<span className="select-all break-all font-mono text-zinc-300">
												{ingress.baseUrl}
											</span>
											{ingress.observedAt ? (
												<>
													{" · "}
													{t("ingress.since", {
														when: ingressDate(ingress.observedAt),
													})}
												</>
											) : null}
										</>
									) : null}
								</p>
								{ingress.baseUrl === null ? (
									<p role="alert" className="mt-1 text-amber-400 text-xs">
										{t("ingress.none", { reason: ingress.reason ?? "—" })}
									</p>
								) : null}
								<p
									className={`mt-1 text-xs ${stale ? "text-amber-400" : "text-zinc-500"}`}
								>
									{stale
										? t("ingress.stale", {
												when: ingressDate(ingress.checkedAt),
											})
										: t("ingress.checked", {
												when: ingressDate(ingress.checkedAt),
											})}
								</p>
							</>
						)}
					</div>
					<Badge tone={secretSource === "unavailable" ? "error" : "ok"}>
						{secretSource === "env"
							? t("ingress.secretEnv")
							: secretSource === "generated"
								? t("ingress.secretGenerated")
								: t("ingress.secretUnavailable")}
					</Badge>
				</div>
				{/* WP-G G-2: per-encoding tokens — the PATTERN, nothing to copy. */}
				<div className="mt-4 min-w-0">
					<h3 className="font-medium text-xs text-zinc-300">
						{t("ingress.receiver")}
					</h3>
					<p className="mt-1 break-all font-mono text-xs text-zinc-400">
						{receiverEndpoint ?? "—"}
					</p>
					<p className="mt-1 text-xs text-zinc-500">
						{t("ingress.receiverHint")}
					</p>
				</div>
			</section>

			<h2 className="mt-8 font-medium text-sm text-zinc-200">
				{t("settings.recentDeliveries")}
			</h2>
			{events.isError ? (
				<p role="alert" className="mt-2 text-red-400 text-sm">
					{t("settings.failedToLoadDeliveries")}
				</p>
			) : (
				<div className="mt-2 overflow-x-auto rounded-lg border border-zinc-800">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-zinc-800 border-b text-left text-xs text-zinc-500">
								<th className="px-3 py-2 font-medium">
									{t("settingsForms.received")}
								</th>
								<th className="px-3 py-2 font-medium">
									{t("settingsForms.type")}
								</th>
								<th className="px-3 py-2 font-medium">
									{t("settingsForms.signature")}
								</th>
								<th className="px-3 py-2 font-medium">
									{t("settingsForms.processed")}
								</th>
								<th className="w-24 px-3 py-2 font-medium">
									{t("settingsForms.payload")}
								</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-zinc-800/70">
							{eventItems.map((event) => (
								<tr key={event.id}>
									<td className="px-3 py-1.5 text-xs text-zinc-400">
										{formatDateTime(event.receivedAt)}
									</td>
									<td className="px-3 py-1.5 text-xs text-zinc-300">
										{event.eventType ?? "—"}
									</td>
									<td className="px-3 py-1.5">
										<Badge tone={event.signatureValid ? "ok" : "error"}>
											{event.signatureValid
												? t("settingsForms.signatureVerified")
												: t("settingsForms.signatureUnverified")}
										</Badge>
									</td>
									<td className="px-3 py-1.5 text-xs text-zinc-400">
										{event.processedAt
											? formatDateTime(event.processedAt)
											: t("settingsForms.processingPending")}
									</td>
									<td className="px-3 py-1.5">
										<Button
											variant="ghost"
											size="sm"
											onClick={() => setPayloadForId(event.id)}
										>
											{t("settingsForms.view")}
										</Button>
									</td>
								</tr>
							))}
							{!events.isLoading && eventItems.length === 0 ? (
								<tr>
									<td
										colSpan={5}
										className="px-3 py-8 text-center text-sm text-zinc-500"
									>
										{t("settings.noDeliveriesYetWebhookEventsAppear")}
									</td>
								</tr>
							) : null}
						</tbody>
					</table>
					{events.hasNextPage ? (
						<div className="border-zinc-800 border-t p-2">
							<Button
								variant="secondary"
								size="sm"
								disabled={events.isFetchingNextPage}
								onClick={() => events.fetchNextPage()}
							>
								{events.isFetchingNextPage
									? t("settings.loading")
									: t("settings.loadMore")}
							</Button>
						</div>
					) : null}
				</div>
			)}

			{canReadAudit ? (
				<>
					<h2 className="mt-8 font-medium text-sm text-zinc-200">
						{t("settings.bitmovinApiAuditLog")}
					</h2>
					{audit.isError ? (
						<p role="alert" className="mt-2 text-red-400 text-sm">
							{t("settings.failedToLoadTheAuditLog")}
						</p>
					) : (
						<div className="mt-2 overflow-x-auto rounded-lg border border-zinc-800">
							<table className="w-full text-sm">
								<thead>
									<tr className="border-zinc-800 border-b text-left text-xs text-zinc-500">
										<th className="px-3 py-2 font-medium">
											{t("settingsForms.at")}
										</th>
										<th className="px-3 py-2 font-medium">
											{t("settingsForms.call")}
										</th>
										<th className="px-3 py-2 font-medium">
											{t("settingsForms.status")}
										</th>
										<th className="px-3 py-2 font-medium">
											{t("settingsForms.duration")}
										</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-zinc-800/70">
									{auditItems.map((log) => (
										<tr key={log.id}>
											<td className="px-3 py-1.5 text-xs text-zinc-400">
												{formatDateTime(log.at)}
											</td>
											<td className="px-3 py-1.5 font-mono text-xs text-zinc-300">
												{/* break-all: a manifest/DRM path carries four
										    36-char UUIDs (~200 chars, one token) and
										    otherwise balloons this column until Status
										    scrolls off (UI loop 2026-08-21). */}
												{log.method}{" "}
												<span className="break-all">{log.path}</span>
											</td>
											<td className="px-3 py-1.5 text-xs">
												{log.error ? (
													// The error MESSAGE is the one field this audit log
													// exists for — it was fetched and used only to pick
													// this colour (ux inventory #5). One click opens it.
													<DetailPopover
														summary={
															<span className="text-red-400">
																{log.statusCode ?? "ERR"}
															</span>
														}
														label={t("uiX.auditErrorLabel")}
													>
														<p className="max-w-sm select-all whitespace-pre-wrap break-all font-mono text-red-300">
															{log.error}
														</p>
													</DetailPopover>
												) : (
													<span className="text-zinc-300">
														{log.statusCode}
													</span>
												)}
											</td>
											<td className="px-3 py-1.5 text-xs text-zinc-400">
												{log.durationMs !== null ? `${log.durationMs}ms` : "—"}
											</td>
										</tr>
									))}
									{!audit.isLoading && auditItems.length === 0 ? (
										<tr>
											<td
												colSpan={4}
												className="px-3 py-8 text-center text-sm text-zinc-500"
											>
												{t("settings.noApiCallsRecordedYetTry")}
											</td>
										</tr>
									) : null}
								</tbody>
							</table>
							{audit.hasNextPage ? (
								<div className="border-zinc-800 border-t p-2">
									<Button
										variant="secondary"
										size="sm"
										disabled={audit.isFetchingNextPage}
										onClick={() => audit.fetchNextPage()}
									>
										{audit.isFetchingNextPage
											? t("settings.loading")
											: t("settings.loadMore")}
									</Button>
								</div>
							) : null}
						</div>
					)}
				</>
			) : null}

			<Dialog
				open={payloadForId !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPayloadForId(null);
					}
				}}
				title={payload.data?.eventType ?? t("settings.webhookPayload")}
				description={
					payload.data
						? t("settingsX.receivedAt", {
								when: formatDateTime(payload.data.receivedAt),
							})
						: t("settings.loading")
				}
			>
				<pre className="max-h-96 overflow-auto rounded-md border border-zinc-800 bg-zinc-900 p-3 text-xs text-zinc-300">
					{payload.isLoading
						? t("settings.loading")
						: payload.isError
							? t("settings.failedToLoadThePayload")
							: JSON.stringify(payload.data?.raw, null, 2)}
				</pre>
			</Dialog>

			{/*  PR4: registration management — receiving was configured
			    here while registering still meant the Bitmovin dashboard. */}
			<RegistrationPanel />
		</section>
	);
}
