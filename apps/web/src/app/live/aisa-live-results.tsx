"use client";

import { useEffect, useState } from "react";
import type {
	AisaResultSnapshot,
	AisaResultsResponse,
} from "@/lib/aisa-live/contracts";
import {
	type AisaSnapshotState,
	applyAisaSnapshot,
} from "@/lib/aisa-live/snapshots";
import {
	type AisaTranslationsResponse,
	translationForObservation,
} from "@/lib/aisa-live/translations";
import { useT } from "@/lib/i18n/context";
import { AisaMomentPreview } from "./aisa-live-player";
import { AISA_TERMINAL } from "./aisa-live-shared";

const seconds = (value: number) => Number(value.toFixed(2));

export function AisaLiveResults({
	accountId,
	analysisId,
	encodingId,
	status,
	result,
	failed,
	onFinal,
	translations,
	acceptedSnapshot,
	rejectedUpdate = false,
	language = "original",
}: {
	accountId: string;
	analysisId: string;
	encodingId: string;
	status?: string;
	result?: AisaResultsResponse;
	failed: boolean;
	onFinal?: (isFinal: boolean) => void;
	translations?: AisaTranslationsResponse;
	/** Explicit null selects controlled mode before the first accepted result. */
	acceptedSnapshot?: AisaResultSnapshot | null;
	rejectedUpdate?: boolean;
	language?: "ja" | "original";
}) {
	return (
		<Results
			key={`${accountId}:${analysisId}:${encodingId}`}
			accountId={accountId}
			analysisId={analysisId}
			encodingId={encodingId}
			status={status}
			result={result}
			failed={failed}
			onFinal={onFinal}
			translations={translations}
			acceptedSnapshot={acceptedSnapshot}
			rejectedUpdate={rejectedUpdate}
			language={language}
		/>
	);
}

function Results({
	accountId,
	analysisId,
	encodingId,
	status,
	result,
	failed,
	onFinal,
	translations,
	acceptedSnapshot,
	rejectedUpdate,
	language,
}: Parameters<typeof AisaLiveResults>[0]) {
	const { t } = useT();
	const [{ accepted, rejected }, setView] = useState<{
		accepted: AisaSnapshotState | null;
		rejected: boolean;
	}>({ accepted: null, rejected: false });
	const controlled = acceptedSnapshot !== undefined;
	useEffect(() => {
		if (controlled || result?.availability !== "available") return;
		setView((previous) => {
			try {
				if (
					result.snapshot.analysisId !== analysisId ||
					result.snapshot.encodingId !== encodingId
				)
					throw new Error("Unexpected analysis identity");
				return {
					accepted: applyAisaSnapshot(previous.accepted, result.snapshot),
					rejected: false,
				};
			} catch {
				return { ...previous, rejected: true };
			}
		});
	}, [result, analysisId, encodingId, controlled]);
	const snapshot = controlled ? acceptedSnapshot : accepted?.snapshot;
	const invalidUpdate = controlled ? rejectedUpdate : rejected;
	useEffect(() => {
		onFinal?.(Boolean(snapshot?.isFinal));
	}, [snapshot?.isFinal, onFinal]);
	const moments = [...(snapshot?.keyMoments ?? [])].sort(
		(left, right) =>
			left.startInSeconds - right.startInSeconds ||
			left.id.localeCompare(right.id),
	);
	const observations = new Map(
		snapshot?.observations.map((observation) => [observation.id, observation]),
	);
	return (
		<section className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h2 className="font-semibold text-lg text-zinc-100">
					{t("aisaLive.keyMoments")}
				</h2>
				{snapshot ? (
					<p className="text-sm text-zinc-400">
						{t(snapshot.isFinal ? "aisaLive.final" : "aisaLive.evolving")}
					</p>
				) : null}
			</div>
			{failed ? (
				<p role="alert" className="text-sm text-red-300">
					{t("aisaLive.pollFailed")}
				</p>
			) : null}
			{invalidUpdate ? (
				<p role="alert" className="text-sm text-amber-300">
					{t(snapshot ? "aisaLive.retained" : "aisaLive.invalidResult")}
				</p>
			) : null}
			{status === "FINISHED" && !snapshot?.isFinal ? (
				<p role="status" className="text-sm text-amber-300">
					{t("aisaLive.awaitingFinal")}
				</p>
			) : null}
			{!snapshot ? (
				<p role="status" className="text-sm text-zinc-400">
					{t(
						status && AISA_TERMINAL.has(status) && status !== "FINISHED"
							? "aisaLive.terminalNoResults"
							: "aisaLive.pending",
					)}
				</p>
			) : (
				<>
					<div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-500">
						<span>
							{t("aisaLive.sequence", { sequence: snapshot.sequence })}
						</span>
						<span>
							{t("aisaLive.coverage", {
								start: seconds(snapshot.analyzedStartTimeSeconds),
								end: seconds(snapshot.analyzedEndTimeSeconds),
							})}
						</span>
					</div>
					{moments.length === 0 ? (
						<p
							role="status"
							className="rounded-md border border-zinc-800 p-4 text-sm text-zinc-400"
						>
							{t("aisaLive.empty")}
						</p>
					) : (
						<ol className="space-y-3">
							{moments.map((moment) => (
								<li
									key={moment.id}
									className="grid gap-4 rounded-md border border-zinc-800 bg-zinc-900/30 p-4 md:grid-cols-[minmax(14rem,20rem)_minmax(0,1fr)]"
								>
									<AisaMomentPreview
										accountId={accountId}
										analysisId={analysisId}
										encodingId={encodingId}
										mediaTimeOriginUnixMs={snapshot.mediaTimeOriginUnixMs}
										moment={moment}
										labels={{
											play: t("aisaLive.previewPlay"),
											pause: t("aisaLive.previewPause"),
											replay: t("aisaLive.previewReplay"),
											loading: t("aisaLive.previewLoading"),
											unavailable: t("aisaLive.previewUnavailableMedia"),
											failed: t("aisaLive.previewFailed"),
											seek: t("aisaLive.previewSeek"),
											mute: t("aisaLive.previewMute"),
											unmute: t("aisaLive.previewUnmute"),
											thumbnailAlt: t("aisaLive.previewThumbnail"),
										}}
									/>
									<div className="min-w-0 space-y-3">
										<div className="flex flex-wrap justify-between gap-2 text-sm">
											<p className="text-zinc-200">
												{t("aisaLive.range", {
													start: seconds(moment.startInSeconds),
													end: seconds(moment.endInSeconds),
													anchor: seconds(moment.anchorInSeconds),
												})}
											</p>
											<span className="text-emerald-400">
												{t("aisaLive.importance", {
													level: moment.importanceLevel,
												})}
											</span>
										</div>
										{moment.categories?.length ? (
											<div className="flex flex-wrap gap-2">
												{moment.categories.map((category) => (
													<span
														key={category}
														className="break-all rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400"
													>
														{category}
													</span>
												))}
											</div>
										) : null}
										{moment.observations.map((id) => {
											const observation = observations.get(id);
											if (!observation) return null;
											const translated =
												language === "ja"
													? translationForObservation(translations, {
															analysisId,
															encodingId,
															...observation,
														})
													: undefined;
											return (
												<div key={id}>
													<p
														className="break-words text-sm text-zinc-300"
														lang={translated ? "ja" : "en"}
													>
														{translated?.text ?? observation.text}
													</p>
													{language === "ja" && !translated ? (
														<p className="mt-1 text-xs text-zinc-500">
															{t("aisaLive.translationPending")}
														</p>
													) : null}
												</div>
											);
										})}
									</div>
								</li>
							))}
						</ol>
					)}
					<p className="text-xs text-zinc-500">
						{snapshot.metadata.disclaimer}
					</p>
				</>
			)}
		</section>
	);
}
