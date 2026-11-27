"use client";

import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";

type FieldSet = Record<string, string | number | boolean>;
type Result = { fields: FieldSet } | { items: FieldSet[]; total: number };
type Subject = {
	id: string;
	step: string;
	attempt: number;
	child?: { collection: string; id: string; offset: number };
};
export type ProviderDiagnostic = {
	key: string;
	label: string;
	labelJa: string;
};

const namedFields: Record<string, [en: string, ja: string]> = {
	type: ["Type", "種別"],
	startRequestAvailable: ["Start request available", "開始設定あり"],
	encodingMode: ["Encoding mode", "エンコードモード"],
	manifestGenerator: ["Manifest generator", "マニフェスト生成方式"],
	handleVariableInputFps: [
		"Variable input frame rate",
		"入力の可変フレームレート",
	],
	trimOffsetSeconds: ["Trim start (s)", "トリム開始 (秒)"],
	trimDurationSeconds: ["Trim duration (s)", "トリム時間 (秒)"],
	configured: ["Configured", "設定済み"],
	available: ["Available", "利用可能"],
	reportOutputCount: ["Report outputs", "レポート出力数"],
	outputCount: ["Outputs", "出力先数"],
	dashManifestCount: ["DASH manifests", "DASHマニフェスト数"],
	hlsManifestCount: ["HLS manifests", "HLSマニフェスト数"],
	smoothManifestCount: ["Smooth manifests", "Smoothマニフェスト数"],
	vodDashManifestCount: ["VOD DASH manifests", "VODのDASHマニフェスト数"],
	vodHlsManifestCount: ["VOD HLS manifests", "VODのHLSマニフェスト数"],
	vodSmoothManifestCount: ["VOD Smooth manifests", "VODのSmoothマニフェスト数"],
	videoTrackCount: ["Video tracks", "映像トラック数"],
	audioTrackCount: ["Audio tracks", "音声トラック数"],
	subtitleTrackCount: ["Subtitle tracks", "字幕トラック数"],
	metadataTrackCount: ["Metadata tracks", "メタデータトラック数"],
	bitrateBps: ["Bitrate (bps)", "ビットレート (bps)"],
	filterCount: ["Filters", "フィルター数"],
	firstPosition: ["First position", "先頭位置"],
	lastPosition: ["Last position", "末尾位置"],
	inputCount: ["Inputs", "入力数"],
	reportedInputs: ["Reported inputs", "応答に含まれる入力数"],
	analyzedInputs: ["Analyzed inputs", "解析済み入力数"],
};

function Details({ fields }: { fields: FieldSet }) {
	const { locale, t } = useT();
	const labels = {
		fileSizeBytes: t("providerResources.fileSizeBytes"),
		durationSeconds: t("providerResources.durationSeconds"),
		containerBitrateBps: t("providerResources.containerBitrateBps"),
		psnrDb: "PSNR (dB)",
		fromSeconds: locale === "ja" ? "開始 (秒)" : "Start (s)",
		toSeconds: locale === "ja" ? "終了 (秒)" : "End (s)",
	} as const;
	return (
		<dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
			{Object.entries(fields).map(([key, value]) =>
				key === "id" ? null : (
					<div className="contents" key={key}>
						<dt className="text-zinc-400">
							{Object.hasOwn(labels, key)
								? labels[key as keyof typeof labels]
								: (namedFields[key]?.[locale === "ja" ? 1 : 0] ?? key)}
						</dt>
						<dd className="break-all">{String(value)}</dd>
					</div>
				),
			)}
		</dl>
	);
}

export function ResourceDiagnostics({
	endpoint,
	subject,
	choices,
}: {
	endpoint: string;
	subject: Subject;
	choices: ProviderDiagnostic[];
}) {
	const { locale, t } = useT();
	const id = useId();
	const [key, setKey] = useState("");
	const [offset, setOffset] = useState(0);
	const pageSize = 25;
	const child = subject.child;
	const query = new URLSearchParams({
		step: subject.step,
		attempt: String(subject.attempt),
		view: child ? "childDiagnostic" : "diagnostic",
		diagnostic: key,
		offset: String(child?.offset ?? offset),
	});
	if (child) {
		query.set("collection", child.collection);
		query.set("childId", child.id);
	}
	const data = useQuery({
		queryKey: ["provider-diagnostic", endpoint, subject.id, query.toString()],
		queryFn: ({ signal }) =>
			apiFetch<Result>(`${endpoint}?${query}`, { signal }),
		enabled: choices.some((entry) => entry.key === key),
		retry: false,
		refetchOnWindowFocus: false,
	});
	return (
		<div className="space-y-2 rounded border border-zinc-800 p-2 text-xs">
			<label htmlFor={id} className="mr-2">
				{locale === "ja" ? "診断情報" : "Diagnostics"}
			</label>
			<select
				id={id}
				value={key}
				className="max-w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1"
				onChange={(event) => {
					setKey(event.currentTarget.value);
					setOffset(0);
				}}
			>
				<option value="">
					{locale === "ja" ? "診断項目を選択" : "Select a diagnostic"}
				</option>
				{choices.map((entry) => (
					<option key={entry.key} value={entry.key}>
						{locale === "ja" ? entry.labelJa : entry.label}
					</option>
				))}
			</select>
			{key &&
				(data.isPending ? (
					<p role="status">{t("providerResources.loading")}</p>
				) : data.isError ? (
					<p role="alert">
						{t("providerResources.failed")}{" "}
						<Button variant="ghost" size="sm" onClick={() => data.refetch()}>
							{t("common.retry")}
						</Button>
					</p>
				) : "fields" in data.data ? (
					Object.keys(data.data.fields).length ? (
						<Details fields={data.data.fields} />
					) : (
						<p>{t("providerResources.informationUnavailable")}</p>
					)
				) : (
					<>
						{data.data.items.length ? (
							<ul className="space-y-2">
								{data.data.items.map((item) => (
									<li
										className="rounded border border-zinc-800 p-2"
										key={String(item.id)}
									>
										<Details fields={item} />
									</li>
								))}
							</ul>
						) : (
							<p>{t("providerResources.emptyPage")}</p>
						)}
						{!child && (offset > 0 || offset + pageSize < data.data.total) && (
							<div className="flex gap-2">
								<Button
									variant="secondary"
									size="sm"
									disabled={!offset}
									onClick={() => setOffset((n) => Math.max(0, n - pageSize))}
								>
									{t("providerResources.previous")}
								</Button>
								<Button
									variant="secondary"
									size="sm"
									disabled={offset + pageSize >= data.data.total}
									onClick={() => setOffset((n) => n + pageSize)}
								>
									{t("providerResources.next")}
								</Button>
							</div>
						)}
					</>
				))}
		</div>
	);
}
