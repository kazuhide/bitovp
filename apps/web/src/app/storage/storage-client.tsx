"use client";

import {
	BROWSABLE_CREDENTIAL_PROVIDERS,
	type CredentialSummaryWire,
	objectUri,
	type StoragePresetWire,
	type StorageRoleId,
} from "@bitovp/core";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input, SelectNative } from "@/components/ui/input";
import { NewCredentialLink } from "@/components/ui/new-credential-link";
import { ApiError, apiFetch } from "@/lib/api";
import { prefixCrumbs } from "@/lib/format";
import { useT } from "@/lib/i18n/context";
import { isBucketDenied } from "@/lib/storage-error-keys";
import { useStorageErrorText } from "@/lib/use-storage-error-text";
import {
	type BucketOwnerSearch,
	findCredentialForBucket,
} from "./find-credential-for-bucket";
import { InspectDialog, type InspectTarget } from "./inspect-dialog";
import { ObjectTable, type TableObject } from "./object-table";
import { SelectionPanel, type StorageSelection } from "./selection-panel";

type ObjectsPage = {
	prefixes: string[];
	objects: TableObject[];
	nextCursor?: string;
	/** Present only for a search response (see @bitovp/storage searchObjects). */
	scan?: {
		scannedObjects: number;
		scannedPages: number;
		matchLimitReached: boolean;
		scanLimitReached: boolean;
		complete: boolean;
	};
};

/**
 * Derived, not transcribed. This was a hand-written `Set<string>` — untyped, so
 * neither a typo nor a provider added later would fail tsc. It happened to be
 * right; the watch-folder picker, which asked the same question a different
 * way, was not.
 */
const BROWSABLE = new Set<string>(BROWSABLE_CREDENTIAL_PROVIDERS);

/** Buckets a GIVEN credential was refused, learned by trying . */
type DeniedBuckets = { credentialId: string; buckets: Set<string> };
const EMPTY_BUCKETS: ReadonlySet<string> = new Set();
const NO_DENIALS: DeniedBuckets = { credentialId: "", buckets: new Set() };

/**
 * Searching walks the bucket page by page server-side, so every keystroke would
 * otherwise start a fresh scan.
 */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * "This credential cannot open it — which one can?" .
 *
 * Rendered only on a BUCKET-level refusal, and it does nothing until asked:
 * the search costs one request per candidate credential. When it finds one,
 * switching is a single click, which is the whole point — the operator should
 * not have to remember which of their keys is scoped to which bucket.
 */
function BucketOwnerOffer({
	bucket,
	search,
	onSearch,
	onSwitch,
}: {
	bucket: string;
	search: "searching" | BucketOwnerSearch | null;
	onSearch: () => void;
	onSwitch: (credentialId: string) => void;
}) {
	const { t } = useT();
	if (search === "searching") {
		return (
			<p className="mt-2 text-xs text-zinc-400">
				{t("storage.searchingCredentials")}
			</p>
		);
	}
	if (search?.kind === "found") {
		return (
			<p className="mt-2 text-xs text-zinc-300">
				{t("storage.credentialCanOpen")}{" "}
				<button
					type="button"
					className="rounded bg-emerald-900/60 px-2 py-0.5 text-emerald-200 hover:bg-emerald-900"
					onClick={() => onSwitch(search.credentialId)}
				>
					{search.label}
				</button>
			</p>
		);
	}
	if (search?.kind === "none") {
		return (
			<p className="mt-2 text-xs text-zinc-400">
				{/* The cap is stated when it bites, so "none found" is never read
				    as "none exists" after a truncated search. */}
				{search.truncated
					? t("storage.noCredentialCanOpenTruncated")
					: t("storage.noCredentialCanOpen")}
			</p>
		);
	}
	return (
		<button
			type="button"
			className="mt-2 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-900"
			onClick={onSearch}
		>
			{t("storage.findCredentialFor")} {bucket}
		</button>
	);
}

export function StorageClient() {
	const { t } = useT();
	const errorText = useStorageErrorText();
	/**
	 * Buckets this credential turned out to be refused (403), learned by trying.
	 *
	 * `ListBuckets` is ACCOUNT-level on Akamai/Linode and AWS, while an access
	 * key can be scoped to particular buckets — so the list is honest about the
	 * account and silent about this key. Probing all of them up front is not an
	 * option (a real GCS account here lists 69), so the browser remembers each
	 * refusal instead and marks it, and the operator stops re-clicking the ones
	 * that are not theirs.
	 */

	const queryClient = useQueryClient();
	const [credentialId, setCredentialId] = useState("");
	const [denied, setDenied] = useState<DeniedBuckets>(NO_DENIALS);
	/**
	 * The answer to "then which of my credentials DOES open this?" (#144).
	 *
	 * `null` = never asked. The search is operator-initiated because it costs a
	 * request per credential, and nothing is probed up front for the same
	 * reason the marks are learned by trying: one real account here lists 69
	 * buckets.
	 */
	const [ownerSearch, setOwnerSearch] = useState<{
		bucket: string;
		state: "searching" | BucketOwnerSearch;
	} | null>(null);
	/**
	 * DERIVED, not reset by an effect.
	 *
	 * A refusal belongs to a CREDENTIAL, so the state carries the one it was
	 * learned under and a mismatch simply reads as empty. The first version
	 * cleared the Set in a `useEffect` on `credentialId` — which worked, and
	 * which Biome correctly called out for depending on a value the body never
	 * reads. An effect that exists to undo state is usually state modelled one
	 * level too shallow.
	 */
	const deniedBuckets =
		denied.credentialId === credentialId ? denied.buckets : EMPTY_BUCKETS;
	const [bucket, setBucket] = useState("");
	const [bucketInput, setBucketInput] = useState("");
	const [prefix, setPrefix] = useState("");
	const [selection, setSelection] = useState<StorageSelection>({});
	// The object currently being ffprobed; null closes the dialog. Carries the
	// page's credential/bucket context, so inspection never re-asks for either.
	const [inspecting, setInspecting] = useState<InspectTarget | null>(null);
	const [queryInput, setQueryInput] = useState("");
	const [extInput, setExtInput] = useState("");
	const [search, setSearch] = useState("");
	const [ext, setExt] = useState("");
	const searching = search !== "" || ext !== "";

	useEffect(() => {
		const timer = setTimeout(() => {
			setSearch(queryInput.trim());
			setExt(extInput.trim());
		}, SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [queryInput, extInput]);

	const credentials = useQuery({
		queryKey: ["credentials"],
		queryFn: () => apiFetch<CredentialSummaryWire[]>("/api/credentials"),
	});
	const credential = credentials.data?.find((c) => c.id === credentialId);

	const buckets = useQuery({
		queryKey: ["storage-buckets", credentialId],
		queryFn: () =>
			apiFetch<{ buckets: string[] }>(
				`/api/credentials/${credentialId}/storage/buckets`,
			),
		enabled: credentialId !== "",
		retry: false,
		staleTime: 60_000,
	});

	const objects = useInfiniteQuery({
		queryKey: ["storage-objects", credentialId, bucket, prefix, search, ext],
		queryFn: ({ pageParam }) => {
			const params = new URLSearchParams({ bucket });
			if (prefix) {
				params.set("prefix", prefix);
			}
			if (pageParam) {
				params.set("cursor", pageParam);
			}
			// Sent to the server rather than applied to the loaded rows: a filter
			// over the last page silently searches 100 of N objects.
			if (search) {
				params.set("search", search);
			}
			if (ext) {
				params.set("ext", ext);
			}
			return apiFetch<ObjectsPage>(
				`/api/credentials/${credentialId}/storage/objects?${params}`,
			);
		},
		initialPageParam: "",
		getNextPageParam: (last) => last.nextCursor ?? null,
		enabled: credentialId !== "" && bucket !== "",
		retry: false,
	});

	useEffect(() => {
		// Keyed on the bucket that FAILED, not on the current one: by the time
		// this runs the operator may have clicked elsewhere, and marking the
		// wrong row is worse than marking none.
		if (!bucket) return;
		/**
		 * Two conditions the first version got wrong, both found by review-282
		 * with rendered tests.
		 *
		 * `!objects.data` — on an infinite query `objects.error` is ALSO set when
		 * `fetchNextPage` fails. Without this, a "Load more" that 403s marks the
		 * bucket "no access" while page one's objects are listed two panes away.
		 * The picker's own error branch already gated this way; the browser did
		 * not.
		 *
		 * `isBucketDenied`, not `isAccessDenied` — a 403 whose code says the
		 * CREDENTIAL was rejected (mistyped secret, skewed clock) is not about
		 * this bucket, and marking every bucket for it teaches the operator the
		 * opposite of the truth.
		 *
		 * And the success arm: nothing used to remove a mark, so granting the
		 * missing permission left the row reading "no access" over a listing of
		 * its contents until a reload.
		 */
		const denies = !objects.data && isBucketDenied(objects.error);
		if (!denies && !objects.isSuccess) return;
		setDenied((prev) => {
			const buckets =
				prev.credentialId === credentialId ? prev.buckets : new Set<string>();
			if (denies === buckets.has(bucket)) return prev;
			const next = new Set(buckets);
			if (denies) {
				next.add(bucket);
			} else {
				next.delete(bucket);
			}
			return { credentialId, buckets: next };
		});
	}, [bucket, credentialId, objects.data, objects.error, objects.isSuccess]);

	const presets = useQuery({
		queryKey: ["storage-presets"],
		queryFn: () => apiFetch<StoragePresetWire[]>("/api/storage-presets"),
	});

	const savePreset = useMutation({
		mutationFn: (payload: {
			label: string;
			bucket: string;
			prefix: string;
			role: StorageRoleId;
		}) =>
			apiFetch("/api/storage-presets", {
				method: "POST",
				body: JSON.stringify({ ...payload, credentialId }),
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["storage-presets"] }),
	});

	const deletePreset = useMutation({
		mutationFn: (id: string) =>
			apiFetch<void>(`/api/storage-presets/${id}`, { method: "DELETE" }),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["storage-presets"] }),
	});

	function clearSearch() {
		setQueryInput("");
		setExtInput("");
		setSearch("");
		setExt("");
	}

	function selectCredential(id: string) {
		setCredentialId(id);
		setBucket("");
		setBucketInput("");
		setPrefix("");
		setSelection({});
		setInspecting(null);
		clearSearch();
	}

	function openBucket(name: string, atPrefix = "") {
		setBucket(name);
		setPrefix(atPrefix);
		// An inspection is bound to credential+bucket+key — drop it on a switch.
		setInspecting(null);
		clearSearch();
		// A location-bound output selection must not survive a bucket/preset
		// switch — saving it would persist the previously browsed location.
		setSelection((prev) => ({ input: prev.input }));
	}

	const uriFor = (path: string) =>
		credential ? objectUri(credential.provider, bucket, path) : path;

	const copyUri = (path: string) => navigator.clipboard.writeText(uriFor(path));

	const crumbs = prefixCrumbs(prefix);
	const pages = objects.data?.pages ?? [];
	const credentialPresets = (presets.data ?? []).filter(
		(p) => p.credentialId === credentialId,
	);

	const matchCount = pages.reduce((total, p) => total + p.objects.length, 0);
	const scannedObjects = pages.reduce(
		(total, p) => total + (p.scan?.scannedObjects ?? 0),
		0,
	);
	// The LAST page owns the verdict: the scan either reached the end of the
	// listing or was cut off by the server's caps.
	const scanComplete = pages[pages.length - 1]?.scan?.complete ?? false;

	function searchStatus(): string {
		if (objects.isLoading || objects.isFetchingNextPage) {
			return t("uiX.scanningThePrefix");
		}
		// The count was an English literal spliced into a localized frame, so the
		// Keep match-count wording in the translation catalogue.
		const matches = t(
			matchCount === 1 ? "uiX.matchCountOne" : "uiX.matchCountOther",
			{ count: matchCount },
		);
		if (scanComplete) {
			return t("uiX.scanWholePrefix", { matches, scanned: scannedObjects });
		}
		// Never let a bounded scan read as "the bucket holds nothing else".
		return t("uiX.scanTruncated", { matches, scanned: scannedObjects });
	}

	return (
		<section>
			<header>
				<div className="flex items-center gap-2">
					<h1 className="font-semibold text-xl text-zinc-50">
						{t("storage.title")}
					</h1>
					<HelpOverlay labelFor={t("storage.title")}>
						{/* Keep spacing inside translated values rather than JSX separators so Japanese particles remain attached to their noun. */}
						{t("prose.storageIntro")}
						<strong>{t("storage.locationPresets")}</strong>
						{t("ui.namedBucketPrefixShortcutsOfferedAsOne")}
					</HelpOverlay>
				</div>
			</header>

			<div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[300px_1fr]">
				<div className="space-y-4">
					<Field label={t("storage.credential")} htmlFor="storage-credential">
						<SelectNative
							id="storage-credential"
							value={credentialId}
							onChange={(e) => selectCredential(e.target.value)}
						>
							<option value="">{t("storage.selectCredential")}</option>
							{(credentials.data ?? []).map((cred) => (
								<option
									key={cred.id}
									value={cred.id}
									disabled={!BROWSABLE.has(cred.provider)}
								>
									{cred.label}
									{BROWSABLE.has(cred.provider)
										? ""
										: t("storage.notBrowsableSuffix")}
								</option>
							))}
						</SelectNative>
						<NewCredentialLink />
					</Field>

					{credentials.isError ? (
						<p
							role="alert"
							className="rounded-md border border-red-900 bg-red-950/30 px-3 py-2 text-red-300 text-xs"
						>
							{credentials.error instanceof ApiError
								? credentials.error.message
								: t("storage.credentialsLoadFailed")}{" "}
							{t("uiX.addOrCheckCredentials")}
						</p>
					) : null}

					{credentialId ? (
						<div>
							<p className="mb-1.5 font-medium text-xs text-zinc-300">
								{t("storage.bucket")}
							</p>
							{buckets.isLoading ? (
								<p className="text-xs text-zinc-500">
									{t("storage.listingBuckets")}
								</p>
							) : buckets.data?.buckets.length === 0 ? (
								<p className="text-xs text-zinc-500">
									{/* : this used to be an EMPTY <ul> — a
									    success that rendered nothing at all. */}
									{t("storage.noBucketsListed")}
								</p>
							) : buckets.data ? (
								<ul
									aria-label={t("storage.bucket")}
									className="max-h-48 space-y-0.5 overflow-y-auto"
								>
									{buckets.data.buckets.map((name) => (
										<li key={name}>
											<button
												type="button"
												className={`w-full rounded px-2 py-1 text-left text-sm ${
													name === bucket
														? "bg-zinc-800 text-zinc-50"
														: "text-zinc-400 hover:bg-zinc-900"
												}`}
												onClick={() => openBucket(name)}
											>
												{/* flex + truncate + shrink-0: a 60-char bucket
												    name used to clip behind the rail's inner
												    scrollbar and take the red no-access marker
												    out of view with it — a denied bucket looked
												    normal (UI loop 2026-08-21). */}
												<span className="flex items-center justify-between gap-2">
													<span className="truncate" title={name}>
														{name}
													</span>
													{deniedBuckets.has(name) ? (
														<span className="shrink-0 text-red-400 text-xs">
															{t("storage.noAccess")}
														</span>
													) : null}
												</span>
											</button>
										</li>
									))}
								</ul>
							) : buckets.isError ? (
								<p className="text-xs text-zinc-500">
									{/*
									 * The SAME helper the picker uses, list scope.
									 * This site rendered the raw message, so a
									 * bucket-list 403 read "AccessDenied (upstream
									 * 403)" here and classified-but-wrong prose in the
									 * picker — #144's whole complaint was these two
									 * screens saying different things (review-282).
									 */}
									{errorText(
										buckets.error,
										"storage.bucketListingUnavailable",
										"list",
									)}{" "}
									{t("uiX.enterTheBucketName")}
								</p>
							) : null}
							<form
								className="mt-2 flex gap-2"
								onSubmit={(e) => {
									e.preventDefault();
									if (bucketInput.trim()) {
										openBucket(bucketInput.trim());
									}
								}}
							>
								<Input
									aria-label={t("storage.bucketName")}
									className="h-8 text-xs"
									placeholder={t("storage.bucketNamePlaceholder")}
									value={bucketInput}
									onChange={(e) => setBucketInput(e.target.value)}
								/>
								<Button type="submit" variant="secondary" size="sm">
									{t("storage.open")}
								</Button>
							</form>
						</div>
					) : null}

					{credentialId && credentialPresets.length > 0 ? (
						<div>
							<p className="mb-1.5 font-medium text-xs text-zinc-300">
								{t("storage.locationPresets")}
							</p>
							<ul className="space-y-1">
								{credentialPresets.map((preset) => (
									<li
										key={preset.id}
										className="flex items-center gap-2 rounded border border-zinc-800 px-2 py-1"
									>
										<button
											type="button"
											className="min-w-0 flex-1 truncate text-left text-xs text-zinc-300 hover:text-emerald-400"
											onClick={() => openBucket(preset.bucket, preset.prefix)}
										>
											{preset.label}
										</button>
										<Badge>{preset.role}</Badge>
										<Button
											variant="ghost"
											size="sm"
											aria-label={t("uiX.deletePresetLabel", {
												label: preset.label,
											})}
											onClick={() => deletePreset.mutate(preset.id)}
										>
											×
										</Button>
									</li>
								))}
							</ul>
						</div>
					) : null}
				</div>

				<div className="min-w-0 space-y-4">
					{bucket ? (
						<>
							<nav
								aria-label={t("storage.prefixBreadcrumb")}
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
								<Button
									variant="secondary"
									size="sm"
									className="ml-auto"
									onClick={() =>
										setSelection((prev) => ({
											...prev,
											output: { uri: uriFor(prefix), bucket, prefix },
										}))
									}
								>
									{t("storage.useCurrentPrefix")}
								</Button>
							</nav>

							{objects.isError && !objects.data ? (
								<div
									role="alert"
									className="rounded-md border border-red-900 bg-red-950/30 p-4 text-red-300 text-sm"
								>
									{errorText(objects.error, "storage.listFailed")}
									{isBucketDenied(objects.error) ? (
										<BucketOwnerOffer
											bucket={bucket}
											search={
												ownerSearch?.bucket === bucket
													? ownerSearch.state
													: null
											}
											onSearch={async () => {
												setOwnerSearch({ bucket, state: "searching" });
												const result = await findCredentialForBucket(
													(credentials.data ?? []).filter((c) =>
														BROWSABLE.has(c.provider),
													),
													bucket,
													credentialId,
												);
												setOwnerSearch({ bucket, state: result });
											}}
											onSwitch={(id) => {
												setCredentialId(id);
												setOwnerSearch(null);
											}}
										/>
									) : null}
								</div>
							) : (
								<ObjectTable
									prefixes={[...new Set(pages.flatMap((p) => p.prefixes))]}
									objects={pages.flatMap((p) => p.objects)}
									isLoading={objects.isLoading}
									hasNextPage={objects.hasNextPage ?? false}
									isFetchingNextPage={objects.isFetchingNextPage}
									onFetchNextPage={() => objects.fetchNextPage()}
									onOpenPrefix={(p) => setPrefix(p)}
									onUseAsInput={(key) =>
										setSelection((prev) => ({
											...prev,
											input: { uri: uriFor(key) },
										}))
									}
									onUseAsOutput={(p) =>
										setSelection((prev) => ({
											...prev,
											output: { uri: uriFor(p), bucket, prefix: p },
										}))
									}
									onCopyUri={copyUri}
									onInspect={(key, size) =>
										setInspecting({
											credentialId,
											bucket,
											objectKey: key,
											objectSize: size,
										})
									}
									search={{
										query: queryInput,
										extension: extInput,
										onQueryChange: setQueryInput,
										onExtensionChange: setExtInput,
										prefix,
										notice: searching ? (
											<p
												role="status"
												className={
													scanComplete
														? "text-xs text-zinc-400"
														: "text-amber-300 text-xs"
												}
											>
												{searchStatus()}
											</p>
										) : null,
									}}
								/>
							)}
							{objects.isError && objects.data ? (
								<p role="alert" className="text-red-400 text-xs">
									{t("storage.loadMoreFailed")}{" "}
									{errorText(objects.error, "storage.tryAgain")}
								</p>
							) : null}

							<SelectionPanel
								selection={selection}
								savePending={savePreset.isPending}
								saveError={
									savePreset.error instanceof ApiError
										? savePreset.error.message
										: savePreset.isError
											? t("storage.presetSaveFailed")
											: null
								}
								onSavePreset={(args) =>
									savePreset.mutateAsync(args).then(() => undefined)
								}
							/>
						</>
					) : (
						<div
							role="status"
							className="rounded-lg border border-zinc-800 border-dashed bg-zinc-900/40 p-10 text-center text-sm text-zinc-500"
						>
							{credentialId
								? t("storage.pickBucket")
								: t("storage.pickCredential")}
						</div>
					)}
				</div>
			</div>

			<InspectDialog target={inspecting} onClose={() => setInspecting(null)} />
		</section>
	);
}
