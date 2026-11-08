"use client";

import { type ReactNode, useEffect, useState } from "react";
import type {
	AisaResultSnapshot,
	AisaResultsResponse,
} from "@/lib/aisa-live/contracts";
import {
	type AisaSnapshotState,
	applyAisaSnapshot,
} from "@/lib/aisa-live/snapshots";
import type { AisaTranslationsResponse } from "@/lib/aisa-live/translations";
import { useT } from "@/lib/i18n/context";
import { AISA_TERMINAL } from "./aisa-live-shared";
import { AisaMomentTimeline } from "./aisa-live-timeline";

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
	embedded = false,
	technicalDetails,
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
	embedded?: boolean;
	/** Metadata supplied by the channel panel shares the result diagnostics fold. */
	technicalDetails?: ReactNode;
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
			embedded={embedded}
			technicalDetails={technicalDetails}
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
	embedded,
	technicalDetails,
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
	const diagnostics = snapshot ? (
		<div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-500">
			<span>{t("aisaLive.sequence", { sequence: snapshot.sequence })}</span>
			<span>
				{t("aisaLive.coverage", {
					start: seconds(snapshot.analyzedStartTimeSeconds),
					end: seconds(snapshot.analyzedEndTimeSeconds),
				})}
			</span>
		</div>
	) : null;
	return (
		<section className="space-y-4">
			{!embedded || snapshot ? (
				<div className="flex flex-wrap items-center justify-between gap-3">
					{!embedded ? (
						<h2 className="font-semibold text-lg text-zinc-100">
							{t("aisaLive.keyMoments")}
						</h2>
					) : null}
					{snapshot ? (
						<p className="text-sm text-zinc-400">
							{t(snapshot.isFinal ? "aisaLive.final" : "aisaLive.evolving")}
						</p>
					) : null}
				</div>
			) : null}
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
			{technicalDetails || (embedded && snapshot) ? (
				<details className="rounded-md border border-zinc-800 px-3 py-2 text-xs text-zinc-500">
					<summary className="cursor-pointer rounded text-zinc-400 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
						{t("aisaLive.analysisDetails")}
					</summary>
					<div className="mt-3 space-y-2">
						{technicalDetails}
						{diagnostics}
					</div>
				</details>
			) : (
				diagnostics
			)}
			{!snapshot ? (
				<p role="status" className="text-sm text-zinc-400">
					{t(
						status && AISA_TERMINAL.has(status) && status !== "FINISHED"
							? "aisaLive.terminalNoResults"
							: "aisaLive.pending",
					)}
				</p>
			) : moments.length === 0 ? (
				<p
					role="status"
					className="rounded-md border border-zinc-800 p-4 text-sm text-zinc-400"
				>
					{t("aisaLive.empty")}
				</p>
			) : (
				<AisaMomentTimeline
					accountId={accountId}
					analysisId={analysisId}
					encodingId={encodingId}
					snapshot={snapshot}
					translations={translations}
					language={language}
				/>
			)}
		</section>
	);
}
