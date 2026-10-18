"use client";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import { videoKeys, type WizardSprite, type WizardState } from "./build-plan";

/** A `spriteN` key not already used (length+1 can collide after a removal). */
function nextSpriteKey(sprites: WizardSprite[]): string {
	const used = new Set(sprites.map((s) => s.key));
	let n = sprites.length + 1;
	while (used.has(`sprite${n}`)) {
		n += 1;
	}
	return `sprite${n}`;
}

/** "" → undefined; a positive integer otherwise (sub-1/NaN clears the field). */
function optInt(raw: string): number | undefined {
	if (raw.trim() === "") {
		return undefined;
	}
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
}

/**
 * Per-stream trick-play sprites (encodings.streams.sprites). Each row targets a
 * video rendition and produces a tiled scrub-preview image plus a WebVTT index.
 * Sprites are video-only (validate rejects non-video targets). The grid is set
 * by EITHER images-per-file OR rows×columns (hTiles/vTiles) — not both.
 */
export function SpritesSection({
	state,
	onPatch,
}: {
	state: WizardState;
	onPatch: (partial: Partial<WizardState>) => void;
}) {
	const { t } = useT();
	const sprites = state.sprites ?? [];
	const streamKeys = videoKeys(state.videos);

	const patchSprite = (index: number, partial: Partial<WizardSprite>) => {
		const next = [...sprites];
		const current = next[index];
		if (!current) {
			return;
		}
		next[index] = { ...current, ...partial };
		onPatch({ sprites: next });
	};

	const add = () =>
		onPatch({
			sprites: [
				...sprites,
				{
					key: nextSpriteKey(sprites),
					streamKey: streamKeys[0] ?? "",
					distance: 10,
					height: 90,
					hTiles: 10,
					vTiles: 10,
					filename: "sprite.jpg",
					vttName: "sprite.vtt",
					path: "sprite",
				},
			],
		});

	return (
		<section className="space-y-3">
			<div className="flex items-center justify-between">
				<h2 className="font-medium text-sm text-zinc-200">
					{t("wizard.spritesTrickPlay")}
				</h2>
				<Button
					variant="secondary"
					size="sm"
					disabled={streamKeys.length === 0}
					onClick={add}
				>
					{t("wizard.addSprite")}
				</Button>
			</div>
			{sprites.length === 0 ? (
				<p className="text-xs text-zinc-500">
					{t("wizard.noneAddOneToGenerateATiled")}
				</p>
			) : null}
			{sprites.map((sprite, index) => (
				<div
					key={`sprite-${index}`}
					className="space-y-3 rounded-md border border-zinc-800 p-3"
				>
					<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
						<Field label={t("wizard.stream")} htmlFor={`wz-sp-${index}-stream`}>
							<SelectNative
								id={`wz-sp-${index}-stream`}
								value={sprite.streamKey}
								onChange={(e) =>
									patchSprite(index, { streamKey: e.target.value })
								}
							>
								{!streamKeys.includes(sprite.streamKey) ? (
									<option value={sprite.streamKey}>
										{sprite.streamKey || "—"} {t("wizardX.missingParen")}
									</option>
								) : null}
								{streamKeys.map((k) => (
									<option key={k} value={k}>
										{k}
									</option>
								))}
							</SelectNative>
						</Field>
						<Field label={t("wizard.unit")} htmlFor={`wz-sp-${index}-unit`}>
							<SelectNative
								id={`wz-sp-${index}-unit`}
								value={sprite.unit ?? "SECONDS"}
								onChange={(e) =>
									patchSprite(index, {
										unit: e.target.value as WizardSprite["unit"],
									})
								}
							>
								<option value="SECONDS">SECONDS</option>
								<option value="PERCENTS">PERCENTS</option>
							</SelectNative>
						</Field>
						<Field
							label={t("wizard.intervalDistance")}
							htmlFor={`wz-sp-${index}-distance`}
							help={t("wizard.oneTileEveryNUnits")}
						>
							<Input
								id={`wz-sp-${index}-distance`}
								type="number"
								value={sprite.distance}
								onChange={(e) =>
									patchSprite(index, { distance: Number(e.target.value) })
								}
							/>
						</Field>
						<Field
							label={t("wizard.tileHeightPx")}
							htmlFor={`wz-sp-${index}-height`}
							help={t("wizard.widthOrHeightRequiredOtherIsDerived")}
						>
							<Input
								id={`wz-sp-${index}-height`}
								type="number"
								value={sprite.height ?? ""}
								placeholder="90"
								onChange={(e) =>
									patchSprite(index, { height: optInt(e.target.value) })
								}
							/>
						</Field>
						<Field
							label={t("wizard.gridRowsHtiles")}
							htmlFor={`wz-sp-${index}-htiles`}
							help={t("wizard.withColumnsOrUseImagesFile")}
						>
							<Input
								id={`wz-sp-${index}-htiles`}
								type="number"
								value={sprite.hTiles ?? ""}
								placeholder="10"
								onChange={(e) =>
									patchSprite(index, { hTiles: optInt(e.target.value) })
								}
							/>
						</Field>
						<Field
							label={t("wizard.gridColumnsVtiles")}
							htmlFor={`wz-sp-${index}-vtiles`}
							help={t("wizard.withRowsOrUseImagesFile")}
						>
							<Input
								id={`wz-sp-${index}-vtiles`}
								type="number"
								value={sprite.vTiles ?? ""}
								placeholder="10"
								onChange={(e) =>
									patchSprite(index, { vTiles: optInt(e.target.value) })
								}
							/>
						</Field>
						<Field
							label={t("wizard.imageFilename")}
							htmlFor={`wz-sp-${index}-filename`}
							help={t("wizard.jpgJpegPng")}
						>
							<Input
								id={`wz-sp-${index}-filename`}
								value={sprite.filename}
								placeholder={t("wizard.spriteJpg")}
								onChange={(e) =>
									patchSprite(index, { filename: e.target.value })
								}
							/>
						</Field>
						<Field
							label={t("wizard.webvttIndex")}
							htmlFor={`wz-sp-${index}-vtt`}
							help={t("wizard.optionalVtt")}
						>
							<Input
								id={`wz-sp-${index}-vtt`}
								value={sprite.vttName ?? ""}
								placeholder={t("wizard.spriteVtt")}
								onChange={(e) =>
									patchSprite(index, { vttName: e.target.value || undefined })
								}
							/>
						</Field>
						<Field
							label={t("wizard.outputPath")}
							htmlFor={`wz-sp-${index}-path`}
							help={t("wizard.relativeToTheBaseOutputPath")}
						>
							<Input
								id={`wz-sp-${index}-path`}
								value={sprite.path ?? ""}
								placeholder={t("wizard.sprite")}
								onChange={(e) =>
									patchSprite(index, { path: e.target.value || undefined })
								}
							/>
						</Field>
					</div>
					<details className="rounded-md border border-zinc-800/60 p-2">
						<summary className="cursor-pointer text-xs text-zinc-400">
							{t("wizard.advanced")}
						</summary>
						<div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
							<Field
								label={t("wizard.tileWidthPx")}
								htmlFor={`wz-sp-${index}-width`}
								help={t("wizard.widthOrHeightRequired")}
							>
								<Input
									id={`wz-sp-${index}-width`}
									type="number"
									value={sprite.width ?? ""}
									placeholder="160"
									onChange={(e) =>
										patchSprite(index, { width: optInt(e.target.value) })
									}
								/>
							</Field>
							<Field
								label={t("wizard.imagesPerFile")}
								htmlFor={`wz-sp-${index}-ipf`}
								help={t("wizard.useInsteadOfRowsColumnsNotBoth")}
							>
								<Input
									id={`wz-sp-${index}-ipf`}
									type="number"
									value={sprite.imagesPerFile ?? ""}
									placeholder=""
									onChange={(e) =>
										patchSprite(index, {
											imagesPerFile: optInt(e.target.value),
										})
									}
								/>
							</Field>
							<Field
								label={t("wizard.spriteName")}
								htmlFor={`wz-sp-${index}-name`}
							>
								<Input
									id={`wz-sp-${index}-name`}
									value={sprite.spriteName ?? ""}
									placeholder={t("wizard.spriteJpgResourceName")}
									onChange={(e) =>
										patchSprite(index, {
											spriteName: e.target.value || undefined,
										})
									}
								/>
							</Field>
							<Field
								label={t("wizard.creationMode")}
								htmlFor={`wz-sp-${index}-mode`}
								help={t("wizard.intervalStartRecommendedForTrickPlay")}
							>
								<SelectNative
									id={`wz-sp-${index}-mode`}
									value={sprite.creationMode ?? ""}
									onChange={(e) =>
										patchSprite(index, {
											creationMode:
												(e.target.value as WizardSprite["creationMode"]) ||
												undefined,
										})
									}
								>
									<option value="">{t("wizard.defaultApi")}</option>
									<option value="INTERVAL_START">INTERVAL_START</option>
									<option value="INTERVAL_END">INTERVAL_END</option>
								</SelectNative>
							</Field>
						</div>
					</details>
					<Button
						variant="secondary"
						size="sm"
						onClick={() =>
							onPatch({ sprites: sprites.filter((_, i) => i !== index) })
						}
					>
						{t("wizard.remove")}
					</Button>
				</div>
			))}
		</section>
	);
}
