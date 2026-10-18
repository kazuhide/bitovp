"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { useSession } from "@/lib/auth/use-session";
import { useT } from "@/lib/i18n/context";
import { reloadAfterOrganizationChange } from "@/lib/tenant-fetch";
import { SettingsBreadcrumb } from "../settings-breadcrumb";
import { IpPolicy, type Organization } from "./ip-policy";
import { ViewAs } from "./view-as";

export function Organizations() {
	const { t } = useT();
	const session = useSession();
	const cache = useQueryClient();
	const owner =
		session.status === "success" &&
		session.data.platformOwner === true &&
		!session.data.isImpersonating;
	const query = useQuery({
		queryKey: ["organizations"],
		enabled: owner,
		queryFn: () =>
			apiFetch<{ organizations: Organization[] }>("/api/organizations"),
	});
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const create = useMutation({
		mutationFn: () =>
			apiFetch("/api/organizations", {
				method: "POST",
				body: JSON.stringify({ name, slug }),
			}),
		onSuccess: () => {
			setName("");
			setSlug("");
			void cache.invalidateQueries({ queryKey: ["organizations"] });
			void cache.invalidateQueries({ queryKey: ["auth", "session"] });
		},
	});
	const change = useMutation({
		mutationFn: (organizationId: string) =>
			apiFetch("/api/account/organization", {
				method: "POST",
				body: JSON.stringify({ organizationId }),
			}),
		onSuccess: reloadAfterOrganizationChange,
	});
	const toggle = useMutation({
		mutationFn: ({ id, active }: { id: string; active: boolean }) =>
			apiFetch(`/api/platform/organizations/${id}`, {
				method: "PATCH",
				body: JSON.stringify({ active }),
			}),
		onSuccess: () => {
			void cache.invalidateQueries({ queryKey: ["organizations"] });
			void cache.invalidateQueries({ queryKey: ["auth", "session"] });
		},
	});
	return (
		<section>
			<SettingsBreadcrumb />
			<h1 className="font-semibold text-xl text-zinc-50">
				{t("tenant.organizations")}
			</h1>
			<div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-zinc-400">
				<span>
					{t("tenant.current")}: {session.data?.organizationName ?? "—"}
				</span>
				<Link
					href="/settings/users"
					className="text-emerald-400 underline underline-offset-4"
				>
					{t("tenant.member")}
				</Link>
			</div>
			{owner ? (
				<>
					<form
						className="mt-6 flex flex-wrap items-end gap-3"
						onSubmit={(event) => {
							event.preventDefault();
							create.mutate();
						}}
					>
						<div className="min-w-40 flex-1">
							<label
								htmlFor="organization-name"
								className="mb-2 block text-xs text-zinc-400"
							>
								{t("tenant.name")}
							</label>
							<Input
								id="organization-name"
								value={name}
								onChange={(event) => setName(event.target.value)}
								required
								maxLength={120}
							/>
						</div>
						<div className="min-w-40 flex-1">
							<label
								htmlFor="organization-slug"
								className="mb-2 block text-xs text-zinc-400"
							>
								{t("tenant.slug")}
							</label>
							<Input
								id="organization-slug"
								value={slug}
								onChange={(event) => setSlug(event.target.value)}
								required
								maxLength={100}
								pattern="[a-z0-9]+(-[a-z0-9]+)*"
								placeholder="my-organization"
							/>
						</div>
						<Button type="submit" disabled={create.isPending}>
							{t("tenant.create")}
						</Button>
					</form>
					{create.error ? (
						<p role="alert" className="mt-3 text-sm text-red-400">
							{create.error.message}
						</p>
					) : null}
					{query.isPending ? (
						<p role="status" className="mt-5 text-sm text-zinc-400">
							{t("tenant.loading")}
						</p>
					) : null}
					{query.error ? (
						<p role="alert" className="mt-5 text-sm text-red-400">
							{query.error.message}
						</p>
					) : null}
					{query.data?.organizations.map((org) => (
						<details
							key={org.id}
							className="mt-4 rounded-lg border border-zinc-800 px-4 py-3"
						>
							<summary className="cursor-pointer text-sm font-medium text-zinc-200">
								{org.name}{" "}
								<span className="ml-2 font-normal text-xs text-zinc-500">
									{org.slug}
									{org.active ? "" : ` · ${t("users.inactive")}`}
								</span>
							</summary>
							<div className="mt-4 flex flex-wrap items-center gap-4">
								<label
									htmlFor={`org-active-${org.id}`}
									className="flex items-center gap-2 text-sm"
								>
									<input
										id={`org-active-${org.id}`}
										type="checkbox"
										checked={org.active}
										disabled={toggle.isPending}
										onChange={(event) =>
											toggle.mutate({
												id: org.id,
												active: event.target.checked,
											})
										}
									/>
									{t("tenant.active")}
								</label>
								{session.data?.organizations?.some(
									(memberOrg) => memberOrg.id === org.id,
								) ? (
									<Button
										size="sm"
										variant="secondary"
										disabled={
											!org.active ||
											change.isPending ||
											session.data?.organizationId === org.id
										}
										onClick={() => change.mutate(org.id)}
									>
										{t("tenant.current")}
									</Button>
								) : null}
								{toggle.error ? (
									<p role="alert" className="text-sm text-red-400">
										{toggle.error.message}
									</p>
								) : null}
								{change.error ? (
									<p role="alert" className="mt-2 text-sm text-red-400">
										{change.error.message}
									</p>
								) : null}
							</div>
							<IpPolicy organizationId={org.id} owner initial={org} />
						</details>
					))}
					{query.data ? (
						<ViewAs
							organizations={query.data.organizations.filter(
								(org) => org.active,
							)}
						/>
					) : null}
				</>
			) : (
				<p className="mt-6 text-sm text-zinc-400">{t("tenant.ownerOnly")}</p>
			)}
		</section>
	);
}
