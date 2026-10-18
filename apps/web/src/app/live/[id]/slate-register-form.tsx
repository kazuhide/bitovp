"use client";

import { SLATE_SUPPORTED_PROVIDERS, type SlateDifference } from "@bitovp/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { summarizeProbe } from "@/app/storage/inspect-shared";
import { StoragePicker } from "@/components/storage-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import {
	apiCustomerErrorCode,
	localizedCustomerError,
	slateDifferencesOf,
} from "@/lib/customer-error";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";
import {
	mediaAttributeLabel,
	mediaDifferenceText,
} from "@/lib/i18n/media-difference";
import { zodIssueMessage } from "@/lib/i18n/zod-issue-message";
import {
	type InsertableContentDto,
	insertableContentCreateSchema,
	type SlateNormalizationDto,
	type SlatePreflightDto,
	type SlatePreflightStandDown,
} from "@/lib/live-runtime/schemas";
import { Disclosure } from "./disclosure";
import { InputIdPicker } from "./input-id-picker";

/**
 * Register slate content by PICKING the file (C36 / WP-A1).
 *
 * The previous form took a Bitmovin input id and a typed path and handed them
 * to the provider, whose READY meant "registered" and nothing else — measured
 * 2026-09-02, a clip at the wrong frame rate / sample rate registered READY
 * and failed at air time. This form browses the vaulted storage instead
 * (credential → bucket → object, the same picker the wizards use), then asks
 * the server to CHECK the file against the live ingest before the register
 * button enables. The check is the server's (`…/insertable-content/preflight`)
 * so the verdict shown here is the verdict the registration route enforces.
 *
 * The raw `inputId` / `inputPath` form stays, under an advanced disclosure,
 * for content that lives on an input this app does not vault; it goes through
 * the same check, which stands down — and says so — when nothing can probe it.
 */

const POLL_MS = 2000;

/** The source the operator is describing, in either shape. */
type Draft =
	| { kind: "source"; credentialId: string; bucket: string; key: string }
	| { kind: "input"; inputId: string; inputPath: string };

const STAND_DOWN_KEY: Record<SlatePreflightStandDown, MessageKey> = {
	NO_INGEST_REFERENCE: "contentInsertion.standDownNoIngestReference",
	NO_PROBE: "contentInsertion.standDownNoProbe",
	NO_CREDENTIAL: "contentInsertion.standDownNoCredential",
	INPUT_UNRESOLVED: "contentInsertion.standDownInputUnresolved",
	INSPECTION_FAILED: "contentInsertion.standDownInspectionFailed",
	NO_COMPARABLE_ATTRIBUTE: "contentInsertion.standDownNoComparableAttribute",
};

/**
 * : core's REFUSE reasons are a fixed set of English sentences;
 * the operator reads them by code, never interpolated (the same discipline
 * as `STAND_DOWN_KEY`). An unknown reason gets the generic line.
 */
function refuseReasonKey(reason: string): MessageKey {
	if (reason.includes("could not be probed")) {
		return "contentInsertion.prepRefusedUnprobed";
	}
	if (reason.includes("no container")) {
		return "contentInsertion.prepRefusedNoContainer";
	}
	if (reason.includes("no video stream")) {
		return "contentInsertion.prepRefusedNoVideo";
	}
	if (reason.includes("inspection failed")) {
		return "contentInsertion.prepRefusedInspection";
	}
	return "contentInsertion.prepRefused";
}

function draftKey(draft: Draft | null): string {
	return draft === null ? "" : JSON.stringify(draft);
}

function preflightBody(draft: Draft, bitmovinAccountId: string) {
	return draft.kind === "source"
		? {
				bitmovinAccountId,
				source: {
					credentialId: draft.credentialId,
					bucket: draft.bucket,
					key: draft.key,
				},
			}
		: {
				bitmovinAccountId,
				input: { inputId: draft.inputId, inputPath: draft.inputPath },
			};
}

export function SlateRegisterForm({
	channelId,
	bitmovinAccountId,
	onRegistered,
}: {
	channelId: string;
	bitmovinAccountId: string;
	onRegistered: () => void;
}) {
	const { t } = useT();
	const queryClient = useQueryClient();
	const base = `/api/live-channels/${channelId}/insertable-content`;
	const [contentName, setContentName] = useState("");
	const [picked, setPicked] = useState<Draft | null>(null);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [inputId, setInputId] = useState("");
	const [inputPath, setInputPath] = useState("");
	const [advanced, setAdvanced] = useState(false);
	/** The draft the operator asked to check — the query is armed for it only. */
	const [checkedFor, setCheckedFor] = useState("");
	const [issues, setIssues] = useState<string[]>([]);

	const draft: Draft | null = advanced
		? inputId.trim() !== "" && inputPath.trim() !== ""
			? { kind: "input", inputId: inputId.trim(), inputPath: inputPath.trim() }
			: null
		: picked;
	const currentKey = draftKey(draft);
	const armed = draft !== null && checkedFor === currentKey;

	const preflight = useQuery({
		queryKey: ["slate-preflight", channelId, currentKey],
		enabled: armed,
		retry: false,
		queryFn: () =>
			apiFetch<SlatePreflightDto>(`${base}/preflight`, {
				method: "POST",
				body: JSON.stringify(preflightBody(draft as Draft, bitmovinAccountId)),
			}),
		// PENDING = the worker is probing the object; poll until the verdict.
		refetchInterval: (query) =>
			query.state.data?.status === "PENDING" ? POLL_MS : false,
	});
	const verdict = armed ? preflight.data : undefined;
	// : for a PICKED file the server converts what does not match (or
	// waits for the input), so only a refusal keeps the button off. The raw
	// input-id shape has no credential to write with and keeps the C36 gate.
	const canRegister =
		verdict?.status === "DONE" &&
		(draft?.kind === "source" && verdict.preparation
			? verdict.preparation.action !== "REFUSE"
			: verdict.verdict === "OK" || verdict.verdict === "UNVERIFIED");
	/** The 202 body: the registration is now the worker's, watched in the panel. */
	const [accepted, setAccepted] = useState<SlateNormalizationDto | null>(null);

	const create = useMutation({
		mutationFn: (payload: unknown) =>
			apiFetch<
				InsertableContentDto & {
					preflight?: SlatePreflightDto;
					normalization?: SlateNormalizationDto;
				}
			>(base, {
				method: "POST",
				body: JSON.stringify({ bitmovinAccountId, content: payload }),
			}),
		onSuccess: (result) => {
			setAccepted(result.normalization ?? null);
			setContentName("");
			setPicked(null);
			setInputId("");
			setInputPath("");
			setCheckedFor("");
			onRegistered();
		},
		onError: (error) => {
			// The inspection finished between our check and the register: the
			// route re-checked and found it running — re-arm the poll.
			if (apiCustomerErrorCode(error) === "SLATE_UNINSPECTED") {
				void queryClient.invalidateQueries({
					queryKey: ["slate-preflight", channelId, currentKey],
				});
			}
		},
	});

	const submitCreate = () => {
		setIssues([]);
		if (draft === null) {
			return;
		}
		const parsed = insertableContentCreateSchema.safeParse({
			...(contentName !== "" ? { name: contentName } : {}),
			...(draft.kind === "source"
				? {
						source: {
							credentialId: draft.credentialId,
							bucket: draft.bucket,
							key: draft.key,
						},
					}
				: { inputs: [{ inputId: draft.inputId, inputPath: draft.inputPath }] }),
		});
		if (!parsed.success) {
			setIssues(
				parsed.error.issues.map(
					(issue) =>
						`${issue.path.join(".") || "input"}: ${zodIssueMessage(issue, t)}`,
				),
			);
			return;
		}
		create.mutate(parsed.data);
	};

	// Both pre-rendered HERE, through the safe renderers, so no raw error
	// object is handed to a child: the customer copy gate reads this file.
	const createMessage = create.error
		? localizedCustomerError(t, create.error, "contentInsertion.requestFailed")
		: null;
	const createDifferences = slateDifferencesOf(create.error);
	const preflightMessage = preflight.error
		? localizedCustomerError(
				t,
				preflight.error,
				"contentInsertion.requestFailed",
			)
		: null;

	return (
		<section className="rounded-md border border-zinc-800 p-3">
			<h4 className="font-medium text-xs text-zinc-300">
				{t("contentInsertion.register")}
			</h4>
			<p className="mt-1 text-xs text-zinc-500">
				{t("contentInsertion.registerLead")}
			</p>

			{issues.length > 0 ? (
				<ul role="alert" className="mt-2 space-y-0.5 text-red-400 text-xs">
					{issues.map((issue) => (
						<li key={issue}>{issue}</li>
					))}
				</ul>
			) : null}
			{createMessage ? (
				<div role="alert" className="mt-2 space-y-1 text-red-400 text-sm">
					<p>{createMessage}</p>
					{createDifferences.length > 0 ? (
						<DifferenceList differences={createDifferences} />
					) : null}
				</div>
			) : null}

			<div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
				<Field label={t("contentInsertion.nameOptional")} htmlFor="ic-name">
					<Input
						id="ic-name"
						placeholder={t("contentInsertion.namePlaceholder")}
						value={contentName}
						onChange={(e) => setContentName(e.target.value)}
					/>
				</Field>
				{advanced ? null : (
					<Field
						label={t("contentInsertion.sourceFile")}
						htmlFor="ic-source"
						help={t("contentInsertion.sourceFileHelp")}
						trailing={
							<Button
								type="button"
								variant="secondary"
								size="sm"
								onClick={() => setPickerOpen(true)}
							>
								{t("feeder.browseStorage")}
							</Button>
						}
					>
						<Input
							id="ic-source"
							readOnly
							value={
								picked?.kind === "source"
									? `${picked.bucket}/${picked.key}`
									: ""
							}
							placeholder={t("schedule.slatePickPlaceholder")}
						/>
					</Field>
				)}
			</div>

			<Disclosure
				id="ic-advanced"
				label={t("contentInsertion.advancedOpen")}
				closeLabel={t("contentInsertion.advancedClose")}
				onOpenChange={(open) => {
					// While open, the ADVANCED source is the one checked and
					// registered; closed, the picked file is. Either way the
					// previous check is for another draft, so it is disarmed.
					setAdvanced(open);
					setCheckedFor("");
					create.reset();
				}}
			>
				<AdvancedSourceFields
					bitmovinAccountId={bitmovinAccountId}
					inputId={inputId}
					inputPath={inputPath}
					onInputId={setInputId}
					onInputPath={setInputPath}
				/>
			</Disclosure>

			<div className="mt-3 flex flex-wrap items-center gap-2">
				<Button
					type="button"
					variant="secondary"
					size="sm"
					disabled={draft === null || (armed && preflight.isFetching)}
					onClick={() => {
						setIssues([]);
						setAccepted(null);
						create.reset();
						setCheckedFor(currentKey);
						if (armed) {
							void preflight.refetch();
						}
					}}
				>
					{armed && (preflight.isFetching || verdict?.status === "PENDING")
						? t("contentInsertion.checking")
						: t("contentInsertion.checkCompatibility")}
				</Button>
				<Button
					size="sm"
					disabled={!canRegister || create.isPending}
					onClick={submitCreate}
				>
					{create.isPending
						? t("contentInsertion.registering")
						: t("contentInsertion.register")}
				</Button>
				{draft !== null && !armed ? (
					<span className="text-xs text-zinc-500">
						{t("contentInsertion.registerNeedsCheck")}
					</span>
				) : null}
			</div>

			{accepted ? (
				<p role="status" className="mt-3 text-sm text-zinc-300">
					{t(
						accepted.status === "WAITING_FOR_INPUT"
							? "contentInsertion.normalizationAcceptedWaiting"
							: "contentInsertion.normalizationAccepted",
					)}
				</p>
			) : null}

			{armed ? (
				<PreflightVerdict
					dto={verdict}
					errorMessage={preflightMessage}
					pending={preflight.isPending}
					picked={draft?.kind === "source"}
				/>
			) : null}

			<StoragePicker
				open={pickerOpen}
				mode="object"
				// Insertable content is DOWNLOADED BY BITMOVIN from a storage
				// input — the six providers the worker can turn into one.
				providers={[...SLATE_SUPPORTED_PROVIDERS]}
				{...(picked?.kind === "source"
					? {
							initialCredentialId: picked.credentialId,
							initialBucket: picked.bucket,
						}
					: {})}
				onClose={() => setPickerOpen(false)}
				onSelect={({ credentialId, bucket, path }) => {
					setPicked({ kind: "source", credentialId, bucket, key: path });
					setPickerOpen(false);
				}}
			/>
		</section>
	);
}

/** The raw form — mounted only while the disclosure is open. */
function AdvancedSourceFields({
	bitmovinAccountId,
	inputId,
	inputPath,
	onInputId,
	onInputPath,
}: {
	bitmovinAccountId: string;
	inputId: string;
	inputPath: string;
	onInputId: (value: string) => void;
	onInputPath: (value: string) => void;
}) {
	const { t } = useT();
	return (
		<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
			<p className="text-xs text-zinc-500 sm:col-span-2">
				{t("contentInsertion.advancedLead")}
			</p>
			<Field label={t("contentInsertion.inputPath")} htmlFor="ic-input-path">
				<Input
					id="ic-input-path"
					autoComplete="off"
					placeholder={t("contentInsertion.inputPathPlaceholder")}
					value={inputPath}
					onChange={(e) => onInputPath(e.target.value)}
				/>
			</Field>
			<div className="sm:col-span-2">
				<Field
					label={t("contentInsertion.inputId")}
					htmlFor="ic-input-id"
					help={t("ui.theBitmovinInputResourceHoldingTheFile")}
				>
					<InputIdPicker
						inputId="ic-input-id"
						bitmovinAccountId={bitmovinAccountId}
						value={inputId}
						onChange={onInputId}
					/>
				</Field>
			</div>
		</div>
	);
}

function PreflightVerdict({
	dto,
	errorMessage,
	pending,
	picked,
}: {
	dto: SlatePreflightDto | undefined;
	/** Already localized by the parent — never a raw error. */
	errorMessage: string | null;
	pending: boolean;
	/** The picker's shape: the server acts on `preparation` . */
	picked: boolean;
}) {
	const { t } = useT();
	if (errorMessage !== null) {
		return (
			<p role="alert" className="mt-3 text-red-400 text-sm">
				{errorMessage}
			</p>
		);
	}
	if (pending || dto === undefined || dto.status === "PENDING") {
		return (
			<p role="status" className="mt-3 text-sm text-zinc-400">
				{t("contentInsertion.preflightPending")}
			</p>
		);
	}
	// : for a picked file the preparation, not the verdict, is what
	// will happen — a mismatch is converted, a missing reference is waited for.
	const preparation = picked ? dto.preparation : undefined;
	const tone = preparation
		? preparation.action === "REFUSE"
			? "error"
			: preparation.action === "REGISTER_AS_IS"
				? "ok"
				: "neutral"
		: dto.verdict === "OK"
			? "ok"
			: dto.verdict === "INCOMPATIBLE"
				? "error"
				: "neutral";
	const headline = preparation
		? preparation.action === "REGISTER_AS_IS"
			? t(
					preparation.reason === "IMAGE"
						? "contentInsertion.prepImage"
						: "contentInsertion.prepAsIs",
				)
			: preparation.action === "NORMALIZE"
				? t("contentInsertion.prepNormalize", {
						reasons: preparation.reasons
							.map((attribute) => mediaAttributeLabel(t, attribute))
							.join(", "),
					})
				: preparation.action === "WAIT_FOR_INPUT"
					? t("contentInsertion.prepWait")
					: t(refuseReasonKey(preparation.reason))
		: dto.verdict === "OK"
			? t("contentInsertion.verdictOk")
			: dto.verdict === "INCOMPATIBLE"
				? t("contentInsertion.verdictIncompatible")
				: t("contentInsertion.verdictUnverified");
	const badge = preparation
		? preparation.action === "REGISTER_AS_IS"
			? "OK"
			: preparation.action === "NORMALIZE"
				? "CONVERT"
				: preparation.action === "WAIT_FOR_INPUT"
					? "WAIT"
					: "REFUSED"
		: dto.verdict;
	const summary = summarizeProbe(dto.probe);
	return (
		<div
			role="status"
			data-verdict={dto.verdict}
			className="mt-3 space-y-2 rounded-md border border-zinc-800 bg-zinc-900/40 p-3 text-sm"
		>
			<div className="flex flex-wrap items-center gap-2">
				<Badge tone={tone}>{badge}</Badge>
				<span className="text-zinc-200">{headline}</span>
			</div>
			{preparation?.action === "NORMALIZE" && dto.conversionDestination ? (
				<p className="text-xs text-zinc-400">
					{t(
						dto.conversionDestination.sameAsSource
							? "contentInsertion.prepDestinationSource"
							: "contentInsertion.prepDestinationOutput",
						{
							location: dto.conversionDestination.keyPrefix
								? `${dto.conversionDestination.bucket}/${dto.conversionDestination.keyPrefix}`
								: dto.conversionDestination.bucket,
						},
					)}
				</p>
			) : null}
			{dto.standDown ? (
				<p className="text-xs text-zinc-400">
					{t(STAND_DOWN_KEY[dto.standDown])}
				</p>
			) : null}
			{dto.verdict === "OK" && dto.compared && dto.compared.length > 0 ? (
				// rev406 R1: an OK is a statement about what was COMPARED. A
				// heartbeat-derived reference knows no profile, level, pixel format
				// or channel count, and "compatible" alone read as all of it.
				<p className="text-xs text-zinc-400">
					{t("contentInsertion.comparedOn", {
						compared: dto.compared
							.map((attribute) => mediaAttributeLabel(t, attribute))
							.join(", "),
					})}
					{dto.notComparable && dto.notComparable.length > 0
						? ` ${t("contentInsertion.notComparable", {
								attributes: dto.notComparable
									.map((attribute) => mediaAttributeLabel(t, attribute))
									.join(", "),
							})}`
						: ""}
				</p>
			) : null}
			{/* : a still is admitted; say what it will look like on air. */}
			{dto.kind === "image" ? (
				<p className="text-xs text-zinc-400">
					{t("contentInsertion.imageNotice")}
				</p>
			) : null}
			{dto.inputPath.stripped ? (
				<p className="text-xs text-zinc-500">
					{t("contentInsertion.leadingSlashStripped", {
						path: dto.inputPath.path,
					})}
				</p>
			) : null}
			{dto.differences && dto.differences.length > 0 ? (
				<DifferenceList
					differences={dto.differences}
					converts={preparation?.action === "NORMALIZE"}
				/>
			) : null}
			{summary ? (
				<dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
					<div>
						<dt className="text-zinc-500">{t("inspect.container")}</dt>
						<dd className="text-zinc-200">{summary.formatName ?? "—"}</dd>
					</div>
					{summary.streams.map((stream) => (
						<div key={stream.key}>
							<dt className="text-zinc-500">
								{stream.codecType ?? "—"} {stream.codecName ?? ""}
							</dt>
							<dd className="text-zinc-200">
								{[
									stream.resolution,
									stream.frameRate,
									stream.sampleRate,
									stream.channels === null ? null : `${stream.channels} ch`,
								]
									.filter((v): v is string => v !== null)
									.join(" · ") || "—"}
							</dd>
						</div>
					))}
				</dl>
			) : null}
		</div>
	);
}

/**
 * One line per attribute, marked blocking or reported-only — or, when the
 * server will convert the file , marked as what the conversion
 * fixes, since nothing blocks then.
 */
function DifferenceList({
	differences,
	converts = false,
}: {
	differences: (Omit<SlateDifference, "attribute"> & { attribute: string })[];
	converts?: boolean;
}) {
	const { t } = useT();
	return (
		<ul className="space-y-0.5 text-xs">
			<li className="text-zinc-500">
				{t("contentInsertion.differencesTitle")}
			</li>
			{differences.map((d) => (
				<li
					key={`${d.attribute}:${d.candidate}`}
					className={d.blocking && !converts ? "text-red-300" : "text-zinc-400"}
				>
					<span className="font-mono">{mediaDifferenceText(t, d)}</span>{" "}
					<span className="text-zinc-500">
						{converts
							? t("contentInsertion.differenceConverted")
							: d.blocking
								? t("contentInsertion.differenceBlocking")
								: t("contentInsertion.differenceReported")}
					</span>
				</li>
			))}
		</ul>
	);
}
