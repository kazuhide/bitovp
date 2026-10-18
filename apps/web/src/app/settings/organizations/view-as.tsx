"use client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { localizedCustomerError } from "@/lib/customer-error";
import { useT } from "@/lib/i18n/context";
import { reloadAfterOrganizationChange } from "@/lib/tenant-fetch";
import type { Organization } from "./ip-policy";

type Member = { id: string; displayName: string; role: string };
export function ViewAs({ organizations }: { organizations: Organization[] }) {
	const { t } = useT();
	const [organizationId, setOrganizationId] = useState(
		organizations[0]?.id ?? "",
	);
	const [targetUserId, setTargetUserId] = useState("");
	const [password, setPassword] = useState("");
	const members = useQuery({
		queryKey: ["view-as-members", organizationId],
		enabled: Boolean(organizationId),
		queryFn: () =>
			apiFetch<Member[]>(
				`/api/platform/organizations/${organizationId}/members`,
			),
	});
	const target = targetUserId || members.data?.[0]?.id || "";
	const start = useMutation({
		mutationFn: () =>
			apiFetch("/api/account/impersonation", {
				method: "POST",
				body: JSON.stringify({
					organizationId,
					targetUserId: target,
					currentPassword: password,
				}),
			}),
		onSettled: () => setPassword(""),
		onSuccess: reloadAfterOrganizationChange,
	});
	const selectClass =
		"w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200";
	return (
		<form
			className="mt-8 space-y-4 rounded-lg border border-zinc-800 p-4"
			onSubmit={(event) => {
				event.preventDefault();
				start.mutate();
			}}
		>
			<h2 className="font-medium text-sm">
				{t("tenant.viewAs")}
				<span className="ml-2 font-normal text-xs text-zinc-500">
					{t("tenant.readOnly")}
				</span>
			</h2>
			<div className="grid gap-4 md:grid-cols-3">
				<div>
					<label
						htmlFor="view-as-organization"
						className="mb-2 block text-xs text-zinc-400"
					>
						{t("tenant.organization")}
					</label>
					<select
						id="view-as-organization"
						value={organizationId}
						className={selectClass}
						onChange={(event) => {
							setOrganizationId(event.target.value);
							setTargetUserId("");
						}}
					>
						{organizations.map((org) => (
							<option key={org.id} value={org.id}>
								{org.name}
							</option>
						))}
					</select>
				</div>
				<div>
					<label
						htmlFor="view-as-member"
						className="mb-2 block text-xs text-zinc-400"
					>
						{t("tenant.member")}
					</label>
					<select
						id="view-as-member"
						className={selectClass}
						value={target}
						disabled={!members.isSuccess || !members.data.length}
						onChange={(event) => setTargetUserId(event.target.value)}
					>
						{members.data?.map((member) => (
							<option key={member.id} value={member.id}>
								{member.displayName} · {member.role}
							</option>
						))}
					</select>
				</div>
				<div>
					<label
						htmlFor="view-as-password"
						className="mb-2 block text-xs text-zinc-400"
					>
						{t("tenant.password")}
					</label>
					<Input
						id="view-as-password"
						type="password"
						autoComplete="current-password"
						required
						value={password}
						onChange={(event) => setPassword(event.target.value)}
					/>
				</div>
			</div>
			{members.isSuccess && !members.data.length ? (
				<p className="text-sm text-zinc-400">{t("tenant.noMembers")}</p>
			) : null}
			{members.isPending ? (
				<p role="status" className="text-sm text-zinc-400">
					{t("tenant.loading")}
				</p>
			) : null}
			{members.error || start.error ? (
				<p role="alert" className="text-sm text-red-400">
					{localizedCustomerError(
						t,
						members.error ?? start.error,
						"common.requestFailed",
					)}
				</p>
			) : null}
			<Button
				type="submit"
				disabled={!target || members.isFetching || start.isPending}
			>
				{t("tenant.view")}
			</Button>
		</form>
	);
}
