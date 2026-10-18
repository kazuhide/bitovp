"use client";

import { useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";

type FormValues = {
	code: string;
	email: string;
	displayName: string;
	password: string;
};

/** First-boot admin creation (#32 §3c) — renders outside the app shell. */
export function SetupForm() {
	const { t } = useT();
	const form = useForm<FormValues>({
		defaultValues: { code: "", email: "", displayName: "", password: "" },
	});
	const submit = useMutation({
		mutationFn: (values: FormValues) =>
			apiFetch<{ ok: true }>("/api/auth/setup", {
				method: "POST",
				body: JSON.stringify(values),
			}),
		onSuccess: () => {
			// The response set the admin session cookie; full load so every
			// server component re-renders authenticated.
			window.location.assign("/");
		},
	});
	const error =
		submit.error instanceof ApiError
			? submit.error.message
			: submit.error
				? t("setup.failed")
				: undefined;

	return (
		<div className="w-full max-w-sm rounded-lg border border-zinc-800 bg-zinc-900/40 p-6">
			<div className="flex items-center gap-2">
				<span aria-hidden className="text-emerald-400">
					●
				</span>
				<h1 className="font-semibold text-sm text-zinc-50">
					{t("setup.title")}
				</h1>
			</div>
			<p className="mt-3 text-sm text-zinc-400">{t("setup.subtitle")}</p>
			<form
				className="mt-5 space-y-4"
				onSubmit={form.handleSubmit((values) => submit.mutate(values))}
				noValidate
			>
				<Field
					label={t("setup.codeLabel")}
					htmlFor="setup-code"
					error={error ?? form.formState.errors.code?.message}
				>
					<Input
						id="setup-code"
						autoComplete="one-time-code"
						{...form.register("code", { required: t("setup.codeRequired") })}
					/>
					<p className="mt-1 text-xs text-zinc-500">{t("setup.codeHint")}</p>
				</Field>
				<Field
					label={t("setup.emailLabel")}
					htmlFor="setup-email"
					error={form.formState.errors.email?.message}
				>
					<Input
						id="setup-email"
						type="email"
						autoComplete="username"
						{...form.register("email", { required: t("setup.emailRequired") })}
					/>
				</Field>
				<Field
					label={t("setup.displayNameLabel")}
					htmlFor="setup-display-name"
					error={form.formState.errors.displayName?.message}
				>
					<Input
						id="setup-display-name"
						{...form.register("displayName", {
							required: t("setup.displayNameRequired"),
						})}
					/>
				</Field>
				<Field
					label={t("setup.passwordLabel")}
					htmlFor="setup-password"
					error={form.formState.errors.password?.message}
				>
					<Input
						id="setup-password"
						type="password"
						autoComplete="new-password"
						{...form.register("password", {
							required: t("setup.passwordRequired"),
							minLength: { value: 12, message: t("setup.passwordTooShort") },
						})}
					/>
				</Field>
				<Button type="submit" className="w-full" disabled={submit.isPending}>
					{submit.isPending ? t("setup.submitting") : t("setup.submit")}
				</Button>
			</form>
		</div>
	);
}
