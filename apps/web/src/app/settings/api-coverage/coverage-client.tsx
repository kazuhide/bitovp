"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import {
	type CoverageEndpoint,
	filterCoverageOperations,
	type OperationEvidence,
	type OperationLedger,
	operationEvidence,
	operationScopes,
} from "@/lib/api-coverage/operation-ledger";
import { useT } from "@/lib/i18n/context";
import { type RequestFieldInventory, RequestFields } from "./request-fields";

type ParamFamilyRow = {
	family: string;
	fields: number;
	wizard: number;
	advanced: number;
	rawJson: number;
	autoDerived: number;
	hardcoded: number;
	notSettable: number;
};
type CoveragePayload = {
	sdk: { installed: string; surveyed: string; stale: boolean };
	current: {
		schemaVersion: 1;
		provenance: {
			generatedAt: string;
			sourceCommit: string;
			sourceFingerprint: string;
			sdkVersion: string;
			sdkFingerprint: string;
			method: "typescript-resolved-sdk-signatures-v1";
			scope: "encoding";
		};
		summary: {
			totalOperations: number;
			sourceConfirmed: number;
			unconfirmed: number;
			createTotal: number;
			createSourceConfirmed: number;
		};
		families: {
			family: string;
			total: number;
			sourceConfirmed: number;
			unconfirmed: number;
		}[];
		endpoints: CoverageEndpoint[];
		requestFields?: RequestFieldInventory;
	};
	operationLedger?: OperationLedger;
	parameterSnapshot: {
		surveyedSdk: string;
		surveyedAt: string;
		paramTotals: Record<string, number>;
		paramFamilies: ParamFamilyRow[];
		fields: number;
		operatorReachable: number;
	};
};
const PAGE_SIZE = 50;
const coveragePath = "/api/settings/api-coverage";
const cell = "py-2 pr-4 align-top";
const selectClass =
	"rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200";
const buttonClass =
	"rounded border border-zinc-700 px-3 py-1 text-xs disabled:opacity-40";
const percent = (count: number, total: number) =>
	total > 0 ? `${((count / total) * 100).toFixed(1)}%` : "—";

export function ApiCoverageClient() {
	const { t } = useT();
	const coverage = useQuery({
		queryKey: ["api-coverage"],
		queryFn: () => apiFetch<CoveragePayload>(coveragePath),
		staleTime: Infinity,
	});
	const [family, setFamily] = useState("");
	const [status, setStatus] = useState("");
	const [reachability, setReachability] = useState("");
	const [scope, setScope] = useState("");
	const [search, setSearch] = useState("");
	const [page, setPage] = useState(0);
	const filtered = useMemo(
		() =>
			filterCoverageOperations(
				coverage.data?.current.endpoints ?? [],
				coverage.data?.operationLedger,
				{ family, source: status, reachability, scope, q: search },
			),
		[coverage.data, family, status, reachability, scope, search],
	);

	const heading = (
		<h1 className="font-semibold text-xl text-zinc-50">
			{t("pageTitles.apiCoverage")}
		</h1>
	);
	if (coverage.isPending || coverage.isError)
		return (
			<div className="space-y-8">
				{heading}
				<p
					className={
						coverage.isError ? "text-red-400 text-sm" : "text-sm text-zinc-400"
					}
				>
					{t(
						coverage.isError ? "apiCoverage.loadFailed" : "apiCoverage.loading",
					)}
				</p>
			</div>
		);

	const {
		sdk,
		current,
		operationLedger,
		parameterSnapshot: historical,
	} = coverage.data;
	const { summary, provenance } = current;
	const audited = operationLedger?.summary;
	const download = new URLSearchParams({
		format: "csv",
		family,
		source: status,
		reachability,
		scope,
		q: search,
	});
	const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
	const safePage = Math.min(page, pageCount - 1);
	const rows = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
	return (
		<div className="space-y-8">
			{heading}
			<section className="space-y-3">
				<p data-testid="current-notice" className="text-sm text-zinc-300">
					{t("apiCoverage.currentNotice")}
				</p>
				<p
					data-testid="sdk-notice"
					className={
						sdk.stale ? "text-amber-300 text-xs" : "text-xs text-zinc-400"
					}
				>
					{sdk.stale
						? t("apiCoverage.staleWarning", {
								installed: sdk.installed,
								surveyed: sdk.surveyed,
							})
						: t("apiCoverage.sdkMatches")}
				</p>
				<div className="grid gap-3 sm:grid-cols-3">
					<StatCard
						label={t("apiCoverage.sdkVersion")}
						value={sdk.installed}
						sub={t("apiCoverage.surveyedAgainst", { version: sdk.surveyed })}
					/>
					<StatCard
						label={t("apiCoverage.confirmedOperations")}
						value={`${summary.sourceConfirmed} / ${summary.totalOperations}`}
						sub={percent(summary.sourceConfirmed, summary.totalOperations)}
					/>
					<StatCard
						label={t("apiCoverage.confirmedCreates")}
						value={`${summary.createSourceConfirmed} / ${summary.createTotal}`}
						sub={percent(summary.createSourceConfirmed, summary.createTotal)}
					/>
				</div>
				<p
					data-testid="current-provenance"
					className="break-all text-xs text-zinc-500"
				>
					{t("apiCoverage.currentProvenance", {
						date: provenance.generatedAt,
						repo: provenance.sourceCommit,
						source: provenance.sourceFingerprint,
						sdk: provenance.sdkVersion,
						sdkFingerprint: provenance.sdkFingerprint,
					})}
				</p>
			</section>
			{audited && (
				<section
					className="space-y-2"
					aria-labelledby="operation-evidence-heading"
				>
					<h2
						id="operation-evidence-heading"
						className="font-medium text-sm text-zinc-100"
					>
						{t("apiCoverage.operationLedger.title")}
					</h2>
					<dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-zinc-200">
						{(
							[
								["appConfirmed", audited.appConfirmed],
								["contractConfirmed", audited.transportConfirmed],
								["providerVerified", audited.providerVerified],
								["unreviewed", audited.unreviewed],
							] as const
						).map(([label, count]) => (
							<div key={label} className="flex gap-2">
								<dt>{t(`apiCoverage.operationLedger.${label}`)}</dt>
								<dd className="tabular-nums text-zinc-400">
									{count} / {audited.total}
								</dd>
							</div>
						))}
					</dl>
					<p className="text-xs text-zinc-400">
						{t("apiCoverage.operationLedger.notice")}
					</p>
				</section>
			)}
			<section>
				<h2 className="font-medium text-sm text-zinc-100">
					{t("apiCoverage.byFamily")}
				</h2>
				<div className="mt-2 overflow-x-auto">
					<table className="w-full text-left text-xs">
						<thead>
							<tr className="border-zinc-800 border-b text-zinc-400">
								<th scope="col" className={cell}>
									{t("apiCoverage.family")}
								</th>
								<th scope="col" className={cell}>
									{t("apiCoverage.total")}
								</th>
								<th scope="col" className={cell}>
									{t("apiCoverage.sourceConfirmed")}
								</th>
								<th scope="col" className={cell}>
									{t("apiCoverage.unconfirmed")}
								</th>
							</tr>
						</thead>
						<tbody>
							{current.families.map((row) => (
								<tr key={row.family} className="border-zinc-900 border-b">
									<th scope="row" className={cell}>
										{row.family}
									</th>
									<td className={cell}>{row.total}</td>
									<td className={cell}>{row.sourceConfirmed}</td>
									<td className={cell}>{row.unconfirmed}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</section>
			<section>
				<h2 className="font-medium text-sm text-zinc-100">
					{t("apiCoverage.endpoints")}
				</h2>
				<div className="mt-2 flex flex-wrap items-center gap-2">
					<Input
						aria-label={t("apiCoverage.searchLabel")}
						placeholder={t("apiCoverage.searchPlaceholder")}
						value={search}
						onChange={(e) => {
							setSearch(e.target.value);
							setPage(0);
						}}
						className="w-64"
					/>
					<select
						aria-label={t("apiCoverage.family")}
						value={family}
						onChange={(e) => {
							setFamily(e.target.value);
							setPage(0);
						}}
						className={selectClass}
					>
						<option value="">{t("apiCoverage.allFamilies")}</option>
						{current.families.map((row) => (
							<option key={row.family} value={row.family}>
								{row.family}
							</option>
						))}
					</select>
					<select
						aria-label={t("apiCoverage.state")}
						value={status}
						onChange={(e) => {
							setStatus(e.target.value);
							setPage(0);
						}}
						className={selectClass}
					>
						<option value="">{t("apiCoverage.allStates")}</option>
						<option value="source-confirmed">
							{t("apiCoverage.sourceConfirmed")}
						</option>
						<option value="unconfirmed">{t("apiCoverage.unconfirmed")}</option>
					</select>
					<select
						aria-label={t("apiCoverage.operationLedger.reachability")}
						value={reachability}
						onChange={(e) => {
							setReachability(e.target.value);
							setPage(0);
						}}
						className={selectClass}
					>
						<option value="">
							{t("apiCoverage.operationLedger.allReachability")}
						</option>
						<option value="app-confirmed">
							{t("apiCoverage.operationLedger.appConfirmed")}
						</option>
						<option value="unreviewed">
							{t("apiCoverage.operationLedger.unreviewed")}
						</option>
					</select>
					<select
						aria-label={t("apiCoverage.operationLedger.scope")}
						value={scope}
						onChange={(e) => {
							setScope(e.target.value);
							setPage(0);
						}}
						className={selectClass}
					>
						<option value="">
							{t("apiCoverage.operationLedger.allScopes")}
						</option>
						{operationScopes.map((name) => (
							<option key={name} value={name}>
								{t(`apiCoverage.operationLedger.scopes.${name}`)}
							</option>
						))}
					</select>
					{operationLedger && (
						<a href={`${coveragePath}?${download}`} className={buttonClass}>
							{t("apiCoverage.operationLedger.download")}
						</a>
					)}
					<span aria-live="polite" className="text-xs text-zinc-500">
						{t("apiCoverage.matchCount", { n: filtered.length })}
					</span>
				</div>
				<div className="mt-2 overflow-x-auto">
					<table
						data-testid="current-endpoints"
						className="w-full text-left text-xs"
					>
						<thead>
							<tr className="border-zinc-800 border-b text-zinc-400">
								<th scope="col" className={cell}>
									{t("apiCoverage.endpoint")}
								</th>
								<th scope="col" className={cell}>
									{t("apiCoverage.operation")}
								</th>
								<th scope="col" className={cell}>
									{t("apiCoverage.sdkMethod")}
								</th>
								<th scope="col" className={cell}>
									{t("apiCoverage.state")}
								</th>
								<th scope="col" className={cell}>
									{t("apiCoverage.sourceEvidence")}
								</th>
								<th scope="col" className={cell}>
									{t("apiCoverage.operationLedger.title")}
								</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => (
								<tr
									key={`${row.sdkMethod}:${row.operation}:${row.httpVerb}:${row.path}`}
									className="border-zinc-900 border-b"
								>
									<td className={`${cell} break-all font-mono`}>{row.path}</td>
									<td className={cell}>
										{row.httpVerb} {row.operation}
									</td>
									<td className={`${cell} break-all font-mono`}>
										{row.sdkMethod}
									</td>
									<td className={cell}>
										<Badge
											tone={
												row.status === "source-confirmed" ? "ok" : "neutral"
											}
										>
											{t(
												row.status === "source-confirmed"
													? "apiCoverage.sourceConfirmed"
													: "apiCoverage.unconfirmed",
											)}
										</Badge>
									</td>
									<td className={`${cell} break-all font-mono`}>
										{row.evidence.length
											? row.evidence.map((e) => (
													<div key={`${e.file}:${e.line}`}>
														{e.file}:{e.line}
													</div>
												))
											: "—"}
									</td>
									<td className={cell}>
										<WorkflowEvidence
											evidence={operationEvidence(
												operationLedger,
												row.sdkMethod,
											)}
										/>
									</td>
								</tr>
							))}
						</tbody>
					</table>
					{rows.length === 0 && (
						<p
							data-testid="no-matches"
							role="status"
							className="py-4 text-sm text-zinc-400"
						>
							{t("apiCoverage.noMatches")}
						</p>
					)}
				</div>
				<div className="mt-3 flex items-center gap-3">
					<button
						type="button"
						className={buttonClass}
						disabled={safePage === 0}
						onClick={() => setPage(safePage - 1)}
					>
						{t("apiCoverage.prev")}
					</button>
					<span className="text-xs text-zinc-400">
						{safePage + 1} / {pageCount}
					</span>
					<button
						type="button"
						className={buttonClass}
						disabled={safePage + 1 >= pageCount}
						onClick={() => setPage(safePage + 1)}
					>
						{t("apiCoverage.next")}
					</button>
				</div>
			</section>
			{current.requestFields && (
				<RequestFields inventory={current.requestFields} />
			)}
			<details
				data-testid="parameter-snapshot"
				className="rounded-lg border border-zinc-800 p-4 text-xs text-zinc-400"
			>
				<summary className="cursor-pointer font-medium text-zinc-200">
					{t("apiCoverage.parameterSnapshotTitle")}
				</summary>
				<p className="mt-3">{t("apiCoverage.parameterSnapshotNotice")}</p>
				<p className="mt-2">{t("apiCoverage.historicalNotice")}</p>
				<p className="mt-2">
					{t("apiCoverage.parameterProvenance", {
						date: historical.surveyedAt,
						sdk: historical.surveyedSdk,
					})}
				</p>
				<dl className="mt-3 flex flex-wrap gap-x-3">
					<dt>{t("apiCoverage.paramsReachable")}</dt>
					<dd>
						{historical.operatorReachable} / {historical.fields}
					</dd>
					<dd>{percent(historical.operatorReachable, historical.fields)}</dd>
				</dl>
				<h2 className="mt-4 font-medium text-zinc-200">
					{t("apiCoverage.paramsByFamily")}
				</h2>
				<p className="mt-1">{t("apiCoverage.paramsLegend")}</p>
				<div className="mt-2 overflow-x-auto">
					<table className="w-full text-left text-xs">
						<thead>
							<tr className="border-zinc-800 border-b">
								<th scope="col" className={cell}>
									{t("apiCoverage.family")}
								</th>
								<th scope="col" className={cell}>
									{t("apiCoverage.fields")}
								</th>
								<th scope="col" className={cell}>
									wizard
								</th>
								<th scope="col" className={cell}>
									advanced
								</th>
								<th scope="col" className={cell}>
									raw-JSON
								</th>
								<th scope="col" className={cell}>
									{t("apiCoverage.autoDerived")}
								</th>
								<th scope="col" className={cell}>
									{t("apiCoverage.notSettable")}
								</th>
							</tr>
						</thead>
						<tbody>
							{historical.paramFamilies.map((row) => (
								<tr key={row.family} className="border-zinc-900 border-b">
									<th scope="row" className={cell}>
										{row.family}
									</th>
									<td className={cell}>{row.fields}</td>
									<td className={cell}>{row.wizard}</td>
									<td className={cell}>{row.advanced}</td>
									<td className={cell}>{row.rawJson}</td>
									<td className={cell}>{row.autoDerived + row.hardcoded}</td>
									<td className={cell}>{row.notSettable}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</details>
		</div>
	);
}

function WorkflowEvidence({ evidence }: { evidence: OperationEvidence }) {
	const { t } = useT();
	const { proof } = evidence;
	return (
		<div className="min-w-36 space-y-1 text-zinc-300">
			{proof ? (
				<details className="max-w-72">
					<summary className="cursor-pointer text-zinc-100">
						{t("apiCoverage.operationLedger.appConfirmed")} ·{" "}
						{t(`apiCoverage.operationLedger.scopes.${proof.scope}`)}
					</summary>
					<p className="my-1">{proof.scenario}</p>
					<ul className="break-all font-mono text-zinc-400">
						<li>
							{proof.entrypoint.httpVerb} {proof.entrypoint.path}
						</li>
						<li>{proof.transport.file}</li>
						<li>{proof.contractTest.file}</li>
					</ul>
				</details>
			) : (
				<p>{t("apiCoverage.operationLedger.unreviewed")}</p>
			)}
			<p>
				{t(
					evidence.contract === "transport-confirmed"
						? "apiCoverage.operationLedger.contractConfirmed"
						: "apiCoverage.operationLedger.contractUnverified",
				)}
			</p>
			<p>{t("apiCoverage.operationLedger.providerUnverified")}</p>
		</div>
	);
}

function StatCard({
	label,
	value,
	sub,
}: {
	label: string;
	value: string;
	sub: string;
}) {
	return (
		<div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
			<p className="text-xs text-zinc-400">{label}</p>
			<p className="mt-1 font-semibold text-2xl text-zinc-50 tabular-nums">
				{value}
			</p>
			<p className="mt-1 text-xs text-zinc-500">{sub}</p>
		</div>
	);
}
