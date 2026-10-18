"use client";

import type {
	CredentialProviderId,
	CredentialSummaryWire,
	StoragePresetWire,
} from "@bitovp/core";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
	InspectDialog,
	type InspectTarget,
} from "@/app/storage/inspect-dialog";
import { ObjectTable, type TableObject } from "@/app/storage/object-table";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { InfoHint } from "@/components/ui/info-hint";
import { Input, SelectNative } from "@/components/ui/input";
import { NewCredentialLink } from "@/components/ui/new-credential-link";
import { ApiError, apiFetch } from "@/lib/api";
import { prefixCrumbs } from "@/lib/format";
import { useT } from "@/lib/i18n/context";
import { useStorageErrorText } from "@/lib/use-storage-error-text";

export type StoragePickerSelection = {
	credentialId: string;
	bucket: string;
	/** Object key (mode "object") or prefix (mode "prefix"). */
	path: string;
};

type StoragePickerProps = {
	open: boolean;
	mode: "object" | "prefix";
	/** Providers selectable for this use (wizard P1: AWS_S3 only). */
	providers: CredentialProviderId[];
	/** Pre-scope the browser to an already-chosen location so the credential is
	 *  never asked twice — a field that already has a credential opens the
	 *  picker straight at its bucket instead of a blank credential step. */
	initialCredentialId?: string;
	initialBucket?: string;
	onClose: () => void;
	onSelect: (selection: StoragePickerSelection) => void;
};

type ObjectsPage = {
	prefixes: string[];
	objects: TableObject[];
	nextCursor?: string;
};

/** UI-DESIGN §3: the storage browser reused as a modal inside wizards. */
export function StoragePicker({
	open,
	mode,
	providers,
	initialCredentialId,
	initialBucket,
	onClose,
	onSelect,
}: StoragePickerProps) {
	const { t } = useT();
	const errorText = useStorageErrorText();
	const [credentialId, setCredentialId] = useState("");
	// : Inspect from the picker - the browser and job-detail cards
	// had it, the wizard picker did not.
	const [inspecting, setInspecting] = useState<InspectTarget | null>(null);
	const [bucket, setBucket] = useState("");
	const [bucketInput, setBucketInput] = useState("");
	const [prefix, setPrefix] = useState("");

	// Seed from the field's existing location when the modal OPENS, so "Change"
	// continues from where the user is instead of re-asking the credential. The
	// wasOpen ref makes this fire only on the false→true edge, so in-modal
	// navigation is never reset even if the seed props change mid-browse.
	const wasOpen = useRef(false);
	useEffect(() => {
		if (open && !wasOpen.current) {
			setCredentialId(initialCredentialId ?? "");
			setBucket(initialBucket ?? "");
			setBucketInput("");
			setPrefix("");
			// Review of PR #175, I1: without this, reopening the picker
			// resurrects the PREVIOUS session's Inspect modal over the browse
			// UI — and where the prior row was not adoptable, re-fires an
			// unrequested bounded read of customer storage.
			setInspecting(null);
		}
		wasOpen.current = open;
	}, [open, initialCredentialId, initialBucket]);

	const credentials = useQuery({
		queryKey: ["credentials"],
		queryFn: () => apiFetch<CredentialSummaryWire[]>("/api/credentials"),
		enabled: open,
	});
	const selectable = (credentials.data ?? []).filter((c) =>
		providers.includes(c.provider),
	);

	const buckets = useQuery({
		queryKey: ["storage-buckets", credentialId],
		queryFn: () =>
			apiFetch<{ buckets: string[] }>(
				`/api/credentials/${credentialId}/storage/buckets`,
			),
		enabled: open && credentialId !== "",
		retry: false,
		staleTime: 60_000,
	});

	const objects = useInfiniteQuery({
		queryKey: ["storage-objects", credentialId, bucket, prefix],
		queryFn: ({ pageParam }) => {
			const params = new URLSearchParams({ bucket });
			if (prefix) {
				params.set("prefix", prefix);
			}
			if (pageParam) {
				params.set("cursor", pageParam);
			}
			return apiFetch<ObjectsPage>(
				`/api/credentials/${credentialId}/storage/objects?${params}`,
			);
		},
		initialPageParam: "",
		getNextPageParam: (last: ObjectsPage) => last.nextCursor ?? null,
		enabled: open && credentialId !== "" && bucket !== "",
		retry: false,
	});

	const presets = useQuery({
		queryKey: ["storage-presets"],
		queryFn: () => apiFetch<StoragePresetWire[]>("/api/storage-presets"),
		enabled: open && mode === "prefix",
	});
	const credentialPresets = (presets.data ?? []).filter(
		(p) =>
			p.role === "OUTPUT" && selectable.some((c) => c.id === p.credentialId),
	);

	const pages = objects.data?.pages ?? [];
	const crumbs = prefixCrumbs(prefix);

	function finish(selection: StoragePickerSelection) {
		onSelect(selection);
		onClose();
	}

	function pick(path: string) {
		finish({ credentialId, bucket, path });
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					onClose();
				}
			}}
			title={
				mode === "object"
					? t("ui.pickAnInputObject")
					: t("ui.pickAnOutputPrefix")
			}
			description={
				mode === "object"
					? t("ui.browseABucketAndChooseTheSource")
					: t("ui.navigateToTheDestinationPrefixThenUse")
			}
			wide
		>
			<div className="space-y-3">
				{credentials.isError ? (
					<p role="alert" className="text-red-400 text-sm">
						{credentials.error instanceof ApiError
							? credentials.error.message
							: t("ui.failedToLoadCredentials")}
					</p>
				) : null}
				<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
					<Field label={t("ui.credential")} htmlFor="picker-credential">
						<SelectNative
							id="picker-credential"
							value={credentialId}
							onChange={(e) => {
								setCredentialId(e.target.value);
								setBucket("");
								setPrefix("");
							}}
						>
							<option value="">{t("ui.selectCredential")}</option>
							{selectable.map((c) => (
								<option key={c.id} value={c.id}>
									{c.label}
								</option>
							))}
						</SelectNative>
						<NewCredentialLink />
					</Field>
					{/*
					 * : `{buckets: []}` is a SUCCESS, and it used to render
					 * an enabled select whose only entry was "Select bucket…" — no
					 * hint, manual input unpromoted. A dead end that LOOKS healthy,
					 * which is worse than the error branch one line below it. Empty
					 * success now takes the error branch's LAYOUT (no useless select,
					 * manual input promoted and labelled) with its own sentence,
					 * because "the listing failed" and "the listing is empty" are
					 * different facts and only one of them is about permissions.
					 */}
					<Field
						label={t("ui.bucket")}
						htmlFor="picker-bucket"
						{...(buckets.isError
							? {
									/**
									 * The reason PLUS what to do about it — 's
									 * actual title, which the first pass at that row did
									 * not touch.
									 *
									 * `/storage` has always appended
									 * `uiX.enterTheBucketName` here and the picker never
									 * did, so a bucket-LIST refusal left an operator with
									 * a bare code and a text field they had no reason to
									 * think was the answer. The generic bucket-scope
									 * sentence cannot be reused: it says "pick another
									 * bucket", and at this point there is no list to pick
									 * from.
									 */
									hint: `${errorText(
										buckets.error,
										"ui.listingUnavailableTypeBelow",
										"list",
									)} ${t("uiX.enterTheBucketName")}`,
								}
							: buckets.data?.buckets.length === 0
								? { hint: t("ui.noBucketsListedTypeBelow") }
								: {})}
					>
						<div className="flex gap-2">
							{buckets.isError || buckets.data?.buckets.length === 0 ? null : (
								<SelectNative
									id="picker-bucket"
									className="min-w-0"
									value={bucket}
									disabled={!credentialId || !buckets.data}
									onChange={(e) => {
										setBucket(e.target.value);
										setPrefix("");
									}}
								>
									<option value="">{t("ui.selectBucket")}</option>
									{(buckets.data?.buckets ?? []).map((name) => (
										<option key={name} value={name}>
											{name}
										</option>
									))}
								</SelectNative>
							)}
							<form
								className={
									buckets.isError || buckets.data?.buckets.length === 0
										? "flex flex-1 gap-1"
										: "flex gap-1"
								}
								onSubmit={(e) => {
									e.preventDefault();
									if (bucketInput.trim()) {
										setBucket(bucketInput.trim());
										setPrefix("");
									}
								}}
							>
								<Input
									id={
										buckets.isError || buckets.data?.buckets.length === 0
											? "picker-bucket"
											: undefined
									}
									aria-label={t("ui.bucketNameManual")}
									className={
										buckets.isError || buckets.data?.buckets.length === 0
											? "h-9 flex-1 text-xs"
											: "h-9 w-36 text-xs"
									}
									placeholder={t("ui.orTypeBucket")}
									value={bucketInput}
									onChange={(e) => setBucketInput(e.target.value)}
								/>
								<Button type="submit" variant="secondary" size="sm">
									{t("ui.open")}
								</Button>
							</form>
						</div>
					</Field>
				</div>

				{mode === "prefix" && credentialPresets.length > 0 ? (
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-xs text-zinc-500">
							{t("ui.locationPresets")}
						</span>
						{credentialPresets.map((preset) => (
							<button
								key={preset.id}
								type="button"
								className="rounded-full border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:border-emerald-600 hover:text-emerald-300"
								onClick={() =>
									finish({
										credentialId: preset.credentialId,
										bucket: preset.bucket,
										path: preset.prefix,
									})
								}
							>
								{preset.label}
							</button>
						))}
					</div>
				) : null}

				{bucket ? (
					<>
						<nav
							aria-label={t("ui.prefixBreadcrumb")}
							className="flex flex-wrap items-center gap-1 text-sm"
						>
							<button
								type="button"
								className="text-zinc-300 hover:text-emerald-400"
								onClick={() => setPrefix("")}
							>
								{bucket}
							</button>
							{crumbs.map((crumb) => (
								<span key={crumb} className="flex items-center gap-1">
									<span className="text-zinc-600">/</span>
									<button
										type="button"
										className="text-zinc-300 hover:text-emerald-400"
										onClick={() => setPrefix(crumb)}
									>
										{crumb.split("/").filter(Boolean).pop()}
									</button>
								</span>
							))}
							{mode === "prefix" ? (
								<Button
									size="sm"
									className="ml-auto"
									onClick={() => pick(prefix)}
								>
									{t("ui.useCurrentPrefix")}
								</Button>
							) : null}
						</nav>

						{objects.isError && !objects.data ? (
							<p role="alert" className="text-red-400 text-sm">
								{errorText(objects.error, "ui.failedToListObjects")}
							</p>
						) : (
							<ObjectTable
								prefixes={[...new Set(pages.flatMap((p) => p.prefixes))]}
								objects={pages.flatMap((p) => p.objects)}
								isLoading={objects.isLoading}
								hasNextPage={objects.hasNextPage ?? false}
								isFetchingNextPage={objects.isFetchingNextPage}
								onFetchNextPage={() => objects.fetchNextPage()}
								onOpenPrefix={(p) => setPrefix(p)}
								onUseAsInput={mode === "object" ? pick : undefined}
								onUseAsOutput={mode === "prefix" ? pick : undefined}
								onInspect={(key, size) =>
									setInspecting({
										credentialId,
										bucket,
										objectKey: key,
										objectSize: size,
									})
								}
							/>
						)}
						<InspectDialog
							target={inspecting}
							onClose={() => setInspecting(null)}
						/>
					</>
				) : (
					<div
						role="status"
						className="rounded-lg border border-zinc-800 border-dashed bg-zinc-900/40 p-8 text-center text-sm text-zinc-500"
					>
						{credentialId
							? t("ui.pickOrTypeABucket")
							: selectable.length > 0
								? t("uiX.selectCredentialToBrowse")
								: credentials.isError
									? t("uiX.credentialsUnavailable")
									: t("uiX.noBrowsableCredential")}
					</div>
				)}
				{mode === "object" ? (
					<InfoHint
						labelFor={t("ui.hint")}
						text={t("ui.useTheUseAsInputActionOn")}
					/>
				) : null}
			</div>
		</Dialog>
	);
}
