"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { safeNextPath } from "@/lib/auth/gate";
import { fetchSession, SESSION_QUERY_KEY } from "@/lib/auth/use-session";
import { localizedCustomerError } from "@/lib/customer-error";
import { useT } from "@/lib/i18n/context";

type FormValues = { email: string; password: string };

export function LoginForm() {
	const { t } = useT();
	const searchParams = useSearchParams();
	// The proxy already validated `next` when it built this URL; re-validating
	// covers a hand-crafted /login?next=//evil.example that never went through it.
	const next = safeNextPath(searchParams.get("next")) ?? "/";
	const session = useQuery({
		queryKey: SESSION_QUERY_KEY,
		queryFn: fetchSession,
	});
	const usersMode = session.data?.mode === "users";
	const form = useForm<FormValues>({
		defaultValues: { email: "", password: "" },
	});
	const signIn = useMutation({
		mutationFn: (values: FormValues) =>
			apiFetch<{ ok: true; mustChangePassword?: boolean }>("/api/auth/login", {
				method: "POST",
				body: JSON.stringify(
					usersMode
						? values
						: // password mode's route schema tolerates email, but sending
							// an empty string would fail its min-length — omit it.
							{ password: values.password },
				),
			}),
		onSuccess: (data) => {
			// Full load, not router.push: every server component on the target
			// page has to be re-rendered by an authenticated request. A forced
			// rotate goes to the rotate screen — the gate would bounce every
			// other path there anyway (#32 §3c).
			window.location.assign(
				data.mustChangePassword ? "/change-password" : next,
			);
		},
	});

	if (session.data && !session.data.configured) {
		return (
			<Panel title={t("login.notConfiguredTitle")}>
				<p className="text-sm text-zinc-400">{t("login.notConfiguredBody")}</p>
				<p role="alert" className="mt-4 text-amber-300 text-sm">
					{session.data.reasonCode === "AUTH_PROVIDER_UNAVAILABLE"
						? t("customerError.authProviderUnavailable")
						: t("customerError.authNotConfigured")}
				</p>
			</Panel>
		);
	}

	if (session.data?.mode === "none") {
		return (
			<Panel title={t("login.disabledTitle")}>
				<p className="text-sm text-zinc-400">{t("login.disabledBody")}</p>
				<a
					href="/"
					className="mt-4 inline-block text-emerald-400 text-sm hover:underline"
				>
					{t("login.continueToConsole")}
				</a>
			</Panel>
		);
	}

	const error = signIn.error
		? localizedCustomerError(t, signIn.error, "login.failed")
		: undefined;

	return (
		<Panel title={t("login.title")}>
			<p className="text-sm text-zinc-400">
				{t(usersMode ? "login.usersSubtitle" : "login.subtitle")}
			</p>
			<form
				className="mt-5 space-y-4"
				onSubmit={form.handleSubmit((values) => signIn.mutate(values))}
				noValidate
			>
				{usersMode ? (
					<Field
						label={t("login.emailLabel")}
						htmlFor="email"
						error={form.formState.errors.email?.message}
					>
						<Input
							id="email"
							type="email"
							autoComplete="username"
							{...form.register("email", {
								required: t("login.emailRequired"),
							})}
						/>
					</Field>
				) : null}
				<Field
					label={t(
						usersMode ? "login.userPasswordLabel" : "login.passwordLabel",
					)}
					htmlFor="password"
					error={error ?? form.formState.errors.password?.message}
				>
					<Input
						id="password"
						type="password"
						autoComplete="current-password"
						aria-invalid={error ? true : undefined}
						{...form.register("password", {
							required: t("login.passwordRequired"),
						})}
					/>
				</Field>
				<Button type="submit" className="w-full" disabled={signIn.isPending}>
					{signIn.isPending ? t("login.submitting") : t("login.submit")}
				</Button>
			</form>
		</Panel>
	);
}

function Panel({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<div className="w-full max-w-sm rounded-lg border border-zinc-800 bg-zinc-900/40 p-6">
			<div className="flex items-center gap-2">
				<span aria-hidden className="text-emerald-400">
					●
				</span>
				<h1 className="font-semibold text-sm text-zinc-50">{title}</h1>
			</div>
			<div className="mt-4">{children}</div>
		</div>
	);
}
