"use client";

import type { PerTitleCodec } from "@bitovp/core";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import type { PerTitleEncodingImportedConfiguration } from "./per-title-encoding-import";
import { encodingImportCopy } from "./per-title-encoding-import-copy";
import { PerTitleEncodingImportResult } from "./per-title-encoding-import-result";
import { useEncodingImportAccounts } from "./use-encoding-import-accounts";
import { usePerTitleEncodingImport } from "./use-per-title-encoding-import";

export function PerTitleEncodingImportPanel({
	context,
	allowedCodecs,
	onCancel,
	onComplete,
}: {
	context: unknown;
	allowedCodecs: readonly PerTitleCodec[];
	onCancel: () => void;
	onComplete: (configurations: PerTitleEncodingImportedConfiguration[]) => void;
}) {
	const { locale } = useT();
	const copy = encodingImportCopy[locale];
	const id = useId();
	const [mode, setMode] = useState<"saved" | "temporary">("saved");
	const [accountId, setAccountId] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [tenantOrgId, setTenantOrgId] = useState("");
	const [encodingId, setEncodingId] = useState("");
	const [invalid, setInvalid] = useState(false);
	const accounts = useEncodingImportAccounts(mode === "saved");
	const request = usePerTitleEncodingImport(context, allowedCodecs);
	useEffect(() => {
		document.getElementById(`${id}-encoding`)?.focus();
	}, [id]);
	const edit = (change: () => void) => {
		request.invalidate();
		setInvalid(false);
		change();
	};
	function fetchSettings() {
		if (request.loading) return;
		const encoding = encodingId.trim();
		if (
			!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(
				encoding,
			) ||
			(mode === "saved"
				? !accounts.accounts.some(({ id }) => id === accountId)
				: !apiKey.trim())
		) {
			setInvalid(true);
			return;
		}
		setInvalid(false);
		void request.fetchSettings(
			mode === "saved"
				? {
						encodingId: encoding,
						bitmovinAccountId: accountId,
					}
				: {
						encodingId: encoding,
						apiKey: apiKey.trim(),
						...(tenantOrgId.trim() ? { tenantOrgId: tenantOrgId.trim() } : {}),
					},
		);
	}
	return (
		<form
			className="min-w-0 space-y-4"
			autoComplete="off"
			onSubmit={(event) => {
				event.preventDefault();
				fetchSettings();
			}}
		>
			<fieldset className="flex flex-wrap gap-4">
				<legend className="sr-only">
					{locale === "ja" ? "認証方法" : "Authentication method"}
				</legend>
				{(["saved", "temporary"] as const).map((value) => (
					<label
						key={value}
						className="flex items-center gap-2 text-sm text-zinc-300"
					>
						<input
							type="radio"
							name={`${id}-source`}
							checked={mode === value}
							className="accent-blue-500"
							onChange={() =>
								edit(() => {
									setMode(value);
									setApiKey("");
									setTenantOrgId("");
								})
							}
						/>
						{copy[value]}
					</label>
				))}
			</fieldset>
			{mode === "saved" ? (
				<div className="space-y-2">
					<Field label={copy.account} htmlFor={`${id}-account`}>
						<SelectNative
							id={`${id}-account`}
							value={accountId}
							disabled={accounts.status === "loading"}
							onChange={(event) => edit(() => setAccountId(event.target.value))}
						>
							<option value="">
								{accounts.status === "loading"
									? copy.loadingAccounts
									: copy.chooseAccount}
							</option>
							{accounts.accounts.map((account) => (
								<option key={account.id} value={account.id}>
									{account.label}
								</option>
							))}
						</SelectNative>
					</Field>
					{accounts.status === "error" ? (
						<p role="alert" className="text-xs text-red-300">
							{copy.accountsError}{" "}
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={accounts.retry}
							>
								{locale === "ja" ? "再試行" : "Retry"}
							</Button>
						</p>
					) : null}
					{accounts.status === "loaded" && !accounts.accounts.length ? (
						<p role="status" className="text-xs text-zinc-400">
							{copy.noAccounts}
						</p>
					) : null}
				</div>
			) : (
				<div className="grid gap-3 sm:grid-cols-2">
					<Field label={copy.key} htmlFor={`${id}-key`}>
						<Input
							id={`${id}-key`}
							type="password"
							autoComplete="one-time-code"
							autoCapitalize="none"
							autoCorrect="off"
							spellCheck={false}
							maxLength={4096}
							value={apiKey}
							onChange={(event) => edit(() => setApiKey(event.target.value))}
						/>
					</Field>
					<Field label={copy.tenant} htmlFor={`${id}-tenant`}>
						<Input
							id={`${id}-tenant`}
							autoComplete="off"
							spellCheck={false}
							maxLength={128}
							value={tenantOrgId}
							onChange={(event) =>
								edit(() => setTenantOrgId(event.target.value))
							}
						/>
					</Field>
				</div>
			)}
			<Field label={copy.encoding} htmlFor={`${id}-encoding`}>
				<Input
					id={`${id}-encoding`}
					value={encodingId}
					autoComplete="off"
					spellCheck={false}
					maxLength={128}
					onChange={(event) => edit(() => setEncodingId(event.target.value))}
				/>
			</Field>
			<Button
				type="submit"
				variant="secondary"
				disabled={
					request.loading || (mode === "saved" && accounts.status !== "loaded")
				}
			>
				{request.loading ? copy.fetching : copy.fetch}
			</Button>
			{request.loading ? (
				<p role="status" className="text-xs text-zinc-400">
					{copy.fetching}
				</p>
			) : null}
			{invalid || request.error ? (
				<p role="alert" className="text-xs text-red-300">
					{invalid
						? copy.invalidInput
						: request.error
							? copy[request.error]
							: null}
				</p>
			) : null}
			{request.result ? (
				<PerTitleEncodingImportResult
					key={request.resultVersion}
					result={request.result}
					onCancel={onCancel}
					onComplete={onComplete}
				/>
			) : (
				<div className="flex justify-end border-t border-zinc-800 pt-3">
					<Button type="button" variant="ghost" onClick={onCancel}>
						{copy.cancel}
					</Button>
				</div>
			)}
		</form>
	);
}
