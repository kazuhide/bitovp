"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { type FormEvent, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
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
		sampleRate: "Sampling rate (Hz)",
		frameRate: "Frame rate (fps)",
		width: "Width (px)",
		height: "Height (px)",
		qScale: "Quality scale",
		channelLayout: "Channel layout",
		mode: "DTS mode",
		automatic: "Automatic",
		create: "Create configuration",
		check: "Check provider",
		remove: "Remove",
		retryRemove: "Retry removal",
		cancel: "Cancel",
		confirm: "Confirm provider ID",
		noRows: "No configurations created here.",
		scopeChanged: "Earlier account scope",
		failed: "Action failed. Refresh the account and check the receipt.",
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
		sampleRate: "サンプリング周波数（Hz）",
		frameRate: "フレームレート（fps）",
		width: "幅（px）",
		height: "高さ（px）",
		qScale: "品質スケール",
		channelLayout: "チャンネル構成",
		mode: "DTS モード",
		automatic: "自動",
		create: "構成を作成",
		check: "Bitmovin の状態を確認",
		remove: "削除",
		retryRemove: "削除を再試行",
		cancel: "キャンセル",
		confirm: "削除する構成の ID",
		noRows: "この画面で作成した構成はありません。",
		scopeChanged: "以前のアカウント設定",
		failed: "操作に失敗しました。アカウントと操作記録を確認してください。",
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

async function submissionKey(identity: string, body: CreateNativeCodec) {
	const bytes = new TextEncoder().encode(canonicalCreateRequestJson(body));
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	const storageKey = `bitovp.native-codec:${identity}:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
	const key = sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
	sessionStorage.setItem(storageKey, key);
	return { key, storageKey };
}

export function NativeCodecClient() {
	const { locale } = useT();
	const label = locale === "ja" ? copy.ja : copy.en;
	const client = useQueryClient();
	const formId = useId();
	const session = useSession();
	const actor =
		session.status === "success" && !session.isFetching
			? draftIdentity(session.data)
			: null;
	const identity = actor ? JSON.stringify(actor) : null;
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
	const admin =
		Boolean(identity && session.data?.role === "ADMIN") ||
		Boolean(
			identity &&
				(session.data?.mode === "password" || session.data?.mode === "none"),
		);
	const accounts = useQuery({
		queryKey: ["native-codec-accounts", identity],
		queryFn: ({ signal }) =>
			apiFetch<Account[]>("/api/bitmovin-accounts", { signal }),
		enabled: admin,
	});
	const rows = useQuery({
		queryKey: ["native-codec-configurations", identity, account, offset],
		queryFn: ({ signal }) =>
			apiFetch<NativeCodecList>(
				`/api/encoding-native/codecs?bitmovinAccountId=${encodeURIComponent(account)}&offset=${offset}`,
				{ signal },
			),
		enabled: admin && accounts.data?.some(({ id }) => id === account),
	});

	function headersForCurrentSession() {
		const current = client.getQueryState<SessionDto>(SESSION_QUERY_KEY);
		if (
			!identity ||
			current?.status !== "success" ||
			current.fetchStatus !== "idle" ||
			current.isInvalidated ||
			JSON.stringify(draftIdentity(current.data)) !== identity
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
			setNotice(label[receipt.state]);
			setConfirm(null);
		} catch {
			setError(label.failed);
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
		if (!identity || !rows.data || !admin) return;
		const form = new FormData(event.currentTarget);
		const entries = [...form.entries()].filter(([, value]) => value !== "");
		const accepted = createNativeCodecSchema.safeParse({
			...Object.fromEntries(
				entries.map(([key, value]) => [
					key,
					["mode", "channelLayout"].includes(key) ? value : Number(value),
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
			const pending = await submissionKey(identity, body);
			const result = await apiFetch<NativeCodecReceipt>(
				"/api/encoding-native/codecs",
				{
					method: "POST",
					body: JSON.stringify(body),
					headers: {
						...headersForCurrentSession(),
						"Idempotency-Key": pending.key,
					},
				},
			);
			if (result.state !== "CREATING")
				sessionStorage.removeItem(pending.storageKey);
			if (result.state === "ACTIVE") setName("");
			return result;
		});
	}

	function check(row: NativeCodecReceipt) {
		if (!rows.data || !admin || !row.canAct) return;
		const target = {
			id: row.id,
			bitmovinAccountId: account,
			scopeVersion: rows.data.scopeVersion,
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
			!admin ||
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
			{admin && (
				<label className="grid max-w-sm gap-1 text-sm">
					{label.account}
					<select
						className={selectClass}
						value={account}
						disabled={busy}
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
			{admin && rows.data && (
				<>
					<form className="space-y-3" onSubmit={create}>
						<fieldset
							disabled={busy || rows.isFetching}
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
									label={label.bitrate}
									required={codec !== "h262"}
								/>
							)}
							{audio.has(codec) && (
								<NumberField name="rate" label={label.sampleRate} />
							)}
							{codec === "dts" && (
								<label className="grid gap-1 text-sm">
									{label.mode}
									<select name="mode" className={selectClass}>
										<option value="">{label.automatic}</option>
										<option value="EXPRESS_AUDIO">Express Audio</option>
										<option value="DIGITAL_SURROUND">Digital Surround</option>
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
													disabled={busy || rows.isFetching}
													onClick={() => check(row)}
												>
													{label.check}
												</Button>
											)}
											{(row.state === "ACTIVE" || row.canRetryDelete) && (
												<Button
													size="sm"
													type="button"
													variant="secondary"
													disabled={busy || rows.isFetching}
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
												busy ||
												rows.isFetching ||
												confirmedId !== row.providerId
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
								disabled={busy || offset === 0}
								onClick={() => setOffset(offset - pageSize)}
							>
								{label.previous}
							</Button>
							<Button
								type="button"
								variant="secondary"
								disabled={busy || !rows.data.hasMore}
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
