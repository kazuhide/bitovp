"use client";
import {
	type VodInputFavoriteCreate,
	vodInputFavoriteCreateSchema,
} from "@bitovp/core/vod-input-timeline";
import { useState } from "react";
import type { StoragePickerSelection } from "@/components/storage-picker";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { baseName } from "@/lib/format";
import { useFavoriteLabels } from "./favorite-labels";

export function FavoriteSaveDialog({
	selection,
	busy,
	error,
	onSave,
	onClose,
}: {
	selection: StoragePickerSelection;
	busy: boolean;
	error: string | null;
	onSave: (value: VodInputFavoriteCreate) => Promise<boolean>;
	onClose: () => void;
}) {
	const l = useFavoriteLabels(),
		[label, setLabel] = useState(baseName(selection.path));
	const [kind, setKind] = useState<VodInputFavoriteCreate["kind"]>(
		/\.(png|jpe?g)$/i.test(selection.path)
			? "IMAGE"
			: /\.(wav|mp3|aac|m4a|flac|opus|ogg)$/i.test(selection.path)
				? "AUDIO"
				: "VIDEO",
	);
	const parsed = vodInputFavoriteCreateSchema.safeParse({
		credentialId: selection.credentialId,
		bucket: selection.bucket,
		objectKey: selection.path,
		label,
		kind,
	});
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !busy) onClose();
			}}
			title={l.saveTitle}
		>
			<div className="space-y-3">
				<p className="break-all text-xs text-zinc-400">{selection.path}</p>
				<Field label={l.label} htmlFor="favorite-label">
					<Input
						id="favorite-label"
						value={label}
						maxLength={120}
						disabled={busy}
						onChange={(event) => setLabel(event.target.value)}
					/>
				</Field>
				<Field label={l.kind} htmlFor="favorite-kind">
					<SelectNative
						id="favorite-kind"
						value={kind}
						disabled={busy}
						onChange={(event) => setKind(event.target.value as typeof kind)}
					>
						<option value="VIDEO">{l.video}</option>
						<option value="AUDIO">{l.audio}</option>
						<option value="IMAGE">{l.image}</option>
					</SelectNative>
				</Field>
				<div className="flex justify-end gap-2">
					<Button variant="ghost" disabled={busy} onClick={onClose}>
						{l.cancel}
					</Button>
					<Button
						disabled={busy || !parsed.success}
						onClick={() => {
							if (parsed.success)
								void onSave(parsed.data).then((saved) => {
									if (saved) onClose();
								});
						}}
					>
						{l.save}
					</Button>
				</div>
				{error && (
					<p role="alert" className="text-xs text-amber-300">
						{l.error(error)}
					</p>
				)}
			</div>
		</Dialog>
	);
}
