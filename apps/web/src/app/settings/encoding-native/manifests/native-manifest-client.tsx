"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useId, useState } from "react";
import { CopyableId } from "@/components/copyable-id";
import { Button } from "@/components/ui/button";
import { SelectNative } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/context";

type Account = { id: string; label: string };
type Page = {
	items: {
		id: string;
		type: "DASH" | "HLS" | "SMOOTH_STREAMING";
		createdAt?: string;
		modifiedAt?: string;
	}[];
	offset: number;
	totalCount: number;
	nextOffset: number | null;
};

export function NativeManifestClient() {
	const { t } = useT();
	const accountField = useId();
	const [accountId, setAccountId] = useState("");
	const [offsets, setOffsets] = useState([0]);
	const offset = offsets.at(-1) ?? 0;
	const accounts = useQuery({
		queryKey: ["bitmovin-accounts"],
		queryFn: ({ signal }) =>
			apiFetch<Account[]>("/api/bitmovin-accounts", { signal }),
	});
	const account = accounts.data?.some((item) => item.id === accountId)
		? accountId
		: (accounts.data?.[0]?.id ?? "");
	const inventory = useQuery({
		queryKey: ["encoding-manifests", account, offset],
		queryFn: ({ signal }) =>
			apiFetch<Page>(
				`/api/encoding-native/manifests?${new URLSearchParams({
					bitmovinAccountId: account,
					offset: String(offset),
				})}`,
				{ signal },
			),
		enabled: !!account,
		retry: false,
	});
	const page = inventory.data;
	return (
		<section className="min-w-0 max-w-5xl space-y-4">
			<header className="space-y-1">
				<Link
					href="/settings/encoding-native"
					className="text-sm text-muted-foreground underline"
				>
					{t("encodingNative.title")}
				</Link>
				<h1 className="text-2xl font-semibold">{t("jobDetail.manifests")}</h1>
			</header>
			{accounts.isPending && <p role="status">{t("common.loading")}</p>}
			{accounts.isError && (
				<p role="alert">{t("errorDefinitions.accountsFailed")}</p>
			)}
			{accounts.isSuccess && !account && (
				<Link
					href="/settings/bitmovin"
					className="text-sm text-emerald-400 underline"
				>
					{t("errorDefinitions.addAccount")}
				</Link>
			)}
			{account && (
				<label
					htmlFor={accountField}
					className="block max-w-sm space-y-1 text-sm"
				>
					<span>{t("encodingStatistics.account")}</span>
					<SelectNative
						id={accountField}
						value={account}
						onChange={(event) => {
							setAccountId(event.currentTarget.value);
							setOffsets([0]);
						}}
					>
						{accounts.data?.map((item) => (
							<option key={item.id} value={item.id}>
								{item.label}
							</option>
						))}
					</SelectNative>
				</label>
			)}
			{account && inventory.isPending && (
				<p role="status">{t("common.loading")}</p>
			)}
			{inventory.isError && (
				<p role="alert">{t("encodingNative.loadFailed")}</p>
			)}
			{page && (
				<>
					{page.items.length ? (
						<div className="overflow-x-auto rounded-md border">
							<table className="w-full text-left text-sm">
								<thead className="bg-muted/40 text-muted-foreground">
									<tr>
										<th scope="col" className="p-3">
											ID
										</th>
										<th scope="col" className="p-3">
											{t("encodingNative.configType")}
										</th>
										<th scope="col" className="p-3">
											{t("encodingNative.created")}
										</th>
										<th scope="col" className="p-3">
											{t("encodingNative.modified")}
										</th>
									</tr>
								</thead>
								<tbody>
									{page.items.map((item) => (
										<tr key={item.id} className="border-t">
											<td className="p-3">
												<CopyableId value={item.id} />
											</td>
											<td className="p-3">
												{item.type === "SMOOTH_STREAMING"
													? "Smooth Streaming"
													: item.type}
											</td>
											<td className="p-3">
												{item.createdAt && formatDateTime(item.createdAt)}
											</td>
											<td className="p-3">
												{item.modifiedAt && formatDateTime(item.modifiedAt)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					) : (
						<p className="text-sm text-muted-foreground">
							{t("encodingNative.empty")}
						</p>
					)}
					{(offsets.length > 1 || page.nextOffset !== null) && (
						<nav
							aria-label={t("encodingNative.pagination")}
							className="flex gap-2"
						>
							<Button
								variant="secondary"
								size="sm"
								disabled={offsets.length === 1}
								onClick={() => setOffsets(offsets.slice(0, -1))}
							>
								{t("providerResources.previous")}
							</Button>
							<Button
								variant="secondary"
								size="sm"
								disabled={page.nextOffset === null}
								onClick={() => {
									if (page.nextOffset !== null)
										setOffsets([...offsets, page.nextOffset]);
								}}
							>
								{t("providerResources.next")}
							</Button>
						</nav>
					)}
				</>
			)}
		</section>
	);
}
