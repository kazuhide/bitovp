"use client";

import { STORAGE_ROLES, type StorageRoleId } from "@bitovp/core";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldRowAction } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";

export type StorageSelection = {
	input?: { uri: string };
	output?: { uri: string; bucket: string; prefix: string };
};

type SelectionPanelProps = {
	selection: StorageSelection;
	savePending: boolean;
	saveError: string | null;
	onSavePreset: (args: {
		label: string;
		bucket: string;
		prefix: string;
		role: StorageRoleId;
	}) => Promise<void>;
};

function CopyButton({ value }: { value: string }) {
	const { t } = useT();
	const [copied, setCopied] = useState(false);
	return (
		<Button
			variant="ghost"
			size="sm"
			aria-label={t("uiX.copyValue", { value })}
			onClick={async () => {
				await navigator.clipboard.writeText(value);
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			}}
		>
			{copied ? (
				<Check aria-hidden className="h-3.5 w-3.5 text-emerald-400" />
			) : (
				<Copy aria-hidden className="h-3.5 w-3.5" />
			)}
		</Button>
	);
}

/** Shows the picked input object / output prefix; saves location presets. */
export function SelectionPanel({
	selection,
	savePending,
	saveError,
	onSavePreset,
}: SelectionPanelProps) {
	const { t } = useT();
	const [label, setLabel] = useState("");
	const [role, setRole] = useState<StorageRoleId>("OUTPUT");

	if (!selection.input && !selection.output) {
		return null;
	}

	return (
		<aside className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
			<h2 className="font-medium text-sm text-zinc-200">
				{t("storage.selection")}
			</h2>
			<dl className="mt-2 space-y-2 text-sm">
				{selection.input ? (
					<div className="flex items-center gap-2">
						<dt className="w-24 shrink-0 text-xs text-zinc-500">
							{t("storage.input")}
						</dt>
						<dd className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-300">
							{selection.input.uri}
						</dd>
						<CopyButton value={selection.input.uri} />
					</div>
				) : null}
				{selection.output ? (
					<div className="flex items-center gap-2">
						<dt className="w-24 shrink-0 text-xs text-zinc-500">
							{t("storage.output")}
						</dt>
						<dd className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-300">
							{selection.output.uri}
						</dd>
						<CopyButton value={selection.output.uri} />
					</div>
				) : null}
			</dl>
			{selection.output ? (
				/*
				 * Field stacks, not a hand-rolled label+input . The
				 * old markup was `items-end` around its own label markup — correct
				 * on screen only while NOTHING in the row had a hint or error, the
				 * exact latency  documents. Field + items-start makes
				 * the row a member of the population `field-row-alignment.test.ts`
				 * derives, so the guard sees it instead of trusting this comment.
				 */
				<form
					className="mt-3 flex items-start gap-2 border-zinc-800 border-t pt-3"
					onSubmit={(e) => {
						e.preventDefault();
						const output = selection.output;
						if (output && label.trim()) {
							// Keep the typed label unless the save actually succeeds.
							onSavePreset({
								label: label.trim(),
								bucket: output.bucket,
								prefix: output.prefix,
								role,
							})
								.then(() => setLabel(""))
								.catch(() => undefined);
						}
					}}
				>
					<div className="flex-1">
						<Field label={t("storage.saveAsPreset")} htmlFor="preset-label">
							<Input
								id="preset-label"
								className="h-8 text-xs"
								placeholder={t("storage.presetLabelPlaceholder")}
								value={label}
								onChange={(e) => setLabel(e.target.value)}
							/>
						</Field>
					</div>
					<Field label={t("storage.presetRole")} htmlFor="preset-role">
						<SelectNative
							id="preset-role"
							className="h-8 w-28 text-xs"
							value={role}
							onChange={(e) => setRole(e.target.value as StorageRoleId)}
						>
							{STORAGE_ROLES.map((r) => (
								<option key={r} value={r}>
									{r}
								</option>
							))}
						</SelectNative>
					</Field>
					<FieldRowAction>
						<Button
							type="submit"
							size="sm"
							disabled={savePending || !label.trim()}
						>
							{savePending ? t("common.saving") : t("common.save")}
						</Button>
					</FieldRowAction>
				</form>
			) : null}
			{saveError ? (
				<p role="alert" className="mt-2 text-red-400 text-xs">
					{saveError}
				</p>
			) : null}
		</aside>
	);
}
