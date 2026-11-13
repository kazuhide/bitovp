"use client";
import type { VodInputFavoriteWire } from "@bitovp/core/vod-input-timeline";
import { FileAudio2, FileImage, FileVideo2, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	StoragePicker,
	type StoragePickerSelection,
} from "@/components/storage-picker";
import { Button } from "@/components/ui/button";
import { BROWSABLE_STORAGE_PROVIDERS } from "../stream-model";
import { FavoriteImageActions } from "./favorite-image-actions";
import { useFavoriteLabels } from "./favorite-labels";
import { FavoriteSaveDialog } from "./favorite-save-dialog";
import type { InputFavoritesModel } from "./use-input-favorites";

export function FavoriteBin({
	model,
	disabled,
	onUse,
	canUseLogo,
	canUseMedia,
	onPrepareImage,
}: {
	model: InputFavoritesModel;
	disabled: boolean;
	onUse: (favorite: VodInputFavoriteWire) => void;
	canUseLogo: boolean;
	canUseMedia: boolean;
	onPrepareImage?: (favorite: VodInputFavoriteWire) => void;
}) {
	const l = useFavoriteLabels(),
		[picker, setPicker] = useState(false),
		[selection, setSelection] = useState<StoragePickerSelection | null>(null),
		[applying, setApplying] = useState(false),
		[logoInfo, setLogoInfo] = useState(false);
	const latest = useRef({
		disabled,
		onUse,
		canUseLogo,
		canUseMedia,
		onPrepareImage,
	});
	latest.current = { disabled, onUse, canUseLogo, canUseMedia, onPrepareImage };
	const active = useRef<AbortController | null>(null);
	useEffect(() => () => active.current?.abort(), []);
	async function apply(id: string, clip = false) {
		if (active.current) return;
		const controller = new AbortController();
		active.current = controller;
		setApplying(true);
		try {
			const fresh = (await model.load(controller.signal)).find(
					(item) => item.id === id,
				),
				current = latest.current;
			if (controller.signal.aborted) return;
			if (fresh?.availability !== "AVAILABLE" || !fresh.inputKind)
				throw new Error("FAVORITE_UNAVAILABLE");
			if (current.disabled) return;
			if (fresh.kind === "IMAGE" && !clip && !current.canUseLogo)
				throw new Error("LOGO_NEEDS_VIDEO");
			if ((fresh.kind !== "IMAGE" || clip) && !current.canUseMedia)
				throw new Error("FAVORITE_SOURCE_LIMIT");
			if (clip) {
				if (fresh.kind !== "IMAGE" || !current.onPrepareImage)
					throw new Error("FAVORITE_UNAVAILABLE");
				current.onPrepareImage(fresh);
			} else current.onUse(fresh);
			setLogoInfo(fresh.kind === "IMAGE" && !clip);
		} catch (error) {
			if (!controller.signal.aborted) model.fail(error);
		} finally {
			if (active.current === controller) active.current = null;
			if (!controller.signal.aborted) setApplying(false);
		}
	}
	const blocked = disabled || model.busy || applying || !model.ready;
	return (
		<div className="space-y-2 border-zinc-800 border-t pt-2">
			<div className="flex items-center justify-between gap-2">
				<h3 className="font-medium text-sm text-zinc-200">{l.title}</h3>
				<Button
					size="icon"
					variant="ghost"
					aria-label={l.add}
					disabled={blocked}
					onClick={() => setPicker(true)}
				>
					<Plus aria-hidden className="h-4 w-4" />
				</Button>
			</div>
			<ul className="max-h-48 space-y-1 overflow-y-auto">
				{model.items.map((item) => {
					const image = item.kind === "IMAGE",
						Icon = image
							? FileImage
							: item.kind === "AUDIO"
								? FileAudio2
								: FileVideo2;
					const reason =
						item.availability === "CREDENTIAL_UNAVAILABLE"
							? l.unavailable
							: item.availability === "UNSUPPORTED_PROVIDER"
								? l.unsupported
								: image && !canUseLogo
									? l.needsVideo
									: !image && !canUseMedia
										? l.cap
										: null;
					return (
						<li
							key={item.id}
							className="flex min-w-0 items-center gap-1 rounded border border-zinc-800 p-1"
						>
							{image && onPrepareImage ? (
								<FavoriteImageActions
									item={item}
									blocked={blocked}
									canUseLogo={canUseLogo}
									canUseMedia={canUseMedia}
									reason={reason}
									onLogo={() => void apply(item.id)}
									onClip={() => void apply(item.id, true)}
								/>
							) : (
								<button
									type="button"
									disabled={blocked || !!reason}
									title={reason ?? item.objectKey}
									aria-label={image ? l.logo(item.label) : l.use(item.label)}
									onClick={() => void apply(item.id)}
									className="flex min-w-0 flex-1 items-center gap-2 rounded p-1 text-left text-xs hover:bg-zinc-900 focus-visible:outline-2 focus-visible:outline-emerald-400 disabled:opacity-50"
								>
									<Icon
										aria-hidden
										className="h-5 w-5 shrink-0 text-zinc-500"
									/>
									<span className="min-w-0">
										<span className="block truncate text-zinc-200">
											{item.label}
										</span>
										{reason && (
											<span className="block text-zinc-400">{reason}</span>
										)}
									</span>
								</button>
							)}
							<Button
								size="icon"
								variant="ghost"
								aria-label={l.remove(item.label)}
								disabled={disabled || model.busy || applying}
								onClick={() => void model.remove(item.id)}
							>
								<Trash2 aria-hidden className="h-3.5 w-3.5" />
							</Button>
						</li>
					);
				})}
			</ul>
			{model.ready && !model.items.length && !model.error && (
				<p className="text-xs text-zinc-500">{l.empty}</p>
			)}
			{logoInfo && (
				<p role="status" className="text-xs text-zinc-400">
					{l.logoInfo}
				</p>
			)}
			{model.error && !selection && (
				<div role="alert" className="space-y-1 text-xs text-amber-300">
					<p>{l.error(model.error)}</p>
					<Button
						size="sm"
						variant="ghost"
						disabled={disabled || model.busy}
						onClick={() => void model.load().catch(model.fail)}
					>
						{l.retry}
					</Button>
				</div>
			)}
			<StoragePicker
				open={picker}
				mode="object"
				providers={[...BROWSABLE_STORAGE_PROVIDERS]}
				onClose={() => setPicker(false)}
				onSelect={(value) => {
					setPicker(false);
					setSelection(value);
				}}
			/>
			{selection && (
				<FavoriteSaveDialog
					key={JSON.stringify(selection)}
					selection={selection}
					busy={model.busy}
					error={model.error}
					onSave={model.add}
					onClose={() => setSelection(null)}
				/>
			)}
		</div>
	);
}
