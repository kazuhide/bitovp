"use client";

import {
	type InfiniteData,
	useInfiniteQuery,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import type { LabelCatalogPage } from "@/lib/server/statistics-labels";

type Cursor = {
	offset: number;
	totalCount?: number;
	seen: string[];
	requests: number;
};

class CatalogRestartRequired extends Error {}

/** Mounted only inside the open Display panels menu. */
export function DashboardLabelFilter({
	accountId,
	label,
	enabled,
	onSelect,
}: {
	accountId: string;
	label: string;
	enabled: boolean;
	onSelect: (label: string) => void;
}) {
	const { t } = useT();
	const id = useId();
	const [search, setSearch] = useState("");
	const [lookup, setLookup] = useState("");
	const [restarting, setRestarting] = useState(false);
	const [restartFailure, setRestartFailure] = useState<Error | null>(null);
	const restartAbort = useRef<AbortController | null>(null);
	const queryClient = useQueryClient();
	const catalogKey = ["dashboard-usage-labels", accountId];
	useEffect(() => () => restartAbort.current?.abort(), []);
	const labels = useInfiniteQuery({
		queryKey: catalogKey,
		initialPageParam: { offset: 0, seen: [], requests: 0 } as Cursor,
		queryFn: async ({ pageParam, signal }) => {
			if (pageParam.requests >= 20)
				throw new CatalogRestartRequired("Label catalog page limit reached");
			const params = new URLSearchParams({
				accountId,
				offset: String(pageParam.offset),
			});
			if (pageParam.totalCount !== undefined)
				params.set("totalCount", String(pageParam.totalCount));
			let result: LabelCatalogPage;
			try {
				result = await apiFetch<LabelCatalogPage>(
					`/api/dashboard/usage/labels?${params}`,
					{ signal },
				);
			} catch (err) {
				if (
					err instanceof ApiError &&
					typeof err.details === "object" &&
					err.details !== null &&
					"restart" in err.details &&
					err.details.restart === true
				)
					throw new CatalogRestartRequired(
						"Label catalog changed; retry to restart",
					);
				throw err;
			}
			if (
				result.offset !== pageParam.offset ||
				(pageParam.totalCount !== undefined &&
					result.totalCount !== pageParam.totalCount) ||
				result.labels.some((name) => pageParam.seen.includes(name))
			)
				throw new CatalogRestartRequired(
					"Label catalog changed; retry to restart",
				);
			return result;
		},
		getNextPageParam: (last, pages) =>
			last.nextOffset === null
				? undefined
				: {
						offset: last.nextOffset,
						totalCount: last.totalCount,
						seen: pages.flatMap((page) => page.labels),
						requests: pages.length,
					},
		enabled: enabled && !!accountId,
		staleTime: 60_000,
		retry: false,
	});
	useEffect(() => {
		if (
			enabled &&
			labels.data !== undefined &&
			!restarting &&
			labels.hasNextPage &&
			!labels.isFetching &&
			!labels.error
		)
			void labels.fetchNextPage();
	}, [
		enabled,
		restarting,
		labels.data,
		labels.hasNextPage,
		labels.isFetching,
		labels.error,
		labels.fetchNextPage,
	]);
	const restartCatalog = async () => {
		const controller = new AbortController();
		restartAbort.current = controller;
		setRestarting(true);
		setRestartFailure(null);
		try {
			await queryClient.cancelQueries({ queryKey: catalogKey, exact: true });
			const first = await apiFetch<LabelCatalogPage>(
				`/api/dashboard/usage/labels?${new URLSearchParams({ accountId, offset: "0", refresh: "1" })}`,
				{ signal: controller.signal },
			);
			if (controller.signal.aborted) return;
			queryClient.setQueryData<InfiniteData<LabelCatalogPage, Cursor>>(
				catalogKey,
				{
					pages: [first],
					pageParams: [{ offset: 0, seen: [], requests: 0 }],
				},
			);
		} catch (err) {
			if (!controller.signal.aborted)
				setRestartFailure(
					err instanceof Error
						? err
						: new Error("Statistics labels unavailable"),
				);
		} finally {
			if (!controller.signal.aborted) setRestarting(false);
		}
	};
	const exact = useQuery({
		queryKey: ["dashboard-usage-label-exact", accountId, lookup],
		queryFn: ({ signal }) =>
			apiFetch<LabelCatalogPage>(
				`/api/dashboard/usage/labels?${new URLSearchParams({ accountId, label: lookup })}`,
				{ signal },
			),
		enabled: enabled && !!accountId && !!lookup,
		staleTime: 60_000,
		retry: false,
	});
	const loaded = labels.data?.pages.flatMap((page) => page.labels) ?? [];
	const names = [...new Set([...loaded, ...(exact.data?.labels ?? [])])].sort(
		(a, b) => a.localeCompare(b),
	);
	const matches = names.filter((name) =>
		name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
	);
	const total = labels.data?.pages[0]?.totalCount ?? 0;
	const partial = loaded.length < total;
	const error = restartFailure ?? exact.error ?? labels.error;
	return (
		<fieldset className="mt-4 space-y-2 border-zinc-800 border-t pt-3">
			<legend className="px-1 font-medium text-xs text-zinc-300">
				{t("usage.labelFilters")}
			</legend>
			<Field
				label={t("usage.label")}
				htmlFor={`${id}-label`}
				tooltip={t("usage.labelHint")}
			>
				<SelectNative
					id={`${id}-label`}
					value={label}
					disabled={!names.length && !label}
					onChange={(event) => onSelect(event.target.value)}
				>
					<option value="">{t("usage.allLabels")}</option>
					{label && !matches.includes(label) ? (
						<option value={label}>{label}</option>
					) : null}
					{matches.map((name) => (
						<option key={name} value={name} disabled={name.includes(",")}>
							{name}
						</option>
					))}
				</SelectNative>
			</Field>
			<Field
				label={t("usage.searchLabels")}
				htmlFor={`${id}-search`}
				tooltip={t("usage.labelCatalogHint")}
			>
				<Input
					id={`${id}-search`}
					type="search"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
			</Field>
			<div className="flex flex-wrap items-center justify-between gap-2">
				{labels.data ? (
					<p role="status" className="text-xs text-zinc-400">
						{t("usage.loadedLabels", { loaded: loaded.length, total })}
					</p>
				) : null}
				<Button
					size="sm"
					variant="ghost"
					disabled={
						!search.trim() ||
						search.trim().length > 256 ||
						search.includes(",") ||
						exact.isFetching
					}
					onClick={() =>
						search.trim() === lookup
							? void exact.refetch()
							: setLookup(search.trim())
					}
				>
					{t("usage.findExactLabel")}
				</Button>
			</div>
			{partial ? (
				<p className="text-xs text-zinc-400">{t("usage.partialLabelSearch")}</p>
			) : null}
			{restarting || labels.isFetching || exact.isFetching ? (
				<p role="status" className="text-xs text-zinc-400">
					{t("common.loading")}
				</p>
			) : null}
			{labels.data && !error && !partial && !names.length ? (
				<p role="status" className="text-xs text-zinc-400">
					{t("usage.noLabels")}
				</p>
			) : null}
			{labels.data &&
			!error &&
			!partial &&
			names.length > 0 &&
			search.trim() &&
			!matches.length ? (
				<p role="status" className="text-xs text-zinc-400">
					{t("usage.noMatchingLabels")}
				</p>
			) : null}
			{exact.data && lookup === search.trim() && !exact.data.labels.length ? (
				<p role="status" className="text-xs text-zinc-400">
					{t("usage.exactLabelMissing")}
				</p>
			) : null}
			{error ? (
				<p role="alert" className="text-xs text-red-400">
					{t("usage.labelsLoadFailed")}: {error.message}
					<Button
						size="sm"
						variant="ghost"
						disabled={restarting || labels.isFetching || exact.isFetching}
						onClick={() => {
							if (restartFailure) void restartCatalog();
							else if (exact.error) void exact.refetch();
							else if (labels.error instanceof CatalogRestartRequired)
								void restartCatalog();
							else if (labels.hasNextPage) void labels.fetchNextPage();
							else void labels.refetch();
						}}
					>
						{t("usage.retryLabels")}
					</Button>
				</p>
			) : null}
		</fieldset>
	);
}
