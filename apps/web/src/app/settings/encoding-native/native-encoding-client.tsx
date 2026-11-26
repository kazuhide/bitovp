"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useId, useState } from "react";
import { CopyableId } from "@/components/copyable-id";
import { Button } from "@/components/ui/button";
import { SelectNative } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import {
	type EncodingCatalogueKind,
	encodingCatalogueKinds,
	encodingCatalogueProtocols,
} from "@/lib/encoding-catalogue";
import { formatBitrate, formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/context";

type TemplateType = "" | "VOD" | "LIVE";
type Target = {
	kind: EncodingCatalogueKind;
	bitmovinAccountId: string;
	protocol?: string;
};
type Account = { id: string; label: string };
type Item = {
	id: string;
	name?: string;
	type?: "VOD" | "LIVE";
	status?: "STOPPED" | "STARTED" | "ERROR";
	createdAt?: string;
	modifiedAt?: string;
	inputId?: string;
	outputCount?: number;
	cloudRegion?: string;
	bitrateBps?: number;
	width?: number;
	height?: number;
	frameRate?: number;
	sampleRateHz?: number;
};
type Page = { offset: number; totalCount: number; items: Item[] };
const kindLabels = {
	templates: "encodingNative.templates",
	"watch-folders": "encodingNative.watchFolders",
	inputs: "encodingNative.inputs",
	outputs: "encodingNative.outputs",
	"video-codecs": "encodingNative.videoCodecs",
	"audio-codecs": "encodingNative.audioCodecs",
	"subtitle-codecs": "encodingNative.subtitleCodecs",
	filters: "encodingNative.filters",
} as const;
const defaultProtocol: Partial<Record<EncodingCatalogueKind, string>> = {
	inputs: "s3",
	outputs: "s3",
	"video-codecs": "h264",
	"audio-codecs": "aac",
	"subtitle-codecs": "webvtt",
};

export function NativeEncodingClient() {
	const { t } = useT();
	const fieldId = useId();
	const [accountId, setAccountId] = useState<string>();
	const [kind, setKind] = useState<EncodingCatalogueKind>("templates");
	const [type, setType] = useState<TemplateType>("");
	const [protocol, setProtocol] = useState("");
	const [offsets, setOffsets] = useState([0]);
	const [selected, setSelected] = useState<string>();
	const offset = offsets.at(-1) ?? 0;
	const accounts = useQuery({
		queryKey: ["bitmovin-accounts"],
		queryFn: ({ signal }) =>
			apiFetch<Account[]>("/api/bitmovin-accounts", { signal }),
	});
	const activeId = accountId ?? accounts.data?.[0]?.id ?? "";
	const accountReady =
		accounts.isSuccess &&
		accounts.data.some((account) => account.id === activeId);
	const options = encodingCatalogueProtocols[kind];
	const storage = kind === "inputs" || kind === "outputs";
	const params: Target = {
		kind,
		bitmovinAccountId: activeId,
		...(options && protocol && { protocol }),
	};
	const list = useQuery({
		queryKey: ["encoding-native", params, type, offset],
		queryFn: ({ signal }) =>
			apiFetch<Page>(
				`/api/encoding-native?${new URLSearchParams({
					...params,
					offset: String(offset),
					...(kind === "templates" && type ? { type } : {}),
				})}`,
				{ signal },
			),
		enabled: accountReady,
		retry: false,
		refetchOnWindowFocus: false,
	});

	function moveTo(next: number[]) {
		setOffsets(next);
		setSelected(undefined);
	}

	const page = list.data;
	const end = page ? page.offset + page.items.length : offset;
	return (
		<section className="min-w-0 max-w-5xl space-y-4">
			<h1 className="font-semibold text-xl text-zinc-50">
				{t("encodingNative.title")}
			</h1>
			{accounts.isError ? (
				<LoadFailure
					message={t("errorDefinitions.accountsFailed")}
					reload={() => accounts.refetch()}
				/>
			) : accounts.isPending ? (
				<Loading />
			) : accounts.data.length === 0 ? (
				<Link
					href="/settings/bitmovin"
					className="inline-flex min-h-11 items-center text-emerald-400 text-sm underline underline-offset-4"
				>
					{t("errorDefinitions.addAccount")}
				</Link>
			) : (
				<>
					<div className="grid gap-3 text-sm text-zinc-400 sm:grid-cols-3">
						<label htmlFor={`${fieldId}-account`} className="min-w-0 space-y-1">
							<span>{t("errorDefinitions.account")}</span>
							<SelectNative
								id={`${fieldId}-account`}
								value={accountReady ? activeId : ""}
								onChange={(event) => {
									setAccountId(event.target.value);
									moveTo([0]);
								}}
							>
								<option value="" disabled>
									{t("errorDefinitions.chooseAccount")}
								</option>
								{accounts.data.map((account) => (
									<option key={account.id} value={account.id}>
										{account.label}
									</option>
								))}
							</SelectNative>
						</label>
						<label
							htmlFor={`${fieldId}-resource`}
							className="min-w-0 space-y-1"
						>
							<span>{t("encodingNative.resource")}</span>
							<SelectNative
								id={`${fieldId}-resource`}
								value={kind}
								onChange={(event) => {
									const next = encodingCatalogueKinds.find(
										(value) => value === event.target.value,
									);
									if (!next) return;
									setKind(next);
									setType("");
									setProtocol(defaultProtocol[next] ?? "");
									moveTo([0]);
								}}
							>
								{encodingCatalogueKinds.map((value) => (
									<option key={value} value={value}>
										{t(kindLabels[value])}
									</option>
								))}
							</SelectNative>
						</label>
						{kind === "templates" && (
							<label
								htmlFor={`${fieldId}-template-type`}
								className="min-w-0 space-y-1"
							>
								<span>{t("encodingNative.templateType")}</span>
								<SelectNative
									id={`${fieldId}-template-type`}
									value={type}
									onChange={(event) => {
										const next = event.target.value;
										setType(next === "VOD" || next === "LIVE" ? next : "");
										moveTo([0]);
									}}
								>
									<option value="">{t("encodingNative.allTypes")}</option>
									<option value="VOD">VOD</option>
									<option value="LIVE">Live</option>
								</SelectNative>
							</label>
						)}
						{options && (
							<label
								htmlFor={`${fieldId}-protocol`}
								className="min-w-0 space-y-1"
							>
								<span>
									{t(
										storage
											? "encodingNative.protocol"
											: "encodingNative.configType",
									)}
								</span>
								<SelectNative
									id={`${fieldId}-protocol`}
									value={protocol}
									onChange={(event) => {
										setProtocol(event.target.value);
										moveTo([0]);
									}}
								>
									{kind === "filters" && (
										<option value="">{t("encodingNative.allTypes")}</option>
									)}
									{Object.entries(options).map(([value, label]) => (
										<option key={value} value={value}>
											{label}
										</option>
									))}
								</SelectNative>
							</label>
						)}
					</div>
					{!accountReady ? (
						<p role="status" className="text-sm text-zinc-400">
							{t("errorDefinitions.accountUnavailable")}
						</p>
					) : list.isError ? (
						<LoadFailure
							message={t("encodingNative.loadFailed")}
							reload={() => list.refetch()}
						/>
					) : page ? (
						page.items.length === 0 ? (
							<p role="status" className="text-sm text-zinc-400">
								{t("encodingNative.empty")}
							</p>
						) : (
							<ul className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
								{page.items.map((item) => (
									<li key={item.id} className="min-w-0">
										<button
											type="button"
											aria-expanded={selected === item.id}
											aria-controls={
												selected === item.id
													? `encoding-resource-${item.id}`
													: undefined
											}
											className="flex min-h-11 w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-emerald-500"
											onClick={() =>
												setSelected(selected === item.id ? undefined : item.id)
											}
										>
											<span className="min-w-0 break-all">
												{item.name ?? item.id}
											</span>
											<span className="flex shrink-0 items-center gap-3 text-zinc-400">
												<ResourceClassification item={item} />
												{t("encodingNative.details")}
											</span>
										</button>
										{selected === item.id && (
											<ResourceDetail target={params} id={item.id} />
										)}
									</li>
								))}
							</ul>
						)
					) : (
						<Loading />
					)}
					{accountReady &&
						(offsets.length > 1 || (page && end < page.totalCount)) && (
							<nav
								aria-label={t("encodingNative.pagination")}
								className="flex flex-wrap items-center gap-2 text-sm text-zinc-400"
							>
								<Button
									variant="secondary"
									size="sm"
									disabled={offsets.length === 1}
									onClick={() => moveTo(offsets.slice(0, -1))}
								>
									{t("providerResources.previous")}
								</Button>
								{page && page.items.length > 0 && (
									<span>
										{t("encodingNative.range", {
											start: page.offset + 1,
											end,
											total: page.totalCount,
										})}
									</span>
								)}
								<Button
									variant="secondary"
									size="sm"
									disabled={!page || list.isError || end >= page.totalCount}
									onClick={() => moveTo([...offsets, end])}
								>
									{t("providerResources.next")}
								</Button>
							</nav>
						)}
				</>
			)}
		</section>
	);
}

function ResourceClassification({ item }: { item: Item }) {
	const { t } = useT();
	if (item.type) return item.type === "VOD" ? "VOD" : "Live";
	return item.status ? t(`encodingNative.status.${item.status}`) : null;
}

function ResourceDetail({ target, id }: { target: Target; id: string }) {
	const { t } = useT();
	const detail = useQuery({
		queryKey: ["encoding-native-detail", target, id],
		queryFn: ({ signal }) =>
			apiFetch<{ item: Item }>(
				`/api/encoding-native?${new URLSearchParams({ ...target, id })}`,
				{ signal },
			),
		retry: false,
		refetchOnWindowFocus: false,
	});
	const item = detail.data?.item;
	return (
		<div
			id={`encoding-resource-${id}`}
			className="border-t border-zinc-800 px-3 py-3"
		>
			{detail.isError ? (
				<LoadFailure
					message={t("encodingNative.detailFailed")}
					reload={() => detail.refetch()}
				/>
			) : item ? (
				<dl className="grid gap-x-5 gap-y-1 text-sm text-zinc-300 sm:grid-cols-[max-content_minmax(0,1fr)]">
					<dt>{t("uiX.idNoun")}</dt>
					<dd>
						<CopyableId value={item.id} />
					</dd>
					{(item.type || item.status) && (
						<>
							<dt>
								{t(
									item.type
										? "encodingNative.templateType"
										: "encodingNative.statusLabel",
								)}
							</dt>
							<dd>
								<ResourceClassification item={item} />
							</dd>
						</>
					)}
					{item.createdAt && (
						<>
							<dt>{t("encodingNative.created")}</dt>
							<dd>{formatDateTime(item.createdAt)}</dd>
						</>
					)}
					{item.modifiedAt && (
						<>
							<dt>{t("encodingNative.modified")}</dt>
							<dd>{formatDateTime(item.modifiedAt)}</dd>
						</>
					)}
					{item.cloudRegion && (
						<>
							<dt>{t("encodingNative.region")}</dt>
							<dd>{item.cloudRegion}</dd>
						</>
					)}
					{item.bitrateBps !== undefined && (
						<>
							<dt>{t("encodingNative.bitrate")}</dt>
							<dd>{formatBitrate(item.bitrateBps)}</dd>
						</>
					)}
					{item.width !== undefined && item.height !== undefined && (
						<>
							<dt>{t("encodingNative.resolution")}</dt>
							<dd>
								{item.width} × {item.height}
							</dd>
						</>
					)}
					{item.frameRate !== undefined && (
						<>
							<dt>{t("encodingNative.frameRate")}</dt>
							<dd>{item.frameRate} fps</dd>
						</>
					)}
					{item.sampleRateHz !== undefined && (
						<>
							<dt>{t("encodingNative.sampleRate")}</dt>
							<dd>{item.sampleRateHz} Hz</dd>
						</>
					)}
					{item.inputId && (
						<>
							<dt>{t("encodingNative.inputId")}</dt>
							<dd>
								<CopyableId value={item.inputId} />
							</dd>
						</>
					)}
					{item.outputCount !== undefined && (
						<>
							<dt>{t("encodingNative.outputCount")}</dt>
							<dd>{item.outputCount}</dd>
						</>
					)}
				</dl>
			) : (
				<Loading />
			)}
		</div>
	);
}

function Loading() {
	const { t } = useT();
	return (
		<p role="status" className="text-sm text-zinc-400">
			{t("common.loading")}
		</p>
	);
}

function LoadFailure({
	message,
	reload,
}: {
	message: string;
	reload: () => unknown;
}) {
	const { t } = useT();
	return (
		<div className="flex flex-wrap items-center gap-2">
			<p role="alert" className="text-red-400 text-sm">
				{message}
			</p>
			<Button variant="secondary" size="sm" onClick={() => reload()}>
				{t("common.retry")}
			</Button>
		</div>
	);
}
