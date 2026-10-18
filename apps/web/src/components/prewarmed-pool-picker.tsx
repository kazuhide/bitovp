"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import {
	LIST_LIMIT_MAX,
	type PageDto,
	type PrewarmedPoolDto,
} from "@/lib/infrastructure/schemas";

function csvToList(csv: string): string[] {
	return csv
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function toggle(ids: string[], id: string): string[] {
	return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/**
 * Pre-warmed pool picker for the Bitmovin account form. In edit mode it
 * lists the account's own pools (via the Infrastructure proxy routes) as
 * checkboxes; a manual-id input remains for pools living in OTHER Bitmovin
 * organizations (and is the only path in create mode, where no account id
 * exists yet to list against). State stays the form's CSV string so the
 * account payload shape is unchanged.
 */
export function PrewarmedPoolPicker({
	accountId,
	csv,
	onChange,
	inputId = "pool-picker-manual",
}: {
	/** Saved Bitmovin account id — undefined in create mode. */
	accountId?: string;
	csv: string;
	onChange: (csv: string) => void;
	/** id for the manual-id input (the Field label target). */
	inputId?: string;
}) {
	const { t } = useT();
	const [manualId, setManualId] = useState("");
	const selected = csvToList(csv);

	const pools = useQuery({
		queryKey: ["infra-prewarmed-pools", accountId],
		queryFn: () =>
			apiFetch<PageDto<PrewarmedPoolDto>>(
				`/api/infrastructure/prewarmed-pools?bitmovinAccountId=${accountId}&limit=${LIST_LIMIT_MAX}`,
			),
		enabled: accountId !== undefined,
	});

	const addManual = () => {
		const id = manualId.trim();
		if (id !== "" && !selected.includes(id)) {
			onChange([...selected, id].join(", "));
		}
		setManualId("");
	};

	return (
		<div className="space-y-2">
			{accountId === undefined ? (
				<p className="text-xs text-zinc-500">
					{t("settings.saveTheAccountFirstToPick")}
				</p>
			) : pools.isLoading ? (
				<div
					role="status"
					aria-busy="true"
					aria-label={t("settings.loadingPools")}
					className="h-9 animate-pulse rounded-md bg-zinc-900"
				/>
			) : pools.isError ? (
				<p className="text-xs text-zinc-500">
					{t("settings.couldNotListPools")}
					{pools.error instanceof ApiError ? ` (${pools.error.message})` : ""}{" "}
					{t("settingsX.pasteIdsManuallyBelow")}
				</p>
			) : pools.data && pools.data.items.length > 0 ? (
				<ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-zinc-800 p-2">
					{pools.data.items.map((pool) => (
						<li key={pool.id}>
							<label className="flex items-center gap-2 text-sm text-zinc-300">
								<input
									type="checkbox"
									className="h-4 w-4 accent-emerald-600"
									checked={selected.includes(pool.id)}
									onChange={() =>
										onChange(toggle(selected, pool.id).join(", "))
									}
								/>
								<span className="min-w-0 flex-1 truncate">
									{pool.name || pool.id}
									<span className="ml-2 text-xs text-zinc-500">
										{pool.cloudRegion}
									</span>
								</span>
								<Badge tone={pool.status === "STARTED" ? "ok" : "neutral"}>
									{pool.status ?? "?"}
								</Badge>
							</label>
						</li>
					))}
				</ul>
			) : (
				<p className="text-xs text-zinc-500">
					{t("settings.noPoolsInThisAccountCreate")}
				</p>
			)}

			{/* Pools from other orgs are still valid — manual-id fallback. */}
			<div className="flex gap-2">
				<Input
					id={inputId}
					aria-label={t("settings.addPoolIdManually")}
					placeholder={t("settingsForms.poolIdOtherOrg")}
					value={manualId}
					onChange={(e) => setManualId(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							addManual();
						}
					}}
				/>
				<Button
					type="button"
					variant="secondary"
					size="sm"
					className="h-9 shrink-0"
					onClick={addManual}
				>
					{t("settings.addId")}
				</Button>
			</div>

			{selected.length > 0 ? (
				<div className="flex flex-wrap gap-1">
					{selected.map((id) => (
						<Badge key={id} className="max-w-full">
							<span className="truncate">{id}</span>
							<button
								type="button"
								aria-label={t("settingsX.removePoolId", { id })}
								className="ml-1 text-zinc-500 hover:text-zinc-200"
								onClick={() =>
									onChange(selected.filter((x) => x !== id).join(", "))
								}
							>
								×
							</button>
						</Badge>
					))}
				</div>
			) : null}
		</div>
	);
}
