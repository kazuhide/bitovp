"use client";

import type {
	AnalysisJsonValue,
	ProviderAnalysisView,
	SceneAnalysisDocument,
} from "@bitovp/core";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";

const LABELS: Record<string, MessageKey> = {
	metadata: "library.analysisFields.metadata",
	version: "library.analysisFields.version",
	disclaimer: "library.analysisFields.disclaimer",
	inputLanguageCodes: "library.analysisFields.inputLanguageCodes",
	ratings: "library.analysisFields.ratings",
	rating: "library.analysisFields.rating",
	region: "library.analysisFields.region",
	system: "library.analysisFields.system",
	credits: "library.analysisFields.credits",
	persons: "library.analysisFields.persons",
	songs: "library.analysisFields.songs",
	copyright: "library.analysisFields.copyright",
	name: "library.analysisFields.name",
	role: "library.analysisFields.role",
	department: "library.analysisFields.department",
	artist: "library.analysisFields.artist",
	scenes: "library.analysisFields.scenes",
	content: "library.analysisFields.content",
	characters: "library.analysisFields.characters",
	characterAppearance: "library.analysisFields.characterAppearance",
	approximateAge: "library.analysisFields.approximateAge",
	playedBy: "library.analysisFields.playedBy",
	shots: "library.analysisFields.shots",
	mainSubjects: "library.analysisFields.mainSubjects",
	box2d: "library.analysisFields.box2d",
	centerX: "library.analysisFields.centerX",
	centerY: "library.analysisFields.centerY",
	appearanceTimeInSeconds: "library.analysisFields.appearanceTimeInSeconds",
	startInSeconds: "library.analysisFields.startInSeconds",
	endInSeconds: "library.analysisFields.endInSeconds",
	duration: "library.analysisFields.duration",
	title: "library.analysisFields.title",
	description: "library.analysisFields.description",
	summary: "library.analysisFields.summary",
	verboseSummary: "library.analysisFields.verboseSummary",
	detailedDescription: "library.analysisFields.detailedDescription",
	keywords: "library.analysisFields.keywords",
	sensitiveTopics: "library.analysisFields.sensitiveTopics",
	iabSensitiveTopicTaxonomies:
		"library.analysisFields.iabSensitiveTopicTaxonomies",
	iab: "library.analysisFields.iab",
	adOpportunityInformation: "library.analysisFields.adOpportunityInformation",
	score: "library.analysisFields.score",
	reason: "library.analysisFields.reason",
	shotAdvisories: "library.analysisFields.shotAdvisories",
};

function AnalysisNode({
	name,
	value,
}: {
	name: string;
	value: AnalysisJsonValue;
}) {
	const { t } = useT();
	const [open, setOpen] = useState(false);
	const [shown, setShown] = useState(50);
	const label = Object.hasOwn(LABELS, name) ? LABELS[name] : undefined;
	const heading = (
		<>
			<code className="break-all text-xs">{name}</code>
			{label && <span className="ml-2 text-zinc-400">{t(label)}</span>}
		</>
	);
	if (value === null || typeof value !== "object") {
		return (
			<dl className="min-w-0 border-zinc-800 border-l pl-3">
				<dt>{heading}</dt>
				<dd className="mt-1 whitespace-pre-wrap break-words">
					{value === "" ? t("library.analysisEmptyString") : String(value)}
				</dd>
			</dl>
		);
	}
	const count = Object.keys(value).length;
	if (count === 0)
		return (
			<dl className="border-zinc-800 border-l pl-3">
				<dt>{heading}</dt>
				<dd>
					{t(
						Array.isArray(value)
							? "library.analysisEmptyArray"
							: "library.analysisEmptyObject",
					)}
				</dd>
			</dl>
		);
	return (
		<details
			onToggle={(event) => {
				if (event.target === event.currentTarget)
					setOpen(event.currentTarget.open);
			}}
			className="min-w-0 border-zinc-800 border-l pl-3"
		>
			<summary className="cursor-pointer">
				{heading} <span className="text-xs text-zinc-400">({count})</span>
			</summary>
			{open && (
				<>
					<div className="mt-2 space-y-3">
						{Object.entries(value)
							.slice(0, shown)
							.map(([key, child]) => (
								<AnalysisNode
									key={key}
									name={Array.isArray(value) ? `[${key}]` : key}
									value={child}
								/>
							))}
					</div>
					{shown < count && (
						<Button
							className="mt-2"
							onClick={() => setShown((previous) => previous + 50)}
						>
							{t("library.analysisMore", {
								shown: Math.min(shown, count),
								total: count,
							})}
						</Button>
					)}
				</>
			)}
		</details>
	);
}

export function AnalysisData({
	providerAnalysis,
	document,
}: {
	providerAnalysis?: ProviderAnalysisView;
	document: SceneAnalysisDocument;
}) {
	const { t } = useT();
	const [open, setOpen] = useState(false);
	const data = providerAnalysis ?? {
		source: "NORMALIZED",
		data: document as unknown as AnalysisJsonValue,
	};
	return (
		<details
			className="space-y-2 text-sm"
			onToggle={(event) => {
				if (event.target === event.currentTarget)
					setOpen(event.currentTarget.open);
			}}
		>
			<summary className="cursor-pointer font-medium">
				{t("library.analysisAll")}
			</summary>
			{open && (
				<>
					<p className="text-xs text-zinc-400">
						{t(
							data.source === "PROVIDER"
								? "library.analysisProvider"
								: "library.analysisNormalized",
						)}
					</p>
					<div className="max-h-[40rem] space-y-3 overflow-auto">
						<AnalysisNode key={data.source} name="$" value={data.data} />
					</div>
				</>
			)}
		</details>
	);
}

export function AnalysisHighlights({
	providerAnalysis,
}: {
	providerAnalysis?: ProviderAnalysisView;
}) {
	const data = providerAnalysis?.data;
	if (!data || typeof data !== "object" || Array.isArray(data)) return null;
	const metadata = data.metadata;
	const disclaimer =
		metadata && typeof metadata === "object" && !Array.isArray(metadata)
			? metadata.disclaimer
			: undefined;
	const fields = [
		["inputLanguageCodes", data.inputLanguageCodes],
		["ratings", data.ratings],
		["disclaimer", disclaimer],
	] as const;
	return (
		<div className="space-y-3 text-sm">
			{fields
				.filter(
					(entry): entry is readonly [(typeof entry)[0], AnalysisJsonValue] =>
						entry[1] !== undefined,
				)
				.map(([name, value]) => (
					<AnalysisNode key={name} name={name} value={value} />
				))}
		</div>
	);
}
