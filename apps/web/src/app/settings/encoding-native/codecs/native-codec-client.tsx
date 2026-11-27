"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { type FormEvent, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import type { SessionDto } from "@/lib/auth/dto";
import { SESSION_QUERY_KEY, useSession } from "@/lib/auth/use-session";
import {
	CREATE_SESSION_HEADER,
	canonicalCreateRequestJson,
} from "@/lib/creation-submission-contract";
import { useT } from "@/lib/i18n/context";
import {
	type CreateNativeCodec,
	createNativeCodecSchema,
	dtsXBitrates,
	h262Profile,
	type NativeCodecList,
	type NativeCodecReceipt,
	nativeCodecKind,
	nativeCodecKinds,
	nativeCodecLabels,
} from "@/lib/native-codec-configurations";
import { draftIdentity } from "@/lib/wizard-draft";

const copy = {
	en: {
		title: "Codec configurations",
		back: "Encoding resources",
		account: "Bitmovin account",
		pickAccount: "Select account",
		name: "Name",
		codec: "Codec",
		bitrate: "Bitrate (bps)",
		targetBitrate: "Target bitrate (bps)",
		profile: "Profile",
		sampleRate: "Sampling rate (Hz)",
		frameRate: "Frame rate (fps)",
		width: "Width (px)",
		height: "Height (px)",
		qScale: "Quality scale",
		channelLayout: "Channel layout",
		mode: "DTS mode",
		expressAudio: "Express Audio",
		digitalSurround: "Digital Surround",
		automatic: "Automatic",
		create: "Create configuration",
		check: "Check provider",
		resume: "Resume creation",
		remove: "Remove",
		retryRemove: "Retry removal",
		cancel: "Cancel",
		confirm: "Confirm provider ID",
		noRows: "No configurations created here.",
		scopeChanged: "Earlier account scope",
		failed: "Action failed. Refresh the account and check the receipt.",
		removedSubmission:
			"The previous configuration was removed. Submit again to create it.",
		invalid: "Check the configuration fields.",
		unavailable: "Could not load codec configurations.",
		previous: "Previous",
		next: "Next",
		CREATING: "Creation pending",
		ACTIVE: "Active",
		DELETING: "Removal pending",
		REMOVED: "Removed",
		REJECTED: "Provider rejected creation",
	},
	ja: {
		title: "コーデック構成",
		back: "エンコーディングリソース",
		account: "Bitmovin アカウント",
		pickAccount: "アカウントを選択",
		name: "名前",
		codec: "コーデック",
		bitrate: "ビットレート（bps）",
		targetBitrate: "目標ビットレート（bps）",
		profile: "プロファイル",
		sampleRate: "サンプリング周波数（Hz）",
		frameRate: "フレームレート（fps）",
		width: "幅（px）",
		height: "高さ（px）",
		qScale: "品質スケール",
		channelLayout: "チャンネル構成",
		mode: "DTS モード",
		expressAudio: "エクスプレスオーディオ",
		digitalSurround: "デジタルサラウンド",
		automatic: "自動",
		create: "構成を作成",
		check: "Bitmovin の状態を確認",
		resume: "作成を再開",
		remove: "削除",
		retryRemove: "削除を再試行",
		cancel: "キャンセル",
		confirm: "削除する構成の ID",
		noRows: "この画面で作成した構成はありません。",
		scopeChanged: "以前のアカウント設定",
		failed: "操作に失敗しました。アカウントと操作記録を確認してください。",
		removedSubmission:
			"前回の構成は削除済みです。作成するにはもう一度送信してください。",
		invalid: "構成の入力値を確認してください。",
		unavailable: "コーデック構成を読み込めませんでした。",
		previous: "前へ",
		next: "次へ",
		CREATING: "作成結果待ち",
		ACTIVE: "使用可能",
		DELETING: "削除結果待ち",
		REMOVED: "削除済み",
		REJECTED: "Bitmovin が作成を拒否",
	},
} as const;

const selectClass =
	"h-9 rounded-md border border-input bg-background px-3 text-sm";
type Account = { id: string; label: string };
const pageSize = 25;
const audio = new Set(["dts", "mp2", "mp3", "vorbis"]);
const video = new Set(["h262", "mjpeg", "vp8"]);
const submissionPrefix = (identity: string) =>
	`bitovp.native-codec:${identity}:`;

async function submissionKey(identity: string, body: CreateNativeCodec) {
	const bytes = new TextEncoder().encode(canonicalCreateRequestJson(body));
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	const storageKey =
		submissionPrefix(identity) +
		Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
	const key = sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
	sessionStorage.setItem(storageKey, key);
	return key;
}

function clearPendingCreation(identity: string, receiptId: string) {
	const prefix = submissionPrefix(identity);
	for (let index = sessionStorage.length - 1; index >= 0; index--) {
		const key = sessionStorage.key(index);
		// The create journal uses the idempotency key as its receipt ID.
		if (key?.startsWith(prefix) && sessionStorage.getItem(key) === receiptId)
			sessionStorage.removeItem(key);
	}
}

function codecAdminIdentity(session?: SessionDto) {
	const actor = draftIdentity(session);
	return actor &&
		(session?.role === "ADMIN" ||
			session?.mode === "password" ||
			session?.mode === "none")
		? JSON.stringify(actor)
		: null;
}

export function NativeCodecClient() {
	const client = useQueryClient();
	const session = useSession();
	const identity = codecAdminIdentity(session.data);
	const canDispatch =
		identity !== null &&
		session.status === "success" &&
		session.fetchStatus === "idle" &&
		client.getQueryState(SESSION_QUERY_KEY)?.isInvalidated === false;
	const admitted = useRef<string | null>(null);
	if (canDispatch) admitted.current = identity;
	// Keep the admitted editor mounted during verification. A change of
	// identity remounts all account and form state.
	const editorIdentity = admitted.current === identity ? identity : null;
	return (
		<CodecEditor
			key={editorIdentity ?? "signed-out"}
			identity={editorIdentity}
			canDispatch={canDispatch}
		/>
	);
}

function CodecEditor({
	identity,
	canDispatch,
}: {
	identity: string | null;
	canDispatch: boolean;
}) {
	const { locale } = useT();
	const label = locale === "ja" ? copy.ja : copy.en;
	const client = useQueryClient();
	const formId = useId();
	const [account, setAccount] = useState("");
	const [offset, setOffset] = useState(0);
	const [codec, setCodec] = useState<NativeCodecReceipt["codec"]>("mp3");
	const [name, setName] = useState("");
	const [confirm, setConfirm] = useState<string | null>(null);
	const [confirmedId, setConfirmedId] = useState("");
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<string>();
	const [error, setError] = useState<string>();
	const inFlight = useRef(false);
	const accounts = useQuery({
		queryKey: ["native-codec-accounts", identity],
		queryFn: ({ signal }) =>
			apiFetch<Account[]>("/api/bitmovin-accounts", { signal }),
		enabled: canDispatch,
	});
	const rows = useQuery({
		queryKey: ["native-codec-configurations", identity, account, offset],
		queryFn: ({ signal }) =>
			apiFetch<NativeCodecList>(
				`/api/encoding-native/codecs?bitmovinAccountId=${encodeURIComponent(account)}&offset=${offset}`,
				{ signal },
			),
		enabled: canDispatch && accounts.data?.some(({ id }) => id === account),
	});
	const actionDisabled = !canDispatch || busy || rows.isFetching;

	function headersForCurrentSession() {
		const current = client.getQueryState<SessionDto>(SESSION_QUERY_KEY);
		if (
			!identity ||
			current?.status !== "success" ||
			current.fetchStatus !== "idle" ||
			current.isInvalidated ||
			codecAdminIdentity(current.data) !== identity
		)
			throw new Error("Codec configuration session changed.");
		return { [CREATE_SESSION_HEADER]: identity };
	}

	async function run(action: () => Promise<NativeCodecReceipt>) {
		if (inFlight.current) return;
		inFlight.current = true;
		setBusy(true);
		setNotice(undefined);
		setError(undefined);
		try {
			const receipt = await action();
			if (identity && receipt.state !== "CREATING")
				clearPendingCreation(identity, receipt.id);
			setNotice(label[receipt.state]);
			setConfirm(null);
		} catch (error) {
			setError(
				error instanceof ApiError && error.status === 410
					? label.removedSubmission
					: label.failed,
			);
		} finally {
			setBusy(false);
			inFlight.current = false;
			await client.invalidateQueries({
				queryKey: ["native-codec-configurations", identity, account],
			});
		}
	}

	function create(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!identity || !rows.data || actionDisabled) return;
		const form = new FormData(event.currentTarget);
		const entries = [...form.entries()].filter(([, value]) => value !== "");
		const accepted = createNativeCodecSchema.safeParse({
			...Object.fromEntries(
				entries.map(([key, value]) => [
					key,
					["mode", "channelLayout", "profile"].includes(key)
						? value
						: Number(value),
				]),
			),
			name,
			codec,
			bitmovinAccountId: account,
			scopeVersion: rows.data.scopeVersion,
		});
		if (!accepted.success) {
			setError(label.invalid);
			return;
		}
		const body = accepted.data;
		void run(async () => {
			const key = await submissionKey(identity, body);
			const result = await apiFetch<NativeCodecReceipt>(
				"/api/encoding-native/codecs",
				{
					method: "POST",
					body: JSON.stringify(body),
					headers: {
						...headersForCurrentSession(),
						"Idempotency-Key": key,
					},
				},
			).catch((error: unknown) => {
				if (error instanceof ApiError && error.status === 410)
					clearPendingCreation(identity, key);
				throw error;
			});
			if (result.state === "ACTIVE") setName("");
			return result;
		});
	}

	function check(row: NativeCodecReceipt) {
		if (!rows.data || actionDisabled || !row.canAct) return;
		const target = {
			id: row.id,
			bitmovinAccountId: account,
			scopeVersion: rows.data.scopeVersion,
			...(row.state === "CREATING" && row.canResumeCreate && { resume: true }),
		};
		void run(() =>
			apiFetch<NativeCodecReceipt>("/api/encoding-native/codecs", {
				method: "PATCH",
				headers: headersForCurrentSession(),
				body: JSON.stringify(target),
			}),
		);
	}

	function remove(row: NativeCodecReceipt) {
		if (
			!rows.data ||
			actionDisabled ||
			!row.canAct ||
			!row.providerId ||
			confirmedId !== row.providerId
		)
			return;
		const target = {
			id: row.id,
			bitmovinAccountId: account,
			scopeVersion: rows.data.scopeVersion,
			confirmProviderId: row.providerId,
		};
		void run(() =>
			apiFetch<NativeCodecReceipt>("/api/encoding-native/codecs", {
				method: "DELETE",
				headers: headersForCurrentSession(),
				body: JSON.stringify(target),
			}),
		);
	}

	return (
		<section className="space-y-6">
			<header>
				<Link
					className="text-sm text-muted-foreground underline"
					href="/settings/encoding-native"
				>
					{label.back}
				</Link>
				<h1 className="mt-2 text-2xl font-semibold">{label.title}</h1>
			</header>
			{identity && (
				<label className="grid max-w-sm gap-1 text-sm">
					{label.account}
					<select
						className={selectClass}
						value={account}
						disabled={busy || !canDispatch}
						onChange={(event) => {
							setAccount(event.target.value);
							setOffset(0);
							setNotice(undefined);
							setError(undefined);
							setConfirm(null);
						}}
					>
						<option value="">{label.pickAccount}</option>
						{accounts.data?.map(({ id, label }) => (
							<option key={id} value={id}>
								{label}
							</option>
						))}
					</select>
				</label>
			)}
			{(accounts.isError || rows.isError) && (
				<p role="alert">{label.unavailable}</p>
			)}
			{notice && <p role="status">{notice}</p>}
			{error && (
				<p role="alert" className="text-destructive">
					{error}
				</p>
			)}
			{identity && rows.data && (
				<>
					<form className="space-y-3" onSubmit={create}>
						<fieldset
							disabled={actionDisabled}
							className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
						>
							<label htmlFor={`${formId}-name`} className="grid gap-1 text-sm">
								{label.name}
								<Input
									id={`${formId}-name`}
									value={name}
									onChange={(event) => setName(event.target.value)}
									required
									maxLength={80}
								/>
							</label>
							<label className="grid gap-1 text-sm">
								{label.codec}
								<select
									className={selectClass}
									value={codec}
									onChange={(event) =>
										setCodec(nativeCodecKind.parse(event.target.value))
									}
								>
									{nativeCodecKinds.map((value) => (
										<option key={value} value={value}>
											{nativeCodecLabels[value]}
										</option>
									))}
								</select>
							</label>
							{(audio.has(codec) || codec === "vp8" || codec === "h262") && (
								<NumberField
									name="bitrate"
									label={codec === "h262" ? label.targetBitrate : label.bitrate}
									required
								/>
							)}
							{codec === "h262" && (
								<label className="grid gap-1 text-sm">
									{label.profile}
									<select name="profile" className={selectClass} required>
										<option value={h262Profile}>MPEG-2 4:2:2</option>
									</select>
								</label>
							)}
							{audio.has(codec) && (
								<NumberField name="rate" label={label.sampleRate} />
							)}
							{codec === "dts" && (
								<label className="grid gap-1 text-sm">
									{label.mode}
									<select name="mode" className={selectClass}>
										<option value="">{label.automatic}</option>
										<option value="EXPRESS_AUDIO">{label.expressAudio}</option>
										<option value="DIGITAL_SURROUND">
											{label.digitalSurround}
										</option>
									</select>
								</label>
							)}
							{codec === "dtsx" && (
								<>
									<label className="grid gap-1 text-sm">
										{label.bitrate}
										<select name="bitrate" className={selectClass}>
											{dtsXBitrates.map((value) => (
												<option key={value} value={value}>
													{value}
												</option>
											))}
										</select>
									</label>
									<label className="grid gap-1 text-sm">
										{label.channelLayout}
										<select name="channelLayout" className={selectClass}>
											<option>5.1</option>
											<option>5.1.4</option>
										</select>
									</label>
								</>
							)}
							{video.has(codec) && (
								<>
									<NumberField name="width" label={label.width} />
									<NumberField name="height" label={label.height} />
									<NumberField
										name="rate"
										label={label.frameRate}
										required={codec === "mjpeg"}
										step="any"
									/>
								</>
							)}
							{codec === "mjpeg" && (
								<NumberField name="qScale" label={label.qScale} required />
							)}
							<div>
								<Button type="submit">{label.create}</Button>
							</div>
						</fieldset>
					</form>
					{rows.data.rows.length === 0 && (
						<p className="text-muted-foreground">{label.noRows}</p>
					)}
					<ul aria-label={label.title} className="divide-y rounded-md border">
						{rows.data.rows.map((row) => (
							<li key={row.id} className="space-y-3 p-3">
								<div className="flex flex-wrap items-center justify-between gap-3">
									<div className="min-w-0 text-sm">
										<div className="font-medium break-all">{row.name}</div>
										<div className="text-muted-foreground">
											{nativeCodecLabels[row.codec]} · {label[row.state]}
											{!row.canAct && ` · ${label.scopeChanged}`}
										</div>
										{row.providerId && (
											<code className="break-all">{row.providerId}</code>
										)}
									</div>
									{row.canAct && (
										<div className="flex flex-wrap gap-2">
											{(row.state === "CREATING" ||
												row.state === "DELETING") && (
												<Button
													size="sm"
													type="button"
													variant="secondary"
													disabled={actionDisabled}
													onClick={() => check(row)}
												>
													{row.state === "CREATING" && row.canResumeCreate
														? label.resume
														: label.check}
												</Button>
											)}
											{(row.state === "ACTIVE" || row.canRetryDelete) && (
												<Button
													size="sm"
													type="button"
													variant="secondary"
													disabled={actionDisabled}
													onClick={() => {
														setConfirm(row.id);
														setConfirmedId("");
													}}
												>
													{row.canRetryDelete
														? label.retryRemove
														: label.remove}
												</Button>
											)}
										</div>
									)}
								</div>
								{confirm === row.id && row.canAct && (
									<div className="flex flex-wrap items-end gap-2">
										<label
											htmlFor={`${formId}-confirm`}
											className="grid gap-1 text-sm"
										>
											{label.confirm}
											<Input
												id={`${formId}-confirm`}
												value={confirmedId}
												onChange={(event) => setConfirmedId(event.target.value)}
											/>
										</label>
										<Button
											size="sm"
											type="button"
											variant="destructive"
											disabled={
												actionDisabled || confirmedId !== row.providerId
											}
											onClick={() => remove(row)}
										>
											{label.remove}
										</Button>
										<Button
											size="sm"
											type="button"
											variant="ghost"
											onClick={() => setConfirm(null)}
										>
											{label.cancel}
										</Button>
									</div>
								)}
							</li>
						))}
					</ul>
					{(offset > 0 || rows.data.hasMore) && (
						<div className="flex gap-2">
							<Button
								type="button"
								variant="secondary"
								disabled={!canDispatch || busy || offset === 0}
								onClick={() => setOffset(offset - pageSize)}
							>
								{label.previous}
							</Button>
							<Button
								type="button"
								variant="secondary"
								disabled={!canDispatch || busy || !rows.data.hasMore}
								onClick={() => setOffset(offset + pageSize)}
							>
								{label.next}
							</Button>
						</div>
					)}
				</>
			)}
		</section>
	);
}

function NumberField({
	name,
	label,
	required,
	step = "1",
}: {
	name: string;
	label: string;
	required?: boolean;
	step?: string;
}) {
	const id = useId();
	return (
		<label htmlFor={id} className="grid gap-1 text-sm">
			{label}
			<Input
				id={id}
				type="number"
				name={name}
				min={step === "any" ? 0 : 1}
				step={step}
				required={required}
			/>
		</label>
	);
}
