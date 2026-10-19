"use client";

import {
	type EncodingPlan,
	encodingPlanSchema,
	instantiateTemplatePlan,
	type PresetLaunchDefaults,
	renderTemplateOutputPrefix,
	type TemplateSourceParam,
	templateSourceSites,
} from "@bitovp/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { StoragePicker } from "@/components/storage-picker";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import { useCreationSubmission } from "@/lib/creation-submission-hook";
import { localizedCustomerError } from "@/lib/customer-error";
import { useT } from "@/lib/i18n/context";
import {
	BROWSABLE_STORAGE_PROVIDERS,
	storageKindForProvider,
} from "../vod/new/stream-model";

type PresetDetail = {
	id: string;
	name: string;
	body: unknown;
	launchDefaults: PresetLaunchDefaults | null;
	revision: number;
};

const DEFAULT_PREFIX_TEMPLATE = "{template}/{date}-{uuid}";
const DEFAULT_NAME_TEMPLATE = "{template} {date}";

/**
 * The §4.1 minimal launch form : sources (the ask-list DERIVED
 * from the plan — one row per path-bearing site, prefilled with the
 * template's own path so a zero-edit re-run is one click), output prefix
 * (token template, shown rendered), name. Everything else is the template's;
 * the escape hatch opens the full wizard via the existing `?userPreset=`.
 */
export function LaunchDialog({
	presetId,
	onClose,
}: {
	presetId: string | null;
	onClose: () => void;
}) {
	const { t } = useT();
	const router = useRouter();
	const [overrides, setOverrides] = useState<
		Record<string, TemplateSourceParam>
	>({});
	const [prefixTemplate, setPrefixTemplate] = useState(DEFAULT_PREFIX_TEMPLATE);
	const [name, setName] = useState("");
	const [pickingSite, setPickingSite] = useState<string | null>(null);
	const [issues, setIssues] = useState<string[]>([]);
	const [seededFor, setSeededFor] = useState<string | null>(null);

	const detail = useQuery({
		queryKey: ["template-launch", presetId],
		enabled: presetId !== null,
		queryFn: () => apiFetch<PresetDetail>(`/api/presets/${presetId}`),
	});
	const creation = useCreationSubmission(
		"vod",
		`template:${presetId}:${detail.data?.revision ?? "loading"}`,
		presetId !== null && detail.data?.id === presetId,
	);

	const plan: EncodingPlan | null = useMemo(() => {
		if (!detail.data) {
			return null;
		}
		const parsed = encodingPlanSchema.safeParse(detail.data.body);
		return parsed.success ? parsed.data : null;
	}, [detail.data]);

	const sites = useMemo(() => (plan ? templateSourceSites(plan) : []), [plan]);

	// Seed the form ONCE per opened template, after the async load lands —
	// state initializers cannot see it (the dialog mounts before the fetch).
	useEffect(() => {
		if (
			!detail.data ||
			!creation.seed ||
			`${detail.data.id}:${creation.seed.nonce}` === seededFor
		) {
			return;
		}
		setSeededFor(`${detail.data.id}:${creation.seed.nonce}`);
		setOverrides({});
		setIssues([]);
		setPrefixTemplate(
			detail.data.launchDefaults?.outputPrefixTemplate ??
				DEFAULT_PREFIX_TEMPLATE,
		);
		setName(
			renderTemplateOutputPrefix(
				// Name tokens ride the path renderer: no slashes in a name
				// template means the slash-collapse is a no-op.
				detail.data.launchDefaults?.nameTemplate ?? DEFAULT_NAME_TEMPLATE,
				{
					objectKey: "",
					templateName: detail.data.name,
					now: new Date(creation.seed.createdAt),
					uuid: creation.seed.nonce,
				},
			),
		);
	}, [detail.data, seededFor, creation.seed]);

	// Preview mirrors the instantiation's own semantics: tokens read the
	// FIRST site's effective path.
	const preview = useMemo(() => {
		const first = sites[0];
		const effective = first
			? (overrides[first.siteId]?.objectKey ?? first.currentPath)
			: "";
		return renderTemplateOutputPrefix(prefixTemplate, {
			objectKey: effective,
			templateName: detail.data?.name ?? "",
			now: new Date(creation.seed?.createdAt ?? Date.now()),
			uuid: "xxxxxxxx",
		});
	}, [sites, overrides, prefixTemplate, detail.data?.name, creation.seed]);
	const launch = useMutation({
		mutationFn: async () => {
			if (!detail.data || !creation.seed) {
				throw new Error("not loaded");
			}
			const result = instantiateTemplatePlan({
				presetBody: detail.data.body,
				sources: overrides,
				outputPrefixTemplate: prefixTemplate,
				name,
				templateName: detail.data.name,
				now: new Date(0),
				uuid: "xxxxxxxx",
			});
			if (!result.ok) {
				setIssues(result.issues.map((i) => i.message));
				return null;
			}
			setIssues([]);
			const sources = Object.fromEntries(
				templateSourceSites(result.plan).map((site) => {
					const input = result.plan.inputs.find(
						(entry) => entry.key === site.inputKey,
					);
					return [
						site.siteId,
						{
							objectKey: site.currentPath,
							...(input && "bucket" in input && "credentialId" in input
								? { bucket: input.bucket, credentialId: input.credentialId }
								: {}),
						},
					];
				}),
			);
			const intent = {
				presetBody: detail.data.body,
				sources,
				outputPrefixTemplate: prefixTemplate,
				name,
				templateName: detail.data.name,
				presetId: detail.data.id,
				presetRevision: detail.data.revision,
				renderedAt: creation.seed.createdAt,
			};
			return creation.submit<{ id: string }>(intent, (seed, snapshot) => {
				const frozen = snapshot as typeof intent;
				const rendered = instantiateTemplatePlan({
					...frozen,
					now: new Date(frozen.renderedAt),
					uuid: seed.nonce,
				});
				if (!rendered.ok)
					throw new Error("Template parameters changed before submission");
				return {
					plan: rendered.plan,
					presetId: frozen.presetId,
					presetRevision: frozen.presetRevision,
				};
			});
		},
		onSuccess: (created) => {
			if (created) {
				onClose();
				router.push(`/vod/jobs/${created.id}`);
			}
		},
	});

	const pickerSeedCredential = useMemo(() => {
		if (pickingSite === null || !plan) {
			return undefined;
		}
		const site = sites.find((s) => s.siteId === pickingSite);
		const input = plan.inputs.find((i) => i.key === site?.inputKey);
		return input && "credentialId" in input ? input.credentialId : undefined;
	}, [pickingSite, plan, sites]);

	// review-109pr1 P1: the picker offers ONLY providers whose storage kind
	// matches the site's input — a cross-provider pick used to parse clean as
	// the template's own kind and reach Bitmovin with blank credentials (the
	// review-223 F4 class; the worker now also guards, defense in depth).
	const inputKindOf = (siteInputKey: string | undefined) =>
		plan?.inputs.find((i) => i.key === siteInputKey)?.kind;
	const providersForSite = (siteInputKey: string | undefined) =>
		BROWSABLE_STORAGE_PROVIDERS.filter(
			(prov) => storageKindForProvider(prov) === inputKindOf(siteInputKey),
		);
	const pickerProviders =
		pickingSite !== null
			? providersForSite(sites.find((s) => s.siteId === pickingSite)?.inputKey)
			: [];
	const launchFailure = launch.error ?? creation.seedError;
	const launchFailureKey =
		(
			[
				"creationSubmission.sessionUnavailable",
				"creationSubmission.storageUnavailable",
				"creationSubmission.pendingLimit",
				"creationSubmission.responseUnavailable",
			] as const
		).find(
			(key) =>
				launchFailure instanceof ApiError && launchFailure.message === t(key),
		) ?? "ui.createFailed";

	return (
		<Dialog
			open={presetId !== null}
			onOpenChange={(open) => {
				if (!open) {
					setSeededFor(null);
					onClose();
				}
			}}
			title={t("templates.launchTitle", { name: detail.data?.name ?? "…" })}
			wide
		>
			{detail.isPending ? (
				<p className="text-xs text-zinc-500">{t("templates.loading")}</p>
			) : !plan ? (
				<p className="text-rose-400 text-sm">{t("templates.notAPlan")}</p>
			) : (
				<div className="space-y-4">
					<section className="space-y-2">
						<h3 className="font-medium text-xs text-zinc-300 uppercase tracking-wide">
							{t("templates.sources")}
						</h3>
						{sites.map((site) => {
							const override = overrides[site.siteId];
							return (
								<div
									key={site.siteId}
									className="rounded-md border border-zinc-800 bg-zinc-950 p-2"
								>
									{/* Field.trailing, NOT an end-aligned sibling — the hint
									    makes the Field taller and the button drifts (the exact
									    #101 misalignment; the field-drift scan flagged this
									    file's first cut). */}
									<Field
										htmlFor={`tpl-src-${site.siteId}`}
										label={site.siteId}
										hint={
											override
												? t("templates.sourceMoved")
												: t("templates.sourceOriginal")
										}
										trailing={
											providersForSite(site.inputKey).length > 0 ? (
												<Button
													size="sm"
													variant="secondary"
													onClick={() => setPickingSite(site.siteId)}
												>
													{t("templates.browse")}
												</Button>
											) : undefined
										}
									>
										<Input
											id={`tpl-src-${site.siteId}`}
											value={override?.objectKey ?? site.currentPath}
											onChange={(e) =>
												setOverrides((prev) => ({
													...prev,
													[site.siteId]: {
														...prev[site.siteId],
														objectKey: e.target.value,
													},
												}))
											}
										/>
									</Field>
								</div>
							);
						})}
						{sites.length === 0 ? (
							<p className="text-xs text-zinc-500">
								{t("templates.noSources")}
							</p>
						) : null}
					</section>

					<Field
						htmlFor="tpl-output-prefix"
						label={t("templates.outputPrefix")}
						hint={t("templates.outputPrefixPreview", { preview })}
					>
						<Input
							id="tpl-output-prefix"
							value={prefixTemplate}
							onChange={(e) => setPrefixTemplate(e.target.value)}
						/>
					</Field>

					<Field htmlFor="tpl-job-name" label={t("templates.jobName")}>
						<Input
							id="tpl-job-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
					</Field>

					{issues.length > 0 ? (
						<ul className="space-y-1 text-rose-400 text-xs">
							{issues.map((msg) => (
								<li key={msg}>{msg}</li>
							))}
						</ul>
					) : null}
					{launch.isError || creation.seedError ? (
						<p className="text-rose-400 text-xs">
							{localizedCustomerError(t, launchFailure, launchFailureKey)}
						</p>
					) : null}

					<div className="flex items-center justify-between gap-2 pt-2">
						<a
							href={`/vod/new?userPreset=${encodeURIComponent(detail.data?.id ?? "")}`}
							className="text-xs text-zinc-400 underline-offset-2 hover:underline"
						>
							{t("templates.editInWizard")}
						</a>
						<Button
							disabled={
								launch.isPending || name.trim() === "" || !creation.seed
							}
							onClick={() => launch.mutate()}
						>
							{launch.isPending
								? t("templates.creating")
								: t("templates.create")}
						</Button>
					</div>
				</div>
			)}
			<StoragePicker
				open={pickingSite !== null}
				mode="object"
				providers={pickerProviders}
				initialCredentialId={pickerSeedCredential}
				onClose={() => setPickingSite(null)}
				onSelect={({ credentialId, bucket, path }) => {
					if (pickingSite !== null) {
						setOverrides((prev) => ({
							...prev,
							[pickingSite]: { objectKey: path, bucket, credentialId },
						}));
					}
					setPickingSite(null);
				}}
			/>
		</Dialog>
	);
}
