"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import {
	shownOfTotal,
	useOffsetList,
} from "@/app/settings/infrastructure/use-offset-list";
import { CopyableId } from "@/components/copyable-id";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import { zodIssueMessage } from "@/lib/i18n/zod-issue-message";
import { LIST_LIMIT_MAX, type PageDto } from "@/lib/infrastructure/schemas";
import {
	type DnsMappingDto,
	dnsMappingCreateSchema,
} from "@/lib/live-runtime/schemas";
import {
	LiveEncodingPicker,
	useLiveEncodingChannels,
} from "./live-encoding-picker";

type FormValues = { encodingId: string; subdomain: string; name: string };
type MappingCollection = {
	accountId: string;
	encodingId: string;
	items: DnsMappingDto[];
};
type DeleteMappings = {
	bitmovinAccountId: string;
	encodingId: string;
	confirmMappingIds: string[];
} & ({ mode: "collection"; confirmEncodingId: string } | { mode?: undefined });
const collectionLabels = {
	en: {
		open: "Clear DNS mapping collection",
		listed: "Remove listed mappings",
		confirm: "Clear mappings",
		id: "Encoding ID",
		effect:
			"This removes every ingest hostname for the selected encoding when Bitmovin processes the deletion. This can disrupt reconnection during a broadcast. Enter the encoding ID to confirm.",
	},
	ja: {
		open: "DNS マッピングを一括削除",
		listed: "一覧のマッピングを削除",
		confirm: "すべて削除",
		id: "エンコーディングID",
		effect:
			"Bitmovin が処理する時点で、選択したエンコードのすべての入力用ホスト名が削除されます。配信中は再接続できなくなる場合があります。エンコーディングIDを入力して確定してください。",
	},
};

/**
 * DNS ingest mappings, deliberately thin: a stable hostname pointing at one live
 * encoder's IP. Bitmovin's API scopes create/delete UNDER the encoding (there is
 * no account-level write), so both forms take an encoding id — the list here is
 * the account-wide view that makes those ids discoverable.
 */
export function DnsMappingsSettingsPanel({
	bitmovinAccountId,
}: {
	bitmovinAccountId: string;
}) {
	const { locale, t } = useT();
	const labels = collectionLabels[locale];
	const queryClient = useQueryClient();
	const [createOpen, setCreateOpen] = useState(false);
	const [collection, setCollection] = useState<MappingCollection | null>(null);
	const [typed, setTyped] = useState("");
	const confirmId = useId();

	const base = "/api/live/dns-mappings";
	const queryKey = ["live-dns-mappings", bitmovinAccountId];

	const list = useOffsetList<DnsMappingDto>(
		queryKey,
		`${base}?bitmovinAccountId=${bitmovinAccountId}`,
	);
	const channels = useLiveEncodingChannels(list.items.length > 0);
	const managed = new Set(
		channels.data?.items.flatMap((channel) =>
			channel.origin === "MANAGED" &&
			channel.bitmovinEncodingId &&
			channel.bitmovinAccountId === bitmovinAccountId &&
			(channel.status === "RUNNING" || channel.status === "STOPPED")
				? [channel.bitmovinEncodingId]
				: [],
		),
	);
	const selected =
		collection?.accountId === bitmovinAccountId &&
		managed.has(collection.encodingId)
			? collection
			: null;

	const invalidate = () => queryClient.invalidateQueries({ queryKey });

	const create = useMutation({
		mutationFn: (dnsMapping: unknown) =>
			apiFetch<DnsMappingDto>(base, {
				method: "POST",
				body: JSON.stringify({ bitmovinAccountId, dnsMapping }),
			}),
		onSuccess: () => {
			setCreateOpen(false);
			invalidate();
		},
	});

	const remove = useMutation({
		mutationFn: ({ id, encodingId }: { id: string; encodingId: string }) =>
			apiFetch<{ id: string }>(
				`${base}/${id}?bitmovinAccountId=${bitmovinAccountId}&encodingId=${encodingId}`,
				{ method: "DELETE" },
			),
		onSuccess: invalidate,
	});

	const loadMappings = async (encodingId: string) => {
		const query = new URLSearchParams({
			bitmovinAccountId,
			encodingId,
			limit: String(LIST_LIMIT_MAX),
		});
		const { items, totalCount } = await apiFetch<PageDto<DnsMappingDto>>(
			`${base}?${query}`,
		);
		if (!items.length || items.length !== totalCount)
			throw new ApiError(409, t("settingsX.incompleteDnsMappings"));
		return items;
	};
	const submitRemoval = (command: DeleteMappings) =>
		apiFetch<{ ids: string[]; unresolvedIds: string[] }>(base, {
			method: "DELETE",
			body: JSON.stringify(command),
		});

	const removeAll = useMutation({
		mutationFn: async (encodingId: string) => {
			const items = await loadMappings(encodingId);
			if (
				!window.confirm(
					t("settingsX.deleteEncodingDnsMappings", {
						count: items.length,
						id: encodingId,
					}),
				)
			)
				return false;
			const response = await submitRemoval({
				bitmovinAccountId,
				encodingId,
				confirmMappingIds: items.map((item) => item.id),
			});
			if (response.unresolvedIds.length) {
				await invalidate();
				throw new ApiError(409, t("settingsX.verifyDnsMappingsAfterRemoval"));
			}
			return true;
		},
		onSuccess: (removed) => {
			if (removed) invalidate();
		},
	});
	const previewCollection = useMutation({
		mutationFn: async (encodingId: string) => ({
			accountId: bitmovinAccountId,
			encodingId,
			items: await loadMappings(encodingId),
		}),
		onSuccess: (snapshot) => {
			setTyped("");
			setCollection(snapshot);
		},
	});
	const clearCollection = useMutation({
		mutationFn: (snapshot: MappingCollection & { confirmEncodingId: string }) =>
			submitRemoval({
				mode: "collection",
				bitmovinAccountId: snapshot.accountId,
				encodingId: snapshot.encodingId,
				confirmEncodingId: snapshot.confirmEncodingId,
				confirmMappingIds: snapshot.items.map((item) => item.id),
			}),
		onSettled: () => {
			setCollection(null);
			setTyped("");
			return Promise.all([
				invalidate(),
				queryClient.invalidateQueries({
					queryKey: ["live-channel-dns-mappings"],
				}),
			]);
		},
	});

	const {
		register,
		handleSubmit,
		setError,
		reset,
		setValue,
		watch,
		formState,
	} = useForm<FormValues>({
		defaultValues: { encodingId: "", subdomain: "", name: "" },
	});

	const submit = handleSubmit((values) => {
		const parsed = dnsMappingCreateSchema.safeParse({
			encodingId: values.encodingId.trim(),
			subdomain: values.subdomain.trim(),
			...(values.name !== "" ? { name: values.name } : {}),
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

	const mutationError =
		remove.error ??
		removeAll.error ??
		previewCollection.error ??
		clearCollection.error;
	const removalBusy =
		remove.isPending ||
		removeAll.isPending ||
		previewCollection.isPending ||
		clearCollection.isPending;
	const firstMappingByEncoding = new Map<string, string>();
	for (const item of list.items)
		if (item.encodingId && !firstMappingByEncoding.has(item.encodingId))
			firstMappingByEncoding.set(item.encodingId, item.id);

	return (
		<div>
			<div className="flex items-start justify-between gap-4">
				<div className="flex items-center gap-2">
					<h2 className="font-medium text-sm text-zinc-200">
						{t("settings.dnsMappings")}
					</h2>
					<HelpOverlay labelFor={t("settings.dnsMappings")}>
						{t("settingsX.dnsIntro")}
						<p className="mt-2">
							{t("settingsForms.theSubdomainIsOneDnsLabelLowercase")}
						</p>
					</HelpOverlay>
				</div>
				<RoleAccess control="settings.live.dns">
					<Button onClick={() => setCreateOpen(true)}>
						<Plus aria-hidden className="h-4 w-4" /> {t("settings.addMapping")}
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
						aria-label={t("settings.loadingDnsMappings")}
						className="h-14 animate-pulse rounded-md bg-zinc-900"
					/>
				) : list.isError ? (
					<div
						role="alert"
						className="rounded-md border border-red-900 bg-red-950/30 p-4 text-red-300 text-sm"
					>
						{t("settings.failedToLoadDnsMappings")}
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
						{list.items.map((mapping) => (
							<li
								key={mapping.id}
								className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
							>
								<div className="min-w-0 grow basis-40">
									{/* block, not bare inline: overflow/text-overflow do not
									    apply to non-replaced inlines, so this truncate
									    was a NO-OP — found independently by two
									    reviewers (UI loop 2026-08-21); the sibling
									    panels blockify the same span via a flex row. */}
									<span className="block truncate font-medium font-mono text-sm text-zinc-100">
										{mapping.hostname ?? mapping.subdomain}
									</span>
									<p className="mt-0.5 truncate text-xs text-zinc-500">
										{mapping.ip ? `${mapping.ip} · ` : ""}
										{t("settingsX.encodingIdLine", {
											id: mapping.encodingId ?? "—",
										})}
									</p>
								</div>
								{mapping.hostname ? (
									<CopyableId
										value={mapping.hostname}
										label={t("settings.dnsHostname")}
									/>
								) : null}
								<RoleAccess control="settings.live.dns">
									<Button
										variant="destructive"
										size="sm"
										disabled={removalBusy || !mapping.encodingId}
										onClick={() => {
											if (
												mapping.encodingId &&
												window.confirm(
													t("settingsX.deleteDnsMapping", {
														name: mapping.hostname ?? mapping.subdomain ?? "",
													}),
												)
											) {
												remove.mutate({
													id: mapping.id,
													encodingId: mapping.encodingId,
												});
											}
										}}
									>
										{t("settingsForms.delete")}
									</Button>
									{mapping.encodingId &&
										firstMappingByEncoding.get(mapping.encodingId) ===
											mapping.id && (
											<Button
												variant="secondary"
												size="sm"
												disabled={removalBusy}
												onClick={() => {
													if (mapping.encodingId)
														removeAll.mutate(mapping.encodingId);
												}}
											>
												{managed.has(mapping.encodingId)
													? labels.listed
													: t("settingsX.deleteAllDnsMappings")}
											</Button>
										)}
									{mapping.encodingId &&
										managed.has(mapping.encodingId) &&
										firstMappingByEncoding.get(mapping.encodingId) ===
											mapping.id && (
											<Button
												type="button"
												variant="secondary"
												size="sm"
												disabled={removalBusy}
												onClick={() => {
													clearCollection.reset();
													if (mapping.encodingId)
														previewCollection.mutate(mapping.encodingId);
												}}
											>
												{labels.open}
											</Button>
										)}
								</RoleAccess>
							</li>
						))}
					</ul>
				) : (
					<div
						role="status"
						className="rounded-lg border border-zinc-800 border-dashed bg-zinc-900/40 p-10 text-center"
					>
						<h3 className="font-medium text-sm text-zinc-200">
							{t("settings.noDnsMappingsYet")}
						</h3>
					</div>
				)}
				{!list.isLoading && !list.isError && list.items.length > 0 ? (
					<p className="mt-2 text-xs text-zinc-500">
						{t("settingsX.showingMappings", {
							shown: shownOfTotal(list.items.length, list.totalCount, t),
						})}
					</p>
				) : null}
			</div>

			<RoleAccess control="settings.live.dns">
				<Dialog
					open={!!selected}
					onOpenChange={(open) => {
						if (!open && !clearCollection.isPending) {
							setCollection(null);
							setTyped("");
						}
					}}
					title={labels.open}
					description={labels.effect}
				>
					{selected && (
						<div className="space-y-3">
							<ul className="max-h-36 list-inside list-disc overflow-auto font-mono text-xs">
								{selected.items.map((item) => (
									<li key={item.id} className="break-all">
										{item.hostname ?? item.subdomain ?? item.id}
									</li>
								))}
							</ul>
							<p className="break-all font-mono text-xs">
								{selected.encodingId}
							</p>
							<Field label={labels.id} htmlFor={confirmId}>
								<Input
									id={confirmId}
									value={typed}
									autoComplete="off"
									onChange={(event) => setTyped(event.target.value)}
								/>
							</Field>
							<Button
								type="button"
								variant="destructive"
								disabled={typed !== selected.encodingId || removalBusy}
								onClick={() =>
									clearCollection.mutate({
										...selected,
										confirmEncodingId: typed,
									})
								}
							>
								{labels.confirm}
							</Button>
						</div>
					)}
				</Dialog>
				<Dialog
					open={createOpen}
					onOpenChange={(open) => {
						if (!open && !create.isPending) {
							setCreateOpen(false);
							create.reset();
							reset();
						}
					}}
					title={t("settings.addDnsMapping")}
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
						{/* Registered for form state; the picker below is the visible control. */}
						<input type="hidden" {...register("encodingId")} />
						<Field
							label={t("settings.encodingId")}
							htmlFor="dns-encoding"
							error={formState.errors.encodingId?.message}
							help={[
								t("settingsForms.pickOneOfThisAppSLive"),
								t("settings.theMappingBelongsToOneLive"),
							].join(" ")}
						>
							<LiveEncodingPicker
								inputId="dns-encoding"
								value={watch("encodingId")}
								onChange={(id) =>
									setValue("encodingId", id, { shouldDirty: true })
								}
							/>
						</Field>
						<Field
							label={t("settingsForms.subdomain")}
							htmlFor="dns-subdomain"
							error={formState.errors.subdomain?.message}
							help={t("settingsForms.lowercaseLettersDigitsAndDashesMax63")}
						>
							<Input
								id="dns-subdomain"
								autoComplete="off"
								placeholder="studio-a"
								{...register("subdomain")}
							/>
						</Field>
						<Field
							label={t("settingsForms.nameOptional")}
							htmlFor="dns-name"
							error={formState.errors.name?.message}
						>
							<Input id="dns-name" {...register("name")} />
						</Field>
						<div className="flex justify-end pt-2">
							<Button type="submit" disabled={create.isPending}>
								{create.isPending
									? t("settings.adding")
									: t("settings.addMapping")}
							</Button>
						</div>
					</form>
				</Dialog>
			</RoleAccess>
		</div>
	);
}
