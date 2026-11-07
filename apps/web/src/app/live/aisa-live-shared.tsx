"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import type { BitmovinAccountDto } from "@/app/settings/bitmovin/types";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { SelectNative } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";

export const AISA_PAGE_SIZE = 25;
export const AISA_TERMINAL = new Set([
	"FINISHED",
	"CANCELED",
	"ERROR",
	"TRANSFER_ERROR",
]);
export const AISA_LINK_CLASS =
	"text-sm text-emerald-400 underline underline-offset-4";

export function aisaDetailHref(accountId: string, analysisId: string) {
	return `/live/analyses/${encodeURIComponent(analysisId)}?bitmovinAccountId=${encodeURIComponent(accountId)}`;
}

export function AisaPreviewNotice({ managed = false }: { managed?: boolean }) {
	const { t } = useT();
	return (
		<div className="space-y-2 rounded-md border border-amber-900/60 bg-amber-950/20 p-4 text-sm text-amber-200">
			<p>{t("aisaLive.sports")}</p>
			{managed ? <p>{t("aisaLive.managed")}</p> : null}
		</div>
	);
}

export function AisaPreviewLinks({ create = true }: { create?: boolean }) {
	const { t } = useT();
	return (
		<nav
			className="flex flex-wrap gap-x-5 gap-y-2"
			aria-label={t("aisaLive.title")}
		>
			<Link href="/live/analyses" className={AISA_LINK_CLASS}>
				{t("aisaLive.list")}
			</Link>
			<RoleAccess control="live.aisa.new">
				{create ? (
					<Link href="/live/new?mode=aisa-preview" className={AISA_LINK_CLASS}>
						{t("aisaLive.newAnalysis")}
					</Link>
				) : null}
				<Link href="/live/new" className={AISA_LINK_CLASS}>
					{t("aisaLive.normalLive")}
				</Link>
			</RoleAccess>
		</nav>
	);
}

export function useAisaAccounts() {
	const [selected, setSelected] = useState("");
	const accounts = useQuery({
		queryKey: ["bitmovin-accounts"],
		queryFn: () => apiFetch<BitmovinAccountDto[]>("/api/bitmovin-accounts"),
	});
	const accountId = selected || accounts.data?.[0]?.id || "";
	return { accounts, accountId, setAccountId: setSelected };
}

export function AisaAccountSelect({
	state,
	disabled,
}: {
	state: ReturnType<typeof useAisaAccounts>;
	disabled?: boolean;
}) {
	const { t } = useT();
	const { accounts, accountId, setAccountId } = state;
	if (accounts.isLoading)
		return (
			<p role="status" className="text-sm text-zinc-400">
				{t("aisaLive.loadingAccounts")}
			</p>
		);
	if (accounts.isError)
		return (
			<div role="alert" className="space-y-2 text-sm text-red-300">
				<p>{t("aisaLive.requestFailed")}</p>
				<Button variant="secondary" onClick={() => accounts.refetch()}>
					{t("aisaLive.refresh")}
				</Button>
			</div>
		);
	if (!accounts.data?.length)
		return (
			<p role="status" className="text-sm text-zinc-400">
				{t("aisaLive.noAccounts")}{" "}
				<Link href="/settings/bitmovin" className={AISA_LINK_CLASS}>
					{t("aisaLive.addAccount")}
				</Link>
			</p>
		);
	return (
		<Field label={t("aisaLive.account")} htmlFor="aisa-account">
			<SelectNative
				id="aisa-account"
				name="bitmovinAccountId"
				value={accountId}
				disabled={disabled}
				onChange={(event) => setAccountId(event.target.value)}
			>
				{accounts.data.map((account) => (
					<option value={account.id} key={account.id}>
						{account.label}
					</option>
				))}
			</SelectNative>
		</Field>
	);
}
