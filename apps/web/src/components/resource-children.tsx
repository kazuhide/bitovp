"use client";

import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";

export type ChildChoice = {
	key: string;
	label: string;
	hasDetail: boolean;
	hasMetadata: boolean;
};
type Fields = Record<string, string | number | boolean>;
type Row = { step: string; id: string; attempt: number };
type View = "childDetail" | "childMetadata";

function useChildData<T>(
	endpoint: string,
	parent: Row,
	collection: string,
	offset: number,
	view: "children" | View,
	childId?: string,
) {
	const params = new URLSearchParams({
		step: parent.step,
		attempt: String(parent.attempt),
		collection,
		offset: String(offset),
		view,
	});
	if (childId) params.set("childId", childId);
	return useQuery({
		queryKey: ["resource-children", endpoint, parent.id, params.toString()],
		queryFn: ({ signal }) => apiFetch<T>(`${endpoint}?${params}`, { signal }),
		enabled: !!collection && (view === "children" || !!childId),
		retry: false,
		refetchOnWindowFocus: false,
	});
}
function ChildPage({
	endpoint,
	parent,
	choice,
}: {
	endpoint: string;
	parent: Row;
	choice: ChildChoice;
}) {
	const { t } = useT();
	const [offset, setOffset] = useState(0);
	const [selection, setSelection] = useState<{ id: string; view: View } | null>(
		null,
	);
	const size = 25;
	const list = useChildData<{
		items: Fields[];
		total: number;
		available: number;
	}>(endpoint, parent, choice.key, offset, "children");
	const detail = useChildData<{ fields: Fields }>(
		endpoint,
		parent,
		choice.key,
		offset,
		selection?.view ?? "childDetail",
		selection?.id,
	);
	function go(next: number) {
		setSelection(null);
		setOffset(next);
	}
	if (list.isPending)
		return <p role="status">{t("providerResources.loading")}</p>;
	if (list.isError)
		return (
			<div role="alert">
				{t("providerResources.failed")}{" "}
				<Button variant="ghost" size="sm" onClick={() => list.refetch()}>
					{t("common.retry")}
				</Button>
			</div>
		);
	const { items, total, available } = list.data;
	return (
		<div className="space-y-2 text-xs">
			<p role="status">
				{items.length
					? t("providerResources.range", {
							from: offset + 1,
							to: offset + items.length,
							total,
						})
					: t("providerResources.emptyPage")}
			</p>
			{available < total && (
				<p className="text-amber-300">
					{t("providerResources.drmPrefix", { count: available })}
				</p>
			)}
			<ul className="space-y-2">
				{items.map((item) => {
					const id = String(item.id);
					return (
						<li
							className="space-y-1 rounded border border-zinc-800 p-2"
							key={id}
						>
							<strong>{item.name ?? id}</strong>
							{item.type && <span className="ml-2">{item.type}</span>}
							{item.name && (
								<span className="ml-2 break-all font-mono text-zinc-400">
									{id}
								</span>
							)}
							{(choice.hasDetail || choice.hasMetadata) && (
								<div className="flex flex-wrap gap-2">
									{choice.hasDetail && (
										<Button
											size="sm"
											variant="secondary"
											onClick={() => setSelection({ id, view: "childDetail" })}
										>
											{t("providerResources.detail")}
										</Button>
									)}
									{choice.hasMetadata && (
										<Button
											size="sm"
											variant="ghost"
											onClick={() =>
												setSelection({ id, view: "childMetadata" })
											}
										>
											{t("providerResources.metadata")}
										</Button>
									)}
								</div>
							)}
							{!choice.hasDetail && (
								<dl className="flex flex-wrap gap-x-3 gap-y-1">
									{Object.entries(item)
										.filter(
											([key]) =>
												key !== "id" && key !== "name" && key !== "type",
										)
										.map(([key, value]) => (
											<div className="flex gap-1" key={key}>
												<dt className="text-zinc-400">{key}</dt>
												<dd className="break-all">{String(value)}</dd>
											</div>
										))}
								</dl>
							)}
							{selection?.id === id &&
								(detail.isPending ? (
									<p role="status">{t("providerResources.loading")}</p>
								) : detail.isError ? (
									<p role="alert">
										{t("providerResources.childChanged")}{" "}
										<Button
											variant="ghost"
											size="sm"
											onClick={() => {
												setSelection(null);
												list.refetch();
											}}
										>
											{t("common.retry")}
										</Button>
									</p>
								) : (
									<dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
										{Object.entries(detail.data.fields).map(([key, value]) => (
											<div className="contents" key={key}>
												<dt className="text-zinc-400">{key}</dt>
												<dd className="break-all">{String(value)}</dd>
											</div>
										))}
									</dl>
								))}
						</li>
					);
				})}
			</ul>
			{(offset > 0 || offset + size < available) && (
				<div className="flex gap-2">
					<Button
						size="sm"
						variant="secondary"
						disabled={!offset}
						onClick={() => go(Math.max(0, offset - size))}
					>
						{t("providerResources.previous")}
					</Button>
					<Button
						size="sm"
						variant="secondary"
						disabled={offset + size >= available}
						onClick={() => go(offset + size)}
					>
						{t("providerResources.next")}
					</Button>
				</div>
			)}
		</div>
	);
}
export function ResourceChildren({
	endpoint,
	parent,
	choices,
}: {
	endpoint: string;
	parent: Row;
	choices: ChildChoice[];
}) {
	const [key, setKey] = useState("");
	const id = useId();
	const { t } = useT();
	const choice = choices.find((c) => c.key === key);
	return (
		<section className="space-y-2 border-t border-zinc-800 pt-2">
			<label className="mr-2 text-xs" htmlFor={id}>
				{t("providerResources.relatedResources")}
			</label>
			<select
				className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm"
				id={id}
				value={key}
				onChange={(e) => setKey(e.currentTarget.value)}
			>
				<option value="">{t("providerResources.chooseType")}</option>
				{choices.map((c) => (
					<option key={c.key} value={c.key}>
						{c.key === "drm"
							? t("providerResources.allDrm")
							: c.key === "id3"
								? t("providerResources.allId3")
								: c.label}
					</option>
				))}
			</select>
			{choice && (
				<ChildPage
					key={choice.key}
					endpoint={endpoint}
					parent={parent}
					choice={choice}
				/>
			)}
		</section>
	);
}
