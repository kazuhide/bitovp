"use client";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import {
	collapseGroup,
	ingestInputPath,
	type LiveInputSelection,
	type LiveMuxingOptions,
	type LiveWizardState,
} from "./build-live-plan";
import { liveStorageOptionsAvailable } from "./live-rendition-options";

/** Source selection stays with the rendition's codec settings. */
export function LiveInputFields({
	idBase,
	state,
	input,
	audio = false,
	onInputChange,
}: {
	idBase: string;
	state: LiveWizardState;
	input?: LiveInputSelection;
	audio?: boolean;
	onInputChange: (input: LiveInputSelection | undefined) => void;
}) {
	const { t } = useT();
	const patchInput = (patch: Partial<LiveInputSelection>) => {
		// Editing a shared imported selection detaches only this rendition.
		const { key: _key, ...values } = input ?? {};
		onInputChange(collapseGroup({ ...values, ...patch }));
	};
	return (
		<div className="space-y-3">
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<Field
					label={t("liveRendition.inputPosition")}
					htmlFor={`${idBase}-input-position`}
					help={t("liveRendition.inputPositionHint")}
				>
					<Input
						id={`${idBase}-input-position`}
						type="number"
						min={0}
						step={1}
						placeholder={audio ? "1" : "0"}
						value={input?.position ?? ""}
						onChange={(event) =>
							patchInput({
								position:
									event.target.value === ""
										? undefined
										: Number(event.target.value),
							})
						}
					/>
				</Field>
				<Field
					label={t("liveRendition.inputPath")}
					htmlFor={`${idBase}-input-path`}
					help={t("liveRendition.inputPathHint")}
				>
					<Input
						id={`${idBase}-input-path`}
						placeholder={ingestInputPath(state.inputKind)}
						value={input?.inputPath ?? ""}
						onChange={(event) =>
							patchInput({ inputPath: event.target.value || undefined })
						}
					/>
				</Field>
			</div>
		</div>
	);
}

/** Output paths and file naming are edited in the Packaging step. */
export function LiveMuxingFields({
	idBase,
	state,
	muxing,
	container,
	ownsContainer = true,
	onMuxingChange,
}: {
	idBase: string;
	state: LiveWizardState;
	muxing?: LiveMuxingOptions;
	container: "FMP4" | "CMAF" | "TS";
	ownsContainer?: boolean;
	onMuxingChange: (muxing: LiveMuxingOptions | undefined) => void;
}) {
	const { t } = useT();
	const storage = liveStorageOptionsAvailable(state);
	const patchMuxing = (patch: Partial<LiveMuxingOptions>) =>
		onMuxingChange(collapseGroup({ ...muxing, ...patch }));
	return (
		<div className="space-y-3">
			{storage && ownsContainer ? (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
					<Field
						label={t("liveRendition.outputPath")}
						htmlFor={`${idBase}-media-path`}
						help={t("liveRendition.outputPathHint")}
					>
						<Input
							id={`${idBase}-media-path`}
							value={muxing?.path ?? ""}
							placeholder={t("wizard.default")}
							onChange={(event) =>
								patchMuxing({ path: event.target.value || undefined })
							}
						/>
					</Field>
					{(["segmentNaming", "segmentNamingTemplate"] as const).map((key) => (
						<Field
							key={key}
							label={t(
								key === "segmentNaming"
									? "liveRendition.segmentNaming"
									: "liveRendition.segmentTemplate",
							)}
							htmlFor={`${idBase}-media-${key}`}
							help={t(
								key === "segmentNaming"
									? "liveRendition.segmentNamingHint"
									: "liveRendition.segmentTemplateHint",
							)}
						>
							<Input
								id={`${idBase}-media-${key}`}
								value={muxing?.[key] ?? ""}
								disabled={
									key === "segmentNaming"
										? muxing?.segmentNamingTemplate !== undefined
										: muxing?.segmentNaming !== undefined
								}
								placeholder={`seg_${key === "segmentNamingTemplate" ? "{rand_chars:8}_" : ""}%number%.${container === "TS" ? "ts" : "m4s"}`}
								onChange={(event) =>
									patchMuxing({ [key]: event.target.value || undefined })
								}
							/>
						</Field>
					))}
					{container === "FMP4" ? (
						<Field
							label={t("liveRendition.initName")}
							htmlFor={`${idBase}-media-initSegmentName`}
						>
							<Input
								id={`${idBase}-media-initSegmentName`}
								placeholder="init.mp4"
								value={muxing?.initSegmentName ?? ""}
								onChange={(event) =>
									patchMuxing({
										initSegmentName: event.target.value || undefined,
									})
								}
							/>
						</Field>
					) : null}
				</div>
			) : (
				<p className="text-xs text-zinc-500">
					{t(
						storage
							? "liveRendition.ownContainerRequired"
							: "liveRendition.storageRequired",
					)}
				</p>
			)}
			{muxing &&
			(!storage ||
				!ownsContainer ||
				(container !== "FMP4" && muxing.initSegmentName !== undefined)) ? (
				<Button
					variant="secondary"
					size="sm"
					onClick={() => onMuxingChange(undefined)}
				>
					{t("liveRendition.clearMediaSettings")}
				</Button>
			) : null}
		</div>
	);
}
