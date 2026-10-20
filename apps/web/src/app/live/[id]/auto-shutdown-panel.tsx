"use client";

import {
	type LiveAutoShutdownConfiguration,
	type LiveAutoShutdownUpdateReceipt,
	liveAutoShutdownUpdateParamsSchema,
} from "@bitovp/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import type { LiveChannelStatus } from "@/app/live/live-shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { localizedCustomerError } from "@/lib/customer-error";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";

type RecordedSettings = {
	runId: string;
	configuration: LiveAutoShutdownConfiguration | null;
	revision: string | null;
	receipt: LiveAutoShutdownUpdateReceipt | null;
	request: { key: string; state: string } | null;
};
type Replacement = {
	configuration: LiveAutoShutdownConfiguration;
	expectedRevision: string | null;
};
const TIMERS: {
	key: keyof LiveAutoShutdownConfiguration;
	label: MessageKey;
	min: number;
}[] = [
	{
		key: "bytesReadTimeoutSeconds",
		label: "autoShutdownUpdate.inputLoss",
		min: 30,
	},
	{ key: "streamTimeoutMinutes", label: "autoShutdownUpdate.runtime", min: 5 },
	{
		key: "waitingForFirstConnectTimeoutMinutes",
		label: "autoShutdownUpdate.firstInput",
		min: 5,
	},
];
const PENDING_STATES = new Set([
	"QUEUED",
	"CLAIMED",
	"DISPATCHING",
	"AWAITING_RECEIPT",
]);

export function AutoShutdownPanel({
	channelId,
	runId,
	status,
}: {
	channelId: string;
	runId?: string;
	status: LiveChannelStatus;
}) {
	return status === "RUNNING" && runId ? (
		<RoleAccess control="live.channel.auto-shutdown">
			<AutoShutdownEditor key={runId} channelId={channelId} runId={runId} />
		</RoleAccess>
	) : null;
}

function AutoShutdownEditor({
	channelId,
	runId,
}: {
	channelId: string;
	runId: string;
}) {
	const { t } = useT();
	const queryClient = useQueryClient();
	const [opened, setOpened] = useState(false);
	const [review, setReview] = useState<Replacement | null>(null);
	const [request, setRequest] = useState<{
		id: string;
		key: string;
		startedAt: number;
	} | null>(null);
	const identity = useRef<{ fingerprint: string; id: string } | null>(null);
	const recorded = useQuery({
		queryKey: ["live-auto-shutdown", channelId, runId, request?.id],
		queryFn: () =>
			apiFetch<RecordedSettings>(
				`/api/live-channels/${channelId}/auto-shutdown?runId=${runId}${request ? `&requestId=${request.id}` : ""}`,
			),
		enabled: opened,
		placeholderData: (previous) => previous,
		refetchOnWindowFocus: false,
		refetchInterval: (query) =>
			request &&
			Date.now() - request.startedAt < 120_000 &&
			(!query.state.data?.request ||
				PENDING_STATES.has(query.state.data.request.state))
				? 2_000
				: false,
	});
	const operation =
		request && recorded.data?.request?.key === request.key
			? recorded.data.request.state
			: request
				? "QUEUED"
				: (recorded.data?.request?.state ?? null);
	const update = useMutation({
		mutationFn: (replacement: Replacement) => {
			const fingerprint = JSON.stringify(replacement);
			if (identity.current?.fingerprint !== fingerprint)
				identity.current = { fingerprint, id: crypto.randomUUID() };
			const requestId = identity.current.id;
			setRequest({
				id: requestId,
				key: `manual:auto-shutdown:${channelId}:${requestId}`,
				startedAt: Date.now(),
			});
			return apiFetch(`/api/live-channels/${channelId}/auto-shutdown`, {
				method: "POST",
				body: JSON.stringify({ ...replacement, runId, requestId }),
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["live-auto-shutdown", channelId, runId],
			});
			queryClient.invalidateQueries({ queryKey: ["live-channel", channelId] });
		},
		onError: (error) => {
			const code =
				error instanceof ApiError
					? (error.details as { code?: unknown } | undefined)?.code
					: null;
			if (
				error instanceof ApiError &&
				error.status >= 400 &&
				error.status < 500 &&
				code !== "LIVE_ACTION_REQUEST_AMBIGUOUS" &&
				code !== "LIVE_ACTION_REQUEST_IN_PROGRESS"
			) {
				setRequest(null);
				identity.current = null;
			}
		},
	});
	const locked =
		update.isPending ||
		(operation !== null &&
			(PENDING_STATES.has(operation) || operation === "AMBIGUOUS"));
	return (
		<details
			className="mt-4 rounded-md border border-zinc-800 p-3"
			onToggle={(event) => setOpened(event.currentTarget.open)}
		>
			<summary className="cursor-pointer text-sm text-zinc-300">
				{t("autoShutdownUpdate.title")}
			</summary>
			{opened ? (
				<div className="mt-3 space-y-3 text-xs text-zinc-400">
					<p>{t("autoShutdownUpdate.recordedHint")}</p>
					<p>{t("autoShutdownUpdate.timingHint")}</p>
					<p>{t("autoShutdownUpdate.limitHint")}</p>
					{recorded.isPending ? (
						<p role="status">{t("common.loading")}</p>
					) : null}
					{recorded.data?.configuration ? (
						<ConfigurationForm
							key={`${runId}:${recorded.data.revision}`}
							initial={recorded.data.configuration}
							revision={recorded.data.revision}
							locked={locked}
							onReview={(replacement) => {
								if (operation === "ACKED" || operation === "RESOLVED") {
									identity.current = null;
									setRequest(null);
								}
								update.reset();
								setReview(replacement);
							}}
						/>
					) : null}
					{recorded.data?.configuration === null ? (
						<p role="alert">{t("autoShutdownUpdate.unavailable")}</p>
					) : null}
					{operation && PENDING_STATES.has(operation) ? (
						<p role="status">{t("autoShutdownUpdate.queued")}</p>
					) : null}
					{operation === "ACKED" ? (
						<p role="status" className="text-emerald-400">
							{t("autoShutdownUpdate.applied")}
						</p>
					) : null}
					{operation === "AMBIGUOUS" ? (
						<p role="alert">{t("autoShutdownUpdate.unknown")}</p>
					) : null}
					{operation === "RESOLVED" ? (
						<p role="status">{t("autoShutdownUpdate.resolved")}</p>
					) : null}
					{operation === "FAILED" ? (
						<p role="alert">{t("autoShutdownUpdate.failed")}</p>
					) : null}
					{recorded.data?.receipt?.scheduledShutdownAt ? (
						<p>
							{t("autoShutdownUpdate.scheduled", {
								at: new Date(
									recorded.data.receipt.scheduledShutdownAt,
								).toLocaleString(),
							})}
						</p>
					) : null}
					{recorded.isError ? (
						<p role="alert">
							{localizedCustomerError(
								t,
								recorded.error,
								"autoShutdownUpdate.loadFailed",
							)}
						</p>
					) : null}
					{update.isError ? (
						<p role="alert">
							{localizedCustomerError(
								t,
								update.error,
								"autoShutdownUpdate.failed",
							)}
						</p>
					) : null}
					<Button
						size="sm"
						variant="secondary"
						disabled={recorded.isFetching}
						onClick={() => recorded.refetch()}
					>
						{t("autoShutdownUpdate.reload")}
					</Button>
				</div>
			) : null}
			<Dialog
				open={review !== null}
				onOpenChange={(open) => {
					if (!open) setReview(null);
				}}
				title={t("autoShutdownUpdate.reviewTitle")}
				description={t("autoShutdownUpdate.replaceHint")}
			>
				<dl className="space-y-2 text-sm">
					{TIMERS.map(({ key, label }) => (
						<div key={key} className="flex flex-wrap justify-between gap-2">
							<dt>{t(label)}</dt>
							<dd>
								{review?.configuration[key] ?? t("autoShutdownUpdate.disabled")}
							</dd>
						</div>
					))}
				</dl>
				<p className="mt-3 text-xs text-zinc-400">
					{t("autoShutdownUpdate.timingHint")}
				</p>
				<div className="mt-4 flex justify-end gap-2">
					<Button size="sm" variant="secondary" onClick={() => setReview(null)}>
						{t("common.cancel")}
					</Button>
					<Button
						size="sm"
						variant={
							review && Object.keys(review.configuration).length === 0
								? "destructive"
								: "default"
						}
						disabled={locked}
						onClick={() => {
							if (review) {
								update.mutate(review);
								setReview(null);
							}
						}}
					>
						{review && Object.keys(review.configuration).length === 0
							? t("autoShutdownUpdate.disarmAll")
							: t("autoShutdownUpdate.apply")}
					</Button>
				</div>
			</Dialog>
		</details>
	);
}

function ConfigurationForm({
	initial,
	revision,
	locked,
	onReview,
}: {
	initial: LiveAutoShutdownConfiguration;
	revision: string | null;
	locked: boolean;
	onReview: (replacement: Replacement) => void;
}) {
	const { t } = useT();
	const id = useId();
	const [values, setValues] = useState(() =>
		Object.fromEntries(
			TIMERS.map(({ key }) => [
				key,
				initial[key] === undefined ? "" : String(initial[key]),
			]),
		),
	);
	const [invalid, setInvalid] = useState(false);
	return (
		<div className="space-y-2">
			<fieldset disabled={locked} className="grid gap-3 sm:grid-cols-3">
				<legend className="sr-only">{t("autoShutdownUpdate.title")}</legend>
				{TIMERS.map(({ key, label, min }) => (
					<Field
						key={key}
						label={t(label)}
						htmlFor={`${id}-${key}`}
						help={t("autoShutdownUpdate.emptyDisabled")}
					>
						<Input
							id={`${id}-${key}`}
							type="number"
							min={min}
							step={1}
							value={values[key] ?? ""}
							placeholder={t("autoShutdownUpdate.disabled")}
							onChange={(event) => {
								setValues((previous) => ({
									...previous,
									[key]: event.target.value,
								}));
								setInvalid(false);
							}}
						/>
					</Field>
				))}
			</fieldset>
			{invalid ? <p role="alert">{t("autoShutdownUpdate.invalid")}</p> : null}
			<Button
				size="sm"
				variant="secondary"
				disabled={locked}
				onClick={() => {
					const parsed = liveAutoShutdownUpdateParamsSchema.safeParse({
						configuration: Object.fromEntries(
							TIMERS.flatMap(({ key }) =>
								values[key] ? [[key, Number(values[key])]] : [],
							),
						),
						expectedRevision: revision,
					});
					if (!parsed.success) {
						setInvalid(true);
						return;
					}
					onReview({
						configuration: parsed.data.configuration,
						expectedRevision: revision,
					});
				}}
			>
				{t("autoShutdownUpdate.review")}
			</Button>
		</div>
	);
}
