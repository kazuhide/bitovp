"use client";

import { useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";

type FormValues = {
	currentPassword: string;
	newPassword: string;
	confirmPassword: string;
};

export function RotateForm() {
	const { t } = useT();
	const form = useForm<FormValues>({
		defaultValues: {
			currentPassword: "",
			newPassword: "",
			confirmPassword: "",
		},
	});
	const submit = useMutation({
		mutationFn: (values: FormValues) =>
			apiFetch<{ ok: true }>("/api/account/password", {
				method: "POST",
				body: JSON.stringify({
					currentPassword: values.currentPassword,
					newPassword: values.newPassword,
				}),
			}),
		onSuccess: () => {
			// The response reissued the session cookie (the sessionsValidFrom
			// bump killed the old one); full load re-renders authenticated.
			window.location.assign("/");
		},
	});
	const error =
		submit.error instanceof ApiError
			? submit.error.message
			: submit.error
				? t("rotate.failed")
				: undefined;

	return (
		<div className="w-full max-w-sm rounded-lg border border-zinc-800 bg-zinc-900/40 p-6">
			<div className="flex items-center gap-2">
				<span aria-hidden className="text-emerald-400">
					●
				</span>
				<h1 className="font-semibold text-sm text-zinc-50">
					{t("rotate.title")}
				</h1>
			</div>
			<p className="mt-3 text-sm text-zinc-400">{t("rotate.subtitle")}</p>
			<form
				className="mt-5 space-y-4"
				onSubmit={form.handleSubmit((values) => submit.mutate(values))}
				noValidate
			>
				<Field
					label={t("rotate.currentLabel")}
					htmlFor="rotate-current"
					error={error ?? form.formState.errors.currentPassword?.message}
				>
					<Input
						id="rotate-current"
						type="password"
						autoComplete="current-password"
						{...form.register("currentPassword", {
							required: t("rotate.currentRequired"),
						})}
					/>
				</Field>
				<Field
					label={t("rotate.newLabel")}
					htmlFor="rotate-new"
					error={form.formState.errors.newPassword?.message}
				>
					<Input
						id="rotate-new"
						type="password"
						autoComplete="new-password"
						{...form.register("newPassword", {
							required: t("rotate.newRequired"),
							minLength: { value: 12, message: t("rotate.newTooShort") },
						})}
					/>
				</Field>
				<Field
					label={t("rotate.confirmLabel")}
					htmlFor="rotate-confirm"
					error={form.formState.errors.confirmPassword?.message}
				>
					<Input
						id="rotate-confirm"
						type="password"
						autoComplete="new-password"
						{...form.register("confirmPassword", {
							validate: (value, values) =>
								value === values.newPassword || t("rotate.confirmMismatch"),
						})}
					/>
				</Field>
				<Button type="submit" className="w-full" disabled={submit.isPending}>
					{submit.isPending ? t("rotate.submitting") : t("rotate.submit")}
				</Button>
			</form>
		</div>
	);
}
