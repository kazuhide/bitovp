"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError, apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import { type ChildChoice, MuxingChildren } from "./muxing-children";

type Selection = {
	step: string;
	kind: string;
	id: string;
	attempt: number;
	hasList: boolean;
	listScope?: "linked";
	hasCustomData?: boolean;
	hasInformation?: boolean;
	childCollections?: ChildChoice[];
	removalState?: string | null;
	retainedForPublication?: boolean;
};
type Fields = Record<string, string | number | boolean>;
const pageSize = 25;
const keyOf = (r: Selection) => JSON.stringify([r.step, r.attempt, r.id]);

function FieldList({
	fields,
	labels,
}: {
	fields: Fields;
	labels?: Record<string, string>;
}) {
	return (
		<dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[max-content_1fr]">
			{Object.entries(fields).map(([name, value]) => (
				<div key={name} className="contents">
					<dt className="text-zinc-400">{labels?.[name] ?? name}</dt>
					<dd className="break-all text-zinc-200">{String(value)}</dd>
				</div>
			))}
		</dl>
	);
}
function LookupFailure({
	error,
	retry,
	information,
}: {
	error: Error;
	retry: () => void;
	information?: boolean;
}) {
	const { t } = useT();
	const status = error instanceof ApiError ? error.status : undefined;
	return (
		<div className="flex flex-wrap items-center gap-2">
			<p role="alert" className="text-xs text-amber-300">
				{t(
					status === 404
						? information
							? "providerResources.informationUnavailable"
							: "providerResources.missing"
						: status === 409
							? "providerResources.changed"
							: "providerResources.failed",
				)}
			</p>
			<Button variant="ghost" size="sm" onClick={retry}>
				{t("common.retry")}
			</Button>
		</div>
	);
}
function ResourceRemoval({
	endpoint,
	selected,
	canRemove,
}: {
	endpoint: string;
	selected: Selection;
	canRemove: boolean;
}) {
	const { t } = useT();
	const client = useQueryClient();
	const [confirm, setConfirm] = useState(false);
	const [typed, setTyped] = useState("");
	const [disposition, setDisposition] = useState("");
	const input = useId();
	const action = useMutation({
		mutationFn: async (mode: "remove" | "verify") =>
			apiFetch<{ state: string; disposition: string }>(endpoint, {
				method: mode === "remove" ? "DELETE" : "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					step: selected.step,
					attempt: selected.attempt,
					confirmResourceId: selected.id,
					...(selected.removalState ? { retry: true } : {}),
				}),
			}),
		onSuccess: (result) => {
			setDisposition(result.disposition);
			setConfirm(false);
			setTyped("");
		},
		onSettled: async () => {
			await client.invalidateQueries({
				queryKey: ["provider-resources", endpoint],
			});
		},
	});
	const pending =
		selected.removalState === "SENDING" || selected.removalState === "UNKNOWN";
	const removed = selected.removalState === "REMOVED";
	return (
		<div className="space-y-2 border-t border-zinc-800 pt-3">
			{removed ? (
				<p role="status">{t("providerResources.removed")}</p>
			) : (
				<>
					{pending && (
						<p role="status" className="text-xs text-amber-300">
							{t("providerResources.unconfirmed")}
						</p>
					)}
					{disposition === "present" && (
						<p role="status" className="text-xs">
							{t("providerResources.present")}
						</p>
					)}
					{pending && (
						<Button
							type="button"
							variant="secondary"
							size="sm"
							disabled={action.isPending}
							onClick={() => action.mutate("verify")}
						>
							{t("providerResources.verify")}
						</Button>
					)}
					{canRemove &&
						(confirm ? (
							<div className="space-y-2">
								<label htmlFor={input} className="block text-xs">
									{t("providerResources.confirm", { id: selected.id })}
								</label>
								<input
									id={input}
									className="w-full rounded border border-zinc-700 bg-zinc-950 p-2 text-sm"
									value={typed}
									autoComplete="off"
									onChange={(e) => setTyped(e.target.value)}
								/>
								<div className="flex gap-2">
									<Button
										variant="destructive"
										size="sm"
										disabled={typed !== selected.id || action.isPending}
										onClick={() => action.mutate("remove")}
									>
										{t("providerResources.remove")}
									</Button>
									<Button
										variant="ghost"
										size="sm"
										disabled={action.isPending}
										onClick={() => {
											setConfirm(false);
											setTyped("");
										}}
									>
										{t("common.cancel")}
									</Button>
								</div>
							</div>
						) : (
							<Button
								variant="destructive"
								size="sm"
								onClick={() => setConfirm(true)}
							>
								{t("providerResources.remove")}
							</Button>
						))}
				</>
			)}
			{action.isError && (
				<p role="alert" className="text-xs text-amber-300">
					{t(
						action.error instanceof ApiError && action.error.status === 409
							? "providerResources.removeBlocked"
							: "providerResources.removeFailed",
					)}
				</p>
			)}
		</div>
	);
}
function ResourceInspector({
	endpoint,
	selected,
	canManage,
	canRemove,
}: {
	endpoint: string;
	selected: Selection;
	canManage: boolean;
	canRemove: boolean;
}) {
	const { t } = useT();
	const [view, setView] = useState<
			"detail" | "information" | "siblings" | "customData"
		>("detail"),
		[offset, setOffset] = useState(0);
	const choices = [
		{ view: "detail", label: "providerResources.detail", available: true },
		{
			view: "information",
			label: "providerResources.information",
			available: selected.hasInformation,
		},
		{
			view: "siblings",
			label:
				selected.listScope === "linked"
					? "providerResources.linked"
					: "providerResources.siblings",
			available: selected.hasList,
		},
		{
			view: "customData",
			label: "providerResources.metadata",
			available: selected.hasCustomData,
		},
	] as const;
	const available = choices.filter((choice) => choice.available);
	const params = new URLSearchParams({
		step: selected.step,
		attempt: String(selected.attempt),
		view,
		offset: String(offset),
	});
	const data = useQuery({
		queryKey: ["provider-resource", endpoint, keyOf(selected), view, offset],
		queryFn: ({ signal }) =>
			apiFetch<{ fields?: Fields; items?: Fields[]; total?: number }>(
				`${endpoint}?${params}`,
				{ signal },
			),
		retry: false,
		refetchOnWindowFocus: false,
		enabled: selected.removalState !== "REMOVED",
	});
	return (
		<div className="space-y-3">
			{available.length > 1 && selected.removalState !== "REMOVED" && (
				<div className="flex flex-wrap gap-2">
					{available.map((choice) => (
						<Button
							variant={view === choice.view ? "secondary" : "ghost"}
							size="sm"
							key={choice.view}
							aria-pressed={view === choice.view}
							onClick={() => {
								setView(choice.view);
								setOffset(0);
							}}
						>
							{t(choice.label)}
						</Button>
					))}
				</div>
			)}
			{selected.removalState === "REMOVED" ? (
				!canManage && <p role="status">{t("providerResources.removed")}</p>
			) : data.isPending ? (
				<p role="status" className="text-xs text-zinc-400">
					{t("providerResources.loading")}
				</p>
			) : data.isError ? (
				<LookupFailure
					error={data.error}
					retry={() => data.refetch()}
					information={view === "information"}
				/>
			) : view === "information" &&
				!Object.keys(data.data.fields ?? {}).length ? (
				<p role="status" className="text-xs text-zinc-400">
					{t("providerResources.informationUnavailable")}
				</p>
			) : view !== "siblings" && data.data.fields ? (
				<FieldList
					fields={data.data.fields}
					labels={
						view === "information"
							? {
									fileSizeBytes: t("providerResources.fileSizeBytes"),
									containerBitrateBps: t(
										"providerResources.containerBitrateBps",
									),
									durationSeconds: t("providerResources.durationSeconds"),
								}
							: undefined
					}
				/>
			) : data.data.items ? (
				<div className="space-y-2">
					<p role="status" className="text-xs text-zinc-400">
						{data.data.items.length
							? t("providerResources.range", {
									from: offset + 1,
									to: offset + data.data.items.length,
									total: data.data.total ?? 0,
								})
							: t("providerResources.emptyPage")}
					</p>
					<ul className="space-y-2">
						{data.data.items.map((fields) => (
							<li
								className="rounded-sm border border-zinc-800 p-2"
								key={String(fields.id)}
							>
								<FieldList fields={fields} />
							</li>
						))}
					</ul>
					{(offset > 0 || offset + pageSize < (data.data.total ?? 0)) && (
						<div className="flex gap-2">
							<Button
								size="sm"
								variant="secondary"
								disabled={!offset}
								onClick={() => setOffset((n) => Math.max(0, n - pageSize))}
							>
								{t("providerResources.previous")}
							</Button>
							<Button
								size="sm"
								variant="secondary"
								disabled={offset + pageSize >= (data.data.total ?? 0)}
								onClick={() => setOffset((n) => n + pageSize)}
							>
								{t("providerResources.next")}
							</Button>
						</div>
					)}
				</div>
			) : null}
			{selected.removalState !== "REMOVED" &&
				!!selected.childCollections?.length && (
					<MuxingChildren
						endpoint={endpoint}
						parent={selected}
						choices={selected.childCollections}
					/>
				)}
			{canManage && (canRemove || selected.removalState) && (
				<ResourceRemoval
					endpoint={endpoint}
					selected={selected}
					canRemove={canRemove}
				/>
			)}
		</div>
	);
}
function ResourceChoices({ endpoint }: { endpoint: string }) {
	const { t } = useT();
	const [selection, setSelection] = useState("");
	const id = useId();
	const index = useQuery({
		queryKey: ["provider-resources", endpoint],
		queryFn: ({ signal }) =>
			apiFetch<{
				resources: Selection[];
				canManage: boolean;
				canRemove: boolean;
			}>(endpoint, { signal }),
		retry: false,
	});
	if (index.isPending)
		return (
			<p role="status" className="text-xs text-zinc-400">
				{t("providerResources.loading")}
			</p>
		);
	if (index.isError)
		return <LookupFailure error={index.error} retry={() => index.refetch()} />;
	if (!index.data.resources.length)
		return (
			<p className="text-xs text-zinc-400">{t("providerResources.empty")}</p>
		);
	const selected = index.data.resources.find((r) => keyOf(r) === selection);
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-2">
				<label htmlFor={id} className="text-xs text-zinc-400">
					{t("providerResources.resource")}
				</label>
				<select
					id={id}
					className="max-w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm"
					value={selected ? selection : ""}
					onChange={(e) => setSelection(e.target.value)}
				>
					<option value="">{t("providerResources.choose")}</option>
					{index.data.resources.map((row) => (
						<option key={keyOf(row)} value={keyOf(row)}>
							{row.step} · {row.id}
						</option>
					))}
				</select>
			</div>
			{selected && (
				<ResourceInspector
					key={keyOf(selected)}
					endpoint={endpoint}
					selected={selected}
					canManage={index.data.canManage}
					canRemove={index.data.canRemove && !selected.retainedForPublication}
				/>
			)}
		</div>
	);
}
export function ProviderResources({ endpoint }: { endpoint: string }) {
	const { t } = useT();
	const [open, setOpen] = useState(false);
	return (
		<details
			className="my-2 rounded-md border border-zinc-800 p-3"
			onToggle={(e) => setOpen(e.currentTarget.open)}
		>
			<summary className="cursor-pointer text-sm font-medium text-zinc-200">
				{t("providerResources.title")}
			</summary>
			{open && (
				<div className="mt-3">
					<ResourceChoices endpoint={endpoint} />
				</div>
			)}
		</details>
	);
}
