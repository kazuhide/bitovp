"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { useSession } from "@/lib/auth/use-session";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/context";

/**
 * Settings → Users . The temporary password renders
 * exactly once on the create/reset response — refreshing loses it (only the
 * hash is stored), the copy says so, and the mutation cache entry is dropped on
 * dismiss the way the token screen does it (a secret must not survive in the
 * query cache after the render clears).
 *
 * Page-level role gating is defence in depth: the /api/users routes are
 * ADMIN-gated at the proxy (the real control), and this client additionally
 * refuses to render the CRUD to a non-admin so a VIEWER who navigates here
 * directly sees a clear message, not empty 403'd panels (review-32 m4).
 */

type UserWire = {
	id: string;
	email: string;
	displayName: string;
	role: "ADMIN" | "OPERATOR" | "VIEWER";
	active: boolean;
	mustChangePassword: boolean;
	lastLoginAt: string | null;
	createdAt: string;
};

const ROLES = ["VIEWER", "OPERATOR", "ADMIN"] as const;

export function UsersClient() {
	const { t } = useT();
	const queryClient = useQueryClient();
	const emailId = useId();
	const nameId = useId();
	const roleId = useId();
	const [email, setEmail] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [role, setRole] = useState<(typeof ROLES)[number]>("OPERATOR");
	const [issued, setIssued] = useState<{
		email: string;
		temporaryPassword: string;
	} | null>(null);

	const session = useSession();
	const identity = session.status === "success" ? session.data : undefined;
	const users = useQuery({
		queryKey: ["users", identity?.organizationId],
		queryFn: () => apiFetch<{ users: UserWire[] }>("/api/users"),
		// A non-admin's fetch 403s; don't spin on it.
		enabled: identity?.role === "ADMIN" && !identity.isImpersonating,
	});

	const create = useMutation({
		mutationFn: () =>
			apiFetch<{ user: UserWire; temporaryPassword?: string }>("/api/users", {
				method: "POST",
				body: JSON.stringify({ email, displayName, role }),
			}),
		onSuccess: (created) => {
			setIssued(
				created.temporaryPassword
					? {
							email: created.user.email,
							temporaryPassword: created.temporaryPassword,
						}
					: null,
			);
			setEmail("");
			setDisplayName("");
			setRole("OPERATOR");
			queryClient.invalidateQueries({ queryKey: ["users"] });
		},
	});

	const patch = useMutation({
		mutationFn: (input: {
			id: string;
			body: { role?: string; active?: boolean; resetPassword?: true };
		}) =>
			input.body.resetPassword
				? apiFetch<{ user: UserWire; temporaryPassword?: string }>(
						`/api/platform/users/${input.id}`,
						{ method: "PATCH", body: JSON.stringify(input.body) },
					)
				: apiFetch<{ user: UserWire; temporaryPassword?: string }>(
						`/api/users/${input.id}`,
						{ method: "PATCH", body: JSON.stringify(input.body) },
					),
		onSuccess: (result) => {
			if (result.temporaryPassword) {
				setIssued({
					email: result.user.email,
					temporaryPassword: result.temporaryPassword,
				});
			}
			queryClient.invalidateQueries({ queryKey: ["users"] });
		},
	});

	const dismissSecret = () => {
		setIssued(null);
		// review-286 re-verify: BOTH are needed, and neither alone suffices.
		// reset clears each mutation OBSERVER's currentResult (where
		// create.data.temporaryPassword lives on the mounted component);
		// clear empties the mutation CACHE immediately instead of waiting
		// out query-core's 5-minute GC. clear alone left the secret on the
		// live observer (measured: cache=false, observer=true) — the exact
		// regression MINOR 11 was about. The token screen encodes the same
		// lesson (review-189b).
		create.reset();
		patch.reset();
		queryClient.getMutationCache().clear();
	};

	// review-286 MINOR 10: a neutral state while the session resolves — the
	// first cut fell through to the CRUD form when session.data was
	// undefined, so a VIEWER saw the admin screen for a beat before the gate
	// decided. Wait for the answer either way.
	if (!identity) {
		return (
			<section className="space-y-3">
				<div className="flex items-center gap-2">
					<h1 className="font-semibold text-xl text-zinc-50">
						{t("users.title")}
					</h1>
					<HelpOverlay labelFor={t("users.title")}>
						{t("users.intro")}
					</HelpOverlay>
				</div>
				{session.isError ? (
					<p role="alert" className="text-red-400 text-sm">
						{t("common.requestFailed")}{" "}
						<Button
							variant="secondary"
							size="sm"
							disabled={session.isFetching}
							onClick={() => session.refetch()}
						>
							{t("settingsForms.retry")}
						</Button>
					</p>
				) : (
					<p role="status">{t("common.loading")}</p>
				)}
			</section>
		);
	}
	// Page-level gate (defence in depth; the API is the real control).
	if (identity.role !== "ADMIN" || identity.isImpersonating) {
		return (
			<section className="max-w-2xl space-y-2">
				<h1 className="font-semibold text-xl text-zinc-50">
					{t("users.title")}
				</h1>
				<p role="alert" className="text-amber-400 text-sm">
					{t("common.accessAdminOnly")}
				</p>
			</section>
		);
	}

	return (
		<div className="space-y-8">
			<section className="space-y-2">
				<div className="flex items-center gap-2">
					<h1 className="font-semibold text-xl text-zinc-50">
						{t("users.title")}
					</h1>
					<HelpOverlay labelFor={t("users.title")}>
						{t("users.intro")}
					</HelpOverlay>
				</div>
			</section>

			{issued ? (
				<section
					role="alert"
					className="max-w-2xl space-y-2 rounded-md border border-emerald-700 bg-emerald-950/40 p-4"
				>
					<p className="font-medium text-emerald-300 text-sm">
						{t("users.createdOnce", { email: issued.email })}
					</p>
					<pre className="select-all overflow-x-auto rounded bg-zinc-900 p-2 font-mono text-sm text-zinc-100">
						{issued.temporaryPassword}
					</pre>
					<p className="text-xs text-zinc-400">{t("users.createdHint")}</p>
					<Button variant="secondary" size="sm" onClick={dismissSecret}>
						{t("users.dismissTempPassword")}
					</Button>
				</section>
			) : null}

			{identity.platformOwner ? (
				<section className="max-w-xl space-y-3">
					<h2 className="font-medium text-sm text-zinc-200">
						{t("users.createHeading")}
					</h2>
					<Field
						label={t("users.email")}
						htmlFor={emailId}
						help={t("users.emailHint")}
					>
						<Input
							id={emailId}
							type="email"
							value={email}
							placeholder="firstname.lastname@bitmovin.com"
							onChange={(e) => setEmail(e.target.value)}
						/>
					</Field>
					<Field label={t("users.displayName")} htmlFor={nameId}>
						<Input
							id={nameId}
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
						/>
					</Field>
					<Field label={t("users.role")} htmlFor={roleId}>
						<select
							id={roleId}
							value={role}
							onChange={(e) =>
								setRole(e.target.value as (typeof ROLES)[number])
							}
							className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
						>
							{ROLES.map((r) => (
								<option key={r} value={r}>
									{r}
								</option>
							))}
						</select>
					</Field>
					{create.isError ? (
						<p role="alert" className="text-red-400 text-sm">
							{create.error instanceof Error
								? create.error.message
								: t("users.createFailed")}
						</p>
					) : null}
					<Button
						onClick={() => create.mutate()}
						disabled={
							email.trim() === "" ||
							displayName.trim() === "" ||
							create.isPending
						}
					>
						{t("users.create")}
					</Button>
				</section>
			) : null}

			<section className="space-y-2">
				<h2 className="font-medium text-sm text-zinc-200">
					{t("users.listHeading")}
				</h2>
				{users.isLoading && <p role="status">{t("common.loading")}</p>}
				{users.isError ? (
					<p role="alert" className="text-red-400 text-sm">
						{t("users.listFailed")}{" "}
						<Button
							variant="secondary"
							size="sm"
							disabled={users.isFetching}
							onClick={() => users.refetch()}
						>
							{t("settingsForms.retry")}
						</Button>
					</p>
				) : null}
				{patch.isError ? (
					<p role="alert" className="text-red-400 text-sm">
						{patch.error instanceof Error
							? patch.error.message
							: t("users.actionFailed")}
					</p>
				) : null}
				{users.data?.users.length === 0 ? (
					<p className="text-sm text-zinc-500">{t("users.noneYet")}</p>
				) : null}
				<ul className="space-y-2">
					{users.data?.users.map((u) => {
						const isSelf = session.data?.email === u.email;
						return (
							<li
								key={u.id}
								className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 px-3 py-2 text-sm"
							>
								<span className="font-medium text-zinc-200">
									{u.displayName}
								</span>
								<span className="text-zinc-500">{u.email}</span>
								{isSelf ? <Badge tone="neutral">{t("users.you")}</Badge> : null}
								<Badge tone={u.role === "ADMIN" ? "error" : "neutral"}>
									{u.role}
								</Badge>
								<Badge tone={u.active ? "ok" : "error"}>
									{u.active ? t("users.active") : t("users.inactive")}
								</Badge>
								{u.mustChangePassword ? (
									<Badge tone="error">{t("users.mustChange")}</Badge>
								) : null}
								<span className="text-xs text-zinc-500">
									{t("users.lastLogin")}:{" "}
									{u.lastLoginAt
										? formatDateTime(u.lastLoginAt)
										: t("users.never")}
								</span>
								<span className="ml-auto flex flex-wrap gap-1">
									<select
										aria-label={t("users.changeRole")}
										value={u.role}
										disabled={patch.isPending}
										onChange={(e) =>
											patch.mutate({
												id: u.id,
												body: { role: e.target.value },
											})
										}
										className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100"
									>
										{ROLES.map((r) => (
											<option key={r} value={r}>
												{r}
											</option>
										))}
									</select>
									{isSelf ? (
										<Link
											href="/change-password"
											className="inline-flex h-8 items-center justify-center whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-900 px-3 font-medium text-xs text-zinc-200 transition-colors hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-emerald-500 focus-visible:outline-offset-2"
										>
											{t("users.changeOwnPassword")}
										</Link>
									) : identity.platformOwner ? (
										<Button
											variant="secondary"
											size="sm"
											disabled={patch.isPending}
											onClick={() => {
												if (window.confirm(t("users.resetConfirm"))) {
													patch.mutate({
														id: u.id,
														body: { resetPassword: true },
													});
												}
											}}
										>
											{t("users.resetPassword")}
										</Button>
									) : null}
									{/* Self-deactivate is refused by the API; hide it. */}
									{!isSelf ? (
										<Button
											variant="ghost"
											size="sm"
											disabled={patch.isPending}
											onClick={() =>
												patch.mutate({
													id: u.id,
													body: { active: !u.active },
												})
											}
										>
											{u.active ? t("users.deactivate") : t("users.reactivate")}
										</Button>
									) : null}
								</span>
							</li>
						);
					})}
				</ul>
			</section>
		</div>
	);
}
