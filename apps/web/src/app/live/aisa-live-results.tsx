"use client";

import { useEffect, useState } from "react";
import type { AisaResultsResponse } from "@/lib/aisa-live/contracts";
import {
	type AisaSnapshotState,
	applyAisaSnapshot,
} from "@/lib/aisa-live/snapshots";
import { useT } from "@/lib/i18n/context";
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
}: {
	accountId: string;
	analysisId: string;
	encodingId: string;
	status?: string;
	result?: AisaResultsResponse;
	failed: boolean;
	onFinal?: (isFinal: boolean) => void;
}) {
	return (
		<Results
			key={`${accountId}:${analysisId}:${encodingId}`}
			analysisId={analysisId}
			encodingId={encodingId}
			status={status}
			result={result}
			failed={failed}
			onFinal={onFinal}
		/>
	);
}

function Results({
	analysisId,
	encodingId,
	status,
	result,
	failed,
	onFinal,
}: Omit<Parameters<typeof AisaLiveResults>[0], "accountId">) {
	const { t } = useT();
	const [{ accepted, rejected }, setView] = useState<{
		accepted: AisaSnapshotState | null;
		rejected: boolean;
	}>({ accepted: null, rejected: false });
	useEffect(() => {
		if (result?.availability !== "available") return;
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
	}, [result, analysisId, encodingId]);
	const snapshot = accepted?.snapshot;
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
			{rejected ? (
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
									className="space-y-3 rounded-md border border-zinc-800 bg-zinc-900/30 p-4"
								>
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
									{moment.observations.map((id) => (
										<p key={id} className="break-words text-sm text-zinc-300">
											{observations.get(id)?.text}
										</p>
									))}
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
