"use client";
import type { CredentialSummaryWire } from "@bitovp/core";
import {
	VOD_INPUT_IMAGE_OUTPUT_PROVIDERS,
	type VodInputFavoriteWire,
	type VodInputImagePrepareInput,
	vodInputImagePrepareInputSchema,
} from "@bitovp/core/vod-input-timeline";
import { useEffect, useId, useRef, useState } from "react";
import { StoragePicker } from "@/components/storage-picker";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { InfoHint } from "@/components/ui/info-hint";
import { Input, SelectNative } from "@/components/ui/input";
import type { WizardInputFile } from "../build-plan";
import { inputKindForProvider } from "../stream-model";
import { useImagePlacementLabels } from "./image-placement-labels";
import type { ImagePlacement, PreparedImage } from "./prepared-image-placement";
import { usePreviewTask } from "./use-preview-task";

export type ImageOutputLocation = VodInputImagePrepareInput["output"];
export function ImagePlacementDialog({
	favorite,
	initialOutput,
	credentials,
	positionMs,
	durationMs,
	disabled,
	onPlace,
	onClose,
}: {
	favorite: VodInputFavoriteWire;
	initialOutput?: ImageOutputLocation;
	credentials: Pick<CredentialSummaryWire, "id" | "label" | "provider">[];
	positionMs: number;
	durationMs: number;
	disabled: boolean;
	onPlace: (
		prepared: PreparedImage,
		placement: ImagePlacement,
		kind: WizardInputFile["kind"],
	) => void;
	onClose: () => void;
}) {
	const l = useImagePlacementLabels();
	const formId = useId();
	const [seconds, setSeconds] = useState("5");
	const [mode, setMode] = useState<ImagePlacement["mode"]>("append");
	const [output, setOutput] = useState(
		initialOutput ?? { credentialId: "", bucket: "", prefix: "" },
	);
	const [picker, setPicker] = useState(false);
	const [request, setRequest] = useState<VodInputImagePrepareInput | null>(
		null,
	);
	const [localError, setLocalError] = useState<string | null>(null);
	const task = usePreviewTask(disabled ? null : request, { debounceMs: 0 });
	const remaining = Math.max(0, durationMs - positionMs);
	const credential = credentials.find(
		(item) => item.id === output.credentialId,
	);
	const kind =
		credential &&
		VOD_INPUT_IMAGE_OUTPUT_PROVIDERS.some(
			(provider) => provider === credential.provider,
		)
			? inputKindForProvider(credential.provider)
			: null;
	const duration = Number(seconds);
	const validRange =
		Number.isFinite(duration) &&
		duration >= 1 &&
		duration <= 60 &&
		(mode === "append" || duration * 1000 <= remaining);
	const source = {
		key: `image_${favorite.id.replaceAll("-", "")}`,
		credentialId: favorite.credentialId,
		bucket: favorite.bucket,
		objectKey: favorite.objectKey,
	};
	const parsed = vodInputImagePrepareInputSchema.safeParse({
		kind: "IMAGE_PREPARE",
		source,
		durationMs: Math.round(duration * 1000),
		output,
	});
	const intent = useRef<{
		placement: ImagePlacement;
		kind: WizardInputFile["kind"];
	} | null>(null);
	const adopted = useRef<string | null>(null);
	useEffect(() => {
		if (disabled) {
			setRequest(null);
			intent.current = null;
		}
	}, [disabled]);
	const latest = useRef({ disabled, onPlace, onClose });
	latest.current = { disabled, onPlace, onClose };
	useEffect(() => {
		const prepared = task.ready?.result?.prepared,
			chosen = intent.current;
		if (
			!prepared ||
			!task.ready ||
			!chosen ||
			adopted.current === task.ready.id ||
			latest.current.disabled
		)
			return;
		adopted.current = task.ready.id;
		try {
			latest.current.onPlace(prepared, chosen.placement, chosen.kind);
			latest.current.onClose();
		} catch (error) {
			setLocalError(error instanceof Error ? error.message : "failed");
		}
	}, [task.ready]);
	const busy = task.pending;
	const error = localError ?? task.task?.error?.code ?? task.error;
	return (
		<>
			<Dialog
				open={!picker}
				onOpenChange={(open) => {
					if (!open && !picker) onClose();
				}}
				title={l.title}
				description={favorite.label}
			>
				<form
					className="space-y-4"
					onSubmit={(event) => {
						event.preventDefault();
						if (disabled || busy || !kind || !parsed.success || !validRange)
							return;
						setLocalError(null);
						intent.current = { placement: { mode, atMs: positionMs }, kind };
						if (JSON.stringify(request) === JSON.stringify(parsed.data))
							task.retry();
						else setRequest(parsed.data);
					}}
				>
					<Field htmlFor={`${formId}-duration`} label={l.duration}>
						<Input
							id={`${formId}-duration`}
							aria-label={l.duration}
							type="number"
							min={1}
							max={mode === "append" ? 60 : Math.min(60, remaining / 1000)}
							step={0.001}
							value={seconds}
							disabled={disabled || busy}
							onChange={(event) => setSeconds(event.target.value)}
						/>
					</Field>
					<Field htmlFor={`${formId}-placement`} label={l.placement}>
						<SelectNative
							id={`${formId}-placement`}
							aria-label={l.placement}
							value={mode}
							disabled={disabled || busy}
							onChange={(event) => {
								const next =
									event.target.value === "overwrite" ? "overwrite" : "append";
								setMode(next);
								if (next === "overwrite")
									setSeconds(
										String(
											Math.max(
												1,
												Math.min(Number(seconds) || 5, remaining / 1000),
											),
										),
									);
							}}
						>
							<option value="append">{l.append}</option>
							<option value="overwrite" disabled={remaining < 1000}>
								{l.overwrite}
							</option>
						</SelectNative>
						<p className="mt-1 text-xs text-zinc-400">
							{mode === "append" ? l.appendHint : l.overwriteHint}
						</p>
					</Field>
					<div className="space-y-2">
						<div className="flex items-center gap-2 text-xs text-zinc-400">
							<span>{l.folder}</span>
							<InfoHint text={l.folderHint} />
						</div>
						{output.bucket ? (
							<p className="wrap-anywhere text-xs text-zinc-300">
								{output.bucket} / {output.prefix}
							</p>
						) : (
							<p className="text-xs text-zinc-400">{l.noFolder}</p>
						)}
						<Button
							type="button"
							size="sm"
							variant="secondary"
							disabled={disabled || busy}
							onClick={() => setPicker(true)}
						>
							{l.chooseFolder}
						</Button>
					</div>
					{!validRange && (
						<p role="alert" className="text-xs text-amber-300">
							{l.range}
						</p>
					)}
					{error && (
						<p role="alert" className="text-xs text-amber-300">
							{l.error(error)}
						</p>
					)}
					{busy && (
						<p role="status" className="text-xs text-zinc-400">
							{l.preparing}
						</p>
					)}
					<div className="flex justify-end gap-2">
						<Button type="button" variant="ghost" onClick={onClose}>
							{l.cancel}
						</Button>
						<Button
							type="submit"
							disabled={
								disabled || busy || !parsed.success || !validRange || !kind
							}
						>
							{error ? l.retry : l.place}
						</Button>
					</div>
				</form>
			</Dialog>
			<StoragePicker
				open={picker}
				mode="prefix"
				providers={[...VOD_INPUT_IMAGE_OUTPUT_PROVIDERS]}
				initialCredentialId={output.credentialId || undefined}
				initialBucket={output.bucket || undefined}
				onClose={() => setPicker(false)}
				onSelect={(location) => {
					setOutput({
						credentialId: location.credentialId,
						bucket: location.bucket,
						prefix: location.path,
					});
					setPicker(false);
				}}
			/>
		</>
	);
}
