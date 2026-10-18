"use client";

import { PRODUCT_EVENT_KINDS, type ProductEventKind } from "@bitovp/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input } from "@/components/ui/input";
import { NewCredentialLink } from "@/components/ui/new-credential-link";
import { apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";

/**
 * Settings → Notifications : channels + rules CRUD over the
 * PR1 routes, and the delivery log reading the queue. The webhook URL is a
 * CREDENTIAL (provider NOTIFICATION_WEBHOOK) — this page links to the
 * credentials page for that half and only ever handles the reference.
 */

type ChannelWire = {
	id: string;
	name: string;
	kind: string;
	credentialId: string;
	credentialLabel: string;
	enabled: boolean;
	rules: { id: string; events: string[]; filter: unknown; enabled: boolean }[];
};

type CredentialWire = { id: string; label: string; provider: string };

type DeliveryWire = {
	id: string;
	state: "FAILED" | "DELIVERED";
	kind: string;
	occurredAt: string | null;
	link: string | null;
	attemptsMade: number;
	failedReason: string | null;
};

export function NotificationsClient() {
	const { t } = useT();
	const queryClient = useQueryClient();
	const nameId = useId();
	const credId = useId();
	const kindId = useId();
	const labelsId = useId();

	const channels = useQuery({
		queryKey: ["notification-channels"],
		queryFn: () => apiFetch<ChannelWire[]>("/api/notifications/channels"),
	});
	const credentials = useQuery({
		queryKey: ["credentials"],
		queryFn: () => apiFetch<CredentialWire[]>("/api/credentials"),
	});
	const deliveries = useQuery({
		queryKey: ["notification-deliveries"],
		queryFn: () =>
			apiFetch<{ failed: DeliveryWire[]; completed: DeliveryWire[] }>(
				"/api/notifications/deliveries",
			),
		refetchInterval: 15_000,
	});

	const webhookCredentials = (credentials.data ?? []).filter(
		(credential) => credential.provider === "NOTIFICATION_WEBHOOK",
	);

	const [name, setName] = useState("");
	const [kind, setKind] = useState<"GENERIC_WEBHOOK" | "SLACK_WEBHOOK">(
		"SLACK_WEBHOOK",
	);
	const [credentialId, setCredentialId] = useState("");
	const [events, setEvents] = useState<ProductEventKind[]>([
		"JOB_ERROR",
		"CHANNEL_ERROR",
	]);
	const [labelsCsv, setLabelsCsv] = useState("");

	const create = useMutation({
		mutationFn: () => {
			const labels = labelsCsv
				.split(",")
				.map((label) => label.trim())
				.filter((label) => label !== "");
			return apiFetch("/api/notifications/channels", {
				method: "POST",
				body: JSON.stringify({
					name,
					kind,
					credentialId,
					rules: [
						{
							events,
							...(labels.length > 0 ? { filter: { labels } } : {}),
						},
					],
				}),
			});
		},
		onSuccess: () => {
			setName("");
			setLabelsCsv("");
			queryClient.invalidateQueries({ queryKey: ["notification-channels"] });
		},
	});

	const toggle = useMutation({
		mutationFn: (args: { id: string; enabled: boolean }) =>
			apiFetch(`/api/notifications/channels/${args.id}`, {
				method: "PATCH",
				body: JSON.stringify({ enabled: args.enabled }),
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["notification-channels"] }),
	});

	const remove = useMutation({
		mutationFn: (id: string) =>
			apiFetch(`/api/notifications/channels/${id}`, { method: "DELETE" }),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["notification-channels"] }),
	});

	const channelActionError = toggle.error ?? remove.error;

	const toggleEvent = (eventKind: ProductEventKind) => {
		setEvents((current) =>
			current.includes(eventKind)
				? current.filter((existing) => existing !== eventKind)
				: [...current, eventKind],
		);
	};

	return (
		<div className="space-y-8">
			{/* E2E 2026-08-14 finding: this was the ONE screen of 22 without a
			    level-1 heading — the outline started at h2 and heading
			    navigation skipped the page identity. Same header shape as the
			    sibling settings screens. */}
			<header>
				<div className="flex items-center gap-2">
					<h1 className="font-semibold text-xl text-zinc-50">
						{t("notif.pageHeading")}
					</h1>
					<HelpOverlay labelFor={t("notif.pageHeading")}>
						{t("notif.pageHeadingSub")}
					</HelpOverlay>
				</div>
			</header>
			<section className="space-y-3">
				<h2 className="font-medium text-sm text-zinc-200">
					{t("notif.channels")}
				</h2>
				{channels.isLoading && <p role="status">{t("common.loading")}</p>}
				{channels.isError && (
					<p role="alert" className="text-red-400 text-sm">
						{t("common.requestFailed")}{" "}
						<Button
							variant="secondary"
							size="sm"
							disabled={channels.isFetching}
							onClick={() => channels.refetch()}
						>
							{t("settingsForms.retry")}
						</Button>
					</p>
				)}
				{channelActionError && (
					<p role="alert" className="text-red-400 text-sm">
						{t("common.requestFailed")}
					</p>
				)}
				{!channels.isError && channels.data?.length === 0 ? (
					<p className="text-sm text-zinc-500">{t("notif.noChannelsYet")}</p>
				) : null}
				<ul className="space-y-2">
					{(channels.data ?? []).map((channel) => (
						<li
							key={channel.id}
							className="flex flex-wrap items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2"
						>
							<span className="font-medium text-sm text-zinc-100">
								{channel.name}
							</span>
							<Badge>{channel.kind}</Badge>
							<Badge tone={channel.enabled ? "ok" : "neutral"}>
								{channel.enabled ? t("notif.enabled") : t("notif.disabled")}
							</Badge>
							<span className="text-xs text-zinc-500">
								{channel.credentialLabel}
							</span>
							<span className="font-mono text-[11px] text-zinc-500">
								{channel.rules.flatMap((rule) => rule.events).join(", ")}
							</span>
							<RoleAccess control="settings.notifications">
								<span className="ml-auto flex gap-2">
									<Button
										variant="secondary"
										size="sm"
										disabled={toggle.isPending || remove.isPending}
										onClick={() => {
											remove.reset();
											toggle.mutate({
												id: channel.id,
												enabled: !channel.enabled,
											});
										}}
									>
										{channel.enabled ? t("notif.disable") : t("notif.enable")}
									</Button>
									<Button
										variant="secondary"
										size="sm"
										disabled={toggle.isPending || remove.isPending}
										onClick={() => {
											if (
												window.confirm(
													t("notif.deleteConfirm", { name: channel.name }),
												)
											) {
												toggle.reset();
												remove.mutate(channel.id);
											}
										}}
									>
										{t("ui.delete")}
									</Button>
								</span>
							</RoleAccess>
						</li>
					))}
				</ul>
			</section>

			<RoleAccess control="settings.notifications">
				<section className="max-w-xl space-y-3">
					<h2 className="font-medium text-sm text-zinc-200">
						{t("notif.addChannel")}
					</h2>
					{credentials.isLoading && <p role="status">{t("common.loading")}</p>}
					{credentials.isError && (
						<p role="alert" className="text-red-400 text-sm">
							{t("common.requestFailed")}{" "}
							<Button
								variant="secondary"
								size="sm"
								disabled={credentials.isFetching}
								onClick={() => credentials.refetch()}
							>
								{t("settingsForms.retry")}
							</Button>
						</p>
					)}
					{credentials.isSuccess && webhookCredentials.length === 0 ? (
						<p className="text-amber-400 text-xs">
							{t("notif.needsWebhookCredential")}
						</p>
					) : null}
					<fieldset disabled={create.isPending} className="space-y-3">
						<Field label={t("notif.channelName")} htmlFor={nameId}>
							<Input
								id={nameId}
								value={name}
								placeholder="ops-alerts"
								onChange={(e) => setName(e.target.value)}
							/>
						</Field>
						<Field label={t("notif.kind")} htmlFor={kindId}>
							<select
								id={kindId}
								value={kind}
								onChange={(e) =>
									setKind(e.target.value as "GENERIC_WEBHOOK" | "SLACK_WEBHOOK")
								}
								className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-200"
							>
								<option value="SLACK_WEBHOOK">Slack</option>
								<option value="GENERIC_WEBHOOK">
									{t("notif.genericWebhook")}
								</option>
							</select>
						</Field>
						<Field label={t("notif.credential")} htmlFor={credId}>
							<select
								id={credId}
								value={credentialId}
								onChange={(e) => setCredentialId(e.target.value)}
								className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-200"
							>
								<option value="">{t("notif.selectCredential")}</option>
								{webhookCredentials.map((credential) => (
									<option key={credential.id} value={credential.id}>
										{credential.label}
									</option>
								))}
							</select>
							<NewCredentialLink />
						</Field>
						<fieldset>
							<legend className="mb-1 text-xs text-zinc-400">
								{t("notif.eventKinds")}
							</legend>
							<div className="grid grid-cols-2 gap-1">
								{PRODUCT_EVENT_KINDS.map((eventKind) => (
									<label
										key={eventKind}
										className="flex items-center gap-2 font-mono text-[11px] text-zinc-300"
									>
										<input
											type="checkbox"
											checked={events.includes(eventKind)}
											onChange={() => toggleEvent(eventKind)}
										/>
										{eventKind}
									</label>
								))}
							</div>
						</fieldset>
						<Field
							label={t("notif.labelFilter")}
							htmlFor={labelsId}
							help={t("notif.labelFilterHint")}
						>
							<Input
								id={labelsId}
								value={labelsCsv}
								placeholder="prod, drama"
								onChange={(e) => setLabelsCsv(e.target.value)}
							/>
						</Field>
						{create.isError ? (
							<p role="alert" className="text-red-400 text-sm">
								{create.error instanceof Error
									? create.error.message
									: t("notif.createFailed")}
							</p>
						) : null}
						<Button
							onClick={() => create.mutate()}
							disabled={
								create.isPending ||
								credentials.isLoading ||
								credentials.isError ||
								name.trim() === "" ||
								!webhookCredentials.some(
									(credential) => credential.id === credentialId,
								) ||
								events.length === 0
							}
						>
							{t("notif.createChannel")}
						</Button>
					</fieldset>
				</section>
			</RoleAccess>

			<section className="space-y-3">
				<h2 className="font-medium text-sm text-zinc-200">
					{t("notif.recentDeliveries")}
				</h2>
				{deliveries.isLoading && <p role="status">{t("common.loading")}</p>}
				{deliveries.isError && (
					<p role="alert" className="text-red-400 text-sm">
						{t("common.requestFailed")}{" "}
						<Button
							variant="secondary"
							size="sm"
							disabled={deliveries.isFetching}
							onClick={() => deliveries.refetch()}
						>
							{t("settingsForms.retry")}
						</Button>
					</p>
				)}
				{!deliveries.isError &&
				deliveries.data &&
				deliveries.data.failed.length === 0 &&
				deliveries.data.completed.length === 0 ? (
					<p className="text-sm text-zinc-500">{t("notif.noDeliveriesYet")}</p>
				) : null}
				<ul className="space-y-1">
					{[
						...(deliveries.data?.failed ?? []),
						...(deliveries.data?.completed ?? []),
					].map((delivery) => (
						<li
							key={`${delivery.state}-${delivery.id}`}
							className="flex flex-wrap items-center gap-2 text-xs"
						>
							<Badge tone={delivery.state === "FAILED" ? "error" : "ok"}>
								{delivery.state}
							</Badge>
							<span className="font-mono">{delivery.kind}</span>
							<span className="text-zinc-500">{delivery.occurredAt}</span>
							{delivery.failedReason ? (
								<span className="break-words text-red-400">
									{delivery.failedReason} ({delivery.attemptsMade}{" "}
									{t("notif.attempts")})
								</span>
							) : null}
						</li>
					))}
				</ul>
			</section>
		</div>
	);
}
