"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { type FormEvent, useId, useRef, useState } from "react";
import { CopyableId } from "@/components/copyable-id";
import { Button } from "@/components/ui/button";
import { Input, SelectNative } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import { SESSION_QUERY_KEY, useSession } from "@/lib/auth/use-session";
import { CREATE_SESSION_HEADER } from "@/lib/creation-submission-contract";
import { useT } from "@/lib/i18n/context";
import {
	NATIVE_OPERATION_KEY_CONFLICT,
	type NativeOperationAction,
	type NativeOperationReceipt,
	nativeOperationActions,
	nativeOperationSchema,
} from "@/lib/native-account-operations";
import { draftIdentity } from "@/lib/wizard-draft";

const endpoint = "/api/encoding-native/operations";
type Account = { id: string; label: string };
type Receipts = { scopeVersion: string; rows: NativeOperationReceipt[] };
type Result = NativeOperationReceipt & { uploadUrl?: string };

const copy = {
	en: {
		title: "Manage encoding resources",
		back: "Encoding resources",
		account: "Bitmovin account",
		select: "Select an account",
		action: "Operation",
		execute: "Submit operation",
		processing: "Submitting…",
		activity: "Recent operations",
		refresh: "Refresh",
		empty: "No operations for this account.",
		accountsFailed: "Could not load Bitmovin accounts.",
		receiptsFailed: "Could not load operations.",
		invalid: "Check the fields and the confirmation.",
		failed:
			"Could not complete the request. Refresh the operation history before retrying.",
		PENDING: "Submitted",
		UNKNOWN: "Check the result in Bitmovin",
		ACCEPTED: "Accepted by Bitmovin",
		REJECTED: "Rejected by Bitmovin",
		passed: "Write allowed",
		denied: "Write check failed",
		upload: "Copy 5-minute upload URL",
		copied: "Upload URL copied",
		copyFailed: "Could not copy the URL",
		newAfterReview: "Prepare a new operation after checking Bitmovin",
		keyConflict:
			"This request ID belongs to an earlier operation. Check recent operations.",
		earlierRequest: "Earlier request ID",
		template: "720p MP4 · H.264 2 Mbps · AAC 128 kbps · private output",
		uploadHelp: "Upload the source with HTTP PUT before the URL expires.",
		deleteHelp: "Resources created here can be removed by ID.",
		watchHelp:
			"Starting the folder can encode files automatically and incur charges.",
		templateHelp:
			"This starts a billable encoding and writes to a new subfolder.",
		probeHelp:
			"In a unique subfolder, Bitmovin writes WritePermissionTestFile.txt.",
		acceptCharges: "Allow this billable operation",
		acceptWrite: "Allow the test file",
	},
	ja: {
		title: "エンコーディングリソースを管理",
		back: "エンコーディングリソース",
		account: "Bitmovin アカウント",
		select: "アカウントを選択",
		action: "操作",
		execute: "送信",
		processing: "送信中…",
		activity: "最近の操作",
		refresh: "更新",
		empty: "このアカウントの操作記録はありません。",
		accountsFailed: "アカウントを読み込めませんでした。",
		receiptsFailed: "操作記録を読み込めませんでした。",
		invalid: "入力項目と確認内容を見直してください。",
		failed:
			"リクエストを完了できませんでした。再試行の前に操作記録を更新してください。",
		PENDING: "送信済み",
		UNKNOWN: "Bitmovin で結果を確認",
		ACCEPTED: "Bitmovin が受理",
		REJECTED: "Bitmovin が拒否",
		passed: "書き込み可能",
		denied: "書き込みテストに失敗",
		upload: "5分間有効なアップロードURLをコピー",
		copied: "アップロードURLをコピーしました",
		copyFailed: "URLをコピーできませんでした",
		newAfterReview: "Bitmovin で確認済み · 新しい操作を準備",
		keyConflict:
			"このリクエストIDは以前の操作に使われています。最近の操作を確認してください。",
		earlierRequest: "以前のリクエストID",
		template: "720p MP4 · H.264 2 Mbps · AAC 128 kbps · 非公開出力",
		uploadHelp: "URLの有効期間内にHTTP PUTで素材をアップロードしてください。",
		deleteHelp: "この画面で作成したリソースをIDで削除できます。",
		watchHelp:
			"開始するとファイルの自動エンコードが行われ、料金が発生する場合があります。",
		templateHelp:
			"有料のエンコードを開始し、新しいサブフォルダーに出力します。",
		probeHelp:
			"Bitmovin が専用サブフォルダーに WritePermissionTestFile.txt を作成します。",
		acceptCharges: "料金が発生する操作を許可",
		acceptWrite: "テストファイルの作成を許可",
	},
} as const;

type Lang = keyof typeof copy;
type Copy = (typeof copy)[Lang];
const subjects: Record<string, readonly [string, string]> = {
	"aspera-input": ["Aspera input", "Aspera 入力"],
	"direct-upload": ["direct upload input", "直接アップロード入力"],
	"ftp-input": ["FTP input", "FTP 入力"],
	"http-input": ["HTTP input", "HTTP 入力"],
	"local-input": ["local input", "ローカル入力"],
	"sftp-input": ["SFTP input", "SFTP 入力"],
	"ftp-output": ["FTP output", "FTP 出力"],
	"local-output": ["local output", "ローカル出力"],
	"azure-captions": [
		"Azure Speech captions filter",
		"Azure Speech 字幕フィルター",
	],
	"watch-folder": ["watch folder", "監視フォルダー"],
	template: ["encoding template", "エンコードテンプレート"],
};

function actionLabel(action: string, lang: Lang) {
	if (action === "check-s3-output")
		return lang === "ja" ? "S3 出力権限を確認" : "Check S3 output permissions";
	if (action === "start-template")
		return lang === "ja" ? "MP4 エンコードを開始" : "Start MP4 encoding";
	const split = action.indexOf("-");
	const verb = action.slice(0, split);
	const subject = subjects[action.slice(split + 1)];
	const actions = {
		create: ["Create", "を作成"],
		delete: ["Delete", "を削除"],
		start: ["Start", "を開始"],
		stop: ["Stop", "を停止"],
	} as const;
	const labels = actions[verb as keyof typeof actions];
	if (!subject || !labels) return action;
	return lang === "ja" ? subject[1] + labels[1] : `${labels[0]} ${subject[0]}`;
}

const fields = {
	name: ["Name", "名前"],
	host: ["Host", "ホスト名"],
	port: ["Port", "ポート"],
	username: ["Username", "ユーザー名"],
	password: ["Password", "パスワード"],
	token: ["Aspera token", "Aspera トークン"],
	sshPort: ["SSH port", "SSH ポート"],
	faspPort: ["FASP port", "FASP ポート"],
	path: ["Storage path", "ストレージパス"],
	region: ["Speech region", "Speech リージョン"],
	language: ["Language tag", "言語タグ"],
	subscriptionKey: ["Azure Speech key", "Azure Speech キー"],
	inputId: ["Input ID", "入力ID"],
	inputPath: ["Input path", "入力パス"],
	outputId: ["Output ID", "出力ID"],
	outputPath: ["Output folder prefix", "出力先のプレフィックス"],
	resourceId: ["Resource ID", "リソースID"],
	confirmId: ["Confirm resource ID", "確認用リソースID"],
} as const;
type Field = keyof typeof fields;
const optional = new Set<Field>([
	"username",
	"password",
	"port",
	"token",
	"sshPort",
	"faspPort",
]);
const numeric = new Set<Field>(["port", "sshPort", "faspPort"]);
const sensitive = new Set<Field>(["password", "token", "subscriptionKey"]);

function commandFields(action: NativeOperationAction): readonly Field[] {
	switch (action) {
		case "create-aspera-input":
			return [
				"name",
				"host",
				"username",
				"password",
				"token",
				"sshPort",
				"faspPort",
			];
		case "create-http-input":
		case "create-ftp-input":
		case "create-sftp-input":
		case "create-ftp-output":
			return ["name", "host", "port", "username", "password"];
		case "create-direct-upload":
			return ["name"];
		case "create-local-input":
		case "create-local-output":
			return ["name", "path"];
		case "create-azure-captions":
			return ["name", "region", "language", "subscriptionKey"];
		case "create-template":
		case "create-watch-folder":
			return ["name", "inputId", "inputPath", "outputId", "outputPath"];
		case "start-template":
			return [
				"name",
				"inputId",
				"inputPath",
				"outputId",
				"outputPath",
				"confirmId",
			];
		case "check-s3-output":
			return ["resourceId", "path", "confirmId"];
		default:
			return ["resourceId", "confirmId"];
	}
}

export function NativeOperationClient() {
	const session = useSession();
	const query = useQueryClient();
	const principal = draftIdentity(session.data);
	const admin =
		session.data?.role === "ADMIN" ||
		session.data?.mode === "password" ||
		session.data?.mode === "none";
	const identity = principal && admin ? JSON.stringify(principal) : null;
	const canSubmit =
		!!identity &&
		session.isSuccess &&
		!session.isFetching &&
		query.getQueryState(SESSION_QUERY_KEY)?.isInvalidated === false;
	return (
		<Operations
			key={identity ?? "signed-out"}
			identity={identity}
			canSubmit={canSubmit}
		/>
	);
}

function Operations({
	identity,
	canSubmit,
}: {
	identity: string | null;
	canSubmit: boolean;
}) {
	const { locale } = useT();
	const lang = locale === "ja" ? "ja" : "en";
	const label = copy[lang];
	const id = useId();
	const [account, setAccount] = useState("");
	const [action, setAction] =
		useState<NativeOperationAction>("create-http-input");
	const accounts = useQuery({
		queryKey: ["native-operation-accounts", identity],
		queryFn: ({ signal }) =>
			apiFetch<Account[]>("/api/bitmovin-accounts", { signal }),
		enabled: !!identity,
	});
	const accountReady = accounts.data?.some(({ id }) => id === account) === true;
	const query = useQuery({
		queryKey: ["native-operations", identity, account],
		queryFn: ({ signal }) =>
			apiFetch<Receipts>(
				`${endpoint}?${new URLSearchParams({ bitmovinAccountId: account })}`,
				{ signal },
			),
		enabled: accountReady && !!identity,
	});

	return (
		<section className="max-w-4xl space-y-6">
			<header className="space-y-2">
				<Link
					href="/settings/encoding-native"
					className="text-sm text-muted-foreground underline"
				>
					{label.back}
				</Link>
				<h1 className="font-semibold text-xl">{label.title}</h1>
			</header>
			<div className="grid gap-3 sm:grid-cols-2">
				<label className="space-y-1 text-sm" htmlFor={`${id}-account`}>
					<span>{label.account}</span>
					<SelectNative
						id={`${id}-account`}
						value={account}
						onChange={(event) => setAccount(event.currentTarget.value)}
					>
						<option value="">{label.select}</option>
						{accounts.data?.map(({ id, label }) => (
							<option key={id} value={id}>
								{label}
							</option>
						))}
					</SelectNative>
				</label>
				<label className="space-y-1 text-sm" htmlFor={`${id}-action`}>
					<span>{label.action}</span>
					<SelectNative
						id={`${id}-action`}
						value={action}
						onChange={(event) =>
							setAction(event.currentTarget.value as NativeOperationAction)
						}
					>
						{nativeOperationActions.map((item) => (
							<option key={item} value={item}>
								{actionLabel(item, lang)}
							</option>
						))}
					</SelectNative>
				</label>
			</div>
			{accounts.isError && <p role="alert">{label.accountsFailed}</p>}
			{query.isError && <p role="alert">{label.receiptsFailed}</p>}
			{identity && query.data && accountReady && (
				<OperationForm
					key={account + query.data.scopeVersion + action}
					identity={identity}
					account={account}
					scopeVersion={query.data.scopeVersion}
					action={action}
					lang={lang}
					enabled={canSubmit}
					refresh={() => void query.refetch()}
				/>
			)}
			{query.data && accountReady && (
				<section className="space-y-3 border-t pt-4">
					<div className="flex items-center justify-between gap-3">
						<h2 className="font-medium">{label.activity}</h2>
						<Button
							variant="secondary"
							type="button"
							onClick={() => query.refetch()}
							disabled={query.isFetching}
						>
							{label.refresh}
						</Button>
					</div>
					{query.data.rows.length ? (
						<ul className="divide-y rounded-md border px-3">
							{query.data.rows.map((row) => (
								<li
									key={row.id}
									className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
								>
									<span>{actionLabel(row.action, lang)}</span>
									<span className="text-muted-foreground">
										{receiptStatus(row, label)}
									</span>
									<CopyableId value={row.providerId ?? row.id} />
								</li>
							))}
						</ul>
					) : (
						<p className="text-muted-foreground text-sm">{label.empty}</p>
					)}
				</section>
			)}
		</section>
	);
}

function receiptStatus(row: NativeOperationReceipt, label: Copy) {
	if (row.passed === true) return label.passed;
	if (row.passed === false) return label.denied;
	return Object.hasOwn(label, row.state)
		? label[row.state as keyof Copy]
		: row.state;
}

function OperationForm({
	identity,
	account,
	scopeVersion,
	action,
	lang,
	enabled,
	refresh,
}: {
	identity: string;
	account: string;
	scopeVersion: string;
	action: NativeOperationAction;
	lang: Lang;
	enabled: boolean;
	refresh: () => void;
}) {
	const id = useId();
	const label = copy[lang];
	const inFlight = useRef(false);
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<Result>();
	const [conflictKey, setConflictKey] = useState<string>();
	const [status, setStatus] = useState("");
	const storageKey = [
		"bitovp.native-operation",
		identity,
		account,
		scopeVersion,
		action,
	].join(":");
	const reviewedStorageKey = `${storageKey}:reviewed`;
	const [reviewedKey, setReviewedKey] = useState(() => {
		try {
			return sessionStorage.getItem(reviewedStorageKey);
		} catch {
			return null;
		}
	});
	const formFields = commandFields(action);
	const billed = action === "start-template" || action === "start-watch-folder";
	const probe = action === "check-s3-output";
	const template = action === "create-template" || action === "start-template";

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!enabled || inFlight.current) return;
		const form = event.currentTarget;
		const values = Object.fromEntries(new FormData(form));
		const fields = Object.fromEntries(
			formFields.flatMap((field) => {
				const value = values[field];
				return typeof value === "string" && value !== ""
					? [[field, numeric.has(field) ? Number(value) : value]]
					: [];
			}),
		);
		const parsed = nativeOperationSchema.safeParse({
			bitmovinAccountId: account,
			scopeVersion,
			action,
			...fields,
			...(billed && { acceptCharges: values.acceptCharges === "on" }),
			...(probe && { acceptWrite: values.acceptWrite === "on" }),
		});
		if (!parsed.success) {
			setStatus(label.invalid);
			return;
		}
		inFlight.current = true;
		setBusy(true);
		setStatus("");
		setResult(undefined);
		setConflictKey(undefined);
		let attemptedKey: string | undefined;
		try {
			const key = sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
			attemptedKey = key;
			sessionStorage.setItem(storageKey, key);
			const response = await apiFetch<Result>(endpoint, {
				method: "POST",
				headers: { "Idempotency-Key": key, [CREATE_SESSION_HEADER]: identity },
				body: JSON.stringify(parsed.data),
			});
			setResult(response);
			setStatus(receiptStatus(response, label));
			if (response.state === "ACCEPTED" || response.state === "REJECTED")
				sessionStorage.removeItem(storageKey);
			form.reset();
		} catch (error) {
			if (
				error instanceof ApiError &&
				error.status === 409 &&
				(error.details as { code?: unknown } | null)?.code ===
					NATIVE_OPERATION_KEY_CONFLICT
			) {
				setConflictKey(attemptedKey);
				setStatus(label.keyConflict);
			} else {
				if (error instanceof ApiError && [400, 403, 404].includes(error.status))
					sessionStorage.removeItem(storageKey);
				setStatus(label.failed);
			}
		} finally {
			refresh();
			setBusy(false);
			inFlight.current = false;
		}
	}

	async function copyUpload() {
		if (!result?.uploadUrl) return;
		try {
			await navigator.clipboard.writeText(result.uploadUrl);
			setStatus(label.copied);
		} catch {
			setStatus(label.copyFailed);
		}
	}

	const earlierKey =
		conflictKey ?? (result?.state === "UNKNOWN" ? result.id : undefined);
	return (
		<form
			onSubmit={submit}
			autoComplete="off"
			className="space-y-3 rounded-md border p-4"
		>
			{template && (
				<p className="text-sm text-muted-foreground">{label.template}</p>
			)}
			{action.startsWith("delete-") && (
				<p className="text-sm text-muted-foreground">{label.deleteHelp}</p>
			)}
			<fieldset disabled={!enabled || busy} className="space-y-3">
				<div className="grid gap-3 sm:grid-cols-2">
					{formFields.map((field) => (
						<label
							key={field}
							htmlFor={`${id}-${field}`}
							className="space-y-1 text-sm"
						>
							<span>
								{field === "confirmId" && action === "start-template"
									? lang === "ja"
										? "確認用出力ID"
										: "Confirm output ID"
									: fields[field][lang === "ja" ? 1 : 0]}
							</span>
							<Input
								id={`${id}-${field}`}
								name={field}
								type={
									sensitive.has(field)
										? "password"
										: numeric.has(field)
											? "number"
											: "text"
								}
								required={!optional.has(field)}
								min={numeric.has(field) ? 1 : undefined}
								max={numeric.has(field) ? 65535 : undefined}
								autoComplete={sensitive.has(field) ? "new-password" : "off"}
							/>
						</label>
					))}
				</div>
				{billed && (
					<label className="flex flex-wrap items-center gap-2 text-sm">
						<input name="acceptCharges" type="checkbox" required />{" "}
						{label.acceptCharges}
						<span className="basis-full text-muted-foreground">
							{template ? label.templateHelp : label.watchHelp}
						</span>
					</label>
				)}
				{probe && (
					<label className="flex flex-wrap items-center gap-2 text-sm">
						<input name="acceptWrite" type="checkbox" required />{" "}
						{label.acceptWrite}
						<span className="basis-full text-muted-foreground">
							{label.probeHelp}
						</span>
					</label>
				)}
				<Button type="submit">{busy ? label.processing : label.execute}</Button>
			</fieldset>
			{status && (
				<p aria-live="polite" className="text-sm">
					{status}
				</p>
			)}
			{result?.providerId && <CopyableId value={result.providerId} />}
			{earlierKey && (
				<div className="flex flex-wrap items-center gap-2">
					<CopyableId value={earlierKey} />
					<Button
						type="button"
						variant="secondary"
						disabled={!enabled || busy}
						onClick={() => {
							sessionStorage.setItem(reviewedStorageKey, earlierKey);
							sessionStorage.removeItem(storageKey);
							setReviewedKey(earlierKey);
							setResult(undefined);
							setConflictKey(undefined);
							setStatus("");
							refresh();
						}}
					>
						{label.newAfterReview}
					</Button>
				</div>
			)}
			{reviewedKey && (
				<p className="flex flex-wrap items-center gap-2 text-muted-foreground text-sm">
					{label.earlierRequest}
					<CopyableId value={reviewedKey} label={label.earlierRequest} />
				</p>
			)}
			{result?.uploadUrl && (
				<div className="space-y-2">
					<Button type="button" variant="secondary" onClick={copyUpload}>
						{label.upload}
					</Button>
					<p className="text-sm text-muted-foreground">{label.uploadHelp}</p>
				</div>
			)}
		</form>
	);
}
