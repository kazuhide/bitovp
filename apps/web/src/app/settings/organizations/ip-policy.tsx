"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { apiFetch } from "@/lib/api";
import { localizedCustomerError } from "@/lib/customer-error";
import { useT } from "@/lib/i18n/context";

export type Organization = {
	id: string;
	name: string;
	slug: string;
	active: boolean;
	allowedIpCidrs: string[];
};
export function IpPolicy({
	organizationId,
	owner = false,
	initial,
}: {
	organizationId: string;
	owner?: boolean;
	initial?: Organization;
}) {
	const { t } = useT();
	const id = useId();
	const cache = useQueryClient();
	const query = useQuery({
		queryKey: ["organization-policy", organizationId],
		enabled: !owner,
		queryFn: () =>
			apiFetch<{ organization: Organization; clientIp: string | null }>(
				`/api/organizations/${organizationId}`,
			),
	});
	const [text, setText] = useState(initial?.allowedIpCidrs.join("\n") ?? "");
	useEffect(() => {
		const ips =
			initial?.allowedIpCidrs ?? query.data?.organization.allowedIpCidrs;
		if (ips) setText(ips.join("\n"));
	}, [initial?.allowedIpCidrs, query.data]);
	const save = useMutation({
		mutationFn: () => {
			const body = JSON.stringify({
				allowedIpCidrs: text
					.split(/\r?\n/)
					.map((item) => item.trim())
					.filter(Boolean),
			});
			return owner
				? apiFetch(`/api/platform/organizations/${organizationId}`, {
						method: "PATCH",
						body,
					})
				: apiFetch(`/api/organizations/${organizationId}`, {
						method: "PATCH",
						body,
					});
		},
		onSuccess: () => {
			void cache.invalidateQueries({ queryKey: ["organizations"] });
			void cache.invalidateQueries({ queryKey: ["auth", "session"] });
		},
	});
	return (
		<form
			className="mt-5 space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4"
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate();
			}}
		>
			<div className="flex items-center gap-2">
				<label htmlFor={id} className="font-medium text-sm">
					{t("tenant.ipPolicy")}
				</label>
				<InfoHint text={t("tenant.ipHelp")} labelFor={t("tenant.ipPolicy")} />
			</div>
			{query.isError ? (
				<p className="text-sm text-red-400" role="alert">
					{localizedCustomerError(t, query.error, "common.requestFailed")}
				</p>
			) : null}
			<textarea
				id={id}
				value={text}
				onChange={(event) => {
					setText(event.target.value);
					save.reset();
				}}
				rows={3}
				placeholder={t("tenant.ipPlaceholder")}
				className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-200 focus-visible:outline-2 focus-visible:outline-emerald-500"
				disabled={!owner && !query.isSuccess}
			/>
			<div className="flex flex-wrap items-center gap-3">
				<Button
					type="submit"
					size="sm"
					disabled={save.isPending || (!owner && !query.isSuccess)}
				>
					{t("tenant.save")}
				</Button>
				{query.data?.clientIp ? (
					<span className="text-xs text-zinc-500">
						{t("tenant.ip")}: {query.data.clientIp}
					</span>
				) : null}
				{save.isSuccess ? (
					<span role="status" className="text-xs text-emerald-400">
						{t("tenant.saved")}
					</span>
				) : null}
				{save.error ? (
					<p role="alert" className="text-sm text-red-400">
						{localizedCustomerError(t, save.error, "common.requestFailed")}
					</p>
				) : null}
			</div>
		</form>
	);
}
