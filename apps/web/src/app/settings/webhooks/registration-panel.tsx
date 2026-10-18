"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { formatDateTime } from "@/lib/format";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";

/**
 * Bitmovin webhook registrations .
 *
 * Two lists, deliberately separate:
 *  - PER-ENCODING registrations — the rows the worker's registrar keeps for
 *    every live job / run (four kinds each), with whether the registered URL
 *    still sits under the CURRENT public ingress and when Bitmovin last
 *    delivered. The one action is "re-register now", which asks the worker
 *    to retry every waiting row on its next tick.
 *  - ACCOUNT-LEVEL hooks — what the Bitmovin account still holds at account
 *    level: this app's earlier registrations (legacy / signed) and anyone
 *    else's. Read-and-remove only; the "register the standard set" button
 *    is gone, because per-encoding registration replaced it.
 *
 * Registration failures surface on the rows (status + note); polling covers
 * everything regardless, so a failed registration costs latency, never state.
 */

type AccountWire = { id: string; label: string };
type AccountHooksWire = {
	endpoint: string | null;
	rows: {
		kind: string;
		id: string;
		url: string;
		ours: boolean;
		/** Ours, but at the pre-G-1 unsigned receiver (removed in G-2). */
		legacy: boolean;
	}[];
};

type RegistrationStatus = "ACTIVE" | "SKIPPED" | "FAILED" | "DELETED";
type RegistrationWire = {
	currentBase: string | null;
	rows: {
		id: string;
		encodingId: string;
		kind: string;
		status: RegistrationStatus;
		url: string | null;
		urlMatchesIngress: boolean;
		note: string | null;
		attempts: number;
		nextAttemptAt: string | null;
		registeredAt: string | null;
		lastDeliveryAt: string | null;
		subject:
			| { kind: "job"; id: string; name: string; status: string }
			| {
					kind: "run";
					id: string;
					name: string;
					channelId: string;
					seq: number;
					status: string;
			  }
			| null;
	}[];
};

const STATUS_KEY: Record<RegistrationStatus, MessageKey> = {
	ACTIVE: "webhookReg.statusActive",
	SKIPPED: "webhookReg.statusSkipped",
	FAILED: "webhookReg.statusFailed",
	DELETED: "webhookReg.statusDeleted",
};

const STATUS_TONE: Record<
	RegistrationStatus,
	"ok" | "warn" | "error" | "neutral"
> = {
	ACTIVE: "ok",
	SKIPPED: "warn",
	FAILED: "error",
	DELETED: "neutral",
};

/** The registrar's own vocabulary, rendered for a customer. */
function noteLabel(
	note: string | null,
	t: (key: MessageKey, values?: Record<string, string | number>) => string,
): string | null {
	if (note === null || note === "pending") {
		return null;
	}
	if (note === "ingressUnavailable") {
		return t("webhookReg.noteIngressUnavailable");
	}
	if (note === "perEncodingOnly") {
		return `${t("heartbeatWebhook.modeLegacy")} → ${t("live.push.perEncoding")}`;
	}
	if (note === "delete failed (perEncodingOnly)") {
		return `${t("webhookReg.removeFailed")} (${t("heartbeatWebhook.modeLegacy")})`;
	}
	const heartbeatNotes: Record<string, MessageKey> = {
		"heartbeat: slots": "heartbeatWebhook.slots",
		"heartbeat: ambiguous": "heartbeatWebhook.ambiguous",
		"heartbeat: unresolved create cleanup": "heartbeatWebhook.ambiguous",
		"heartbeat: provider": "heartbeatWebhook.providerFailed",
		"heartbeat: budget": "heartbeatWebhook.budget",
		POLL_ONLY: "live.push.pollOnly",
		PENDING_VERSION: "live.push.pendingVersion",
		PER_ENCODING: "live.push.perEncoding",
		LEGACY_ACCOUNT: "heartbeatWebhook.modeLegacy",
	};
	if (heartbeatNotes[note]) return t(heartbeatNotes[note]);
	if (note === "terminal") {
		return t("webhookReg.noteTerminal");
	}
	if (note === "orphan") {
		return t("webhookReg.noteOrphan");
	}
	if (note === "ingressChanged") {
		return t("webhookReg.noteIngressChanged");
	}
	if (note === "keyRotated") {
		return t("webhookReg.noteKeyRotated");
	}
	return note;
}

export function RegistrationPanel() {
	const { t } = useT();
	const canOperate = useMutationAccess("settings.webhook-registration");
	const queryClient = useQueryClient();
	const accountSelectId = useId();
	const [accountId, setAccountId] = useState("");
	/** Two-step confirm for EXTERNAL rows (review-187 I5): on a shared
	    Bitmovin account, staging's panel lists production's hook as
	    "external" — one silent click must not kill production delivery. */
	const [confirmingId, setConfirmingId] = useState<string | null>(null);

	const registrations = useQuery({
		queryKey: ["webhook-registrations"],
		queryFn: () => apiFetch<RegistrationWire>("/api/webhook-registrations"),
		refetchInterval: 15_000,
	});

	const reconcile = useMutation({
		mutationFn: () =>
			apiFetch<{ requestedAt: string; appliesWithinMs: number }>(
				"/api/webhook-registrations/reconcile",
				{ method: "POST" },
			),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["webhook-registrations"] }),
	});

	const accounts = useQuery({
		queryKey: ["bitmovin-accounts"],
		queryFn: () => apiFetch<AccountWire[]>("/api/bitmovin-accounts"),
	});
	const accountHooks = useQuery({
		queryKey: ["webhook-registrations", "account", accountId],
		enabled: accountId !== "",
		retry: false,
		queryFn: () =>
			apiFetch<AccountHooksWire>(
				`/api/webhook-registration?bitmovinAccountId=${accountId}`,
			),
	});

	const remove = useMutation({
		mutationFn: (args: { kind: string; webhookId: string }) =>
			apiFetch(`/api/webhook-registration?bitmovinAccountId=${accountId}`, {
				method: "DELETE",
				body: JSON.stringify(args),
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: ["webhook-registrations", "account", accountId],
			}),
	});

	const rows = registrations.data?.rows ?? [];

	return (
		<>
			<section className="space-y-3">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div className="flex items-center gap-2">
						<h2 className="font-medium text-sm text-zinc-200">
							{t("webhookReg.perEncodingTitle")}
						</h2>
						<HelpOverlay labelFor={t("webhookReg.perEncodingTitle")}>
							{t("webhookReg.perEncodingLead")}
						</HelpOverlay>
					</div>
					{canOperate ? (
						<Button
							variant="secondary"
							size="sm"
							disabled={reconcile.isPending}
							onClick={() => reconcile.mutate()}
						>
							{t("webhookReg.reregisterNow")}
						</Button>
					) : null}
				</div>
				{reconcile.isSuccess ? (
					<p role="status" className="text-emerald-400 text-xs">
						{t("webhookReg.reregisterRequested", {
							seconds: Math.ceil(reconcile.data.appliesWithinMs / 1000),
						})}
					</p>
				) : null}
				{reconcile.isError ? (
					<p role="alert" className="text-red-400 text-sm">
						{reconcile.error instanceof Error
							? reconcile.error.message
							: t("webhookReg.reregisterFailed")}
					</p>
				) : null}
				{registrations.isError ? (
					<p role="alert" className="text-red-400 text-sm">
						{t("webhookReg.listFailed")}{" "}
						<Button
							variant="secondary"
							size="sm"
							disabled={registrations.isFetching}
							onClick={() => registrations.refetch()}
						>
							{t("settingsForms.retry")}
						</Button>
					</p>
				) : rows.length === 0 ? (
					<p className="text-sm text-zinc-500">
						{registrations.isLoading
							? t("settings.loading")
							: t("webhookReg.noPerEncoding")}
					</p>
				) : (
					<div className="overflow-x-auto rounded-lg border border-zinc-800">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-zinc-800 border-b text-left text-xs text-zinc-500">
									<th className="px-3 py-2 font-medium">
										{t("webhookReg.colSubject")}
									</th>
									<th className="px-3 py-2 font-medium">
										{t("webhookReg.colKind")}
									</th>
									<th className="px-3 py-2 font-medium">
										{t("settingsForms.status")}
									</th>
									<th className="px-3 py-2 font-medium">
										{t("webhookReg.colUrl")}
									</th>
									<th className="px-3 py-2 font-medium">
										{t("webhookReg.colLastDelivery")}
									</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-zinc-800/70">
								{rows.map((row) => {
									const note = noteLabel(row.note, t);
									return (
										<tr key={row.id}>
											<td className="px-3 py-1.5 text-xs text-zinc-300">
												{row.subject === null ? (
													<span className="font-mono text-zinc-500">
														{row.encodingId}
													</span>
												) : row.subject.kind === "job" ? (
													<Link
														href={`/vod/jobs/${row.subject.id}`}
														className="underline-offset-2 hover:underline"
													>
														{row.subject.name}
													</Link>
												) : (
													<Link
														href={`/live/${row.subject.channelId}`}
														className="underline-offset-2 hover:underline"
													>
														{t("webhookReg.runSubject", {
															name: row.subject.name,
															seq: row.subject.seq,
														})}
													</Link>
												)}
											</td>
											<td className="px-3 py-1.5">
												<Badge>{row.kind}</Badge>
											</td>
											<td className="px-3 py-1.5">
												<Badge tone={STATUS_TONE[row.status]}>
													{t(STATUS_KEY[row.status])}
												</Badge>
												{note ? (
													<p className="mt-1 text-xs text-zinc-500">{note}</p>
												) : null}
											</td>
											<td className="px-3 py-1.5 text-xs">
												{row.url === null ? (
													<span className="text-zinc-600">—</span>
												) : (
													<Badge tone={row.urlMatchesIngress ? "ok" : "warn"}>
														{row.urlMatchesIngress
															? t("webhookReg.urlCurrent")
															: t("webhookReg.urlStale")}
													</Badge>
												)}
											</td>
											<td className="px-3 py-1.5 text-xs text-zinc-400">
												{row.lastDeliveryAt
													? formatDateTime(row.lastDeliveryAt)
													: t("webhookReg.noDelivery")}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
			</section>

			<section className="mt-8 space-y-3">
				<div className="flex items-center gap-2">
					<h2 className="font-medium text-sm text-zinc-200">
						{t("webhookReg.title")}
					</h2>
					<HelpOverlay labelFor={t("webhookReg.title")}>
						{t("webhookReg.accountLead")}
					</HelpOverlay>
				</div>
				{accounts.isLoading && <p role="status">{t("common.loading")}</p>}
				{accounts.isError && (
					<p role="alert" className="text-red-400 text-sm">
						{t("settings.failedToLoadAccounts")}{" "}
						<Button
							variant="secondary"
							size="sm"
							disabled={accounts.isFetching}
							onClick={() => accounts.refetch()}
						>
							{t("settingsForms.retry")}
						</Button>
					</p>
				)}
				<div className="max-w-md">
					<label
						htmlFor={accountSelectId}
						className="mb-1 block text-xs text-zinc-400"
					>
						{t("webhookReg.account")}
					</label>
					<select
						id={accountSelectId}
						value={accountId}
						disabled={
							remove.isPending || accounts.isLoading || accounts.isError
						}
						onChange={(e) => {
							setAccountId(e.target.value);
							setConfirmingId(null);
							remove.reset();
						}}
						className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-200"
					>
						<option value="">{t("webhookReg.selectAccount")}</option>
						{(accounts.data ?? []).map((account) => (
							<option key={account.id} value={account.id}>
								{account.label}
							</option>
						))}
					</select>
				</div>
				{accountId === "" ? null : accountHooks.isLoading ? (
					<p role="status">{t("common.loading")}</p>
				) : accountHooks.isError ? (
					<p role="alert" className="text-red-400 text-sm">
						{accountHooks.error instanceof Error
							? accountHooks.error.message
							: t("webhookReg.listFailed")}{" "}
						<Button
							variant="secondary"
							size="sm"
							disabled={accountHooks.isFetching}
							onClick={() => accountHooks.refetch()}
						>
							{t("settingsForms.retry")}
						</Button>
					</p>
				) : (
					<>
						<ul className="space-y-1">
							{(accountHooks.data?.rows ?? []).map((row) => (
								<li
									key={`${row.kind}-${row.id}`}
									className="flex flex-wrap items-center gap-2 text-xs"
								>
									<Badge>{row.kind}</Badge>
									<Badge
										tone={row.ours ? (row.legacy ? "warn" : "ok") : "neutral"}
									>
										{row.ours
											? row.legacy
												? t("ingress.legacyRow")
												: t("webhookReg.thisApp")
											: t("webhookReg.external")}
									</Badge>
									<span className="select-all break-all font-mono text-zinc-400">
										{row.url}
									</span>
									{canOperate ? (
										<Button
											variant="secondary"
											size="sm"
											disabled={remove.isPending}
											onClick={() => {
												if (row.ours || confirmingId === row.id) {
													setConfirmingId(null);
													remove.mutate({ kind: row.kind, webhookId: row.id });
													return;
												}
												setConfirmingId(row.id);
											}}
										>
											{!row.ours && confirmingId === row.id
												? t("webhookReg.confirmExternalUnregister")
												: t("webhookReg.unregister")}
										</Button>
									) : null}
								</li>
							))}
						</ul>
						{accountHooks.data && accountHooks.data.rows.length === 0 ? (
							<p className="text-sm text-zinc-500">
								{t("webhookReg.noneRegistered")}
							</p>
						) : null}
						{remove.isError ? (
							<p role="alert" className="text-red-400 text-sm">
								{remove.error instanceof Error
									? remove.error.message
									: t("webhookReg.removeFailed")}
							</p>
						) : null}
					</>
				)}
			</section>
		</>
	);
}
