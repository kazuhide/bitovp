"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/context";

/**
 * Settings → API tokens . The SECRET renders exactly once,
 * selectable, on the mint response — refreshing the page loses it forever
 * (only the hash is stored), and the copy says so before minting. Revoke is
 * soft (≤60s gate latency, the documented property).
 */

type TokenWire = {
	id: string;
	name: string;
	prefix: string;
	role: string;
	createdAt: string;
	expiresAt: string | null;
	revokedAt: string | null;
	lastUsedAt: string | null;
};

export function TokensClient() {
	const { t } = useT();
	const queryClient = useQueryClient();
	const nameId = useId();
	const daysId = useId();
	const [name, setName] = useState("");
	const [expiresDays, setExpiresDays] = useState("");
	const [minted, setMinted] = useState<{
		name: string;
		secret: string;
	} | null>(null);

	const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

	const tokens = useQuery({
		queryKey: ["api-tokens"],
		queryFn: () => apiFetch<TokenWire[]>("/api/api-tokens"),
	});

	const mint = useMutation({
		mutationFn: () => {
			const days = expiresDays.trim() === "" ? undefined : Number(expiresDays);
			return apiFetch<{ name: string; secret: string }>("/api/api-tokens", {
				method: "POST",
				body: JSON.stringify({
					name,
					...(days !== undefined ? { expiresDays: days } : {}),
				}),
			});
		},
		onSuccess: (created) => {
			setMinted(created);
			setName("");
			setExpiresDays("");
			queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
		},
	});

	const revoke = useMutation({
		mutationFn: (id: string) =>
			apiFetch(`/api/api-tokens/${id}`, { method: "DELETE" }),
		onSuccess: () => {
			setConfirmRevoke(null);
			queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
		},
	});

	return (
		<div className="space-y-8">
			<section className="space-y-2">
				<div className="flex items-center gap-2">
					<h1 className="font-semibold text-xl text-zinc-50">
						{t("tokens.title")}
					</h1>
					<HelpOverlay labelFor={t("tokens.title")}>
						{t("tokens.intro")}
					</HelpOverlay>
				</div>
			</section>

			{minted ? (
				<section
					role="alert"
					className="max-w-2xl space-y-2 rounded-md border border-emerald-700 bg-emerald-950/40 p-4"
				>
					<p className="font-medium text-emerald-300 text-sm">
						{t("tokens.mintedOnce", { name: minted.name })}
					</p>
					<pre className="select-all overflow-x-auto rounded bg-zinc-900 p-2 font-mono text-sm text-zinc-100">
						{minted.secret}
					</pre>
					<p className="text-xs text-zinc-400">{t("tokens.mintedHint")}</p>
					<Button
						variant="secondary"
						size="sm"
						onClick={() => {
							setMinted(null);
							// The mutation cache held the secret after the render
							// cleared (review-189b I4 measured it). reset clears
							// the hook state but the CACHE ENTRY survives — remove
							// it explicitly; the pin reads the cache, not the DOM.
							mint.reset();
							for (const entry of queryClient.getMutationCache().getAll()) {
								queryClient.getMutationCache().remove(entry);
							}
						}}
					>
						{t("tokens.dismissSecret")}
					</Button>
				</section>
			) : null}

			<section className="max-w-xl space-y-3">
				<h2 className="font-medium text-sm text-zinc-200">
					{t("tokens.mintHeading")}
				</h2>
				<Field label={t("tokens.name")} htmlFor={nameId}>
					<Input
						id={nameId}
						value={name}
						placeholder="ci-runner"
						onChange={(e) => setName(e.target.value)}
					/>
				</Field>
				<Field
					label={t("tokens.expiresDays")}
					htmlFor={daysId}
					help={t("tokens.expiresDaysHint")}
				>
					<Input
						id={daysId}
						type="number"
						value={expiresDays}
						placeholder="90"
						onChange={(e) => setExpiresDays(e.target.value)}
					/>
				</Field>
				{mint.isError ? (
					<p role="alert" className="text-red-400 text-sm">
						{mint.error instanceof Error
							? mint.error.message
							: t("tokens.mintFailed")}
					</p>
				) : null}
				<Button
					onClick={() => mint.mutate()}
					disabled={name.trim() === "" || mint.isPending}
				>
					{t("tokens.mint")}
				</Button>
			</section>

			<section className="space-y-2">
				<h2 className="font-medium text-sm text-zinc-200">
					{t("tokens.listHeading")}
				</h2>
				{tokens.isLoading && <p role="status">{t("common.loading")}</p>}
				{tokens.isError ? (
					<p role="alert" className="text-red-400 text-sm">
						{t("tokens.listFailed")}{" "}
						<Button
							variant="secondary"
							size="sm"
							disabled={tokens.isFetching}
							onClick={() => tokens.refetch()}
						>
							{t("settingsForms.retry")}
						</Button>
					</p>
				) : null}
				{revoke.isError ? (
					// The kill-switch's failure mode must be LOUD (review-189 I2):
					// a silent 500 here reads as "the credential is dead" while
					// it keeps working.
					<p role="alert" className="text-red-400 text-sm">
						{revoke.error instanceof Error
							? revoke.error.message
							: t("tokens.revokeFailed")}
					</p>
				) : null}
				{tokens.data?.length === 0 ? (
					<p className="text-sm text-zinc-500">{t("tokens.noneYet")}</p>
				) : null}
				<ul className="space-y-2">
					{(tokens.data ?? []).map((token) => (
						<li
							key={token.id}
							className="flex flex-wrap items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs"
						>
							<span className="font-medium text-sm text-zinc-100">
								{token.name}
							</span>
							<span className="select-all font-mono text-zinc-400">
								bo_{token.prefix}…
							</span>
							<Badge>{token.role}</Badge>
							{token.revokedAt ? (
								<Badge tone="error">{t("tokens.revoked")}</Badge>
							) : token.expiresAt &&
								new Date(token.expiresAt).getTime() < Date.now() ? (
								<Badge tone="neutral">{t("tokens.expired")}</Badge>
							) : (
								<Badge tone="ok">{t("tokens.active")}</Badge>
							)}
							<span className="text-zinc-500">
								{t("tokens.created")}: {formatDateTime(token.createdAt)}
							</span>
							{token.expiresAt ? (
								<span className="text-zinc-500">
									{t("tokens.expires")}: {formatDateTime(token.expiresAt)}
								</span>
							) : null}
							<span className="text-zinc-500">
								{t("tokens.lastUsed")}:{" "}
								{token.lastUsedAt
									? formatDateTime(token.lastUsedAt)
									: t("tokens.never")}
							</span>
							{!token.revokedAt ? (
								confirmRevoke === token.id ? (
									<Button
										variant="secondary"
										size="sm"
										className="ml-auto"
										onClick={() => revoke.mutate(token.id)}
										disabled={revoke.isPending}
									>
										{t("tokens.confirmRevoke")}
									</Button>
								) : (
									// Two-click, like the sibling webhook panel: there is
									// no un-revoke and no secret recovery — one silent
									// click must not kill a CI credential (review-189 I3).
									<Button
										variant="secondary"
										size="sm"
										className="ml-auto"
										title={t("tokens.revokeLatencyHint")}
										onClick={() => setConfirmRevoke(token.id)}
									>
										{t("tokens.revoke")}
									</Button>
								)
							) : null}
						</li>
					))}
				</ul>
			</section>
		</div>
	);
}
