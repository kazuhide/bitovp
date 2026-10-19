"use client";

import {
	BITMOVIN_CLOUD_REGIONS,
	CREDENTIAL_PROVIDER_LABELS,
	type CredentialProviderId,
	type CredentialSummaryWire,
} from "@bitovp/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { BitmovinAccountDto } from "@/app/settings/bitmovin/types";
import {
	buildSubmissionPlan,
	importedAccountId,
} from "@/app/vod/new/plan-import";
import {
	BROWSABLE_STORAGE_PROVIDERS,
	liveOutputKindForProvider,
	outputKindIsBrowsable,
} from "@/app/vod/new/stream-model";
import { SaveAsTemplateButton } from "@/components/save-as-template";
import { StoragePicker } from "@/components/storage-picker";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative, Textarea } from "@/components/ui/input";
import { NewCredentialLink } from "@/components/ui/new-credential-link";
import { WizardDraftOffer } from "@/components/wizard-draft-offer";
import { apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { useCreationSubmission } from "@/lib/creation-submission-hook";
import { localizedCustomerError } from "@/lib/customer-error";
import { formatDateTime } from "@/lib/format";
import type { MessageKey } from "@/lib/i18n";
import { type Translator, useT } from "@/lib/i18n/context";
import {
	joinOutputName,
	renameOutputBase,
	splitOutputFolder,
} from "@/lib/output-path";
import { draftFingerprint, mergeWizardDraft } from "@/lib/wizard-draft";
import { useWizardDraft } from "@/lib/wizard-draft-hook";
import { LiveArchiveSection } from "./archive-section";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
	type LiveWizardState,
	withMslStreamFormat,
} from "./build-live-plan";
import { InputSection } from "./input-section";
import { LiveLadderSection } from "./ladder-section";
import {
	type ImportedLivePlan,
	parseImportedLivePlan,
} from "./live-plan-import";
import {
	evaluateLivePlanDocument,
	evaluateLiveWizardState,
	LivePlanPreview,
} from "./live-plan-preview";
import { tryImportLiveChannelIntoWizard } from "./live-plan-to-wizard";
import { LiveManifestsSection } from "./manifests-section";
import { LiveMirrorSection } from "./mirror-section";
import {
	EMPTY_SCHEDULE_DRAFT,
	type ScheduleDraft,
	ScheduleSection,
	scheduleFromDraft,
} from "./schedule-section";
import { LiveStartSection } from "./start-section";

/**
 * the step names an AWS MediaLive operator
 * expects — Input / Encodes / Destinations / Output groups / Schedule
 * actions — as LIVE-SPECIFIC keys. The generic `ui.*` labels the VOD wizard
 * shares (`ui.ladder`, `ui.start`, …) are deliberately not renamed: "Start"
 * read as "start the channel here", when the channel provisions the moment
 * it is created and that step holds the automatic restart / stop settings.
 */
const STEPS: MessageKey[] = [
	"liveWizard.stepBasics",
	"liveWizard.stepInput",
	"liveWizard.stepEncodes",
	"liveWizard.stepDestinations",
	"liveWizard.stepOutputGroups",
	"liveWizard.stepRunSafety",
	"liveWizard.stepScheduleActions",
	"liveWizard.stepReview",
];

const ENCODER_VERSION_OPTIONS = ["STABLE", "BETA"] as const;

class LocalizedWizardError extends Error {
	constructor(readonly customerMessage: string) {
		super("Local wizard validation failed");
	}
}

function wizardSubmitError(t: Translator, error: unknown): string {
	return error instanceof LocalizedWizardError
		? error.customerMessage
		: localizedCustomerError(t, error, "ui.createFailed");
}

export function LiveWizard({ duplicateFrom }: { duplicateFrom?: string } = {}) {
	const { t } = useT();
	const router = useRouter();
	const [step, setStep] = useState(0);
	const [scheduleDraft, setScheduleDraft] =
		useState<ScheduleDraft>(EMPTY_SCHEDULE_DRAFT);
	const [state, setState] = useState<LiveWizardState>(
		DEFAULT_LIVE_WIZARD_STATE,
	);
	const draftBase = useRef(DEFAULT_LIVE_WIZARD_STATE);
	const [appliedDraftContext, setAppliedDraftContext] = useState<string | null>(
		null,
	);
	// Plans the form cannot round-trip remain in expert mode for verbatim
	// preview and submission until edited as JSON or discarded.
	const [imported, setImported] = useState<ImportedLivePlan | null>(null);
	const [showImport, setShowImport] = useState(false);
	const [importText, setImportText] = useState("");
	const [importError, setImportError] = useState<string | null>(null);
	const [importLoadedForEditing, setImportLoadedForEditing] = useState(false);
	// Output storage browser (S3 prefix picker) — segments/manifests land here.
	const [browseOutput, setBrowseOutput] = useState(false);
	// Duplicate: ?from=<id> prefills the form from an existing channel's plan
	// (the clean retry for a failed channel — a fresh provision, no stale ids).
	const [appliedDuplicate, setAppliedDuplicate] = useState<string | null>(null);
	const [duplicatedFrom, setDuplicatedFrom] = useState<string | null>(null);
	const [duplicateError, setDuplicateError] = useState<string | null>(null);
	const validDuplicate = z.uuid().safeParse(duplicateFrom).success;

	const pinnedVersion = !ENCODER_VERSION_OPTIONS.some(
		(v) => v === state.encoderVersion,
	);
	const credentials = useQuery({
		queryKey: ["credentials"],
		queryFn: () => apiFetch<CredentialSummaryWire[]>("/api/credentials"),
	});
	const accounts = useQuery({
		queryKey: ["bitmovin-accounts"],
		queryFn: () => apiFetch<BitmovinAccountDto[]>("/api/bitmovin-accounts"),
	});
	const duplicate = useQuery({
		queryKey: ["live-channel-duplicate", duplicateFrom],
		refetchOnMount: "always",
		enabled: validDuplicate && duplicateFrom !== appliedDuplicate,
		retry: false,
		queryFn: () =>
			apiFetch<{ name?: string; plan: unknown }>(
				`/api/live-channels/${duplicateFrom}`,
			),
	});
	useEffect(() => {
		if (
			!validDuplicate ||
			duplicateFrom === undefined ||
			duplicateFrom === appliedDuplicate
		) {
			return;
		}
		// A failed read remains retryable; only a completed read is applied.
		if (duplicate.fetchStatus !== "idle" || !duplicate.isFetchedAfterMount)
			return;
		if (duplicate.isError) {
			setDuplicateError(
				t("uiX.couldNotLoadChannelToDuplicate", { id: duplicateFrom }),
			);
			return;
		}
		if (duplicate.data === undefined || duplicate.fetchStatus !== "idle") {
			return;
		}
		// Mark applied first so a parse failure can't loop the effect.
		setAppliedDuplicate(duplicateFrom);
		setDuplicateError(null);
		/**
		 * GATED, not just parsed .
		 *
		 * This used to be `setState(planToLiveWizardState(parsed.data))` on a
		 * successful parse. Parsing only proves the plan is well-formed; it says
		 * nothing about whether the FORM can carry it back. Anything the
		 * readback could not represent was dropped here in silence, and the
		 * operator duplicated a channel that differed from the one they clicked
		 * — measured three ways, each validating with zero errors. The gate
		 * rebuilds the plan from the reconstructed state and refuses unless it
		 * comes back identical, so a channel the form cannot express fails
		 * loudly instead of going on air changed.
		 */
		const imported = tryImportLiveChannelIntoWizard(duplicate.data.plan);
		if (imported.ok) {
			setState(imported.state);
			draftBase.current = imported.state;
			setAppliedDraftContext(
				`from:${duplicateFrom}:${draftFingerprint(duplicate.data.plan)}`,
			);
			setStep(0);
			setDuplicatedFrom(duplicate.data.name ?? duplicateFrom);
			// Keep the source URL so refreshing never silently becomes a blank
			// new-channel form. appliedDuplicate freezes this editing session.
		} else {
			// Either an older/edited stored plan that no longer parses as a live
			// plan, or one the form cannot rebuild exactly — the gate says which.
			setDuplicateError(
				t(imported.reasonKey, {
					name: duplicate.data.name ?? duplicateFrom,
				}),
			);
		}
	}, [
		// `t` formats the two duplicate-failure messages this effect can set; it is
		// stable per locale, so listing it does not re-run the duplication.
		t,
		duplicate.data,
		duplicate.fetchStatus,
		duplicate.isFetchedAfterMount,
		validDuplicate,
		duplicate.isError,
		duplicateFrom,
		appliedDuplicate,
	]);
	const allCredentials = credentials.data ?? [];
	const validationOptions = {
		credentialProviders: new Map(
			(credentials.data ?? []).map((c) => [c.id, c.provider]),
		),
	};
	const evaluation = imported
		? evaluateLivePlanDocument(imported.raw, t, validationOptions)
		: evaluateLiveWizardState(state, t, allCredentials, validationOptions);
	const planAccount = imported ? importedAccountId(imported) : undefined;

	/**
	 * the auto-shutdown that will actually be POSTed, from
	 * whichever half is authoritative. The imported plan wins when one is
	 * loaded (its payload is the import, verbatim); otherwise the FORM state,
	 * not `evaluation.plan` — a half-built wizard has no valid plan yet, and
	 * reading the evaluation would have kept the schedule step silent for
	 * exactly as long as the operator was still filling it in.
	 */
	const submittedAutoShutdown = imported
		? imported.evaluation.ok
			? imported.evaluation.plan.start.autoShutdown
			: null
		: state.start.autoShutdown;
	// : one derivation for the section, the review summary and the
	// submit body — they can never disagree about what will be scheduled.
	const scheduleVerdict = scheduleFromDraft(
		scheduleDraft,
		submittedAutoShutdown,
	);
	const draft = useWizardDraft({
		kind: "live",
		context:
			imported || importLoadedForEditing
				? null
				: duplicateFrom === undefined
					? "new"
					: appliedDuplicate === duplicateFrom && !duplicateError
						? appliedDraftContext
						: null,
		value: { ...state, schedule: scheduleDraft },
		step,
		onRestore: (saved) => {
			const { schedule, ...restored } = mergeWizardDraft(
				{ ...draftBase.current, schedule: EMPTY_SCHEDULE_DRAFT },
				saved.value,
				"live",
			);
			setState(restored);
			setScheduleDraft(schedule);
			setStep(saved.step);
		},
	});
	const creation = useCreationSubmission(
		"live",
		`wizard:${duplicateFrom ?? "new"}`,
	);
	const submit = useMutation({
		mutationFn: () => {
			const current = imported
				? evaluateLivePlanDocument(imported.raw, t, validationOptions)
				: evaluateLiveWizardState(state, t, allCredentials, validationOptions);
			if (!current.ok) throw new LocalizedWizardError(current.zodMessage);
			if (current.issues.some((i) => i.level === "error"))
				throw new LocalizedWizardError(t("ui.blocked"));
			const verdict = scheduleFromDraft(scheduleDraft, submittedAutoShutdown);
			if (!verdict.ok) {
				throw new LocalizedWizardError(
					t(verdict.errorKey as MessageKey, verdict.params),
				);
			}
			return creation.submit<{ id: string }>({
				plan: imported
					? buildSubmissionPlan(imported, state.accountId)
					: buildLiveChannelPlan(state),
				...(verdict.schedule ? { schedule: verdict.schedule } : {}),
			});
		},
		onSuccess: (channel) => {
			if (!imported && !importLoadedForEditing) draft.clear();
			router.push(`/live/${channel.id}`);
		},
	});

	const patch = (partial: Partial<LiveWizardState>) =>
		setState((prev) => ({ ...prev, ...partial }));

	// Live segment outputs: S3 / GenericS3 (Akamai/OCI) / GCS (HMAC + service
	// account) / Azure / SFTP per the plan output union.
	const outputSelectable = (provider: string) =>
		liveOutputKindForProvider(provider) !== null;

	function selectOutputCredential(id: string) {
		if (!id) {
			setState((prev) => ({
				...prev,
				output: { ...prev.output, credentialId: "" },
			}));
			setBrowseOutput(false);
			return;
		}
		const provider = allCredentials.find((c) => c.id === id)?.provider;
		// Shared provider→kind mapping (see stream-model). A provider with no I/O
		// kind (role-based, DRM, live-ingest) is skipped — never collapsed to S3.
		const kind = liveOutputKindForProvider(provider);
		if (kind === null) {
			console.warn(
				`[live-wizard] Unsupported output provider "${provider}" is not selectable as live I/O; ignoring selection.`,
			);
			return;
		}
		setState((prev) => {
			const withOutput: typeof prev = {
				...prev,
				/*
				 * Clearing the MSL delivery format when the destination stops being
				 * MSL. This line used to read `akamaiMsl: undefined`, which was a
				 * NO-OP: the same refactor that made MSL a credential renamed the
				 * field to `mslStreamFormat`, and an object spread takes an unknown
				 * key without complaint, so the comment above it claimed the clearing
				 * mattered while nothing was being cleared.
				 */
				output: {
					...prev.output,
					credentialId: id,
					kind,
					...(kind === "AKAMAI_MSL"
						? {}
						: { mslStreamFormat: undefined, mslVersion: undefined }),
				},
			};
			/*
			 * apply the MSL format normalization
			 * on CREDENTIAL SELECT, not only when the operator touches the format
			 * dropdown.
			 *
			 * The dropdown displays `mslStreamFormat ?? "HLS"`, so selecting an MSL
			 * credential shows HLS immediately — but the ladder stayed on its fMP4
			 * default until the dropdown's onChange ran `withMslStreamFormat`. The
			 * shortest normal path (pick MSL, leave the default HLS, submit) then
			 * built a plan whose DISPLAY said HLS over an fMP4 ladder — a C31 error
			 * at save the operator never touched. Running it here makes the ladder
			 * (TS for HLS) and the manifest families agree with the display without
			 * a click. Re-selecting an MSL credential keeps the current format;
			 * arriving fresh takes the same "HLS" the display defaults to.
			 */
			if (kind === "AKAMAI_MSL") {
				return withMslStreamFormat(
					withOutput,
					prev.output.mslStreamFormat ?? "HLS",
				);
			}
			if (kind === "LIVE_MEDIA_INGEST")
				return {
					...withOutput,
					output: { ...withOutput.output, publicRead: false },
					videos: withOutput.videos.map((v) => ({
						...v,
						container: v.codec === "H264" ? "CMAF" : "FMP4",
						muxedAudioKeys: [],
					})),
					audios: withOutput.audios.map((a) => ({
						...a,
						container: a.codec === "AAC" ? "CMAF" : "FMP4",
						ownContainer: true,
					})),
					manifests: {
						hls: { ...withOutput.manifests.hls, enabled: false },
						dash: { ...withOutput.manifests.dash, enabled: false },
					},
				};
			if (prev.output.kind === "LIVE_MEDIA_INGEST")
				return {
					...withOutput,
					manifests: {
						hls: { ...withOutput.manifests.hls, enabled: true },
						dash: { ...withOutput.manifests.dash, enabled: true },
					},
				};
			return withOutput;
		});
		// Owner request 2026-09-06: browsable destinations open the prefix picker
		// on selection, as the VOD output step does — no extra "browse" click.
		if (
			provider !== undefined &&
			(BROWSABLE_STORAGE_PROVIDERS as readonly string[]).includes(provider)
		) {
			setBrowseOutput(true);
		}
	}

	/**
	 * . Output kind used to be derived ONLY from the chosen
	 * credential's provider, which made a credential-less destination
	 * unreachable — not because the API needs one (it does not: MSL
	 * authenticates with the account API key and its body carries streamId,
	 * eventName, streamFormat, mslVersion) but because that was how we happened
	 * to have built the step. The owner pointed this out; it was our
	 * implementation choice quietly acting as a constraint.
	 */

	const submitDisabled =
		!evaluation.ok ||
		(!state.accountId && !planAccount) ||
		evaluation.issues.some((i) => i.level === "error") ||
		submit.isPending;

	const submitButton = (label: string) => (
		<Button disabled={submitDisabled} onClick={() => submit.mutate()}>
			{submit.isPending ? t("ui.creating") : label}
		</Button>
	);

	if (
		duplicateFrom !== undefined &&
		(!validDuplicate || duplicateError || duplicateFrom !== appliedDuplicate)
	) {
		return (
			<section className="space-y-4">
				<h1 className="font-semibold text-xl text-zinc-50">
					{t("live.duplicate")}
				</h1>
				{!validDuplicate || duplicateError ? (
					<p role="alert" className="text-red-400 text-sm">
						{duplicateError ??
							t("uiX.couldNotLoadChannelToDuplicate", { id: duplicateFrom })}
					</p>
				) : (
					<p role="status" className="text-sm text-zinc-400">
						{t("common.loading")}
					</p>
				)}
				{validDuplicate && duplicate.isError ? (
					<Button
						variant="secondary"
						disabled={duplicate.isFetching}
						onClick={() => duplicate.refetch()}
					>
						{t("common.retry")}
					</Button>
				) : null}
			</section>
		);
	}

	return (
		<section className="grid min-h-[70vh] grid-cols-1 gap-6 xl:grid-cols-[1fr_420px]">
			<div>
				<header className="flex flex-wrap items-center justify-between gap-3">
					<h1 className="font-semibold text-xl text-zinc-50">
						{t("ui.newLiveChannel")}
					</h1>
					{!imported ? (
						<Button
							variant="secondary"
							size="sm"
							onClick={() => setShowImport((v) => !v)}
						>
							{showImport ? t("ui.hideImport") : t("ui.importPlanJson")}
						</Button>
					) : null}
				</header>
				<WizardDraftOffer {...draft} />
				{importLoadedForEditing && !imported ? (
					<p role="status" className="mt-4 text-emerald-300 text-sm">
						{t("wizardX.importLoadedForEditing")}
					</p>
				) : null}

				{duplicatedFrom ? (
					<p className="mt-4 rounded-md border border-emerald-900 bg-emerald-950/40 px-3 py-2 text-emerald-300 text-sm">
						{t("uiX.duplicatedFromNamed", { name: duplicatedFrom })}
					</p>
				) : null}

				{duplicateError ? (
					<p
						role="alert"
						className="mt-4 rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-amber-300 text-sm"
					>
						{duplicateError}
					</p>
				) : null}

				{showImport && !imported ? (
					<div className="mt-4 space-y-2">
						<Field
							label={t("ui.liveChannelPlanJson")}
							htmlFor="lw-import"
							help={t("ui.pasteALivechannelplanEGALive")}
						>
							<Textarea
								id="lw-import"
								rows={8}
								value={importText}
								onChange={(e) => setImportText(e.target.value)}
							/>
						</Field>
						{importError ? (
							<p role="alert" className="text-red-400 text-sm">
								{importError}
							</p>
						) : null}
						<Button
							variant="secondary"
							size="sm"
							onClick={() => {
								const result = parseImportedLivePlan(importText, t);
								if (!result.ok) {
									setImportError(
										t(result.errorKey, {
											...(result.errorDetail === undefined
												? {}
												: {
														detail:
															result.errorDetail ??
															t("wizardX.importParseError"),
													}),
										}),
									);
									return;
								}
								setImportError(null);
								const editable = tryImportLiveChannelIntoWizard(
									result.imported.raw,
								);
								if (editable.ok) {
									setState(editable.state);
									draftBase.current = editable.state;
									setScheduleDraft(EMPTY_SCHEDULE_DRAFT);
									setStep(0);
									setShowImport(false);
									setImported(null);
									setImportLoadedForEditing(true);
								} else {
									// Keep the original payload when form conversion would lose options.
									setImported(result.imported);
								}
							}}
						>
							{t("ui.loadPlan")}
						</Button>
					</div>
				) : null}

				{imported ? (
					<div className="mt-6 space-y-3">
						<p className="text-sm text-zinc-400">
							{t("wizardX.importCannotEditWithoutLoss")}
						</p>
						{planAccount ? (
							<p className="text-sm text-zinc-400">
								{t("uiX.bitmovinAccountFromPlan")}{" "}
								<span className="font-mono text-zinc-300">{planAccount}</span>
							</p>
						) : (
							<Field
								label={t("ui.bitmovinAccount")}
								htmlFor="lw-import-account"
								help={t("ui.injectedIntoBitmovinAccountidTheOneException")}
							>
								<SelectNative
									id="lw-import-account"
									value={state.accountId}
									onChange={(e) => patch({ accountId: e.target.value })}
								>
									<option value="">{t("ui.selectAccount")}</option>
									{state.accountId &&
									!(accounts.data ?? []).some(
										(account) => account.id === state.accountId,
									) ? (
										<option value={state.accountId}>
											{state.accountId}{" "}
											{accounts.isSuccess ? t("wizardX.missingParen") : ""}
										</option>
									) : null}
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
								{wizardSubmitError(t, submit.error)}
							</p>
						) : null}
						<div className="flex gap-2">
							{submitButton(t("ui.createChannelImportedPlan"))}
							{evaluation.ok &&
							!evaluation.issues.some((issue) => issue.level === "error") ? (
								<RoleAccess control="live.new.template">
									<SaveAsTemplateButton
										kind="LIVE_PLAN"
										plan={
											state.accountId
												? buildSubmissionPlan(imported, state.accountId)
												: imported.raw
										}
										defaultName={
											typeof imported.raw.name === "string"
												? imported.raw.name
												: ""
										}
									/>
								</RoleAccess>
							) : null}
							<Button
								variant="secondary"
								onClick={() => {
									setImportText(JSON.stringify(imported.raw, null, 2));
									setImported(null);
									setShowImport(true);
								}}
							>
								{t("wizardX.importEditJson")}
							</Button>
							<Button variant="secondary" onClick={() => setImported(null)}>
								{t("ui.discardImport")}
							</Button>
						</div>
					</div>
				) : null}

				{(
					[
						{ query: credentials, message: "wizard.credentialsLoadFailed" },
						{ query: accounts, message: "wizard.accountsLoadFailed" },
					] as const
				).map(({ query, message }) =>
					query.isError ? (
						<div key={message} className="mt-4 space-y-2">
							<p role="alert" className="text-red-400 text-sm">
								{t(message)}
							</p>
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

				<nav
					aria-label={t("ui.wizardSteps")}
					hidden={!!imported}
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

				<div
					hidden={!!imported}
					className={`mt-6 space-y-4 ${imported ? "hidden" : ""}`}
				>
					{step === 0 ? (
						<>
							<Field label={t("ui.channelName")} htmlFor="lw-name">
								<Input
									id="lw-name"
									value={state.name}
									placeholder="my-live-channel"
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
								label={t("ui.bitmovinAccount")}
								htmlFor="lw-account"
								help={t("ui.configuredInSettingsBitmovinAccounts")}
							>
								<SelectNative
									id="lw-account"
									value={state.accountId}
									onChange={(e) => patch({ accountId: e.target.value })}
								>
									<option value="">{t("ui.selectAccount")}</option>
									{state.accountId &&
									!(accounts.data ?? []).some(
										(account) => account.id === state.accountId,
									) ? (
										<option value={state.accountId}>
											{state.accountId}{" "}
											{accounts.isSuccess ? t("wizardX.missingParen") : ""}
										</option>
									) : null}
									{(accounts.data ?? []).map((account) => (
										<option key={account.id} value={account.id}>
											{account.label}
										</option>
									))}
								</SelectNative>
							</Field>
							<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
								<Field label={t("ui.cloudRegion")} htmlFor="lw-region">
									<SelectNative
										id="lw-region"
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
									label={t("ui.encoderVersion")}
									htmlFor="lw-version"
									help={
										pinnedVersion ? t("ui.pinnedVersionEG22660") : undefined
									}
								>
									<div className="flex gap-2">
										<SelectNative
											id="lw-version"
											className="w-36"
											value={pinnedVersion ? "PINNED" : state.encoderVersion}
											onChange={(e) =>
												patch({
													encoderVersion:
														e.target.value === "PINNED" ? "" : e.target.value,
												})
											}
										>
											{ENCODER_VERSION_OPTIONS.map((v) => (
												<option key={v} value={v}>
													{v}
												</option>
											))}
											<option value="PINNED">{t("ui.pinnedVersion")}</option>
										</SelectNative>
										{pinnedVersion ? (
											<Input
												aria-label={t("ui.pinnedEncoderVersion")}
												placeholder="2.266.0"
												value={state.encoderVersion}
												onChange={(e) =>
													patch({ encoderVersion: e.target.value })
												}
											/>
										) : null}
									</div>
								</Field>
							</div>
						</>
					) : null}

					{step === 1 ? (
						<InputSection
							state={state}
							credentials={allCredentials}
							onPatch={patch}
						/>
					) : null}

					{step === 2 ? (
						<LiveLadderSection state={state} onPatch={patch} />
					) : null}

					{step === 3 ? (
						<>
							<Field
								label={t("ui.outputCredential")}
								htmlFor="lw-out-cred"
								help={t("ui.s3AzureBlobSftpLiveSegmentsAnd")}
							>
								<SelectNative
									id="lw-out-cred"
									value={state.output.credentialId}
									onChange={(e) => selectOutputCredential(e.target.value)}
								>
									<option value="">{t("ui.selectCredential")}</option>
									{state.output.credentialId &&
									!allCredentials.some(
										(c) => c.id === state.output.credentialId,
									) ? (
										<option value={state.output.credentialId}>
											{state.output.credentialId}{" "}
											{credentials.isSuccess ? t("wizardX.missingParen") : ""}
										</option>
									) : null}
									{allCredentials.map((c) => (
										<option
											key={c.id}
											value={c.id}
											disabled={!outputSelectable(c.provider)}
										>
											{/* The provider's LABEL, not its enum — same reason
											 * as the VOD source step: this is the name the
											    credentials screen uses for the same thing. */}
											{c.label} (
											{
												CREDENTIAL_PROVIDER_LABELS[
													c.provider as CredentialProviderId
												]
											}
											)
										</option>
									))}
								</SelectNative>
							</Field>
							<NewCredentialLink />
							{state.output.kind === "LIVE_MEDIA_INGEST" ? (
								<Field
									label={t("fields.lmiScte35Passthrough")}
									htmlFor="lw-lmi-scte35"
									tooltip={t("fields.lmiScte35Help")}
								>
									<input
										id="lw-lmi-scte35"
										type="checkbox"
										checked={state.output.scte35Passthrough ?? false}
										onChange={(e) =>
											patch({
												output: {
													...state.output,
													scte35Passthrough: e.target.checked,
												},
											})
										}
									/>
								</Field>
							) : null}
							{state.output.kind === "AKAMAI_MSL" ? (
								<Field
									label={t("live.mslStreamFormat")}
									htmlFor="lw-msl-format"
									help={t("live.mslStreamFormatHelp")}
								>
									<SelectNative
										id="lw-msl-format"
										value={state.output.mslStreamFormat ?? "HLS"}
										onChange={(e) => {
											/*
											 * The ladder moves WITH the format, or two of the three
											 * options are present-but-unusable: DASH over a TS
											 * ladder is a C31 error at save time that the operator
											 * did not cause. `withMslStreamFormat` sets the segment
											 * container on every rendition and switches the
											 * manifest families — C1's "auto-switch and explain"
											 * rather than "validate at them afterwards".
											 *
											 * RESTORED 2026-08-21. The refactor that made MSL a
											 * credential deleted `MslOutputFields`, which was
											 * right for streamId and eventName — those ARE account
											 * facts — and wrong for this one, which the same
											 * commit's own note calls "a plan choice rather than
											 * an account fact". `withMslStreamFormat` was left
											 * exported, unit-tested, and called by NOBODY, so
											 * every MSL channel silently took the `?? "HLS"`
											 * default at emit with a ladder that was never
											 * adjusted to match it.
											 */
											const next = withMslStreamFormat(
												state,
												e.target.value as "DASH" | "HLS" | "CMAF",
											);
											patch({
												videos: next.videos,
												audios: next.audios,
												manifests: next.manifests,
												output: next.output,
											});
										}}
									>
										<option value="HLS">HLS</option>
										<option value="DASH">DASH</option>
										<option value="CMAF">CMAF</option>
									</SelectNative>
								</Field>
							) : null}
							{state.output.kind === "AKAMAI_MSL" ? (
								<Field
									label={t("live.mslVersion")}
									htmlFor="lw-msl-version"
									help={t("live.mslVersionHelp")}
								>
									<SelectNative
										id="lw-msl-version"
										value={state.output.mslVersion ?? "MSL4"}
										onChange={(e) => {
											/*
											 *  PR 1, and the control did not exist until
											 * the `live-akamai-msl5` fixture's round-trip proved the
											 * form could only author MSL4 — whatever the schema
											 * allowed. MSL5 was reachable by raw-JSON import alone.
											 *
											 * Unlike the stream format above, this moves NOTHING
											 * else in the state: the version changes the segment
											 * NAMING grammar, which `buildLivePlan` derives at emit
											 * from core's single source. The format had to move the
											 * ladder because DASH-over-TS is a C31 error the
											 * operator did not cause; a version change cannot
											 * invalidate a ladder.
											 *
											 * MSL4 stays the default: it is the incumbent until its
											 * EOL 2026-12-31, and defaulting to MSL5 would silently
											 * re-point every existing channel's protocol on edit.
											 */
											patch({
												output: {
													...state.output,
													mslVersion: e.target.value as "MSL4" | "MSL5",
												},
											});
										}}
									>
										<option value="MSL4">MSL4</option>
										<option value="MSL5">MSL5</option>
									</SelectNative>
								</Field>
							) : null}
							{/* AKAMAI_MSL joins these two. The plan's MSL output carries a
							 * credential and a streamFormat and NO bucket, so asking for one
							 * invites a value the plan has no field to put it in. Only the
							    Browse BUTTON was guarded — the box itself still rendered. */}
							{state.output.kind !== "SFTP" &&
							state.output.kind !== "AKAMAI_MSL" &&
							state.output.kind !== "LIVE_MEDIA_INGEST" &&
							state.output.kind !== "AKAMAI_NETSTORAGE" ? (
								<Field
									label={
										state.output.kind === "AZURE"
											? t("ui.container")
											: t("ui.bucket")
									}
									htmlFor="lw-out-bucket"
								>
									<div className="flex gap-2">
										<Input
											id="lw-out-bucket"
											value={state.output.bucket}
											onChange={(e) =>
												patch({
													output: { ...state.output, bucket: e.target.value },
												})
											}
										/>
										{/* No MSL clause here any more, and tsc is the reason: with
										 * the field itself excluding MSL, the comparison became
										 * provably dead (TS2367). It had been the ONLY guard —
										 * the bucket box rendered for MSL and only the button
										    was hidden. */}
										{outputKindIsBrowsable(state.output.kind) ? (
											<Button
												variant="secondary"
												size="sm"
												onClick={() => setBrowseOutput(true)}
											>
												{t("ui.browse")}
											</Button>
										) : null}
									</div>
								</Field>
							) : null}
							<Field
								label={t("ui.outputFolder")}
								htmlFor="lw-out-base"
								help={t("ui.theChannelNameIsAppendedAutomaticallyOutputs", {
									heightToken: "{height}",
									bitrateToken: "{bitrate}",
								})}
							>
								<Input
									id="lw-out-base"
									placeholder="output"
									value={
										splitOutputFolder(state.output.basePath, state.name) ??
										state.output.basePath
									}
									onChange={(e) =>
										patch({
											output: {
												...state.output,
												basePath: joinOutputName(e.target.value, state.name),
											},
										})
									}
								/>
							</Field>
							{state.output.kind !== "SFTP" &&
							state.output.kind !== "LIVE_MEDIA_INGEST" &&
							state.output.kind !== "AKAMAI_NETSTORAGE" ? (
								<label
									htmlFor="lw-out-acl"
									className="flex items-center gap-2 text-sm text-zinc-300"
								>
									<input
										id="lw-out-acl"
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
						</>
					) : null}

					{step === 3 ? (
						<LiveMirrorSection
							state={state}
							credentials={allCredentials}
							onPatch={patch}
						/>
					) : null}
					{step === 3 ? (
						<LiveArchiveSection
							state={state}
							credentials={allCredentials}
							onPatch={patch}
						/>
					) : null}
					{step === 4 ? (
						<LiveManifestsSection state={state} onPatch={patch} />
					) : null}

					{step === 5 ? (
						<LiveStartSection
							state={state}
							onPatch={patch}
							scheduledEndAt={
								scheduleVerdict.ok && scheduleVerdict.schedule
									? scheduleVerdict.schedule.programEndAt
									: null
							}
						/>
					) : null}

					{step === 6 ? (
						<ScheduleSection
							draft={scheduleDraft}
							onPatch={(partial) =>
								setScheduleDraft((prev) => ({ ...prev, ...partial }))
							}
							autoShutdown={submittedAutoShutdown}
						/>
					) : null}
					{step === 7 ? (
						<div className="space-y-3">
							<p className="text-sm text-zinc-400">
								{t("ui.reviewThePlanOnTheRightThe")}
							</p>
							{scheduleVerdict.ok && scheduleVerdict.schedule ? (
								// The SAME derivation the submit body uses — the
								// summary cannot show a slot the server won't get.
								<p className="text-emerald-400 text-sm">
									{t("schedule.reviewLine", {
										up: formatDateTime(scheduleVerdict.schedule.streamUpAt),
										start: formatDateTime(
											scheduleVerdict.schedule.programStartAt,
										),
										end: formatDateTime(scheduleVerdict.schedule.programEndAt),
										slate: scheduleVerdict.schedule.slate
											? t("schedule.reviewSlateSuffix")
											: "",
									})}
								</p>
							) : null}
							{scheduleDraft.enabled && !scheduleVerdict.ok ? (
								<p role="alert" className="text-amber-400 text-sm">
									{t(
										scheduleVerdict.errorKey as MessageKey,
										scheduleVerdict.params,
									)}
								</p>
							) : null}
							{!state.accountId ? (
								<p role="alert" className="text-amber-400 text-sm">
									{t("ui.selectABitmovinAccountInStep1")}
								</p>
							) : null}
							{submit.isError ? (
								<p role="alert" className="text-red-400 text-sm">
									{wizardSubmitError(t, submit.error)}
								</p>
							) : null}
							<div className="flex flex-wrap items-center gap-2">
								{submitButton(t("ui.createLiveChannel"))}
								{evaluation.ok &&
								!evaluation.issues.some((issue) => issue.level === "error") ? (
									<RoleAccess control="live.new.template">
										<SaveAsTemplateButton
											kind="LIVE_PLAN"
											plan={buildLiveChannelPlan(state)}
											defaultName={state.name}
										/>
									</RoleAccess>
								) : null}
							</div>
						</div>
					) : null}
				</div>

				<div
					hidden={!!imported}
					className={`mt-8 flex gap-2 ${imported ? "hidden" : ""}`}
				>
					<Button
						variant="secondary"
						size="sm"
						disabled={step === 0}
						onClick={() => setStep((s) => Math.max(0, s - 1))}
					>
						{t("ui.back")}
					</Button>
					<Button
						variant="secondary"
						size="sm"
						disabled={step === STEPS.length - 1}
						onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
					>
						{t("ui.next")}
					</Button>
				</div>
			</div>

			<LivePlanPreview evaluation={evaluation} />

			<StoragePicker
				open={browseOutput}
				mode="prefix"
				providers={[...BROWSABLE_STORAGE_PROVIDERS]}
				initialCredentialId={state.output.credentialId}
				initialBucket={state.output.bucket}
				onClose={() => setBrowseOutput(false)}
				onSelect={({ credentialId, bucket, path }) => {
					// Derive the kind from the SELECTED credential — never hard-code
					// "S3", or browsing a GenericS3/GCS credential would retarget to AWS.
					const provider = allCredentials.find(
						(c) => c.id === credentialId,
					)?.provider;
					const kind = liveOutputKindForProvider(provider) ?? "S3";
					setState((prev) => ({
						...prev,
						output: {
							...prev.output,
							// The picker only ever lands on a bucketed destination, so
							// any MSL delivery format left over is stale. (Was
							// `akamaiMsl: undefined` — a key that no longer exists, so
							// it cleared nothing.)
							mslStreamFormat: undefined,
							mslVersion: undefined,
							credentialId,
							kind,
							bucket,
							// Picked prefix is the folder; namespace it by the channel name.
							basePath: joinOutputName(path, prev.name),
						},
					}));
					setBrowseOutput(false);
				}}
			/>
		</section>
	);
}
