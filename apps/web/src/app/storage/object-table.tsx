"use client";

import {
	Download,
	FolderOpen,
	Link as LinkIcon,
	ScanSearch,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { baseName, formatBytes, formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/context";

export type TableObject = {
	key: string;
	size: number;
	lastModified?: string;
};

/**
 * Server-side search: the owner drives the filter inputs, queries the API with
 * them, and hands back rows that are ALREADY matched across the whole prefix —
 * so this table must not filter locally (that is what limited search to the
 * loaded pages). Absent = the old local filter over the rows in hand, which is
 * all the wizard picker needs.
 */
export type ObjectTableSearch = {
	query: string;
	extension: string;
	onQueryChange: (value: string) => void;
	onExtensionChange: (value: string) => void;
	/** Browsed prefix, trimmed off match rows so their folder stays visible. */
	prefix: string;
	/** Match count / scan-truncation line rendered under the filter row. */
	notice?: ReactNode;
};

type ObjectTableProps = {
	prefixes: string[];
	objects: TableObject[];
	isLoading: boolean;
	hasNextPage: boolean;
	isFetchingNextPage: boolean;
	onFetchNextPage: () => void;
	onOpenPrefix: (prefix: string) => void;
	/** Optional actions — absent callbacks render no button (picker mode). */
	onUseAsInput?: (key: string) => void;
	onUseAsOutput?: (prefix: string) => void;
	onCopyUri?: (path: string) => void;
	/** ffprobe preview of one object (browser only, not the wizard picker). */
	onInspect?: (key: string, size?: number) => void;
	/** Present ⇒ searching happens server-side (see ObjectTableSearch). */
	search?: ObjectTableSearch;
};

export function ObjectTable({
	prefixes,
	objects,
	isLoading,
	hasNextPage,
	isFetchingNextPage,
	onFetchNextPage,
	onOpenPrefix,
	onUseAsInput,
	onUseAsOutput,
	onCopyUri,
	onInspect,
	search,
}: ObjectTableProps) {
	const { t } = useT();
	const [localExtension, setLocalExtension] = useState("");
	const [localQuery, setLocalQuery] = useState("");
	const query = search ? search.query : localQuery;
	const extension = search ? search.extension : localExtension;

	const visibleObjects = search
		? objects
		: objects.filter((obj) => {
				// Local mode lists ONE folder (no `recursive`), so baseName(key) and
				// the prefix-relative path are the same string — this filter and
				// displayName below still match what is on screen.
				const name = baseName(obj.key).toLowerCase();
				if (extension && !name.endsWith(`.${extension.toLowerCase()}`)) {
					return false;
				}
				return !query || name.includes(query.toLowerCase());
			});

	const displayName = (key: string) => {
		if (!search) {
			return baseName(key);
		}
		// A server-side match can live many folders below the browsed prefix, so
		// its bare file name would not say where it is. This is the same string
		// the server matches against (matchesObjectName in @bitovp/storage takes
		// the prefix for exactly this reason) — searched text and displayed text
		// must stay identical, so the two must change together.
		return key.startsWith(search.prefix)
			? key.slice(search.prefix.length)
			: key;
	};

	return (
		<div className="rounded-lg border border-zinc-800">
			<div className="flex gap-2 border-zinc-800 border-b p-2">
				<Input
					aria-label={t("storage.filterByName")}
					placeholder={
						search ? t("storage.searchPrefix") : t("storage.filterInPrefix")
					}
					className="h-8 max-w-xs text-xs"
					value={query}
					onChange={(e) =>
						search
							? search.onQueryChange(e.target.value)
							: setLocalQuery(e.target.value)
					}
				/>
				<Input
					aria-label={t("storage.filterByExtension")}
					placeholder={t("storage.extPlaceholder")}
					className="h-8 w-24 text-xs"
					value={extension}
					onChange={(e) => {
						const value = e.target.value.replace(/^\./, "");
						if (search) {
							search.onExtensionChange(value);
						} else {
							setLocalExtension(value);
						}
					}}
				/>
			</div>
			{search?.notice ? (
				<div className="border-zinc-800 border-b px-3 py-1.5">
					{search.notice}
				</div>
			) : null}
			<div className="overflow-x-auto">
				<table className="w-full min-w-[34rem] text-sm">
					<thead>
						<tr className="border-zinc-800 border-b text-left text-xs text-zinc-500">
							<th className="px-3 py-2 font-medium">{t("common.name")}</th>
							<th className="px-3 py-2 font-medium">{t("storage.size")}</th>
							<th className="px-3 py-2 font-medium">{t("storage.modified")}</th>
							<th className="px-3 py-2 font-medium">{t("common.actions")}</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-zinc-800/70">
						{prefixes.map((prefix) => (
							<tr key={prefix} className="hover:bg-zinc-900/40">
								<td className="px-3 py-1.5">
									<button
										type="button"
										className="flex items-center gap-2 text-zinc-200 hover:text-emerald-400"
										onClick={() => onOpenPrefix(prefix)}
									>
										<FolderOpen aria-hidden className="h-4 w-4 text-zinc-500" />
										{baseName(prefix)}/
									</button>
								</td>
								<td className="px-3 py-1.5 text-zinc-500">—</td>
								<td className="px-3 py-1.5 text-zinc-500">—</td>
								<td className="px-3 py-1.5">
									<div className="flex gap-1">
										{onUseAsOutput ? (
											<Button
												variant="ghost"
												size="sm"
												onClick={() => onUseAsOutput(prefix)}
											>
												{t("storage.useAsOutput")}
											</Button>
										) : null}
										{onCopyUri ? (
											<Button
												variant="ghost"
												size="sm"
												aria-label={t("uiX.copyUriFor", { name: prefix })}
												onClick={() => onCopyUri(prefix)}
											>
												<LinkIcon aria-hidden className="h-3.5 w-3.5" />
											</Button>
										) : null}
									</div>
								</td>
							</tr>
						))}
						{visibleObjects.map((obj) => (
							<tr key={obj.key} className="hover:bg-zinc-900/40">
								{/* Bounded name, scrolling table: min-w-[34rem] scroll
								    is this browser's idiom, but an UNBOUNDED nowrap
								    name made one deep key push Size/Modified and the
								    action buttons far off-screen (UI loop 2026-08-21).
								    24rem keeps names readable; title has the rest. */}
								<td className="px-3 py-1.5 text-zinc-300">
									<span
										title={obj.key}
										className="block max-w-[24rem] truncate"
									>
										{displayName(obj.key)}
									</span>
								</td>
								<td className="px-3 py-1.5 text-xs text-zinc-400">
									{formatBytes(obj.size)}
								</td>
								<td className="px-3 py-1.5 text-xs text-zinc-400">
									{formatDateTime(obj.lastModified)}
								</td>
								<td className="px-3 py-1.5">
									<div className="flex gap-1">
										{onUseAsInput ? (
											<Button
												variant="ghost"
												size="sm"
												onClick={() => onUseAsInput(obj.key)}
											>
												<Download aria-hidden className="h-3.5 w-3.5" />
												{t("storage.useAsInput")}
											</Button>
										) : null}
										{onInspect ? (
											<Button
												variant="ghost"
												size="sm"
												aria-label={`${t("storage.inspect")} ${obj.key}`}
												onClick={() => onInspect(obj.key, obj.size)}
											>
												<ScanSearch aria-hidden className="h-3.5 w-3.5" />
												{t("storage.inspect")}
											</Button>
										) : null}
										{onCopyUri ? (
											<Button
												variant="ghost"
												size="sm"
												aria-label={t("uiX.copyUriFor", { name: obj.key })}
												onClick={() => onCopyUri(obj.key)}
											>
												<LinkIcon aria-hidden className="h-3.5 w-3.5" />
											</Button>
										) : null}
									</div>
								</td>
							</tr>
						))}
						{!isLoading &&
						prefixes.length === 0 &&
						visibleObjects.length === 0 ? (
							<tr>
								<td
									colSpan={4}
									className="px-3 py-8 text-center text-sm text-zinc-500"
								>
									{t("storage.emptyPrefix")}
								</td>
							</tr>
						) : null}
					</tbody>
				</table>
			</div>
			{isLoading ? (
				<div
					role="status"
					aria-label={t("storage.loadingObjects")}
					className="space-y-1 p-2"
				>
					{[0, 1, 2, 3].map((i) => (
						<div key={i} className="h-7 animate-pulse rounded bg-zinc-900" />
					))}
				</div>
			) : null}
			{hasNextPage ? (
				<div className="border-zinc-800 border-t p-2">
					<Button
						variant="secondary"
						size="sm"
						disabled={isFetchingNextPage}
						onClick={onFetchNextPage}
					>
						{isFetchingNextPage
							? t("common.loading")
							: t("storage.loadMorePaged")}
					</Button>
				</div>
			) : null}
		</div>
	);
}
