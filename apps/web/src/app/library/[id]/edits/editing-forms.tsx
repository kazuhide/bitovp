"use client";

import { BROWSABLE_CREDENTIAL_PROVIDERS } from "@bitovp/core";
import { type ReactNode, useState } from "react";
import {
	StoragePicker,
	type StoragePickerSelection,
} from "@/components/storage-picker";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import type {
	AutomaticEditingContext,
	EditingMediaView,
} from "@/lib/library-editing";

export type EditingEligibility = {
	sourceId: string;
	files: { key: string; label: string }[];
	mediaVersions: EditingMediaView[];
	analyses: { id: string; locale: string; title: string }[];
	automatic?: AutomaticEditingContext;
	storyAvailable?: boolean;
	localStoryAvailable?: boolean;
	captionTranslationAvailable?: boolean;
};
export type NewEditingProject = {
	mediaVersionId: string;
	title: string;
	variant: "LANDSCAPE" | "PORTRAIT";
	analysisRevisionId: string | null;
};

export function MediaPreparation({
	eligibility,
	disabled,
	onPrepare,
	actionLabel,
	children,
	fileInputId = "editing-file",
}: {
	eligibility: EditingEligibility;
	disabled: boolean;
	actionLabel?: string;
	children?: ReactNode;
	fileInputId?: string;
	onPrepare: (
		fileKey: string,
		output: { credentialId: string; bucket: string; prefix: string },
	) => void;
}) {
	const { t } = useT();
	const [selected, setSelected] = useState("");
	const [picker, setPicker] = useState(false);
	const [output, setOutput] = useState<StoragePickerSelection | null>(null);
	const fileKey = selected || eligibility.files[0]?.key || "";
	return (
		<section className="space-y-4 rounded-lg border border-zinc-800 p-4">
			<h2 className="font-semibold">{t("editing.prepare")}</h2>
			<p className="text-sm text-zinc-400">{t("editing.prepareHelp")}</p>
			{eligibility.files.length ? (
				<Field label={t("editing.file")} htmlFor={fileInputId}>
					<SelectNative
						id={fileInputId}
						value={fileKey}
						disabled={disabled}
						onChange={(e) => setSelected(e.target.value)}
					>
						{eligibility.files.map((file) => (
							<option key={file.key} value={file.key}>
								{file.label}
							</option>
						))}
					</SelectNative>
				</Field>
			) : (
				<p className="text-sm text-amber-300">{t("editing.noFiles")}</p>
			)}
			<div className="space-y-2">
				<p className="font-medium text-xs text-zinc-300">
					{t("editing.output")}
				</p>
				{output && (
					<p className="break-all text-sm">
						{output.bucket}/{output.path}
					</p>
				)}
				<Button
					variant="secondary"
					disabled={disabled || !fileKey}
					onClick={() => setPicker(true)}
				>
					{t("editing.chooseOutput")}
				</Button>
			</div>
			{children}
			<Button
				disabled={disabled || !fileKey || !output}
				onClick={() => {
					if (output)
						onPrepare(fileKey, {
							credentialId: output.credentialId,
							bucket: output.bucket,
							prefix: output.path,
						});
				}}
			>
				{actionLabel ?? t("editing.prepare")}
			</Button>
			<StoragePicker
				open={picker}
				mode="prefix"
				providers={[...BROWSABLE_CREDENTIAL_PROVIDERS]}
				initialCredentialId={output?.credentialId}
				initialBucket={output?.bucket}
				onClose={() => setPicker(false)}
				onSelect={(selection) => {
					setOutput(selection);
					setPicker(false);
				}}
			/>
		</section>
	);
}

export function ProjectCreation({
	eligibility,
	initialTitle,
	disabled,
	onCreate,
}: {
	eligibility: EditingEligibility;
	initialTitle: string;
	disabled: boolean;
	onCreate: (input: NewEditingProject) => void;
}) {
	const { t } = useT();
	const [mediaId, setMediaId] = useState("");
	const [title, setTitle] = useState(initialTitle);
	const [variant, setVariant] = useState<"LANDSCAPE" | "PORTRAIT">("LANDSCAPE");
	const [analysisId, setAnalysisId] = useState("");
	const ready = eligibility.mediaVersions.filter(
		(media) => media.state === "READY",
	);
	const selectedMedia = ready.find((media) => media.id === mediaId) ?? ready[0];
	return (
		<section className="space-y-4 rounded-lg border border-zinc-800 p-4">
			<h2 className="font-semibold">{t("editing.create")}</h2>
			{ready.length === 0 && (
				<p className="text-sm text-zinc-400">{t("editing.noMedia")}</p>
			)}
			<Field label={t("editing.mediaVersions")} htmlFor="editing-media">
				<SelectNative
					id="editing-media"
					value={selectedMedia?.id ?? ""}
					disabled={disabled || !ready.length}
					onChange={(e) => setMediaId(e.target.value)}
				>
					{!ready.length && <option value="">{t("editing.noMedia")}</option>}
					{ready.map((media, index) => (
						<option key={media.id} value={media.id}>
							{index + 1}: {((media.durationUs ?? 0) / 1_000_000).toFixed(1)}s ·{" "}
							{media.width}×{media.height}
						</option>
					))}
				</SelectNative>
			</Field>
			<Field label={t("editing.projectTitle")} htmlFor="editing-project-title">
				<Input
					id="editing-project-title"
					value={title}
					maxLength={500}
					disabled={disabled}
					onChange={(e) => setTitle(e.target.value)}
				/>
			</Field>
			<Field label={t("editing.variant")} htmlFor="editing-variant">
				<SelectNative
					id="editing-variant"
					value={variant}
					disabled={disabled}
					onChange={(e) =>
						setVariant(e.target.value === "PORTRAIT" ? "PORTRAIT" : "LANDSCAPE")
					}
				>
					<option value="LANDSCAPE">{t("editing.landscape")}</option>
					<option value="PORTRAIT">{t("editing.portrait")}</option>
				</SelectNative>
			</Field>
			<Field label={t("editing.analysis")} htmlFor="editing-analysis">
				<SelectNative
					id="editing-analysis"
					value={analysisId}
					disabled={disabled}
					onChange={(e) => setAnalysisId(e.target.value)}
				>
					<option value="">{t("editing.noAnalysis")}</option>
					{eligibility.analyses.map((analysis) => (
						<option key={analysis.id} value={analysis.id}>
							{analysis.locale}: {analysis.title}
						</option>
					))}
				</SelectNative>
			</Field>
			<Button
				disabled={disabled || !selectedMedia || !title.trim()}
				onClick={() => {
					if (selectedMedia)
						onCreate({
							mediaVersionId: selectedMedia.id,
							title: title.trim(),
							variant,
							analysisRevisionId: analysisId || null,
						});
				}}
			>
				{t("editing.create")}
			</Button>
		</section>
	);
}
