"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { CopyableId } from "@/components/copyable-id";
import { Button } from "@/components/ui/button";
import {
	type AisaAnalysis,
	type AisaResultsResponse,
	aisaResultSchema,
} from "@/lib/aisa-live/contracts";
import {
	type AisaSnapshotState,
	applyAisaSnapshot,
} from "@/lib/aisa-live/snapshots";
import {
	AISA_TRANSLATION_MAX_ITEMS,
	type AisaTranslationsResponse,
	aisaTranslationsResponseSchema,
	translationForObservation,
} from "@/lib/aisa-live/translations";
import { apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import { AisaLiveResults } from "./aisa-live-results";
import { AISA_TERMINAL } from "./aisa-live-shared";

type Props = {
	accountId: string;
	analysisId: string;
	encodingId: string;
	status?: string;
	initialSnapshot?: unknown;
};

/** Run identity is the component boundary; a re-air cannot retain earlier results. */
export function AisaChannelAnalysisPanel(props: Props) {
	return (
		<RunAnalysis
			key={`${props.accountId}:${props.analysisId}:${props.encodingId}`}
			{...props}
		/>
	);
}

function RunAnalysis({
	accountId,
	analysisId,
	encodingId,
	status,
	initialSnapshot,
}: Props) {
	const { t, locale } = useT();
	const mayTranslate = useMutationAccess("live.aisa.translate");
	const cache = useQueryClient();
	const [language, setLanguage] = useState<"ja" | "original">(
		locale === "ja" ? "ja" : "original",
	);
	const [accepted, setAccepted] = useState<AisaSnapshotState | null>(() => {
		const parsed = aisaResultSchema.safeParse(initialSnapshot);
		return parsed.success &&
			parsed.data.analysisId === analysisId &&
			parsed.data.encodingId === encodingId
			? applyAisaSnapshot(null, parsed.data)
			: null;
	});
	const attempted = useRef(new Set<string>());
	const base = `/api/live/analyses/${encodeURIComponent(analysisId)}`;
	const query = `bitmovinAccountId=${encodeURIComponent(accountId)}`;
	const resource = useQuery({
		queryKey: ["aisa-live-analysis", accountId, analysisId, encodingId],
		queryFn: async () => {
			const data = await apiFetch<AisaAnalysis>(`${base}?${query}`);
			if (data.analysisId !== analysisId || data.encodingId !== encodingId)
				throw new Error("Unexpected analysis identity");
			return data;
		},
		retry: false,
		refetchInterval: (state) =>
			state.state.data && AISA_TERMINAL.has(state.state.data.status)
				? false
				: 5000,
	});
	const results = useQuery({
		queryKey: ["aisa-live-results", accountId, analysisId, encodingId],
		queryFn: () => apiFetch<AisaResultsResponse>(`${base}/results?${query}`),
		retry: false,
		refetchInterval: accepted?.snapshot.isFinal ? false : 5000,
	});
	useEffect(() => {
		if (results.data?.availability !== "available") return;
		const parsed = aisaResultSchema.safeParse(results.data.snapshot);
		if (
			!parsed.success ||
			parsed.data.analysisId !== analysisId ||
			parsed.data.encodingId !== encodingId
		)
			return;
		setAccepted((previous) => {
			try {
				return applyAisaSnapshot(previous, parsed.data);
			} catch {
				return previous;
			}
		});
	}, [results.data, analysisId, encodingId]);
	const snapshot = accepted?.snapshot;
	const translationKey = [
		"aisa-live-translations",
		accountId,
		analysisId,
		encodingId,
		snapshot?.sequence,
	];
	const checkedTranslation = (data: unknown) => {
		const parsed = aisaTranslationsResponseSchema.parse(data);
		if (parsed.analysisId !== analysisId || parsed.encodingId !== encodingId)
			throw new Error("Unexpected translation identity");
		return parsed;
	};
	const translations = useQuery({
		queryKey: translationKey,
		queryFn: async () =>
			checkedTranslation(await apiFetch(`${base}/translations?${query}`)),
		enabled: Boolean(snapshot?.observations.length),
		retry: false,
	});
	const translate = useMutation({
		mutationFn: async (observationIds: string[]) =>
			checkedTranslation(
				await apiFetch(`${base}/translations`, {
					method: "POST",
					body: JSON.stringify({
						bitmovinAccountId: accountId,
						encodingId,
						action: "translate",
						observationIds,
					}),
				}),
			),
		retry: false,
		onSuccess: (data: AisaTranslationsResponse) =>
			cache.setQueryData(translationKey, data),
	});
	const momentObservations = new Set(
		snapshot?.keyMoments.flatMap((moment) => moment.observations),
	);
	const missing =
		snapshot?.observations.filter(
			(item) =>
				momentObservations.has(item.id) &&
				!translationForObservation(translations.data, {
					analysisId,
					encodingId,
					...item,
				}),
		) ?? [];
	const missingIds = missing
		.slice(0, AISA_TRANSLATION_MAX_ITEMS)
		.map((item) => item.id);
	const signature = JSON.stringify(missing.map((item) => [item.id, item.text]));
	useEffect(() => {
		if (
			language !== "ja" ||
			!mayTranslate ||
			!translations.data?.automatic.available ||
			!missingIds.length ||
			translate.isPending ||
			attempted.current.has(signature)
		)
			return;
		attempted.current.add(signature);
		translate.mutate(missingIds);
	}, [
		language,
		mayTranslate,
		translations.data?.automatic.available,
		missingIds,
		signature,
		translate.isPending,
		translate.mutate,
	]);
	return (
		<section
			id="sec-analysis"
			className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 sm:p-6"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="min-w-0">
					<p className="text-sm text-zinc-400">{t("aisaLive.title")}</p>
					<CopyableId value={analysisId} label={t("aisaLive.analysisId")} />
				</div>
				<fieldset
					className="flex flex-wrap gap-2"
					aria-label={t("aisaLive.resultLanguage")}
				>
					<Button
						variant={language === "ja" ? "default" : "secondary"}
						size="sm"
						aria-pressed={language === "ja"}
						onClick={() => setLanguage("ja")}
					>
						{t("aisaLive.japanese")}
					</Button>
					<Button
						variant={language === "original" ? "default" : "secondary"}
						size="sm"
						aria-pressed={language === "original"}
						onClick={() => setLanguage("original")}
					>
						{t("aisaLive.original")}
					</Button>
				</fieldset>
			</div>
			{language === "ja" && snapshot?.keyMoments.length ? (
				<div className="space-y-2 text-xs text-zinc-500">
					<p>{t("aisaLive.translationDerived")}</p>
					{translations.data?.translations.some(
						(entry) => entry.origin === "LOCAL_MODEL",
					) ? (
						<p>
							{t("aisaLive.translationModel", {
								model:
									translations.data.translations.find(
										(entry) => entry.origin === "LOCAL_MODEL",
									)?.model ?? "",
							})}
						</p>
					) : null}
					{translate.isPending ? (
						<p role="status">{t("aisaLive.translating")}</p>
					) : null}
					{translate.isError || translations.isError ? (
						<p role="alert">{t("aisaLive.translationFailed")}</p>
					) : null}
					{missingIds.length &&
					mayTranslate &&
					translations.data?.automatic.available &&
					!translate.isPending ? (
						<Button
							variant="secondary"
							size="sm"
							onClick={() => {
								attempted.current.add(signature);
								translate.mutate(missingIds);
							}}
						>
							{t("aisaLive.translate")}
						</Button>
					) : null}
					{missingIds.length &&
					translations.data &&
					!translations.data.automatic.available ? (
						<p>{t("aisaLive.translationUnavailable")}</p>
					) : null}
				</div>
			) : null}
			<AisaLiveResults
				accountId={accountId}
				analysisId={analysisId}
				encodingId={encodingId}
				status={resource.data?.status ?? status}
				result={
					results.data ??
					(snapshot ? { availability: "available", snapshot } : undefined)
				}
				failed={resource.isError || results.isError}
				translations={translations.data}
				language={language}
			/>
		</section>
	);
}
