"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import {
	type ErrorDefinition,
	ErrorDefinitionsResults,
} from "./error-definitions-list";

type Account = { id: string; label: string };
type Catalogue = { items: ErrorDefinition[]; totalCount: number };

export function ErrorDefinitionsClient({
	initialAccountId,
}: {
	initialAccountId?: string;
}) {
	const { t } = useT();
	const [accountId, setAccountId] = useState(initialAccountId);
	const [search, setSearch] = useState("");
	const accounts = useQuery({
		queryKey: ["bitmovin-accounts"],
		queryFn: ({ signal }) =>
			apiFetch<Account[]>("/api/bitmovin-accounts", { signal }),
	});
	const selectedId = accountId ?? accounts.data?.[0]?.id ?? "";
	const available =
		accounts.data?.some((account) => account.id === selectedId) ?? false;
	const definitions = useQuery({
		queryKey: ["encoding-error-definitions", selectedId],
		queryFn: ({ signal }) =>
			apiFetch<Catalogue>(
				`/api/encoding-error-definitions?bitmovinAccountId=${encodeURIComponent(selectedId)}`,
				{ signal },
			),
		enabled: accounts.isSuccess && available,
		staleTime: 300_000,
		retry: false,
		refetchOnWindowFocus: false,
	});
	return (
		<section className="min-w-0 space-y-4">
			<div className="flex items-center gap-2">
				<h1 className="font-semibold text-xl text-zinc-50">
					{t("pageTitles.errorDefinitions")}
				</h1>
				<InfoHint
					labelFor={t("pageTitles.errorDefinitions")}
					text={t("errorDefinitions.help")}
				/>
			</div>
			{accounts.isPending ? (
				<Status text={t("errorDefinitions.loadingAccounts")} />
			) : accounts.isError ? (
				<LoadFailure
					message={t("errorDefinitions.accountsFailed")}
					reload={() => accounts.refetch()}
				/>
			) : accounts.data.length === 0 ? (
				<Link
					href="/settings/bitmovin"
					className="inline-flex min-h-11 items-center text-emerald-400 text-sm underline underline-offset-4"
				>
					{t("errorDefinitions.addAccount")}
				</Link>
			) : (
				<>
					<div className="flex flex-col gap-3 sm:flex-row sm:items-end">
						<label className="min-w-0 space-y-1 text-sm text-zinc-400 sm:w-64">
							<span>{t("errorDefinitions.account")}</span>
							<select
								value={available ? selectedId : ""}
								onChange={(event) => {
									setAccountId(event.target.value);
									setSearch("");
								}}
								className="block h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-200 focus-visible:outline-2 focus-visible:outline-emerald-500"
							>
								<option value="" disabled>
									{t("errorDefinitions.chooseAccount")}
								</option>
								{accounts.data.map((account) => (
									<option key={account.id} value={account.id}>
										{account.label}
									</option>
								))}
							</select>
						</label>
						<Input
							type="search"
							aria-label={t("errorDefinitions.search")}
							placeholder={t("errorDefinitions.searchPlaceholder")}
							value={search}
							disabled={!available}
							onChange={(event) => {
								setSearch(event.target.value);
							}}
							className="min-w-0 sm:max-w-sm"
						/>
					</div>
					{!available ? (
						<Status text={t("errorDefinitions.accountUnavailable")} />
					) : definitions.isError ? (
						<LoadFailure
							message={t("errorDefinitions.loadFailed")}
							reload={() => definitions.refetch()}
						/>
					) : definitions.isPending ? (
						<Status text={t("errorDefinitions.loading")} />
					) : (
						<ErrorDefinitionsResults
							key={`${selectedId}:${search}`}
							catalogue={definitions.data}
							search={search}
						/>
					)}
				</>
			)}
		</section>
	);
}

function Status({ text }: { text: string }) {
	return (
		<p role="status" className="text-sm text-zinc-400">
			{text}
		</p>
	);
}

function LoadFailure({
	message,
	reload,
}: {
	message: string;
	reload: () => unknown;
}) {
	const { t } = useT();
	return (
		<div className="flex flex-wrap items-center gap-3">
			<p role="alert" className="text-red-400 text-sm">
				{message}
			</p>
			<Button variant="secondary" size="sm" onClick={() => reload()}>
				{t("errorDefinitions.reload")}
			</Button>
		</div>
	);
}
