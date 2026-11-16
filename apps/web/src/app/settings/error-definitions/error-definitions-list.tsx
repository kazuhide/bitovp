"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/context";

export type ErrorDefinition = {
	code: number;
	category?: string;
	message?: string;
	description?: string;
	retryHint?: string;
};

const PAGE_SIZE = 50;

export function ErrorDefinitionsResults({
	catalogue,
	search,
}: {
	catalogue: { items: ErrorDefinition[]; totalCount: number };
	search: string;
}) {
	const { t } = useT();
	const [page, setPage] = useState(0);
	const query = search.trim().toLowerCase();
	const filtered = catalogue.items.filter(
		(item) =>
			!query ||
			[item.code, item.category, item.message, item.description]
				.join(" ")
				.toLowerCase()
				.includes(query),
	);
	const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
	const safePage = Math.min(page, pages - 1);
	return (
		<>
			<p aria-live="polite" className="text-xs text-zinc-400">
				{t("errorDefinitions.count", {
					count: filtered.length,
					total: catalogue.totalCount,
				})}
			</p>
			{filtered.length === 0 ? (
				<p role="status" className="text-sm text-zinc-400">
					{t(
						catalogue.items.length === 0
							? "errorDefinitions.empty"
							: "errorDefinitions.noMatches",
					)}
				</p>
			) : (
				<ErrorDefinitionsList
					items={filtered.slice(
						safePage * PAGE_SIZE,
						(safePage + 1) * PAGE_SIZE,
					)}
				/>
			)}
			{pages > 1 ? (
				<nav
					aria-label={t("errorDefinitions.pagination")}
					className="flex flex-wrap items-center gap-3"
				>
					<Button
						variant="secondary"
						size="sm"
						disabled={safePage === 0}
						onClick={() => setPage(safePage - 1)}
					>
						{t("apiCoverage.prev")}
					</Button>
					<span className="text-xs text-zinc-400">
						{safePage + 1} / {pages}
					</span>
					<Button
						variant="secondary"
						size="sm"
						disabled={safePage + 1 === pages}
						onClick={() => setPage(safePage + 1)}
					>
						{t("apiCoverage.next")}
					</Button>
				</nav>
			) : null}
		</>
	);
}

export function ErrorDefinitionsList({ items }: { items: ErrorDefinition[] }) {
	const { t } = useT();
	return (
		<ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
			{items.map((item) => (
				<li key={item.code} className="min-w-0 space-y-2 p-3 sm:p-4">
					<div className="flex flex-wrap items-center gap-2">
						<h2 className="font-mono font-semibold text-sm text-zinc-100">
							{item.code}
						</h2>
						{item.category ? (
							<span className="break-words text-xs text-zinc-400">
								{item.category}
							</span>
						) : null}
						<Badge tone="neutral">
							{t(
								item.retryHint === "RETRY"
									? "errorDefinitions.retrySuggested"
									: item.retryHint === "NO_RETRY"
										? "errorDefinitions.noRetry"
										: item.retryHint === "RETRY_IN_DIFFERENT_REGION"
											? "errorDefinitions.otherRegion"
											: "errorDefinitions.unknownRetry",
							)}
						</Badge>
					</div>
					{item.message ? (
						<p className="whitespace-pre-wrap break-words text-sm text-zinc-200">
							{item.message}
						</p>
					) : null}
					{item.description ? (
						<p className="whitespace-pre-wrap break-words text-sm text-zinc-400 leading-relaxed">
							{item.description}
						</p>
					) : null}
				</li>
			))}
		</ul>
	);
}
