"use client";
import {
	BRAND_ICON_MAX_BYTES,
	type BrandingSettings,
	brandingSettingsSchema,
	DEFAULT_BRANDING_SETTINGS,
	inspectBrandIcon,
} from "@bitovp/core";
import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { BrandIcon } from "@/components/app-brand";
import { useBranding } from "@/components/branding-provider";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";

async function readIcon(file: File): Promise<string> {
	if (
		file.size > BRAND_ICON_MAX_BYTES ||
		!["image/png", "image/jpeg", "image/webp"].includes(file.type)
	)
		throw new Error("invalid icon");
	const value = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () =>
			typeof reader.result === "string"
				? resolve(reader.result)
				: reject(new Error("invalid icon"));
		reader.onerror = () => reject(new Error("invalid icon"));
		reader.readAsDataURL(file);
	});
	const inspected = inspectBrandIcon(value);
	if (!inspected) throw new Error("invalid icon");
	await new Promise<void>((resolve, reject) => {
		const image = new Image();
		image.onload = () =>
			image.naturalWidth === inspected.width &&
			image.naturalHeight === inspected.height
				? resolve()
				: reject(new Error("invalid icon"));
		image.onerror = () => reject(new Error("invalid icon"));
		image.src = value;
	});
	return value;
}

export function BrandingClient() {
	const branding = useBranding();
	return <BrandingForm key={branding?.organization} />;
}
function BrandingForm() {
	const { t } = useT();
	const branding = useBranding();
	const canEdit = useMutationAccess("settings.branding");
	const [draft, setDraft] = useState<BrandingSettings | null>(null);
	const [iconError, setIconError] = useState(false);
	const [reading, setReading] = useState(false);
	const selection = useRef(0);
	const value = draft ?? branding?.value ?? DEFAULT_BRANDING_SETTINGS;
	const save = useMutation({
		mutationFn: async (next: BrandingSettings) =>
			brandingSettingsSchema.parse(
				await apiFetch("/api/settings/branding", {
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(next),
				}),
			),
		onSuccess: async (next) => {
			await branding?.saved(next);
			setDraft(null);
		},
	});
	const busy = reading || save.isPending;
	return (
		<section>
			<h1 className="font-semibold text-xl text-zinc-50">
				{t("branding.title")}
			</h1>
			<p className="mt-2 max-w-xl text-sm text-zinc-400">
				{t("branding.scope")}
			</p>
			{!branding || branding.pending ? (
				<p className="mt-6 text-sm text-zinc-500">{t("common.loading")}</p>
			) : branding.error ? (
				<div role="alert" className="mt-6 text-sm text-amber-400">
					{t("branding.loadFailed")}{" "}
					<Button variant="secondary" size="sm" onClick={branding.retry}>
						{t("settingsForms.retry")}
					</Button>
				</div>
			) : (
				<>
					<fieldset
						className="mt-6 flex max-w-xl items-center gap-2 rounded-md border border-zinc-800 p-4"
						aria-label={t("branding.preview")}
					>
						<BrandIcon iconDataUrl={value.iconDataUrl} />
						<span className="min-w-0 break-all font-semibold text-sm text-zinc-50">
							{value.displayName}
						</span>
					</fieldset>
					{canEdit ? (
						<form
							className="mt-6 max-w-xl space-y-4"
							onSubmit={(event) => {
								event.preventDefault();
								const parsed = brandingSettingsSchema.safeParse(value);
								if (parsed.success) save.mutate(parsed.data);
							}}
						>
							<Field
								label={t("branding.name")}
								htmlFor="branding-name"
								hint={t("branding.nameHint")}
							>
								<Input
									id="branding-name"
									value={value.displayName}
									disabled={busy}
									onChange={(event) =>
										setDraft({ ...value, displayName: event.target.value })
									}
								/>
							</Field>
							<Field
								label={t("branding.icon")}
								htmlFor="branding-icon"
								hint={t("branding.iconHint")}
							>
								<Input
									id="branding-icon"
									type="file"
									accept="image/png,image/jpeg,image/webp"
									disabled={busy}
									onChange={async (event) => {
										const file = event.target.files?.[0];
										event.target.value = "";
										if (!file) return;
										const current = ++selection.current;
										setReading(true);
										setIconError(false);
										try {
											const iconDataUrl = await readIcon(file);
											if (selection.current === current)
												setDraft({ ...value, iconDataUrl });
										} catch {
											if (selection.current === current) setIconError(true);
										} finally {
											if (selection.current === current) setReading(false);
										}
									}}
								/>
							</Field>
							{reading ? (
								<p role="status" className="text-sm text-zinc-400">
									{t("common.loading")}
								</p>
							) : null}
							{iconError ? (
								<p role="alert" className="text-sm text-red-400">
									{t("branding.iconInvalid")}
								</p>
							) : null}
							{!brandingSettingsSchema.shape.displayName.safeParse(
								value.displayName,
							).success ? (
								<p role="alert" className="text-sm text-red-400">
									{t("branding.nameHint")}
								</p>
							) : null}
							<div className="flex flex-wrap gap-2">
								<Button
									type="button"
									variant="secondary"
									disabled={busy || !value.iconDataUrl}
									onClick={() => {
										setDraft({ ...value, iconDataUrl: null });
										setIconError(false);
									}}
								>
									{t("branding.removeIcon")}
								</Button>
								<Button
									type="button"
									variant="secondary"
									disabled={busy}
									onClick={() => {
										setDraft({ ...DEFAULT_BRANDING_SETTINGS });
										setIconError(false);
									}}
								>
									{t("branding.reset")}
								</Button>
							</div>
							{save.error ? (
								<p role="alert" className="text-sm text-red-400">
									{t("branding.saveFailed")}
								</p>
							) : null}
							{save.isSuccess && draft === null ? (
								<p role="status" className="text-sm text-emerald-400">
									{t("branding.saved")}
								</p>
							) : null}
							<Button
								type="submit"
								disabled={
									busy ||
									draft === null ||
									!brandingSettingsSchema.safeParse(value).success
								}
							>
								{save.isPending ? t("common.saving") : t("common.save")}
							</Button>
						</form>
					) : (
						<p className="mt-4 text-sm text-zinc-400">
							{t("branding.readOnly")}
						</p>
					)}
				</>
			)}
		</section>
	);
}
