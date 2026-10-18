"use client";
import { useMutation } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { apiFetch } from "@/lib/api";
import { useSession } from "@/lib/auth/use-session";
import { useT } from "@/lib/i18n/context";
import { reloadAfterOrganizationChange } from "@/lib/tenant-fetch";
import { Button } from "./ui/button";

export function OrganizationMenu({ children }: { children?: ReactNode }) {
	const { t } = useT();
	const session = useSession();
	const change = useMutation({
		mutationFn: (organizationId: string) =>
			apiFetch("/api/account/organization", {
				method: "POST",
				body: JSON.stringify({ organizationId }),
			}),
		onSuccess: reloadAfterOrganizationChange,
	});
	const exit = useMutation({
		mutationFn: () =>
			apiFetch("/api/account/impersonation", { method: "DELETE" }),
		onSuccess: reloadAfterOrganizationChange,
	});
	const data = session.status === "success" ? session.data : undefined;
	if (!data?.authenticated || data.mode !== "users") return null;
	if (data.isImpersonating)
		return (
			<div
				className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-700/60 bg-amber-950/20 px-3 py-2 text-sm"
				role="status"
			>
				<span>
					{t("tenant.viewingAs", {
						name: data.targetDisplayName ?? "",
						organization: data.organizationName ?? "",
					})}{" "}
					· {t("tenant.readOnly")}
				</span>
				<Button
					size="sm"
					variant="secondary"
					onClick={() => exit.mutate()}
					disabled={exit.isPending}
				>
					{t("tenant.exitViewAs")}
				</Button>
				{exit.error ? <p role="alert">{exit.error.message}</p> : null}
			</div>
		);
	return (
		<div className="mb-2 ml-auto flex max-w-40 flex-col items-end gap-1 text-xs text-zinc-400 sm:float-right sm:ml-4">
			<div className="flex max-w-full items-center justify-end gap-2">
				{(data.organizations?.length ?? 0) > 1 ? (
					<label htmlFor="current-organization">
						{t("tenant.organization")}
					</label>
				) : (
					<span>{t("tenant.organization")}</span>
				)}
				{(data.organizations?.length ?? 0) > 1 ? (
					<select
						id="current-organization"
						value={data.organizationId}
						disabled={change.isPending}
						onChange={(event) => change.mutate(event.target.value)}
						className="h-7 min-w-0 max-w-28 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-200"
					>
						{data.organizations?.map((org) => (
							<option key={org.id} value={org.id}>
								{org.name}
							</option>
						))}
					</select>
				) : (
					<span
						id="current-organization"
						className="truncate text-zinc-200"
						title={data.organizationName}
					>
						{data.organizationName}
					</span>
				)}
			</div>
			{children}
			{change.error ? (
				<p role="alert" className="text-red-400">
					{change.error.message}
				</p>
			) : null}
		</div>
	);
}
