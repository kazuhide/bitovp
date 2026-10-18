"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";

/* Save a job or channel plan as a named FULL_PLAN or LIVE_PLAN template. The route validates that its wizard can open it. Name conflicts retain the 409 response; duplication remains a separate recovery action. */
export function SaveAsTemplateButton({
	kind,
	plan,
	defaultName,
}: {
	kind: "FULL_PLAN" | "LIVE_PLAN";
	plan: unknown;
	defaultName: string;
}) {
	const { t } = useT();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState(defaultName);
	const [savedAs, setSavedAs] = useState<string | null>(null);

	const save = useMutation({
		mutationFn: () =>
			apiFetch<{ id: string; name: string }>("/api/presets", {
				method: "POST",
				body: JSON.stringify(
					kind === "LIVE_PLAN" ? { kind, name, plan } : { name, plan },
				),
			}),
		onSuccess: (created) => {
			setSavedAs(created.name);
			setOpen(false);
		},
	});

	return (
		<>
			<Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
				{t("templates.saveAsTemplate")}
			</Button>
			{savedAs ? (
				<span role="status" className="text-emerald-400 text-xs">
					{t("templates.templateSaved", { name: savedAs })}
				</span>
			) : null}
			<Dialog
				open={open}
				onOpenChange={setOpen}
				title={t("templates.saveAsTemplate")}
			>
				<div className="space-y-4">
					<Field
						htmlFor="save-template-name"
						label={t("templates.templateName")}
					>
						<Input
							id="save-template-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
					</Field>
					{save.isError ? (
						<p className="text-rose-400 text-xs">
							{t("templates.saveTemplateFailed", {
								error:
									save.error instanceof ApiError
										? save.error.message
										: String(save.error),
							})}
						</p>
					) : null}
					<div className="flex justify-end">
						<Button
							disabled={save.isPending || name.trim() === ""}
							onClick={() => save.mutate()}
						>
							{save.isPending
								? t("templates.creating")
								: t("templates.saveAsTemplate")}
						</Button>
					</div>
				</div>
			</Dialog>
		</>
	);
}
