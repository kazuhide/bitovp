"use client";

import {
	BITMOVIN_CLOUD_REGIONS,
	type CredentialSummaryWire,
	checkDeliverySpec,
	type DeliveryConstraint,
	INTERNAL_HEVC_V2_BCF_VERSION,
} from "@bitovp/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BitmovinAccountDto } from "@/app/settings/bitmovin/types";
import { StoragePicker } from "@/components/storage-picker";
import { Button } from "@/components/ui/button";
import { Field, FieldRowAction } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input, SelectNative } from "@/components/ui/input";
import { WizardDraftOffer } from "@/components/wizard-draft-offer";
import { ApiError, apiFetch } from "@/lib/api";
import { useCreationSubmission } from "@/lib/creation-submission-hook";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";
import {
	joinOutputName,
	renameOutputBase,
	splitOutputFolder,
} from "@/lib/output-path";
import { draftFingerprint, mergeWizardDraft } from "@/lib/wizard-draft";
import { useWizardDraft } from "@/lib/wizard-draft-hook";
import { reconcileAutomaticAudioPackaging } from "./automatic-audio-packaging";
import {
	applyMirrorCredentialSelection,
	buildPlan,
	DEFAULT_WIZARD_STATE,
	hasInvalidHevcV2Ladder,
	type WizardState,
	wizardUsesCodecEncodingMode,
} from "./build-plan";
import { MuxingsSection } from "./muxings-section";
import { PlaceholderRefsList } from "./placeholder-refs-list";
import {
	buildSubmissionPlan,
	collectPlaceholders,
	countPendingPlaceholders,
	type ImportedPlan,
	importedAccountId,
	parseImportedPlan,
} from "./plan-import";
import { PlanImportSection } from "./plan-import-section";
import { PlanPresetsPanel } from "./plan-presets-panel";
import {
	evaluatePlanDocument,
	evaluateWizardState,
	PlanPreview,
} from "./plan-preview";
import {
	type PresetFallbackReasonKey,
	tryImportPresetIntoWizard,
} from "./plan-to-wizard";
import { PresetChecklist } from "./preset-checklist";
import { InputFilesEditor, SourcesSection } from "./sources-section";
import { SpritesSection } from "./sprites-section";
import { GcsRegionControl, StorageLocation } from "./storage-location";
import {
	BROWSABLE_STORAGE_PROVIDERS,
	inputKindForProvider,
	isS3Credential,
	outputKindForProvider,
	outputKindHasAcl,
	outputKindIsBrowsable,
	outputNameForKind,
} from "./stream-model";
import { ThumbnailsSection } from "./thumbnails-section";
import { useVmafExecutionValidation } from "./vmaf-execution-settings";
import { RowRemoveButton } from "./wizard-fields";
import {
	EncodingOptionsSection,
	LadderSection,
	ManifestSection,
} from "./wizard-sections";

const STEPS: MessageKey[] = [
	"wizard.basics",
	"wizard.sources",
	"wizard.ladder",
	"wizard.output",
	"wizard.packaging",
	"wizard.encoding",
	"wizard.manifests",
	"wizard.review",
];

const ENCODER_VERSION_OPTIONS = ["STABLE", "BETA"] as const;

/**
 * Storage-picker target: an input file (by index), the primary output, or a
 * delivery mirror (by index — 's rows had no picker at all until
 * the owner asked for one).
 */
type PickerTarget = "output" | { file: number } | { mirror: number } | null;

export function VodWizard({
	copiedJob,
	presetName,
	userPresetId,
	deliveryPresetId,
	editPresetId,
}: {
	copiedJob?: { id: string; plan: Record<string, unknown> };
	presetName?: string;
	userPresetId?: string;
	/** ?deliveryPreset=<id> — a shipped delivery spec . */
	deliveryPresetId?: string;
	/* Template edit mode loads through the same import path as userPreset. Its primary action updates the template with the loaded updatedAt concurrency token instead of submitting an encoding job. */
	editPresetId?: string;
}) {
	const { t } = useT();
	const router = useRouter();
	const [step, setStep] = useState(0);
	const [state, setState] = useState<WizardState>(DEFAULT_WIZARD_STATE);
	const draftBase = useRef(DEFAULT_WIZARD_STATE);
	const [appliedDraftContext, setAppliedDraftContext] = useState<string | null>(
		null,
	);
	const [picker, setPicker] = useState<PickerTarget>(null);
	// Expert mode: an imported plan replaces the form-built one for preview
	// and submission until discarded (the payload is the import, verbatim).
	const [imported, setImported] = useState<ImportedPlan | null>(null);
	const [showImport, setShowImport] = useState(false);
	const [jsonLoadedForEditing, setJsonLoadedForEditing] = useState(false);
	// ?preset=<name> loads a sample preset. When the wizard form can rebuild
	// the plan exactly (tryImportPresetIntoWizard), the fixture is mapped onto
	// the form steps so the user edits it the familiar way; otherwise it falls
	// back to the verbatim imported-plan path with a reason why.
	const [appliedPreset, setAppliedPreset] = useState<string | null>(null);
	const [appliedTemplateUpdatedAt, setAppliedTemplateUpdatedAt] =
		useState<string>();
	const [mappedPresetName, setMappedPresetName] = useState<string | null>(null);
	const [fallbackReason, setFallbackReason] =
		useState<PresetFallbackReasonKey | null>(null);
	// Delivery-spec drift : retained past the load so every later
	// edit is checked against the spec the operator started from. Dismissible
	// — drift is legitimate; silence about it is the only failure mode.
	const [driftSpec, setDriftSpec] = useState<{
		/** Shipped DELIVERY_SPECS id — null for user-preset-carried specs,
		 * which have constraints but no id the submit gate would accept. */
		id: string | null;
		name: string;
		constraints: DeliveryConstraint[];
	} | null>(null);
	const [driftOpen, setDriftOpen] = useState(false);
	// Derived, not stored — survives drafts/presets setting the version
	// externally (P2) without a flag to keep in sync.
	const pinnedVersion = !ENCODER_VERSION_OPTIONS.some(
		(v) => v === state.encoderVersion,
	);
	const credentials = useQuery({
		queryKey: ["credentials"],
		queryFn: () => apiFetch<CredentialSummaryWire[]>("/api/credentials"),
	});
	const validationOptions = {
		credentialProviders: new Map(
			(credentials.data ?? []).map((c) => [c.id, c.provider]),
		),
	};
	const evaluation = imported
		? evaluatePlanDocument(imported.raw, t, validationOptions)
		: evaluateWizardState(state, t, validationOptions);
	// Delivery-spec drift : the CURRENT plan — form-built or
	// verbatim-imported — checked against the spec the operator loaded. The
	// RAW plan object, deliberately not `evaluation.plan`: mapping a preset
	// clears its placeholder credentials, so the state is schema-INVALID
	// until the operator picks their own, and gating drift on a full parse
	// hid every deviation during exactly the editing window the banner
	// exists for. checkDeliverySpec path-reads unknown JSON by design.
	// Memoized (review-205 N7): buildPlan already runs once per render for
	// the preview; the drift check must not double it — and an imported
	// spec may carry up to 200 constraint rows.
	const driftDeviations = useMemo(
		() =>
			driftSpec && (imported || !hasInvalidHevcV2Ladder(state))
				? checkDeliverySpec(
						imported ? imported.raw : buildPlan(state),
						driftSpec,
					)
				: [],
		[driftSpec, imported, state],
	);
	// Preset map-and-gate: a preset's sample-path tokens (<INSERT…>/{YOUR…})
	// prefill the form's path fields verbatim. They're valid strings, so they
	// pass schema validation — gate Start on them so the user can't submit a
	// placeholder. (Imported plans gate via countPendingPlaceholders instead.)
	// The REFS, not just their count : the import path
	// renders an actionable checklist while the form path told the user only
	// "N placeholder paths" — which fields, and which tokens, existed in the
	// data and were unreachable.
	const formPlaceholderRefs =
		!imported && evaluation.ok
			? collectPlaceholders(
					evaluation.plan as unknown as Record<string, unknown>,
				)
			: [];
	const formPlaceholders = formPlaceholderRefs.length;

	const accounts = useQuery({
		queryKey: ["bitmovin-accounts"],
		queryFn: () => apiFetch<BitmovinAccountDto[]>("/api/bitmovin-accounts"),
	});
	const preset = useQuery({
		queryKey: ["sample-preset", presetName],
		refetchOnMount: "always",
		enabled: presetName !== undefined && presetName !== appliedPreset,
		retry: false,
		queryFn: () =>
			apiFetch<Record<string, unknown>>(
				`/api/sample-presets/${encodeURIComponent(presetName ?? "")}`,
			),
	});
	// ?userPreset=<id> loads a SAVED user preset through the SAME import path
	// (its `body` is a secret-free EncodingPlan). Keyed `user:<id>` so it can't
	// collide with a sample name in the appliedPreset gate.
	// Edit mode rides the same load: one id, one import path, one gate key.
	const loadPresetId = userPresetId ?? editPresetId;
	const userPreset = useQuery({
		queryKey: ["user-preset", loadPresetId],
		refetchOnMount: "always",
		enabled:
			loadPresetId !== undefined && `user:${loadPresetId}` !== appliedPreset,
		retry: false,
		queryFn: () =>
			apiFetch<{
				name: string;
				body: Record<string, unknown>;
				updatedAt: string;
			}>(`/api/presets/${loadPresetId}`),
	});
	// ?deliveryPreset=<id> loads a code-shipped delivery spec
	// through the SAME import path; the constraints stay behind for the
	// drift banner. Keyed `delivery:<id>` in the appliedPreset gate.
	const deliveryPreset = useQuery({
		queryKey: ["delivery-preset", deliveryPresetId],
		refetchOnMount: "always",
		enabled:
			deliveryPresetId !== undefined &&
			`delivery:${deliveryPresetId}` !== appliedPreset,
		retry: false,
		queryFn: () =>
			apiFetch<{
				spec: {
					name: string;
					plan: Record<string, unknown>;
					constraints: DeliveryConstraint[];
				};
			}>(`/api/delivery-presets/${encodeURIComponent(deliveryPresetId ?? "")}`),
	});
	// Whichever param is set drives one apply. With the other params undefined
	// this is byte-equivalent to the sample-only path (presetBody =
	// preset.data, presetKey/label = presetName).
	const presetKey = copiedJob
		? `job:${copiedJob.id}`
		: deliveryPresetId
			? `delivery:${deliveryPresetId}`
			: loadPresetId
				? `user:${loadPresetId}`
				: presetName;
	const selectedPresetQuery = deliveryPresetId
		? deliveryPreset
		: loadPresetId
			? userPreset
			: preset;
	// A warm cache can contain an older body while a fresh read is in flight.
	// Finish that read before opening edits, rather than applying cached data.
	const presetReady =
		Boolean(copiedJob) ||
		(selectedPresetQuery.isSuccess &&
			selectedPresetQuery.isFetchedAfterMount &&
			selectedPresetQuery.fetchStatus === "idle");
	const presetUpdatedAt = loadPresetId ? userPreset.data?.updatedAt : undefined;
	const presetBody: Record<string, unknown> | undefined = copiedJob
		? copiedJob.plan
		: deliveryPresetId
			? deliveryPreset.data?.spec.plan
			: loadPresetId
				? userPreset.data?.body
				: preset.data;
	const presetLabel = deliveryPresetId
		? deliveryPreset.data?.spec.name
		: loadPresetId
			? userPreset.data?.name
			: presetName;
	// A user preset saved FROM a delivery-preset import carries its spec
	// beside the plan; loading it re-arms the same drift banner.
	const loadedSpec = deliveryPresetId
		? deliveryPreset.data?.spec
		: loadPresetId
			? (
					userPreset.data as
						| {
								name: string;
								spec?: { constraints: DeliveryConstraint[] } | null;
						  }
						| undefined
				)?.spec && {
					name: userPreset.data?.name ?? "",
					constraints: (
						userPreset.data as unknown as {
							spec: { constraints: DeliveryConstraint[] };
						}
					).spec.constraints,
				}
			: undefined;
	useEffect(() => {
		if (
			!presetReady ||
			presetKey === undefined ||
			presetKey === appliedPreset ||
			presetBody === undefined
		) {
			return;
		}
		const mapping = tryImportPresetIntoWizard(presetBody);
		setAppliedPreset(presetKey);
		// Keep the CAS token with the body actually applied to this edit session.
		// Another reader refreshing React Query must not silently advance it.
		setAppliedTemplateUpdatedAt(presetUpdatedAt);
		// Delivery drift arms on ANY load that carried a spec .
		setDriftSpec(
			loadedSpec
				? {
						id: (loadedSpec as { id?: string }).id ?? null,
						name: loadedSpec.name,
						constraints: loadedSpec.constraints,
					}
				: null,
		);
		if (mapping.ok) {
			// Form-mappable: prefill the steps and stay in the normal wizard
			// (no imported-plan blob, no "Start (imported plan)"). Keep the source
			// URL so returning can offer its draft; appliedPreset prevents reapply.
			// Clear any prior imported/fallback state so switching FROM a fallback
			// preset TO a mappable one can't leave the stale verbatim plan winning
			// over the freshly mapped form (imported has render priority below).
			setImported(null);
			setShowImport(false);
			setFallbackReason(null);
			setState(mapping.state);
			draftBase.current = mapping.state;
			setAppliedDraftContext(
				editPresetId
					? presetUpdatedAt
						? `edit:${editPresetId}:${presetUpdatedAt}`
						: null
					: `${presetKey}:${presetUpdatedAt ?? draftFingerprint(presetBody)}`,
			);
			setStep(0);
			setMappedPresetName(presetLabel ?? null);
		} else {
			// Beyond the form's surface: load verbatim with the reason shown.
			// Drop a prior mapped-preset banner so the two paths stay exclusive.
			setMappedPresetName(null);
			const result = parseImportedPlan(JSON.stringify(presetBody), t);
			if (result.ok) {
				setImported(result.imported);
				setShowImport(true);
				setFallbackReason(mapping.reasonKey);
			}
		}
	}, [
		presetReady,
		presetUpdatedAt,
		presetBody,
		appliedPreset,
		presetKey,
		editPresetId,
		presetLabel,
		loadedSpec,
		t,
	]);

	const discardImport = () => {
		setImported(null);
		setFallbackReason(null);
		// Edit mode keeps its param here too (review-109pr1: the first guard
		// covered only the clean-import effect; this branch also stripped
		// ?editPreset= and silently degraded the mode).
		if (editPresetId) {
			return;
		}
		if (presetName || loadPresetId || deliveryPresetId) {
			// Drop the preset query param so a reload starts clean (not
			// re-import) — including ?deliveryPreset= (review-205 N2: the
			// third branch was omitted, so a discarded delivery preset
			// re-imported on every reload).
			router.replace("/vod/new");
		}
	};

	// A plan-carried account wins over the wizard selection (and satisfies
	// the gate by itself); otherwise the selected account is injected — the
	// one documented exception to verbatim submission.
	const planAccount = imported ? importedAccountId(imported) : undefined;
	const internalAllowed =
		accounts.data?.some(
			(account) =>
				account.id === (planAccount ?? state.accountId) &&
				account.internalHevcV2 === true,
		) ?? false;
	const hasInternalProfile = imported
		? imported.raw.internal !== undefined
		: !!state.internal ||
			state.videos.some((video) => video.codec === "H265V2");
	const internalBlocked = hasInternalProfile && !internalAllowed;
	// Imported plans submit verbatim, so placeholder credential ids and
	// <INSERT_*>/{YOUR *} tokens would reach Bitmovin as-is — Start stays
	// disabled until the checklist (or a re-import) resolves them. Same
	// detection as the checklist badge; C4 {uuid}/{bitrate} never count.
	const pendingPlaceholders = imported
		? countPendingPlaceholders(imported.raw)
		: 0;
	const draft = useWizardDraft({
		kind: "vod",
		context:
			imported || jsonLoadedForEditing
				? null
				: presetKey === undefined
					? "new"
					: appliedPreset === presetKey
						? appliedDraftContext
						: null,
		value: state,
		step,
		onRestore: (saved) => {
			setState(
				mergeWizardDraft(
					presetKey === undefined ? DEFAULT_WIZARD_STATE : draftBase.current,
					saved.value,
					"vod",
				),
			);
			setStep(saved.step);
		},
	});

	const qcExecution = imported
		? evaluation.ok
			? evaluation.plan.qc?.execution
			: undefined
		: state.qc?.vmaf || state.qc?.psnr
			? state.qc.execution
			: undefined;
	const qcExecutionValidation = useVmafExecutionValidation(
		qcExecution,
		qcExecution?.backend === "CLOUD",
	);
	const qcExecutionMessage = !qcExecutionValidation.invalid
		? ""
		: qcExecutionValidation.profiles.isError
			? t("qc.executionProfilesUnavailable")
			: qcExecutionValidation.profiles.isFetching
				? t("common.loading")
				: qcExecutionValidation.missingProfile
					? t("qc.measureProfileMissing")
					: t("qc.executionBudgetInvalid");

	const creation = useCreationSubmission(
		"vod",
		presetKey === undefined
			? "wizard:new"
			: `wizard:${presetKey}:${presetUpdatedAt ?? ""}`,
	);
	const submit = useMutation({
		mutationFn: () => {
			if (internalBlocked) throw new Error(t("hevcV2.unavailable"));
			if (qcExecutionValidation.invalid) throw new Error(qcExecutionMessage);
			return creation.submit<{ id: string }>({
				plan: imported
					? buildSubmissionPlan(imported, state.accountId)
					: buildPlan(state),
			});
		},
		onSuccess: (job) => {
			if (!imported && !jsonLoadedForEditing) draft.clear();
			router.push(`/vod/jobs/${job.id}`);
		},
	});

	// Template re-edit : PATCH with the LOADED updatedAt as
	// the CAS token — a template edited elsewhere since this page loaded is a
	// 409, surfaced as "reload", never silently overwritten.
	const updateTemplate = useMutation({
		mutationFn: () => {
			if (internalBlocked) throw new Error(t("hevcV2.unavailable"));
			return apiFetch<{ id: string }>(`/api/presets/${editPresetId}`, {
				method: "PATCH",
				body: JSON.stringify({
					plan: imported
						? buildSubmissionPlan(imported, state.accountId)
						: buildPlan(state),
					expectedUpdatedAt: appliedTemplateUpdatedAt,
				}),
			});
		},
		onSuccess: () => {
			if (!imported && !jsonLoadedForEditing) draft.clear();
			router.push("/templates");
		},
	});

	const patch = (partial: Partial<WizardState>) =>
		setState((prev) => {
			const changedAccount =
				partial.accountId !== undefined && partial.accountId !== prev.accountId;
			const next = {
				...prev,
				...partial,
				...(changedAccount
					? {
							internal: undefined,
							videos: (partial.videos ?? prev.videos).map((video) =>
								video.codec === "H265V2"
									? {
											...video,
											codec: "H265" as const,
											encodingMode: undefined,
										}
									: video,
							),
						}
					: {}),
			};
			if (
				next.startOptions?.encodingMode &&
				(wizardUsesCodecEncodingMode(next) ||
					(prev.internal &&
						!next.internal &&
						next.startOptions.encodingMode === "SMART_PASS"))
			) {
				next.startOptions = { ...next.startOptions, encodingMode: undefined };
			}
			next.audios = reconcileAutomaticAudioPackaging(next);
			return next;
		});

	// VMAF-only encode (qc.only) skips all delivery outputs: the Muxings /
	// Thumbnails / Sprites step and the Manifests step are disabled (the storage
	// output picker stays enabled — the qc mirrors write there). The toggle lives
	// in the Encoding-options step's Quality control (VMAF) section.
	const qcOnly = Boolean(state.qc?.only && (state.qc.vmaf || state.qc.psnr));

	// The location the picker should open at, so an already-chosen credential is
	// never re-asked (it opens straight at the bucket instead).
	const pickerSeed =
		picker === "output"
			? state.output
			: picker === null
				? undefined
				: "mirror" in picker
					? state.additionalOutputs[picker.mirror]
					: state.inputFiles[picker.file];

	const allCredentials = credentials.data ?? [];
	const outputSelectable = (provider: string) =>
		outputKindForProvider(provider) !== null;
	// "Bucket" / "Container" / "Host" depending on the output storage kind.
	const locationLabel = (kind: WizardState["output"]["kind"]) =>
		kind === "AZURE" ? t("wizard.container") : t("wizard.bucket");

	function selectOutputCredential(id: string) {
		const provider = allCredentials.find((c) => c.id === id)?.provider;
		// `outputSelectable` (the picker filter) and this provider→kind mapping are
		// the single source of truth for which providers are offered as encoding
		// I/O. AWS_S3→S3, Azure→AZURE, SFTP→SFTP, Akamai/OCI/GenericS3→GENERIC_S3
		// (C10), GCS-HMAC→GCS, GCS-service-account→GCS_SERVICE_ACCOUNT. A provider
		// with no mapping (e.g. role-based) is never collapsed to S3 — we skip.
		const kind = outputKindForProvider(provider);
		if (kind === null) {
			console.warn(
				`[vod-wizard] Unsupported output provider "${provider}" is not selectable as encoding I/O; ignoring selection.`,
			);
			return;
		}
		setState((prev) => ({
			...prev,
			output: {
				...prev.output,
				credentialId: id,
				kind,
				name: outputNameForKind(kind),
				// PUBLIC_READ/PRIVATE ACL applies to the S3-family + GCS buckets;
				// Azure/SFTP have no object ACL, so force it off.
				publicRead: outputKindHasAcl(kind) ? prev.output.publicRead : false,
			},
		}));
	}

	// A selected template owns the initial form. Keep edits unavailable until
	// its plan is applied so a late response cannot replace user input.
	if (presetKey !== undefined && presetKey !== appliedPreset) {
		const requestedName =
			presetLabel ?? deliveryPresetId ?? loadPresetId ?? presetName ?? "";
		return (
			<section className="space-y-4">
				<h1 className="font-semibold text-xl text-zinc-50">
					{t("wizard.newVodJob")}
				</h1>
				{selectedPresetQuery.isError ? (
					<>
						<p role="alert" className="text-red-400 text-sm">
							{t("wizardX.couldNotLoadPresetNamed", { name: requestedName })}
						</p>
						<Button
							variant="secondary"
							onClick={() => selectedPresetQuery.refetch()}
						>
							{t("common.retry")}
						</Button>
						<Link href="/templates" className="block text-sm underline">
							{t("wizard.chooseFromTemplates")}
						</Link>
					</>
				) : (
					<p role="status" className="text-sm text-zinc-400">
						{t("wizardX.loadingPreset")} {requestedName}…
					</p>
				)}
			</section>
		);
	}

	return (
		<section className="grid min-h-[70vh] grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
			<div>
				{copiedJob ? (
					<p role="status" className="mb-3 text-sm text-zinc-400">
						{t("wizard.copiedJobHint")}
					</p>
				) : null}
				{editPresetId ? (
					<p
						role="status"
						className="mb-3 rounded-md border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-amber-200 text-xs"
					>
						{t("templates.editingBanner", {
							name: userPreset.data?.name ?? "…",
						})}
					</p>
				) : null}
				<header className="flex flex-wrap items-center justify-between gap-3">
					<h1 className="font-semibold text-xl text-zinc-50">
						{t("wizard.newVodJob")}
					</h1>
					<div className="flex flex-wrap items-center gap-2">
						<Link
							href="/templates"
							className="inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-900 px-3 font-medium text-xs text-zinc-200 transition-colors hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-emerald-500 focus-visible:outline-offset-2"
						>
							{t("wizard.chooseFromTemplates")}
						</Link>
						{/* While a plan is imported, Discard import is the control. */}
						{!imported ? (
							<Button
								variant="secondary"
								size="sm"
								onClick={() => setShowImport((v) => !v)}
							>
								{showImport
									? t("wizard.hideImport")
									: t("wizard.importPlanJson")}
							</Button>
						) : null}
					</div>
				</header>
				<WizardDraftOffer {...draft} />
				{[
					{ query: accounts, message: t("wizard.accountsLoadFailed") },
					{ query: credentials, message: t("wizard.credentialsLoadFailed") },
				].map(({ query, message }) =>
					query.isError ? (
						<div
							key={message}
							role="alert"
							className="mt-3 flex flex-wrap items-center gap-2 text-red-400 text-sm"
						>
							<span>{message}</span>
							<Button
								variant="secondary"
								size="sm"
								disabled={query.isFetching}
								onClick={() => query.refetch()}
							>
								{t("common.retry")}
							</Button>
						</div>
					) : null,
				)}
				{driftSpec && !imported ? (
					/*
					 * The COMMITMENT control ('s last enum gap, ledger
					 * #82's plan field). `state.delivery` and its round-trip were
					 * plumbed when #82 landed, but no form ever wrote it — WARN and
					 * REFUSE were reachable only by hand-editing plan JSON. This
					 * strip renders whenever a spec is tracked, DRIFTING OR NOT,
					 * because committing to a spec you currently satisfy is exactly
					 * when REFUSE is cheap to adopt. Default is "banner only",
					 * which preserves the behaviour every existing flow had.
					 */
					<div className="flex flex-wrap items-center gap-3 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2">
						<p className="text-sm text-zinc-300">
							{t("wizardX.deliverySpecLoaded", { name: driftSpec.name })}
						</p>
						{driftSpec.id !== null ? (
							<span className="flex items-center gap-2 text-xs text-zinc-400">
								{/* htmlFor, not a wrapping label: with the select nested,
								    the label's accessible text swallows the option text and
								    the label query stops matching. */}
								<label htmlFor="wz-delivery-commit">
									{t("wizardX.deliveryCommitmentLabel")}
								</label>
								<SelectNative
									id="wz-delivery-commit"
									className="h-8 w-auto text-xs"
									value={state.delivery?.onDeviation ?? ""}
									onChange={(e) => {
										const value = e.target.value;
										const id = driftSpec.id;
										patch({
											delivery:
												value === "" || id === null
													? undefined
													: {
															specId: id,
															onDeviation: value as "REFUSE" | "WARN",
														},
										});
									}}
								>
									<option value="">{t("wizardX.deliveryCommitNone")}</option>
									<option value="WARN">
										{t("wizardX.deliveryCommitWarn")}
									</option>
									<option value="REFUSE">
										{t("wizardX.deliveryCommitRefuse")}
									</option>
								</SelectNative>
							</span>
						) : null}
					</div>
				) : null}
				{driftSpec && driftDeviations.length > 0 ? (
					<div className="rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<p className="text-amber-200 text-sm">
								{t("wizardX.deliveryDrift", {
									name: driftSpec.name,
									count: driftDeviations.length,
								})}
							</p>
							<span className="flex items-center gap-2">
								<Button
									variant="ghost"
									size="sm"
									onClick={() => setDriftOpen((open) => !open)}
								>
									{driftOpen
										? t("wizardX.deliveryDriftHide")
										: t("wizardX.deliveryDriftShow")}
								</Button>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => {
										// Dismiss = stop tracking this spec entirely; drift is
										// legitimate, silence about it was the failure mode and
										// the operator has now seen it. The COMMITMENT goes with
										// it: a dismissed spec that kept refusing submissions
										// would be invisible enforcement — the exact opposite of
										// what dismissing says.
										setDriftSpec(null);
										setDriftOpen(false);
										patch({ delivery: undefined });
									}}
								>
									{t("wizardX.deliveryDriftDismiss")}
								</Button>
							</span>
						</div>
						{driftOpen ? (
							<div className="mt-2 overflow-x-auto">
								<table className="w-full text-left text-xs">
									<thead>
										<tr className="text-zinc-500">
											<th className="py-1 pr-3 font-medium">
												{t("wizardX.deliveryDriftRequirement")}
											</th>
											<th className="py-1 pr-3 font-medium">
												{t("wizardX.deliveryDriftFound")}
											</th>
										</tr>
									</thead>
									<tbody className="divide-y divide-zinc-800/70">
										{driftDeviations.map((deviation) => (
											<tr key={`${deviation.requirement}-${deviation.path}`}>
												<td className="py-1 pr-3 text-zinc-300">
													{deviation.requirement}
													<code className="ml-1 text-[10px] text-zinc-600">
														{deviation.path}
													</code>
												</td>
												<td className="py-1 pr-3 font-mono text-amber-300">
													{deviation.actual === undefined
														? t("wizardX.deliveryDriftAbsent")
														: JSON.stringify(deviation.actual)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						) : null}
					</div>
				) : null}
				{jsonLoadedForEditing && !imported ? (
					<p
						role="status"
						className="mt-4 rounded-lg border border-emerald-900 bg-emerald-950/30 p-3 text-sm text-zinc-300"
					>
						{t("wizardX.importLoadedForEditing")}
					</p>
				) : null}
				{mappedPresetName && !imported ? (
					<div className="mt-4 flex items-start justify-between gap-3 rounded-lg border border-emerald-900 bg-emerald-950/30 p-3">
						<p className="text-sm text-zinc-300">
							{t("wizardX.loadedPreset")}{" "}
							<span className="font-mono text-emerald-300">
								{mappedPresetName}
							</span>
							{t("wizardX.loadedPresetTail")}
						</p>
						<button
							type="button"
							aria-label={t("wizard.dismissPresetNotice")}
							className="shrink-0 rounded px-2 text-lg text-zinc-500 leading-none hover:text-zinc-300"
							onClick={() => setMappedPresetName(null)}
						>
							×
						</button>
					</div>
				) : null}
				{imported && fallbackReason ? (
					<p className="mt-4 rounded-lg border border-amber-900/60 bg-amber-950/20 p-3 text-amber-200/90 text-sm">
						{t("wizardX.importCannotEditWithoutLoss")}
					</p>
				) : null}
				{showImport || imported ? (
					<div className="mt-4">
						<PlanImportSection
							allowEdit
							imported={imported}
							onLoad={(loaded) => {
								const mapping = tryImportPresetIntoWizard(loaded.raw);
								if (mapping.ok) {
									draftBase.current = mapping.state;
									setJsonLoadedForEditing(true);
									setState(mapping.state);
									setImported(null);
									setShowImport(false);
									setFallbackReason(null);
									setMappedPresetName(null);
									setStep(0);
								} else {
									setImported(loaded);
									setShowImport(true);
									setMappedPresetName(null);
									setFallbackReason(mapping.reasonKey);
								}
							}}
							onDiscard={discardImport}
						/>
					</div>
				) : null}
				{imported && (presetKey !== undefined || pendingPlaceholders > 0) ? (
					<div className="mt-4">
						<PresetChecklist
							imported={imported}
							credentials={allCredentials}
							onUpdate={setImported}
						/>
					</div>
				) : null}
				{internalBlocked ? (
					<p role="alert" className="mt-4 text-amber-400 text-sm">
						{t("hevcV2.unavailable")}
					</p>
				) : null}
				{qcExecutionValidation.invalid &&
				(imported || step === STEPS.length - 1) ? (
					<div role="alert" className="mt-4 space-y-2 text-amber-400 text-sm">
						<p>{qcExecutionMessage}</p>
						{qcExecutionValidation.profiles.isError ? (
							<Button
								variant="secondary"
								size="sm"
								disabled={qcExecutionValidation.profiles.isFetching}
								onClick={() => qcExecutionValidation.profiles.refetch()}
							>
								{t("common.retry")}
							</Button>
						) : null}
					</div>
				) : null}
				{imported ? (
					<div className="mt-6 space-y-3">
						{planAccount ? (
							<p className="text-sm text-zinc-400">
								{t("wizardX.bitmovinAccountFromPlan")}{" "}
								<span className="font-mono text-zinc-300">{planAccount}</span>
							</p>
						) : (
							<Field
								label={t("wizard.bitmovinAccount")}
								htmlFor="wz-import-account"
								help={t("wizard.injectedIntoBitmovinAccountidTheOneException")}
							>
								<SelectNative
									id="wz-import-account"
									value={state.accountId}
									onChange={(e) => patch({ accountId: e.target.value })}
								>
									<option value="">{t("wizard.selectAccount")}</option>
									{(accounts.data ?? []).map((account) => (
										<option key={account.id} value={account.id}>
											{account.label}
										</option>
									))}
								</SelectNative>
							</Field>
						)}
						{submit.isError ? (
							<p role="alert" className="text-red-400 text-sm">
								{submit.error instanceof ApiError
									? submit.error.message
									: t("wizard.submitFailed")}
							</p>
						) : null}
						{pendingPlaceholders > 0 ? (
							<p role="alert" className="text-red-400 text-sm">
								{t("wizardX.placeholdersMustBeReplaced", {
									count: pendingPlaceholders,
								})}
							</p>
						) : null}
						{updateTemplate.isError ? (
							<p role="alert" className="text-red-400 text-sm">
								{updateTemplate.error instanceof ApiError &&
								updateTemplate.error.status === 409
									? t("templates.editConflict")
									: String(updateTemplate.error)}
							</p>
						) : null}
						{editPresetId ? (
							<Button
								disabled={
									internalBlocked ||
									!evaluation.ok ||
									evaluation.issues.some((i) => i.level === "error") ||
									pendingPlaceholders > 0 ||
									updateTemplate.isPending
								}
								onClick={() => updateTemplate.mutate()}
							>
								{updateTemplate.isPending
									? t("templates.updating")
									: t("templates.updateTemplate")}
							</Button>
						) : (
							<Button
								disabled={
									internalBlocked ||
									qcExecutionValidation.invalid ||
									!evaluation.ok ||
									(!state.accountId && !planAccount) ||
									evaluation.issues.some((i) => i.level === "error") ||
									pendingPlaceholders > 0 ||
									submit.isPending
								}
								onClick={() => submit.mutate()}
							>
								{submit.isPending
									? t("wizard.starting")
									: t("wizard.startEncodingImportedPlan")}
							</Button>
						)}
					</div>
				) : null}
				{imported ? <PlanPresetsPanel evaluation={evaluation} /> : null}
				<nav
					aria-label={t("wizard.wizardSteps")}
					className={`mt-4 flex flex-wrap gap-1 ${imported ? "hidden" : ""}`}
				>
					{STEPS.map((labelKey, index) => (
						<button
							key={labelKey}
							type="button"
							aria-current={index === step ? "step" : undefined}
							className={`rounded-md px-3 py-1.5 text-sm ${
								index === step
									? "bg-zinc-800 text-zinc-50"
									: "text-zinc-400 hover:bg-zinc-900"
							}`}
							onClick={() => setStep(index)}
						>
							{index + 1}. {t(labelKey)}
						</button>
					))}
				</nav>

				<div className={`mt-6 space-y-4 ${imported ? "hidden" : ""}`}>
					{step === 0 ? (
						<>
							<Field label={t("wizard.jobName")} htmlFor="wz-name">
								<Input
									id="wz-name"
									value={state.name}
									placeholder="my-first-encoding"
									onChange={(e) =>
										setState((prev) => ({
											...prev,
											name: e.target.value,
											// Keep the name-namespaced output base in sync (no-op
											// unless the base still follows the folder/name shape).
											output: {
												...prev.output,
												basePath: renameOutputBase(
													prev.output.basePath,
													prev.name,
													e.target.value,
												),
											},
										}))
									}
								/>
							</Field>
							<Field
								label={t("wizard.bitmovinAccount")}
								htmlFor="wz-account"
								help={t("wizard.configuredInSettingsBitmovinAccounts")}
							>
								<SelectNative
									id="wz-account"
									value={state.accountId}
									onChange={(e) => patch({ accountId: e.target.value })}
								>
									<option value="">{t("wizard.selectAccount")}</option>
									{(accounts.data ?? []).map((account) => (
										<option key={account.id} value={account.id}>
											{account.label}
										</option>
									))}
								</SelectNative>
							</Field>

							<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
								<Field label={t("wizard.cloudRegion")} htmlFor="wz-region">
									<SelectNative
										id="wz-region"
										value={state.cloudRegion}
										onChange={(e) => patch({ cloudRegion: e.target.value })}
									>
										{BITMOVIN_CLOUD_REGIONS.map((region) => (
											<option key={region} value={region}>
												{region}
											</option>
										))}
									</SelectNative>
								</Field>
								<Field
									label={t("wizard.encoderVersion")}
									htmlFor="wz-version"
									help={
										pinnedVersion ? t("wizard.pinnedVersionEG22660") : undefined
									}
								>
									<div className="space-y-3">
										<div className="flex gap-2">
											<SelectNative
												id="wz-version"
												className="w-36"
												value={pinnedVersion ? "PINNED" : state.encoderVersion}
												onChange={(event) =>
													patch({
														encoderVersion:
															event.target.value === "PINNED"
																? ""
																: event.target.value,
													})
												}
											>
												{ENCODER_VERSION_OPTIONS.map((version) => (
													<option key={version} value={version}>
														{version}
													</option>
												))}
												<option value="PINNED">
													{t("wizard.pinnedVersion")}
												</option>
											</SelectNative>
											{pinnedVersion ? (
												<Input
													aria-label={t("wizard.pinnedEncoderVersion")}
													placeholder="2.266.0"
													value={state.encoderVersion}
													onChange={(event) =>
														patch({ encoderVersion: event.target.value })
													}
												/>
											) : null}
										</div>
										{internalAllowed ? (
											<div className="flex flex-wrap items-center gap-2">
												<label className="flex items-center gap-2 text-sm text-zinc-300">
													<input
														type="checkbox"
														className="h-4 w-4 accent-emerald-600"
														checked={!!state.internal?.hevcV2}
														onChange={(event) =>
															patch({
																internal: event.target.checked
																	? {
																			hevcV2: {
																				bcfVersion:
																					INTERNAL_HEVC_V2_BCF_VERSION,
																			},
																		}
																	: undefined,
															})
														}
													/>
													{t("hevcV2.bcfOverride")}
												</label>
												{state.internal?.hevcV2 ? (
													<Input
														aria-label="BCF version"
														className="min-w-0 flex-1"
														maxLength={128}
														value={state.internal.hevcV2.bcfVersion}
														onChange={(event) =>
															patch({
																internal: {
																	hevcV2: { bcfVersion: event.target.value },
																},
															})
														}
													/>
												) : null}
											</div>
										) : null}
									</div>
								</Field>
							</div>
						</>
					) : null}

					{step === 1 ? (
						<>
							<InputFilesEditor
								state={state}
								credentials={allCredentials}
								onPatch={patch}
								onBrowse={(index) => setPicker({ file: index })}
							/>
							<SourcesSection state={state} onPatch={patch} />
						</>
					) : null}

					{step === 2 ? (
						<>
							<LadderSection
								hevcV2Available={internalAllowed}
								state={state}
								credentials={allCredentials}
								onPatch={patch}
							/>
							<label
								htmlFor="wz-audio-guard"
								className="flex items-center gap-2 text-sm text-zinc-300"
							>
								<input
									id="wz-audio-guard"
									type="checkbox"
									className="h-4 w-4 accent-emerald-600"
									checked={state.audioGuard}
									onChange={(e) => patch({ audioGuard: e.target.checked })}
								/>
								{t("ui.guardAudioRenditionsWithAudiostreamcountGt0")}
							</label>
						</>
					) : null}

					{step === 5 ? (
						<EncodingOptionsSection
							state={state}
							onPatch={patch}
							credentials={allCredentials}
						/>
					) : null}

					{step === 3 ? (
						<>
							<StorageLocation
								idBase="wz-out"
								credentials={allCredentials}
								selectable={outputSelectable}
								browsable={outputKindIsBrowsable(state.output.kind)}
								credentialId={state.output.credentialId}
								showBucket={
									state.output.kind !== "SFTP" &&
									state.output.kind !== "AKAMAI_NETSTORAGE"
								}
								bucket={state.output.bucket}
								bucketLabel={locationLabel(state.output.kind)}
								path={
									splitOutputFolder(state.output.basePath, state.name) ??
									state.output.basePath
								}
								pathLabel={t("uiX.outputFolderLabel")}
								pathPlaceholder="output"
								pathHelp={t("uiX.jobOutputPathHint", {
									heightToken: "{height}",
									bitrateToken: "{bitrate}",
								})}
								onCredentialChange={(id) => {
									selectOutputCredential(id);
									if (id !== "" && isS3Credential(allCredentials, id)) {
										setPicker("output");
									}
								}}
								onChange={(p) =>
									patch({
										output: {
											...state.output,
											...(p.bucket !== undefined ? { bucket: p.bucket } : {}),
											...(p.path !== undefined
												? { basePath: joinOutputName(p.path, state.name) }
												: {}),
										},
									})
								}
								onBrowse={() => setPicker("output")}
							/>
							<GcsRegionControl
								idBase="wz-out"
								kind={state.output.kind}
								value={state.output.region}
								onChange={(region) =>
									patch({ output: { ...state.output, region } })
								}
							/>
							{outputKindHasAcl(state.output.kind) ? (
								<label
									htmlFor="wz-out-acl"
									className="flex items-center gap-2 text-sm text-zinc-300"
								>
									<input
										id="wz-out-acl"
										type="checkbox"
										className="h-4 w-4 accent-emerald-600"
										checked={state.output.publicRead}
										onChange={(e) =>
											patch({
												output: {
													...state.output,
													publicRead: e.target.checked,
												},
											})
										}
									/>
									{t("wizard.aclPublicReadNeededForDirectPlayback")}
								</label>
							) : null}

							<div className="space-y-2">
								<p className="flex items-center gap-1.5 font-medium text-xs text-zinc-300">
									{t("wizard.deliveryMirrors")}
									<HelpOverlay
										label={t("uiX.moreInformationFor", {
											label: t("wizard.deliveryMirrors"),
										})}
									>
										{t("wizardX.deliveryMirrorsHint")}
									</HelpOverlay>
								</p>
								{/* The mirror row was a HAND-ROLLED subset of StorageLocation —
								    a provider select and a bare bucket text box — so it never
								    got the picker the primary output has had all along, and the
								    owner had to type bucket names from memory (2026-08-20).
								    Re-implementing part of a component is how the two drifted;
								    using the component is what keeps them together. */}
								{state.additionalOutputs.map((mirror, index) => (
									<div key={index} className="flex items-start gap-2">
										<div className="min-w-0 flex-1">
											<StorageLocation
												idBase={`wz-mirror-${index}`}
												credentials={allCredentials}
												selectable={outputSelectable}
												browsable={outputKindIsBrowsable(mirror.kind)}
												credentialId={mirror.credentialId}
												credentialLabelText={t("uiX.namedNField", {
													item: t("wizard.deliveryMirror"),
													n: index + 1,
													field: t("common.provider"),
												})}
												showBucket={
													mirror.kind !== "SFTP" &&
													mirror.kind !== "AKAMAI_NETSTORAGE"
												}
												bucket={mirror.bucket}
												bucketLabel={locationLabel(mirror.kind)}
												/**
												 * No per-mirror path, and this is the mirror
												 * SEMANTIC rather than a missing feature: the
												 * compiler emits one EncodingOutput per mirror
												 * beside every destination with the SAME path and
												 * acl (`mirrorOutputRefs`), and the plan's
												 * `deliveryMirrors` carries only an `outputKey`.
												 * A prefix box here would collect a value with
												 * nowhere to go.
												 */
												showPath={false}
												path=""
												pathLabel=""
												bucketHelp={t("prose.deliveryMirrorPathsFollowPrimary")}
												onCredentialChange={(id) => {
													const provider = allCredentials.find(
														(c) => c.id === id,
													)?.provider;
													const next = applyMirrorCredentialSelection(
														state.additionalOutputs,
														index,
														id,
														outputKindForProvider(provider),
													);
													if (next !== null) {
														patch({ additionalOutputs: next });
													}
													if (id !== "" && isS3Credential(allCredentials, id)) {
														setPicker({ mirror: index });
													}
												}}
												onChange={(p) => {
													if (p.bucket === undefined) {
														return;
													}
													const next = [...state.additionalOutputs];
													const current = next[index];
													if (!current) {
														return;
													}
													next[index] = { ...current, bucket: p.bucket };
													patch({ additionalOutputs: next });
												}}
												onBrowse={() => setPicker({ mirror: index })}
											/>
											<GcsRegionControl
												idBase={`wz-mirror-${index}`}
												kind={mirror.kind}
												value={mirror.region}
												onChange={(region) =>
													patch({
														additionalOutputs: state.additionalOutputs.map(
															(entry, i) =>
																i === index ? { ...entry, region } : entry,
														),
													})
												}
											/>
										</div>
										<FieldRowAction>
											<RowRemoveButton
												label={t("common.deleteAria", {
													resource: `${t("wizard.deliveryMirror")} ${index + 1}`,
												})}
												onClick={() =>
													patch({
														additionalOutputs: state.additionalOutputs.filter(
															(_, i) => i !== index,
														),
													})
												}
											/>
										</FieldRowAction>
									</div>
								))}
								<Button
									type="button"
									variant="secondary"
									size="sm"
									onClick={() =>
										patch({
											additionalOutputs: [
												...state.additionalOutputs,
												{
													credentialId: "",
													kind: "S3",
													bucket: "",
													name: "Mirror Output",
												},
											],
										})
									}
								>
									{t("wizard.addDeliveryMirror")}
								</Button>
							</div>
						</>
					) : null}

					{step === 4 ? (
						<fieldset
							disabled={qcOnly}
							className={`space-y-6 ${qcOnly ? "opacity-50" : ""}`}
						>
							{qcOnly ? (
								<p className="rounded-md border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-amber-200/90 text-xs">
									{t("uiX.vmafOnlyPackagingNote")}
								</p>
							) : null}
							<MuxingsSection
								state={state}
								credentials={allCredentials}
								onPatch={patch}
							/>
							<ThumbnailsSection state={state} onPatch={patch} />
							<SpritesSection state={state} onPatch={patch} />
						</fieldset>
					) : null}

					{step === 6 ? (
						<ManifestSection state={state} onPatch={patch} />
					) : null}

					{step === 7 ? (
						<div className="space-y-3">
							<p className="text-sm text-zinc-400">
								{t("wizard.reviewThePlanOnTheRightThe")}
							</p>
							{!state.accountId ? (
								<p role="alert" className="text-amber-400 text-sm">
									{t("wizard.selectABitmovinAccountInStep1")}
								</p>
							) : null}
							{!qcOnly &&
							evaluation.ok &&
							evaluation.plan.manifests.length === 0 &&
							evaluation.plan.muxings.some((muxing) =>
								["FMP4", "CMAF", "TS", "WEBM", "CHUNKED_TEXT"].includes(
									muxing.kind,
								),
							) ? (
								<p className="text-amber-400 text-xs">
									{t("wizard.noManifestsSelectedSegmentsWillBeWritten")}
								</p>
							) : null}
							{formPlaceholders > 0 ? (
								<div role="alert" className="space-y-1 text-amber-400 text-sm">
									<p>
										{t("wizardX.samplePlaceholderPaths", {
											count: formPlaceholders,
										})}
										{t("wizard.mustBeReplacedWithYourRealObject")}
									</p>
									{/* WHICH tokens, at WHICH plan paths — the #80 pattern:
									    the data existed and only the count rendered. */}
									<PlaceholderRefsList refs={formPlaceholderRefs} />
								</div>
							) : null}
							{submit.isError ? (
								<p role="alert" className="text-red-400 text-sm">
									{submit.error instanceof ApiError
										? submit.error.message
										: t("wizard.submitFailed")}
								</p>
							) : null}
							{updateTemplate.isError ? (
								<p role="alert" className="text-red-400 text-sm">
									{updateTemplate.error instanceof ApiError &&
									updateTemplate.error.status === 409
										? t("templates.editConflict")
										: String(updateTemplate.error)}
								</p>
							) : null}
							{editPresetId ? (
								<Button
									disabled={
										internalBlocked ||
										!evaluation.ok ||
										evaluation.issues.some((i) => i.level === "error") ||
										formPlaceholders > 0 ||
										updateTemplate.isPending
									}
									onClick={() => updateTemplate.mutate()}
								>
									{updateTemplate.isPending
										? t("templates.updating")
										: t("templates.updateTemplate")}
								</Button>
							) : (
								<Button
									disabled={
										internalBlocked ||
										qcExecutionValidation.invalid ||
										!evaluation.ok ||
										!state.accountId ||
										evaluation.issues.some((i) => i.level === "error") ||
										formPlaceholders > 0 ||
										submit.isPending
									}
									onClick={() => submit.mutate()}
								>
									{submit.isPending
										? t("wizard.starting")
										: t("wizard.startEncoding")}
								</Button>
							)}
							<PlanPresetsPanel evaluation={evaluation} />
						</div>
					) : null}
				</div>

				<div className={`mt-8 flex gap-2 ${imported ? "hidden" : ""}`}>
					<Button
						variant="secondary"
						size="sm"
						disabled={step === 0}
						onClick={() => setStep((s) => Math.max(0, s - 1))}
					>
						{t("wizard.back")}
					</Button>
					<Button
						variant="secondary"
						size="sm"
						disabled={step === STEPS.length - 1}
						onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
					>
						{t("wizard.next")}
					</Button>
				</div>
			</div>

			<PlanPreview evaluation={evaluation} />

			<StoragePicker
				open={picker !== null}
				/*
				 * A mirror is a destination, so it browses like the output does
				 * (buckets offered for WRITING) rather than like an input file.
				 */
				mode={
					picker === "output" || (picker !== null && "mirror" in picker)
						? "prefix"
						: "object"
				}
				providers={[...BROWSABLE_STORAGE_PROVIDERS]}
				initialCredentialId={pickerSeed?.credentialId}
				initialBucket={pickerSeed?.bucket}
				onClose={() => setPicker(null)}
				onSelect={({ credentialId, bucket, path }) => {
					// Derive the storage kind from the SELECTED credential's provider —
					// never hard-code "S3", or browsing a GenericS3/GCS credential would
					// silently retarget the resource to an AWS S3 input/output.
					const provider = allCredentials.find(
						(c) => c.id === credentialId,
					)?.provider;
					if (picker === "output") {
						const kind = outputKindForProvider(provider) ?? "S3";
						setState((prev) => ({
							...prev,
							output: {
								...prev.output,
								credentialId,
								kind,
								name: outputNameForKind(kind),
								bucket,
								publicRead: outputKindHasAcl(kind)
									? prev.output.publicRead
									: false,
								// Picked prefix is the folder; namespace it by the job name.
								basePath: joinOutputName(path, prev.name),
							},
						}));
					} else if (picker !== null && "mirror" in picker) {
						/*
						 * ONLY the bucket. A mirror writes the primary output's paths
						 * into a different bucket — `deliveryMirrors` carries an
						 * `outputKey` and nothing else, and the compiler emits one
						 * EncodingOutput per mirror with the same path and acl. So a
						 * prefix the operator happened to navigate into has nowhere to
						 * go, and the field's help says so rather than letting them
						 * think it was recorded.
						 */
						const index = picker.mirror;
						const kind = outputKindForProvider(provider) ?? "S3";
						setState((prev) => {
							const mirrors = [...prev.additionalOutputs];
							const current = mirrors[index];
							if (!current) {
								return prev;
							}
							mirrors[index] = {
								...current,
								credentialId,
								kind,
								name: outputNameForKind(kind),
								bucket,
							};
							return { ...prev, additionalOutputs: mirrors };
						});
					} else if (picker !== null) {
						const index = picker.file;
						const kind = inputKindForProvider(provider);
						setState((prev) => {
							const files = [...prev.inputFiles];
							const current = files[index];
							if (!current) {
								return prev;
							}
							files[index] = {
								...current,
								credentialId,
								bucket,
								path,
								// Keep the row's kind in sync with the picked credential.
								...(kind !== null ? { kind } : {}),
							};
							return { ...prev, inputFiles: files };
						});
					}
				}}
			/>
		</section>
	);
}
