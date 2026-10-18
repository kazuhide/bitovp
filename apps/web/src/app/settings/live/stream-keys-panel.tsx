"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import {
	shownOfTotal,
	useOffsetList,
} from "@/app/settings/infrastructure/use-offset-list";
import { CopyableId } from "@/components/copyable-id";
import type { ResourceIdCandidate } from "@/components/resource-id-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input, SelectNative } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import { RoleAccess, useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import { zodIssueMessage } from "@/lib/i18n/zod-issue-message";
import {
	STREAM_KEY_TYPES,
	type StreamKeyDto,
	type StreamKeyStatus,
	streamKeyCreateSchema,
} from "@/lib/live-runtime/schemas";
import { LiveEncodingPicker } from "./live-encoding-picker";

const STATUS_TONE: Record<StreamKeyStatus, "neutral" | "ok"> = {
	ASSIGNED: "ok",
	UNASSIGNED: "neutral",
};

type FormValues = { name: string; type: string; value: string };

/**
 * Reserved stream keys — account-level ingest credentials that outlive a single
 * live encoding, so a contribution encoder can be configured once.
 *
 * The key `value` is DISPLAYED (copyable-id pattern): it is connection material
 * the operator must read back, the ledgered redaction exception. It is stripped
 * from every audit row server-side.
 */
export function StreamKeysPanel({
	bitmovinAccountId,
}: {
	bitmovinAccountId: string;
}) {
	const { t } = useT();
	const canOperate = useMutationAccess("settings.live.stream-keys");
	const queryClient = useQueryClient();
	const [createOpen, setCreateOpen] = useState(false);
	const [unassignOpen, setUnassignOpen] = useState(false);
	const [unassignEncodingId, setUnassignEncodingId] = useState("");

	const base = "/api/live/stream-keys";
	const queryKey = ["live-stream-keys", bitmovinAccountId];

	const list = useOffsetList<StreamKeyDto>(
		queryKey,
		`${base}?bitmovinAccountId=${bitmovinAccountId}`,
	);

	const invalidate = () => queryClient.invalidateQueries({ queryKey });

	const create = useMutation({
		mutationFn: (streamKey: unknown) =>
			apiFetch<StreamKeyDto>(base, {
				method: "POST",
				body: JSON.stringify({ bitmovinAccountId, streamKey }),
			}),
		onSuccess: () => {
			setCreateOpen(false);
			invalidate();
		},
	});

	// The list projection withholds `value` (a list would hand out up to 100
	// live ingest credentials per request), so revealing one is an explicit
	// per-key GET. Held in local state only — never cached by the query client.
	const [revealed, setRevealed] = useState<Record<string, string>>({});
	const reveal = useMutation({
		mutationFn: (id: string) =>
			apiFetch<StreamKeyDto>(
				`${base}/${id}?bitmovinAccountId=${bitmovinAccountId}`,
			),
		onSuccess: (key) => {
			if (key.id && key.value) {
				setRevealed((prev) => ({
					...prev,
					[key.id as string]: key.value as string,
				}));
			}
		},
	});

	const remove = useMutation({
		mutationFn: (id: string) =>
			apiFetch<{ id: string }>(
				`${base}/${id}?bitmovinAccountId=${bitmovinAccountId}`,
				{ method: "DELETE" },
			),
		onSuccess: invalidate,
	});

	const unassign = useMutation({
		mutationFn: (encodingId: string) =>
			apiFetch<{ encodingId: string }>(`${base}/unassign`, {
				method: "POST",
				body: JSON.stringify({ bitmovinAccountId, encodingId }),
			}),
		onSuccess: () => {
			setUnassignOpen(false);
			setUnassignEncodingId("");
			invalidate();
		},
	});

	const { register, handleSubmit, setError, reset, formState } =
		useForm<FormValues>({
			defaultValues: { name: "", type: "RESERVED", value: "" },
		});

	const submit = handleSubmit((values) => {
		const parsed = streamKeyCreateSchema.safeParse({
			...(values.name !== "" ? { name: values.name } : {}),
			...(values.type !== "" ? { type: values.type } : {}),
			...(values.value !== "" ? { value: values.value } : {}),
		});
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				const path = issue.path.join(".");
				setError((path || "root") as keyof FormValues | "root", {
					message: zodIssueMessage(issue, t),
				});
			}
			return;
		}
		create.mutate(parsed.data);
	});

	const mutationError = remove.error ?? unassign.error;

	// The encodings that actually HOLD a key — the only ids on which unassign
	// does anything — read straight off the list already on screen, so the
	// picker offers them even for encodings this app never provisioned (a
	// standby-pool encoding, another operator's channel). Grouped by encoding
	// because the SDK action is scoped by encoding, not by key.
	const keysByEncoding = new Map<string, string[]>();
	for (const key of list.items) {
		if (key.assignedEncodingId) {
			const names = keysByEncoding.get(key.assignedEncodingId) ?? [];
			names.push(key.name || key.id);
			keysByEncoding.set(key.assignedEncodingId, names);
		}
	}
	const assignedEncodingCandidates: ResourceIdCandidate[] = [
		...keysByEncoding,
	].map(([encodingId, names]) => ({
		id: encodingId,
		label: t("settingsX.holdsKeys", { names: names.join(", ") }),
		badge: t(
			names.length === 1 ? "settingsX.keyCountOne" : "settingsX.keyCountOther",
			{ count: names.length },
		),
	}));

	return (
		<div>
			<div className="flex items-start justify-between gap-4">
				<div className="flex items-center gap-2">
					<h2 className="font-medium text-sm text-zinc-200">
						{t("settings.streamKeys")}
					</h2>
					<HelpOverlay labelFor={t("settings.streamKeys")}>
						{t("settingsX.reservedKeyIntro")}{" "}
						<span className="font-mono text-[11px]">TEMPORARY</span>{" "}
						{t("settingsX.reservedKeyIntroTail")}
						<p className="mt-2">
							{t("settingsForms.leaveTheValueBlankAndBitmovinGenerates")}
						</p>
					</HelpOverlay>
				</div>
				{canOperate ? (
					<div className="flex shrink-0 gap-2">
						<Button variant="secondary" onClick={() => setUnassignOpen(true)}>
							{t("settings.unassignByEncoding")}
						</Button>
						<Button onClick={() => setCreateOpen(true)}>
							<Plus aria-hidden className="h-4 w-4" />{" "}
							{t("settings.reserveKey")}
						</Button>
					</div>
				) : null}
			</div>

			{canOperate && mutationError ? (
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
						aria-label={t("settings.loadingStreamKeys")}
						className="space-y-2"
					>
						{[0, 1].map((i) => (
							<div
								key={i}
								className="h-14 animate-pulse rounded-md bg-zinc-900"
							/>
						))}
					</div>
				) : list.isError ? (
					<div
						role="alert"
						className="rounded-md border border-red-900 bg-red-950/30 p-4 text-red-300 text-sm"
					>
						{t("settings.failedToLoadStreamKeys")}
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
						{list.items.map((key) => (
							<li key={key.id} className="flex items-center gap-4 px-4 py-3">
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="truncate font-medium text-sm text-zinc-100">
											{key.name || key.id}
										</span>
										{key.status ? (
											<Badge tone={STATUS_TONE[key.status]}>{key.status}</Badge>
										) : null}
										{key.type ? <Badge>{key.type}</Badge> : null}
									</div>
									{canOperate && key.id && (key.value ?? revealed[key.id]) ? (
										<div className="mt-0.5">
											<CopyableId
												value={(key.value ?? revealed[key.id]) as string}
												label={t("settings.streamKey")}
											/>
										</div>
									) : canOperate && key.id ? (
										<div className="mt-0.5">
											<Button
												variant="secondary"
												size="sm"
												disabled={reveal.isPending}
												onClick={() => reveal.mutate(key.id as string)}
											>
												{t("settings.revealKey")}
											</Button>
										</div>
									) : null}
									{key.assignedEncodingId ? (
										<p className="mt-0.5 text-xs text-zinc-500">
											{t("settingsX.encodingWord")}{" "}
											<a
												className="underline"
												href={`/live?encodingId=${key.assignedEncodingId}`}
											>
												{key.assignedEncodingId}
											</a>
										</p>
									) : null}
									{key.assignedIngestPointId ? (
										//  / review-250 B3: the key↔ingest-point
										// binding was parsed on the wire and DISPLAYED nowhere.
										<p className="mt-0.5 text-xs text-zinc-500">
											{t("settings.ingestPointWord")}{" "}
											<span className="font-mono">
												{key.assignedIngestPointId}
											</span>
										</p>
									) : null}
								</div>
								{canOperate ? (
									<div className="flex shrink-0 gap-1">
										{key.assignedEncodingId ? (
											<Button
												variant="secondary"
												size="sm"
												disabled={unassign.isPending}
												onClick={() => {
													if (key.assignedEncodingId) {
														unassign.mutate(key.assignedEncodingId);
													}
												}}
											>
												{t("settingsForms.unassign")}
											</Button>
										) : null}
										<Button
											variant="destructive"
											size="sm"
											disabled={remove.isPending}
											onClick={() => {
												if (
													window.confirm(
														t("settingsX.deleteStreamKeyNamed", {
															name: key.name || key.id,
														}) +
															(key.status === "ASSIGNED"
																? t("settingsX.deleteStreamKeyAssignedTail")
																: ""),
													)
												) {
													remove.mutate(key.id);
												}
											}}
										>
											{t("settingsForms.delete")}
										</Button>
									</div>
								) : null}
							</li>
						))}
					</ul>
				) : (
					<div
						role="status"
						className="rounded-lg border border-zinc-800 border-dashed bg-zinc-900/40 p-10 text-center"
					>
						<h3 className="font-medium text-sm text-zinc-200">
							{t("settings.noStreamKeysYet")}
						</h3>
					</div>
				)}
				{!list.isLoading && !list.isError && list.items.length > 0 ? (
					<div className="mt-2 flex items-center justify-between gap-4">
						<p className="text-xs text-zinc-500">
							{t("settingsX.showingStreamKeys", {
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

			<RoleAccess control="settings.live.stream-keys">
				<Dialog
					open={createOpen}
					onOpenChange={(open) => {
						if (!open && !create.isPending) {
							setCreateOpen(false);
							create.reset();
							reset();
						}
					}}
					title={t("settings.reserveStreamKey")}
					description={t("settings.leaveTheValueBlankAndBitmovin")}
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
							htmlFor="sk-name"
							error={formState.errors.name?.message}
						>
							<Input
								id="sk-name"
								placeholder="studio-a"
								{...register("name")}
							/>
						</Field>
						<Field
							label={t("settingsForms.type")}
							htmlFor="sk-type"
							error={formState.errors.type?.message}
							help={t("settingsForms.reservedKeysPersistTemporaryOnesAreTied")}
						>
							<SelectNative id="sk-type" {...register("type")}>
								{STREAM_KEY_TYPES.map((type) => (
									<option key={type} value={type}>
										{type}
									</option>
								))}
							</SelectNative>
						</Field>
						<Field
							label={t("settingsForms.valueOptional")}
							htmlFor="sk-value"
							error={formState.errors.value?.message}
							hint={t("settingsForms.mustBeGloballyUniqueAndUnguessableBlank")}
						>
							<Input
								id="sk-value"
								autoComplete="off"
								className="font-mono text-xs"
								{...register("value")}
							/>
						</Field>
						<div className="flex justify-end pt-2">
							<Button type="submit" disabled={create.isPending}>
								{create.isPending
									? t("settings.reserving")
									: t("settings.reserveKey")}
							</Button>
						</div>
					</form>
				</Dialog>
			</RoleAccess>

			<RoleAccess control="settings.live.stream-keys">
				<Dialog
					open={unassignOpen}
					onOpenChange={(open) => {
						if (!open) {
							setUnassignOpen(false);
							unassign.reset();
						}
					}}
					title={t("settings.unassignStreamKeys")}
					description={t("settings.freesEveryKeyHeldByOne")}
				>
					<div className="space-y-4">
						<Field
							label={t("settings.encodingId")}
							htmlFor="sk-unassign-encoding"
							help={t("settingsForms.theLiveEncodingCurrentlyHoldingTheKey")}
						>
							<LiveEncodingPicker
								inputId="sk-unassign-encoding"
								value={unassignEncodingId}
								onChange={setUnassignEncodingId}
								listLabel={t("uiX.encodingsHoldingAKey")}
								extraCandidates={assignedEncodingCandidates}
							/>
						</Field>
						<div className="flex justify-end">
							<Button
								disabled={
									unassign.isPending || unassignEncodingId.trim() === ""
								}
								onClick={() => unassign.mutate(unassignEncodingId.trim())}
							>
								{unassign.isPending
									? t("settings.unassigning")
									: t("settingsForms.unassign")}
							</Button>
						</div>
					</div>
				</Dialog>
			</RoleAccess>
		</div>
	);
}
