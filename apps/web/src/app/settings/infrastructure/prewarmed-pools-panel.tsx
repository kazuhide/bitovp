"use client";

import { ENCODER_VERSION_PRESETS } from "@bitovp/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input, SelectNative } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import { zodIssueMessage } from "@/lib/i18n/zod-issue-message";
import {
	LIST_LIMIT_MAX,
	type PageDto,
	POOL_CLOUD_REGIONS,
	type PoolScheduleDto,
	PREWARMED_DISK_SIZES,
	type PrewarmedPoolDto,
	poolScheduleCreateSchema,
	prewarmedPoolCreateSchema,
} from "@/lib/infrastructure/schemas";
import { shownOfTotal, useOffsetList } from "./use-offset-list";

type PoolFormValues = {
	name: string;
	encoderVersion: string;
	cloudRegion: string;
	infrastructureId: string;
	diskSize: string;
	targetPoolSize: string;
	dynamicPool: boolean;
	gpuEnabled: boolean;
};

/**
 * Prewarmed encoder pools: standing encoder instances that remove queueing
 * latency. cloudRegion must be a SPECIFIC region (no AUTO/aggregates) and a
 * dynamic pool grows on demand but caps at 10 instances.
 */
export function PrewarmedPoolsPanel({
	bitmovinAccountId,
}: {
	bitmovinAccountId: string;
}) {
	const { t } = useT();
	const queryClient = useQueryClient();
	const [createOpen, setCreateOpen] = useState(false);
	const [schedulesFor, setSchedulesFor] = useState<PrewarmedPoolDto | null>(
		null,
	);

	const queryKey = ["infra-prewarmed-pools", bitmovinAccountId];
	const base = "/api/infrastructure/prewarmed-pools";

	const list = useOffsetList<PrewarmedPoolDto>(
		queryKey,
		`${base}?bitmovinAccountId=${bitmovinAccountId}`,
	);

	const invalidate = () => queryClient.invalidateQueries({ queryKey });

	const create = useMutation({
		mutationFn: (pool: unknown) =>
			apiFetch<PrewarmedPoolDto>(base, {
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
				`${base}/${poolId}?bitmovinAccountId=${bitmovinAccountId}`,
				{ method: "DELETE" },
			),
		onSuccess: invalidate,
	});

	const action = useMutation({
		mutationFn: ({
			poolId,
			action,
		}: {
			poolId: string;
			action: "start" | "stop";
		}) =>
			apiFetch<{ id: string; action: string }>(`${base}/${poolId}/actions`, {
				method: "POST",
				body: JSON.stringify({ bitmovinAccountId, action }),
			}),
		onSuccess: invalidate,
	});

	const { register, handleSubmit, setError, reset, formState } =
		useForm<PoolFormValues>({
			defaultValues: {
				name: "",
				encoderVersion: "STABLE",
				cloudRegion: "AWS_EU_WEST_1",
				infrastructureId: "",
				diskSize: "500",
				targetPoolSize: "1",
				dynamicPool: false,
				gpuEnabled: false,
			},
		});

	const submit = handleSubmit((values) => {
		const parsed = prewarmedPoolCreateSchema.safeParse({
			...(values.name !== "" ? { name: values.name } : {}),
			encoderVersion: values.encoderVersion,
			cloudRegion: values.cloudRegion,
			...(values.infrastructureId !== ""
				? { infrastructureId: values.infrastructureId }
				: {}),
			diskSize: values.diskSize,
			targetPoolSize: Number(values.targetPoolSize),
			...(values.dynamicPool ? { dynamicPool: true } : {}),
			...(values.gpuEnabled ? { gpuEnabled: true } : {}),
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

	const mutationError = remove.error ?? action.error;

	return (
		<div>
			<div className="flex items-start justify-between gap-4">
				<div className="flex items-center gap-2">
					<h2 className="font-medium text-sm text-zinc-200">
						{t("settings.prewarmedPools")}
					</h2>
					<HelpOverlay labelFor={t("settings.prewarmedPools")}>
						{t("settings.standingEncoderInstancesThatSkipStartup")}
					</HelpOverlay>
				</div>
				<RoleAccess control="settings.infrastructure.prewarmed-pools">
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
						aria-label={t("settings.loadingPrewarmedPools")}
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
						{t("settings.failedToLoadPools")}
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
				) : list.items.length > 0 ? (
					<ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
						{list.items.map((pool) => {
							const busy =
								action.isPending && action.variables?.poolId === pool.id;
							return (
								<li key={pool.id} className="flex items-center gap-4 px-4 py-3">
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<span className="truncate font-medium text-sm text-zinc-100">
												{pool.name || pool.id}
											</span>
											<Badge
												tone={pool.status === "STARTED" ? "ok" : "neutral"}
											>
												{pool.status ?? "UNKNOWN"}
											</Badge>
											{pool.dynamicPool ? (
												<Badge>{t("settingsForms.dynamic10")}</Badge>
											) : null}
											{pool.gpuEnabled ? <Badge>GPU</Badge> : null}
										</div>
										<p className="mt-0.5 truncate text-xs text-zinc-500">
											{t("settingsX.prewarmedPoolSummary", {
												version: pool.encoderVersion ?? "—",
												region: pool.cloudRegion ?? "—",
												disk: pool.diskSize ?? "—",
												target: pool.targetPoolSize ?? "—",
											})}
										</p>
									</div>
									<div className="flex shrink-0 gap-1">
										<RoleAccess control="settings.infrastructure.prewarmed-pools">
											{pool.status === "STARTED" ? (
												<Button
													variant="secondary"
													size="sm"
													disabled={busy}
													onClick={() =>
														action.mutate({ poolId: pool.id, action: "stop" })
													}
												>
													{busy
														? t("settings.stopping")
														: t("settingsForms.stop")}
												</Button>
											) : (
												<Button
													variant="secondary"
													size="sm"
													disabled={busy}
													onClick={() =>
														action.mutate({ poolId: pool.id, action: "start" })
													}
												>
													{busy
														? t("settings.starting")
														: t("settingsForms.start")}
												</Button>
											)}
										</RoleAccess>
										<Button
											variant="ghost"
											size="sm"
											onClick={() => setSchedulesFor(pool)}
										>
											{t("settingsForms.schedules")}
										</Button>
										<RoleAccess control="settings.infrastructure.prewarmed-pools">
											<Button
												variant="destructive"
												size="sm"
												disabled={remove.isPending}
												onClick={() => {
													if (
														window.confirm(
															t("settingsX.deletePoolNamed", {
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
							);
						})}
					</ul>
				) : (
					<div
						role="status"
						className="rounded-lg border border-zinc-800 border-dashed bg-zinc-900/40 p-10 text-center"
					>
						<h3 className="font-medium text-sm text-zinc-200">
							{t("settings.noPrewarmedPoolsYet")}
						</h3>
					</div>
				)}
				{!list.isLoading && !list.isError && list.items.length > 0 ? (
					<div className="mt-2 flex items-center justify-between gap-4">
						<p className="text-xs text-zinc-500">
							{t("settingsX.showingPools", {
								shown: shownOfTotal(list.items.length, list.totalCount, t),
							})}
						</p>
						{list.hasNextPage ? (
							<Button
								variant="secondary"
								size="sm"
								disabled={list.isFetchingNextPage}
								onClick={() => list.fetchNextPage()}
							>
								{list.isFetchingNextPage
									? t("settings.loading")
									: t("settings.loadMore")}
							</Button>
						) : null}
					</div>
				) : null}
			</div>

			<RoleAccess control="settings.infrastructure.prewarmed-pools">
				<Dialog
					open={createOpen}
					onOpenChange={(open) => {
						if (!open && !create.isPending) {
							setCreateOpen(false);
							create.reset();
							reset();
						}
					}}
					title={t("settings.createPrewarmedEncoderPool")}
					description={t("settings.poolsBillWhileStartedScheduleStops")}
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
							label={t("settingsForms.nameOptional")}
							htmlFor="pool-name"
							error={formState.errors.name?.message}
						>
							<Input
								id="pool-name"
								placeholder="evening-rush"
								{...register("name")}
							/>
						</Field>
						<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
							<Field
								label={t("settings.encoderVersion")}
								htmlFor="pool-version"
								error={formState.errors.encoderVersion?.message}
								help={t("settingsForms.stableBetaOrAPinnedVersion")}
							>
								<Input
									id="pool-version"
									list="pool-encoder-versions"
									{...register("encoderVersion")}
								/>
							</Field>
							<Field
								label={t("settings.cloudRegion")}
								htmlFor="pool-region"
								error={formState.errors.cloudRegion?.message}
								help={t("settingsForms.mustBeASpecificRegionOrExternal")}
							>
								<SelectNative id="pool-region" {...register("cloudRegion")}>
									{POOL_CLOUD_REGIONS.map((region) => (
										<option key={region} value={region}>
											{region}
										</option>
									))}
								</SelectNative>
							</Field>
						</div>
						<datalist id="pool-encoder-versions">
							{ENCODER_VERSION_PRESETS.map((v) => (
								<option key={v} value={v} />
							))}
						</datalist>
						<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
							<Field
								label={t("settings.diskSize")}
								htmlFor="pool-disk"
								error={formState.errors.diskSize?.message}
							>
								<SelectNative id="pool-disk" {...register("diskSize")}>
									{PREWARMED_DISK_SIZES.map((size) => (
										<option key={size} value={size}>
											{size} GB
										</option>
									))}
								</SelectNative>
							</Field>
							<Field
								label={t("settings.targetPoolSize")}
								htmlFor="pool-target"
								error={formState.errors.targetPoolSize?.message}
								hint={t("settingsForms.standingInstancesKeptWarmWhileStarted")}
							>
								<Input
									id="pool-target"
									type="number"
									min={1}
									{...register("targetPoolSize")}
								/>
							</Field>
						</div>
						<Field
							label={t("settingsForms.cloudConnectInfrastructureIdOptional")}
							htmlFor="pool-infra"
							error={formState.errors.infrastructureId?.message}
							help={t("settingsForms.leaveBlankForBitmovinManagedCloud")}
						>
							<Input
								id="pool-infra"
								autoComplete="off"
								{...register("infrastructureId")}
							/>
						</Field>
						<label
							htmlFor="pool-dynamic"
							className="flex items-center gap-2 text-sm text-zinc-300"
						>
							<input
								id="pool-dynamic"
								type="checkbox"
								className="h-4 w-4 accent-emerald-600"
								{...register("dynamicPool")}
							/>
							{t("settings.dynamicPoolGrowsOnDemandCapped")}
						</label>
						<label
							htmlFor="pool-gpu"
							className="flex items-center gap-2 text-sm text-zinc-300"
						>
							<input
								id="pool-gpu"
								type="checkbox"
								className="h-4 w-4 accent-emerald-600"
								{...register("gpuEnabled")}
							/>
							{t("settings.gpuInstances")}
						</label>
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
				open={schedulesFor !== null}
				onOpenChange={(open) => {
					if (!open) {
						setSchedulesFor(null);
					}
				}}
				title={t("settingsX.schedulesFor", {
					name: schedulesFor?.name || schedulesFor?.id || "",
				})}
				description={t("settings.timedStartStopActionsUtcBitmovin")}
			>
				{schedulesFor ? (
					<PoolSchedulesEditor
						poolId={schedulesFor.id}
						bitmovinAccountId={bitmovinAccountId}
					/>
				) : null}
			</Dialog>
		</div>
	);
}

type ScheduleFormValues = { action: "START" | "STOP"; triggerDate: string };

function PoolSchedulesEditor({
	poolId,
	bitmovinAccountId,
}: {
	poolId: string;
	bitmovinAccountId: string;
}) {
	const { t } = useT();
	const queryClient = useQueryClient();
	const base = `/api/infrastructure/prewarmed-pools/${poolId}/schedules`;
	const queryKey = ["infra-pool-schedules", bitmovinAccountId, poolId];

	const list = useQuery({
		queryKey,
		queryFn: () =>
			apiFetch<PageDto<PoolScheduleDto>>(
				`${base}?bitmovinAccountId=${bitmovinAccountId}&limit=${LIST_LIMIT_MAX}`,
			),
	});

	const invalidate = () => queryClient.invalidateQueries({ queryKey });

	const { register, handleSubmit, setError, reset, formState } =
		useForm<ScheduleFormValues>({
			defaultValues: { action: "START", triggerDate: "" },
		});

	const create = useMutation({
		mutationFn: (schedule: unknown) =>
			apiFetch<PoolScheduleDto>(base, {
				method: "POST",
				body: JSON.stringify({ bitmovinAccountId, schedule }),
			}),
		onSuccess: () => {
			reset({ action: "START", triggerDate: "" });
			invalidate();
		},
	});

	const remove = useMutation({
		mutationFn: (scheduleId: string) =>
			apiFetch<{ id: string }>(
				`${base}/${scheduleId}?bitmovinAccountId=${bitmovinAccountId}`,
				{ method: "DELETE" },
			),
		onSuccess: invalidate,
	});

	const submit = handleSubmit((values) => {
		// datetime-local is the operator's local wall clock — convert to UTC ISO.
		// Guard first: extreme inputs (e.g. year 275760) overflow the ECMAScript
		// date range, making getTime NaN — toISOString would then throw a
		// RangeError that escapes handleSubmit as an unhandled rejection.
		let iso = "";
		if (values.triggerDate !== "") {
			const date = new Date(values.triggerDate);
			if (Number.isNaN(date.getTime())) {
				setError("triggerDate", { message: t("settings.invalidDate") });
				return;
			}
			iso = date.toISOString();
		}
		const parsed = poolScheduleCreateSchema.safeParse({
			action: values.action,
			triggerDate: iso,
		});
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				const path = issue.path.join(".");
				setError((path || "root") as keyof ScheduleFormValues | "root", {
					message: zodIssueMessage(issue, t),
				});
			}
			return;
		}
		create.mutate(parsed.data);
	});

	const mutationError = create.error ?? remove.error;

	return (
		<div className="space-y-4">
			{mutationError ? (
				<p role="alert" className="text-red-400 text-sm">
					{mutationError instanceof ApiError
						? mutationError.message
						: t("settings.requestFailed")}
				</p>
			) : null}

			{list.isLoading ? (
				<div
					role="status"
					aria-busy="true"
					aria-label={t("settings.loadingSchedules")}
					className="h-10 animate-pulse rounded-md bg-zinc-900"
				/>
			) : list.isError ? (
				<p role="alert" className="text-red-400 text-sm">
					{t("settings.failedToLoadSchedules")}
					{list.error instanceof ApiError ? `: ${list.error.message}` : ""}
					{t("common.sentenceEnd")}
				</p>
			) : list.data && list.data.items.length > 0 ? (
				<ul className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
					{list.data.items.map((schedule) => (
						<li key={schedule.id} className="flex items-center gap-3 px-3 py-2">
							<Badge tone={schedule.action === "START" ? "ok" : "neutral"}>
								{schedule.action}
							</Badge>
							<span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-300">
								{schedule.triggerDate}
							</span>
							<RoleAccess control="settings.infrastructure.prewarmed-pools">
								<Button
									variant="destructive"
									size="sm"
									disabled={remove.isPending}
									onClick={() => remove.mutate(schedule.id)}
								>
									{t("settingsForms.delete")}
								</Button>
							</RoleAccess>
						</li>
					))}
				</ul>
			) : (
				<p role="status" className="text-sm text-zinc-500">
					{t("settings.noSchedulesYet")}
				</p>
			)}

			<RoleAccess control="settings.infrastructure.prewarmed-pools">
				<form
					onSubmit={submit}
					noValidate
					className="space-y-4 rounded-md border border-zinc-800 p-3"
				>
					<h4 className="font-medium text-xs text-zinc-300">
						{t("settings.addSchedule")}
					</h4>
					{formState.errors.root?.message ? (
						<p role="alert" className="text-red-400 text-xs">
							{formState.errors.root.message}
						</p>
					) : null}
					<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
						<Field label={t("settingsForms.action")} htmlFor="sched-action">
							<SelectNative id="sched-action" {...register("action")}>
								<option value="START">START</option>
								<option value="STOP">STOP</option>
							</SelectNative>
						</Field>
						<Field
							label={t("settings.triggerTime")}
							htmlFor="sched-trigger"
							error={formState.errors.triggerDate?.message}
							help={t("settingsForms.localTimeStoredAsUtcSecondsAre")}
						>
							<Input
								id="sched-trigger"
								type="datetime-local"
								{...register("triggerDate")}
							/>
						</Field>
					</div>
					<div className="flex justify-end">
						<Button type="submit" size="sm" disabled={create.isPending}>
							{create.isPending
								? t("settings.adding")
								: t("settings.addSchedule")}
						</Button>
					</div>
				</form>
			</RoleAccess>
		</div>
	);
}
