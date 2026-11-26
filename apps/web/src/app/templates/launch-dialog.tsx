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
import {
	useWithheldSourceInputs,
	WithheldSourceInputs,
} from "@/components/withheld-source-inputs";
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
	const [overrides, setOverrides] = useState<Map<string, TemplateSourceParam>>(
		() => new Map(),
	);
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

	const sourceVersion = detail.data
		? `${detail.data.id}:${detail.data.revision}`
		: undefined;
	const replacement = useWithheldSourceInputs(detail.data?.body, sourceVersion);
	const presetBody = replacement.body;
	const plan: EncodingPlan | null = useMemo(() => {
		if (!presetBody) {
			return null;
		}
		const parsed = encodingPlanSchema.safeParse(presetBody);
		return parsed.success ? parsed.data : null;
	}, [presetBody]);

	const sites = useMemo(() => (plan ? templateSourceSites(plan) : []), [plan]);

	function changeSource(siteId: string, next: TemplateSourceParam) {
		setOverrides((previous) => {
			const updates = new Map(previous).set(siteId, next);
			const site = sites.find((item) => item.siteId === siteId);
			if (!site || !plan?.hdr10PlusStreams.length) return updates;
			const input = plan.inputs.find((entry) => entry.key === site.inputKey);
			const originalLocation =
				input && "bucket" in input && "credentialId" in input
					? input
					: undefined;
			const location =
				[...previous].find(
					([key, value]) =>
						value.bucket !== undefined &&
						sites.some(
							(other) =>
								other.siteId === key && other.inputKey === site.inputKey,
						),
				)?.[1] ?? originalLocation;
			const moved =
				next.bucket !== undefined &&
				(next.bucket !== location?.bucket ||
					next.credentialId !== location?.credentialId);
			for (const stream of plan.hdr10PlusStreams) {
				if (stream.inputKey !== site.inputKey) continue;
				const metadataId = `${stream.key}:metadata`;
				if (moved && siteId !== stream.key)
					updates.set(stream.key, { objectKey: "" });
				if (
					metadataId !== siteId &&
					(moved ||
						(siteId === stream.key &&
							previous.get(siteId)?.objectKey !== "" &&
							next.objectKey !==
								(previous.get(siteId)?.objectKey ?? site.currentPath)))
				) {
					const original =
						next.objectKey === stream.videoInputPath &&
						!moved &&
						(!next.bucket ||
							(next.bucket === originalLocation?.bucket &&
								next.credentialId === originalLocation?.credentialId));
					if (original) updates.delete(metadataId);
					else updates.set(metadataId, { objectKey: "" });
				}
			}
			return updates;
		});
	}

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
		setOverrides(new Map());
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
			? (overrides.get(first.siteId)?.objectKey ?? first.currentPath)
			: "";
		return renderTemplateOutputPrefix(prefixTemplate, {
			objectKey: effective,
			inputKind: plan?.inputs.find(
				(resource) => resource.key === first?.inputKey,
			)?.kind,
			templateName: detail.data?.name ?? "",
			now: new Date(creation.seed?.createdAt ?? Date.now()),
			uuid: "xxxxxxxx",
		});
	}, [
		sites,
		overrides,
		prefixTemplate,
		detail.data?.name,
		creation.seed,
		plan,
	]);
	const launch = useMutation({
		mutationFn: async () => {
			if (!detail.data || !creation.seed || !presetBody) {
				throw new Error("not loaded");
			}
			const params = {
				presetBody,
				sources: Object.fromEntries(overrides),
				outputPrefixTemplate: prefixTemplate,
				name,
				templateName: detail.data.name,
			};
			const result = instantiateTemplatePlan({
				...params,
				now: new Date(0),
				uuid: "xxxxxxxx",
			});
			if (!result.ok) {
				setIssues(
					result.issues.map((i) =>
						i.code === "HDR10PLUS_PAIR_REQUIRED"
							? t("templates.hdrPairRequired")
							: i.message,
					),
				);
				return null;
			}
			setIssues([]);
			// A reopened attempt may have reached the same final inputs through
			// a different series of replacements. The effective plan binds the retry.
			const intent = {
				plan: result.plan,
				outputPrefixTemplate: prefixTemplate,
				presetId: detail.data.id,
				presetRevision: detail.data.revision,
				renderedAt: creation.seed.createdAt,
			};
			return creation.submit<{ id: string }>(intent, (seed) => {
				const rendered = instantiateTemplatePlan({
					...params,
					now: new Date(intent.renderedAt),
					uuid: seed.nonce,
				});
				if (!rendered.ok)
					throw new Error("Template parameters changed before submission");
				return {
					plan: rendered.plan,
					presetId: intent.presetId,
					presetRevision: intent.presetRevision,
				};
			});
		},
		onSuccess: (created) => {
			if (created) {
				replacement.clear();
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
					replacement.clear();
					onClose();
				}
			}}
			title={t("templates.launchTitle", { name: detail.data?.name ?? "…" })}
			wide
		>
			{detail.isPending ? (
				<p className="text-xs text-zinc-500">{t("templates.loading")}</p>
			) : replacement.pending ? (
				<WithheldSourceInputs
					key={sourceVersion}
					sources={replacement.pending}
					onResolve={replacement.resolve}
				/>
			) : !plan ? (
				<p className="text-rose-400 text-sm">{t("templates.notAPlan")}</p>
			) : (
				<div className="space-y-4">
					<section className="space-y-2">
						<h3 className="font-medium text-xs text-zinc-300 uppercase tracking-wide">
							{t("templates.sources")}
						</h3>
						{sites.map((site) => {
							const override = overrides.get(site.siteId);
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
											override?.objectKey === "" &&
											site.list === "hdr10PlusStreams"
												? t("templates.hdrPairRequired")
												: override
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
												changeSource(site.siteId, {
													...overrides.get(site.siteId),
													objectKey: e.target.value,
												})
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
						changeSource(pickingSite, {
							objectKey: path,
							bucket,
							credentialId,
						});
					}
					setPickingSite(null);
				}}
			/>
		</Dialog>
	);
}
