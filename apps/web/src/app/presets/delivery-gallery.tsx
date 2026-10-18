"use client";

import type { DeliverySpec, Deviation } from "@bitovp/core";
import { exportDeliveryPreset, importDeliveryPreset } from "@bitovp/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useQcVmafEnabled } from "@/lib/feature-flags/context";
import { useT } from "@/lib/i18n/context";

/**
 * Delivery-spec gallery : the code-shipped specs rendered with
 * their machine-readable requirements table — the SAME rows the conformance
 * checker evaluates, so what the operator reads and what fires cannot drift.
 * Export downloads the org-authorable .bitovp-preset.json; Import runs the
 * strict parser + self-conformance and saves a Preset row (category + spec
 * beside the bare plan body).
 */
export function DeliveryGallery({ specs }: { specs: DeliverySpec[] }) {
	const { t } = useT();
	const canOperate = useMutationAccess("presets.delivery");
	const qcVmafEnabled = useQcVmafEnabled();
	const queryClient = useQueryClient();
	const fileInput = useRef<HTMLInputElement>(null);
	const [importError, setImportError] = useState<string | null>(null);
	const [importedDeviations, setImportedDeviations] = useState<
		Deviation[] | null
	>(null);

	const save = useMutation({
		mutationFn: async (spec: DeliverySpec) =>
			apiFetch<{ id: string }>("/api/presets", {
				method: "POST",
				body: JSON.stringify({
					name: spec.name,
					description: spec.description,
					plan: spec.plan,
					category: spec.category,
					spec: {
						constraints: spec.constraints,
						...(spec.suggestedGate
							? { suggestedGate: spec.suggestedGate }
							: {}),
						...(spec.sources ? { sources: spec.sources } : {}),
					},
				}),
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["presets"] });
		},
	});

	const onImportFile = async (file: File) => {
		setImportError(null);
		setImportedDeviations(null);
		// review-205 I3: this is called as `void onImportFile(file)` — a
		// throw anywhere (file read, a shape the import misses) became an
		// unhandled rejection: no message, no save, no feedback. The one
		// thing an import surface must never do is nothing, silently.
		try {
			const result = importDeliveryPreset(await file.text());
			if (!result.ok) {
				setImportError(result.error);
				return;
			}
			// Self-deviations are SHOWN, never silently accepted — the import
			// still saves (an org may ship a spec its example under-fills).
			setImportedDeviations(result.selfDeviations);
			save.mutate(result.spec);
		} catch (err) {
			setImportError(err instanceof Error ? err.message : String(err));
		}
	};

	const download = (spec: DeliverySpec) => {
		const blob = new Blob([exportDeliveryPreset(spec)], {
			type: "application/json",
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `${spec.id}.bitovp-preset.json`;
		a.click();
		URL.revokeObjectURL(url);
	};

	return (
		<section className="space-y-4">
			<header className="space-y-2">
				<div className="flex flex-wrap items-center gap-3">
					<div className="flex items-center gap-2">
						<h2 className="font-semibold text-lg text-zinc-50">
							{t("delivery.galleryTitle")}
						</h2>
						<HelpOverlay labelFor={t("delivery.galleryTitle")}>
							{t("delivery.galleryIntro")}
						</HelpOverlay>
					</div>
					<Badge tone="ok">{specs.length}</Badge>
					{canOperate ? (
						<>
							<Button
								variant="secondary"
								size="sm"
								onClick={() => fileInput.current?.click()}
								disabled={save.isPending}
							>
								{save.isPending
									? t("delivery.importing")
									: t("delivery.importButton")}
							</Button>
							<input
								ref={fileInput}
								type="file"
								accept=".json,application/json"
								className="hidden"
								aria-label={t("delivery.importButton")}
								onChange={(e) => {
									const file = e.target.files?.[0];
									if (file) {
										void onImportFile(file);
									}
									e.target.value = "";
								}}
							/>
						</>
					) : null}
				</div>

				{importError ? (
					<p role="alert" className="text-red-400 text-sm">
						{t("delivery.importFailed", { error: importError })}
					</p>
				) : null}
				{save.isError ? (
					<p role="alert" className="text-red-400 text-sm">
						{t("delivery.importFailed", {
							error:
								save.error instanceof Error
									? save.error.message
									: String(save.error),
						})}
					</p>
				) : null}
				{importedDeviations && importedDeviations.length > 0 ? (
					<p className="text-amber-300 text-sm">
						{t("delivery.importSelfDeviations", {
							count: importedDeviations.length,
						})}
					</p>
				) : null}
			</header>
			<ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
				{specs.map((spec) => (
					<li
						key={spec.id}
						className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-950 p-4"
					>
						<div className="flex items-start justify-between gap-2">
							<h3 className="font-medium text-sm text-zinc-100">{spec.name}</h3>
							<Badge>{spec.category}</Badge>
						</div>
						<p className="text-xs text-zinc-400">{spec.description}</p>
						<div className="overflow-x-auto rounded-md border border-zinc-800/70">
							<table className="w-full text-left text-xs">
								<thead>
									<tr className="text-zinc-500">
										<th className="px-2 py-1 font-medium">
											{t("delivery.requirementCol")}
										</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-zinc-800/50">
									{/* Keyed requirement+path: two rows on one path (a range
									    written as two sentences) must not collide (N5). */}
									{spec.constraints.map((constraint) => (
										<tr key={`${constraint.requirement}-${constraint.path}`}>
											<td className="px-2 py-1 text-zinc-300">
												<span className="mr-1 text-emerald-500">✓</span>
												{constraint.requirement}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						{/*  (review-265 131-A9): no QC recommendation on a
						    deployment where QC does not exist. */}
						{qcVmafEnabled && spec.suggestedGate ? (
							<p className="text-xs text-zinc-500">
								{t("delivery.suggestedGateLine", {
									metric: spec.suggestedGate.rules[0]?.metric ?? "",
									gte: spec.suggestedGate.rules[0]?.gte ?? 0,
								})}
							</p>
						) : null}
						<div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
							<Button variant="ghost" size="sm" onClick={() => download(spec)}>
								{t("delivery.exportButton")}
							</Button>
							{canOperate ? (
								<Link
									href={`/vod/new?deliveryPreset=${encodeURIComponent(spec.id)}`}
									className="inline-flex h-8 shrink-0 items-center rounded-md bg-emerald-600 px-3 font-medium text-white text-xs transition-colors hover:bg-emerald-500 focus-visible:outline-2 focus-visible:outline-emerald-500 focus-visible:outline-offset-2"
								>
									{t("ui.loadInWizard")}
								</Link>
							) : null}
						</div>
					</li>
				))}
			</ul>
		</section>
	);
}
