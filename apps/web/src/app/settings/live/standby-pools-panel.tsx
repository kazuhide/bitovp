"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { CopyableId } from "@/components/copyable-id";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { InfoHint } from "@/components/ui/info-hint";
import { Input, Textarea } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import { zodIssueMessage } from "@/lib/i18n/zod-issue-message";
import {
	LIST_LIMIT_MAX,
	type PageDto,
	type StandbyPoolDetailsDto,
	type StandbyPoolDto,
	type StandbyPoolEncodingDto,
	type StandbyPoolEncodingStatus,
	type StandbyPoolLogDto,
	type StandbyPoolLogType,
	standbyPoolCreateSchema,
} from "@/lib/live-runtime/schemas";

const ENCODING_TONE: Record<
	StandbyPoolEncodingStatus,
	"neutral" | "ok" | "error"
> = {
	TO_BE_CREATED: "neutral",
	CREATING: "neutral",
	PREPARING: "neutral",
	READY: "ok",
	TO_BE_DELETED: "neutral",
	DELETING: "neutral",
	ACQUIRED: "ok",
	ERROR: "error",
};

const LOG_TONE: Record<StandbyPoolLogType, "neutral" | "ok" | "error"> = {
	INFO: "neutral",
	WARN: "neutral",
	ERROR: "error",
};

const POOLS_BASE = "/api/live/standby-pools";

type PoolFormValues = {
	name: string;
	description: string;
	targetPoolSize: string;
	encodingTemplate: string;
};

/**
 * Live standby pools: encodings kept pre-started and idling so a channel can go
 * live in seconds. Acquire one and Bitmovin hands back its ingest points and
 * manifest URLs immediately.
 *
 * NOTE (C6 exception): the pool LIST endpoint takes no paging parameters at all,
 * so this panel does not offer "Load more" — the encodings and logs sub-lists
 * are paged normally.
 */
export function StandbyPoolsPanel({
	bitmovinAccountId,
}: {
	bitmovinAccountId: string;
}) {
	const { t } = useT();
	const queryClient = useQueryClient();
	const [createOpen, setCreateOpen] = useState(false);
	const [detailFor, setDetailFor] = useState<StandbyPoolDto | null>(null);

	const queryKey = ["live-standby-pools", bitmovinAccountId];

	const list = useQuery({
		queryKey,
		queryFn: () =>
			apiFetch<PageDto<StandbyPoolDto>>(
				`${POOLS_BASE}?bitmovinAccountId=${bitmovinAccountId}`,
			),
	});

	const invalidate = () => queryClient.invalidateQueries({ queryKey });

	const create = useMutation({
		mutationFn: (pool: unknown) =>
			apiFetch<StandbyPoolDetailsDto>(POOLS_BASE, {
				method: "POST",
				body: JSON.stringify({ bitmovinAccountId, pool }),
			}),
		onSuccess: () => {
			setCreateOpen(false);
			invalidate();
		},
	});

	const remove = useMutation({
		mutationFn: (poolId: string) =>
			apiFetch<{ id: string }>(
				`${POOLS_BASE}/${poolId}?bitmovinAccountId=${bitmovinAccountId}`,
				{ method: "DELETE" },
			),
		onSuccess: invalidate,
	});

	const { register, handleSubmit, setError, reset, formState } =
		useForm<PoolFormValues>({
			defaultValues: {
				name: "",
				description: "",
				targetPoolSize: "1",
				encodingTemplate: "",
			},
		});

	const submit = handleSubmit((values) => {
		const parsed = standbyPoolCreateSchema.safeParse({
			name: values.name,
			...(values.description !== "" ? { description: values.description } : {}),
			targetPoolSize: Number(values.targetPoolSize),
			encodingTemplate: values.encodingTemplate,
		});
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				const path = issue.path.join(".");
				setError((path || "root") as keyof PoolFormValues | "root", {
					message: zodIssueMessage(issue, t),
				});
			}
			return;
		}
		create.mutate(parsed.data);
	});

	const mutationError = remove.error;
	const pools = list.data?.items ?? [];

	return (
		<div>
			<div className="flex items-start justify-between gap-4">
				<p className="max-w-xl text-xs text-zinc-500">
					{t("settingsX.standbyIntro")}{" "}
					<InfoHint
						label={t("settings.standbyPoolsMoreInformation")}
						text={t("settingsForms.eachPoolStartsItsEncodingsFromAn")}
					/>
				</p>
				<RoleAccess control="settings.live.standby-pools">
					<Button onClick={() => setCreateOpen(true)}>
						<Plus aria-hidden className="h-4 w-4" /> {t("settings.createPool")}
					</Button>
				</RoleAccess>
			</div>

			{mutationError ? (
				<p role="alert" className="mt-4 text-red-400 text-sm">
					{mutationError instanceof ApiError
						? mutationError.message
						: t("settings.requestFailed")}
				</p>
			) : null}

			<div className="mt-4">
				{list.isLoading ? (
					<div
						role="status"
						aria-busy="true"
						aria-label={t("settings.loadingStandbyPools")}
						className="space-y-2"
					>
						{[0, 1].map((i) => (
							<div
								key={i}
								className="h-16 animate-pulse rounded-md bg-zinc-900"
							/>
						))}
					</div>
				) : list.isError ? (
					<div
						role="alert"
						className="rounded-md border border-red-900 bg-red-950/30 p-4 text-red-300 text-sm"
					>
						{t("settings.failedToLoadStandbyPools")}
						{list.error instanceof ApiError ? `: ${list.error.message}` : ""}
						{t("common.sentenceEnd")}{" "}
						<button
							type="button"
							className="underline"
							onClick={() => list.refetch()}
						>
							{t("settingsForms.retry")}
						</button>
					</div>
				) : pools.length > 0 ? (
					<ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
						{pools.map((pool) => (
							<li key={pool.id} className="flex items-center gap-4 px-4 py-3">
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="truncate font-medium text-sm text-zinc-100">
											{pool.name || pool.id}
										</span>
										{pool.poolStatus ? (
											<Badge
												tone={pool.poolStatus === "HEALTHY" ? "ok" : "error"}
											>
												{pool.poolStatus}
											</Badge>
										) : null}
									</div>
									<p className="mt-0.5 truncate text-xs text-zinc-500">
										{t("settingsX.standbyPoolCounts", {
											ready: pool.readyEncodings ?? 0,
											preparing: pool.preparingEncodings ?? 0,
											error: pool.errorEncodings ?? 0,
											target: pool.targetPoolSize ?? "—",
										})}
										{pool.encodingTemplateName
											? t("settingsX.templateSuffix", {
													name: pool.encodingTemplateName,
												})
											: ""}
									</p>
								</div>
								<div className="flex shrink-0 gap-1">
									<Button
										variant="secondary"
										size="sm"
										onClick={() => setDetailFor(pool)}
									>
										{t("settingsForms.details")}
									</Button>
									<RoleAccess control="settings.live.standby-pools">
										<Button
											variant="destructive"
											size="sm"
											disabled={remove.isPending}
											onClick={() => {
												if (
													window.confirm(
														t("settingsX.deleteStandbyPoolNamed", {
															name: pool.name || pool.id,
														}),
													)
												) {
													remove.mutate(pool.id);
												}
											}}
										>
											{t("settingsForms.delete")}
										</Button>
									</RoleAccess>
								</div>
							</li>
						))}
					</ul>
				) : (
					<div
						role="status"
						className="rounded-lg border border-zinc-800 border-dashed bg-zinc-900/40 p-10 text-center"
					>
						<h3 className="font-medium text-sm text-zinc-200">
							{t("settings.noStandbyPoolsYet")}
						</h3>
					</div>
				)}
				{!list.isLoading && !list.isError && pools.length > 0 ? (
					<p className="mt-2 text-xs text-zinc-500">
						{t("settingsX.showingPoolsNoPaging", {
							shown:
								list.data?.totalCount !== undefined
									? t("settingsX.shownOfTotal", {
											shown: pools.length,
											total: list.data.totalCount,
										})
									: String(pools.length),
						})}
					</p>
				) : null}
			</div>

			<RoleAccess control="settings.live.standby-pools">
				<Dialog
					open={createOpen}
					onOpenChange={(open) => {
						if (!open && !create.isPending) {
							setCreateOpen(false);
							create.reset();
							reset();
						}
					}}
					title={t("settings.createStandbyPool")}
					description={t("settings.standingEncodersBillWhileThePool")}
				>
					{create.isError ? (
						<p role="alert" className="mb-3 text-red-400 text-sm">
							{create.error instanceof ApiError
								? create.error.message
								: t("settings.requestFailed")}
						</p>
					) : null}
					<form onSubmit={submit} className="space-y-4" noValidate>
						{formState.errors.root?.message ? (
							<p role="alert" className="text-red-400 text-xs">
								{formState.errors.root.message}
							</p>
						) : null}
						<Field
							label={t("settingsForms.name")}
							htmlFor="sp-name"
							error={formState.errors.name?.message}
						>
							<Input
								id="sp-name"
								placeholder="breaking-news"
								{...register("name")}
							/>
						</Field>
						<Field
							label={t("settingsForms.descriptionOptional")}
							htmlFor="sp-description"
							error={formState.errors.description?.message}
						>
							<Input id="sp-description" {...register("description")} />
						</Field>
						<Field
							label={t("settings.targetPoolSize")}
							htmlFor="sp-target"
							error={formState.errors.targetPoolSize?.message}
							help={t("settingsForms.instancesKeptReadyForStreaming1100")}
						>
							<Input
								id="sp-target"
								type="number"
								min={1}
								max={100}
								{...register("targetPoolSize")}
							/>
						</Field>
						<Field
							label={t("settings.encodingTemplate")}
							htmlFor="sp-template"
							error={formState.errors.encodingTemplate?.message}
							help={t("settingsForms.pasteThePlainTemplateItIsBase64")}
						>
							<Textarea
								id="sp-template"
								rows={10}
								spellCheck={false}
								{...register("encodingTemplate")}
							/>
						</Field>
						<div className="flex justify-end pt-2">
							<Button type="submit" disabled={create.isPending}>
								{create.isPending
									? t("settings.creating")
									: t("settings.createPool")}
							</Button>
						</div>
					</form>
				</Dialog>
			</RoleAccess>

			<Dialog
				open={detailFor !== null}
				onOpenChange={(open) => {
					if (!open) {
						setDetailFor(null);
					}
				}}
				wide
				title={t("settingsX.standbyPoolFor", {
					name: detailFor?.name || detailFor?.id || "",
				})}
			>
				{detailFor ? (
					<StandbyPoolDetail
						poolId={detailFor.id}
						bitmovinAccountId={bitmovinAccountId}
						onChanged={invalidate}
					/>
				) : null}
			</Dialog>
		</div>
	);
}

function StandbyPoolDetail({
	poolId,
	bitmovinAccountId,
	onChanged,
}: {
	poolId: string;
	bitmovinAccountId: string;
	onChanged: () => void;
}) {
	const { t } = useT();
	const queryClient = useQueryClient();
	const accountQuery = `bitmovinAccountId=${bitmovinAccountId}`;
	const base = `${POOLS_BASE}/${poolId}`;

	const detailKey = ["live-standby-pool", poolId];
	const encodingsKey = ["live-standby-pool-encodings", poolId];
	const logsKey = ["live-standby-pool-logs", poolId];

	const detail = useQuery({
		queryKey: detailKey,
		queryFn: () => apiFetch<StandbyPoolDetailsDto>(`${base}?${accountQuery}`),
	});

	const encodings = useQuery({
		queryKey: encodingsKey,
		queryFn: () =>
			apiFetch<PageDto<StandbyPoolEncodingDto>>(
				`${base}/encodings?${accountQuery}&limit=${LIST_LIMIT_MAX}`,
			),
	});

	const logs = useQuery({
		queryKey: logsKey,
		queryFn: () =>
			apiFetch<PageDto<StandbyPoolLogDto>>(
				`${base}/logs?${accountQuery}&limit=25`,
			),
	});

	const invalidateAll = () => {
		queryClient.invalidateQueries({ queryKey: detailKey });
		queryClient.invalidateQueries({ queryKey: encodingsKey });
		queryClient.invalidateQueries({ queryKey: logsKey });
		onChanged();
	};

	const action = useMutation({
		mutationFn: (act: "acquire" | "deleteErrorEncodings") =>
			apiFetch<{ action: string; encoding: StandbyPoolEncodingDto }>(
				`${base}/actions`,
				{
					method: "POST",
					body: JSON.stringify({ bitmovinAccountId, action: act }),
				},
			),
		onSuccess: invalidateAll,
	});

	const removeEncoding = useMutation({
		mutationFn: (id: string) =>
			apiFetch<{ id: string }>(`${base}/encodings/${id}?${accountQuery}`, {
				method: "DELETE",
			}),
		onSuccess: invalidateAll,
	});

	const mutationError = action.error ?? removeEncoding.error;
	const acquired =
		action.isSuccess && action.data.action === "acquire"
			? action.data.encoding
			: null;

	return (
		<div className="space-y-5">
			<RoleAccess control="settings.live.standby-pools">
				<div className="flex flex-wrap items-center gap-2">
					<Button
						disabled={action.isPending}
						onClick={() => action.mutate("acquire")}
					>
						{action.isPending && action.variables === "acquire"
							? t("settings.acquiring")
							: t("settings.acquireEncoding")}
					</Button>
					<Button
						variant="secondary"
						disabled={action.isPending}
						onClick={() => action.mutate("deleteErrorEncodings")}
					>
						{t("settings.clearErrorEncodings")}
					</Button>
				</div>
			</RoleAccess>

			{mutationError ? (
				<p role="alert" className="text-red-400 text-sm">
					{mutationError instanceof ApiError
						? mutationError.message
						: t("settings.requestFailed")}
				</p>
			) : null}

			<RoleAccess control="settings.live.standby-pools">
				{acquired ? (
					<section className="rounded-md border border-emerald-900 bg-emerald-950/20 p-3">
						<h4 className="font-medium text-xs text-emerald-300">
							{t("settings.acquiredEncoding")}
						</h4>
						<p className="mt-1 text-xs text-zinc-400">
							{t("settings.copyTheseIntoYourContributionEncoder")}
						</p>
						{acquired.encodingId ? (
							<div className="mt-2">
								<CopyableId
									value={acquired.encodingId}
									label={t("settings.encodingId")}
								/>
							</div>
						) : null}
						{acquired.ingestPoints?.map((point) => (
							<div
								key={`${point.streamBaseUrl}:${point.streamKey}`}
								className="mt-2 space-y-1"
							>
								{point.streamBaseUrl ? (
									<div className="flex items-center gap-2">
										<span className="w-24 shrink-0 text-[11px] text-zinc-500">
											{t("settings.streamUrl")}
										</span>
										<CopyableId
											value={point.streamBaseUrl}
											label={t("settings.streamUrl")}
										/>
									</div>
								) : null}
								{point.streamKey ? (
									<div className="flex items-center gap-2">
										<span className="w-24 shrink-0 text-[11px] text-zinc-500">
											{t("settings.streamKey")}
										</span>
										<CopyableId
											value={point.streamKey}
											label={t("settings.streamKey")}
										/>
									</div>
								) : null}
							</div>
						))}
						{acquired.manifests?.map((manifest) =>
							manifest.url ? (
								<div
									key={manifest.url}
									className="mt-2 flex items-center gap-2"
								>
									<span className="w-24 shrink-0 text-[11px] text-zinc-500">
										{manifest.type ?? t("settingsForms.manifest")}
									</span>
									<CopyableId
										value={manifest.url}
										label={t("settings.manifestUrl")}
									/>
								</div>
							) : null,
						)}
					</section>
				) : null}
			</RoleAccess>

			<section>
				<h4 className="font-medium text-xs text-zinc-300">
					{t("settingsForms.encodings")}
				</h4>
				{encodings.isLoading ? (
					<div
						role="status"
						aria-busy="true"
						aria-label={t("settings.loadingStandbyEncodings")}
						className="mt-2 h-12 animate-pulse rounded-md bg-zinc-900"
					/>
				) : encodings.isError ? (
					<p role="alert" className="mt-2 text-red-400 text-sm">
						{t("settings.failedToLoadEncodings")}
						{encodings.error instanceof ApiError
							? `: ${encodings.error.message}`
							: ""}
						{t("common.sentenceEnd")}
					</p>
				) : (encodings.data?.items.length ?? 0) > 0 ? (
					<table className="mt-2 w-full text-left text-xs">
						<thead className="text-zinc-500">
							<tr>
								<th className="py-1 font-medium">
									{t("settingsForms.status")}
								</th>
								<th className="py-1 font-medium">
									{t("settingsForms.encoding")}
								</th>
								<th className="py-1 font-medium">
									{t("settingsForms.created")}
								</th>
								<th className="py-1" />
							</tr>
						</thead>
						<tbody className="divide-y divide-zinc-800">
							{encodings.data?.items.map((encoding) => (
								<tr key={encoding.id}>
									<td className="py-2">
										{encoding.status ? (
											<Badge tone={ENCODING_TONE[encoding.status]}>
												{encoding.status}
											</Badge>
										) : null}
									</td>
									<td className="py-2 font-mono text-zinc-400">
										{encoding.encodingId ?? "—"}
									</td>
									<td className="py-2 text-zinc-500">
										{encoding.createdAt ?? "—"}
									</td>
									<td className="py-2 text-right">
										<RoleAccess control="settings.live.standby-pools">
											<Button
												variant="destructive"
												size="sm"
												disabled={removeEncoding.isPending}
												onClick={() => removeEncoding.mutate(encoding.id)}
											>
												{t("settingsForms.delete")}
											</Button>
										</RoleAccess>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				) : (
					<p role="status" className="mt-2 text-sm text-zinc-500">
						{t("settings.noStandbyEncodingsInThisPool")}
					</p>
				)}
			</section>

			<section>
				<h4 className="font-medium text-xs text-zinc-300">
					{t("settingsForms.eventLogNewestFirst")}
				</h4>
				{logs.isLoading ? (
					<div
						role="status"
						aria-busy="true"
						aria-label={t("settings.loadingPoolEventLog")}
						className="mt-2 h-12 animate-pulse rounded-md bg-zinc-900"
					/>
				) : logs.isError ? (
					<p role="alert" className="mt-2 text-red-400 text-sm">
						{t("settings.failedToLoadTheEventLog")}
						{logs.error instanceof ApiError ? `: ${logs.error.message}` : ""}
						{t("common.sentenceEnd")}
					</p>
				) : (logs.data?.items.length ?? 0) > 0 ? (
					<ul className="mt-2 max-h-64 space-y-1 overflow-y-auto rounded-md border border-zinc-800 p-2">
						{logs.data?.items.map((log) => (
							<li key={log.id} className="flex items-start gap-2 text-xs">
								{log.eventType ? (
									<Badge tone={LOG_TONE[log.eventType]}>{log.eventType}</Badge>
								) : null}
								<div className="min-w-0 flex-1">
									<p className="text-zinc-300">{log.message}</p>
									{log.details ? (
										<p className="text-[11px] text-zinc-500">{log.details}</p>
									) : null}
								</div>
								<span className="shrink-0 font-mono text-[11px] text-zinc-600">
									{log.createdAt}
								</span>
							</li>
						))}
					</ul>
				) : (
					<p role="status" className="mt-2 text-sm text-zinc-500">
						{t("settings.noEventsLogged")}
					</p>
				)}
			</section>

			<section>
				<h4 className="font-medium text-xs text-zinc-300">
					{t("settings.encodingTemplate")}
				</h4>
				{detail.isLoading ? (
					<div
						role="status"
						aria-busy="true"
						aria-label={t("settings.loadingPoolDetails")}
						className="mt-2 h-12 animate-pulse rounded-md bg-zinc-900"
					/>
				) : detail.data?.encodingTemplateText !== undefined ? (
					<pre className="mt-2 max-h-64 overflow-auto rounded-md border border-zinc-800 bg-zinc-900/60 p-2 font-mono text-[11px] text-zinc-300">
						{detail.data.encodingTemplateText}
					</pre>
				) : (
					<p role="status" className="mt-2 text-sm text-zinc-500">
						{t("settings.templateUnavailableNotDecodableText")}
					</p>
				)}
			</section>
		</div>
	);
}
