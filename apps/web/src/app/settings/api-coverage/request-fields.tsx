"use client";

import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";

type SourceReference = { file: string; line: number };
export type RequestFieldInventory = {
	method: string;
	scope: string;
	summary: {
		bodyOperations: number;
		expandedOperations: number;
		unexpandedOperations: number;
		totalFields: number;
		sourceAssigned: number;
		unconfirmed: number;
	};
	operations: {
		sdkMethod: string;
		path: string;
		httpVerb: string;
		bodyParameterIndex: number;
		bodyModel: string;
		expansion: "expanded" | "unexpanded";
		reason?: string;
		fields: {
			name: string;
			type: string;
			sdkEvidence: SourceReference;
			status: "source-assigned" | "unconfirmed";
			evidence: SourceReference[];
		}[];
	}[];
};

const PAGE_SIZE = 50;
const cell = "py-2 pr-4 align-top";
const buttonClass =
	"rounded border border-zinc-700 px-3 py-1 disabled:opacity-40";
const summaryKeys = [
	"bodyOperations",
	"expandedOperations",
	"unexpandedOperations",
	"totalFields",
	"sourceAssigned",
	"unconfirmed",
] as const;
const columnKeys = [
	"endpoint",
	"requestFields.model",
	"requestFields.property",
	"state",
	"sourceEvidence",
] as const;
const reasonKeys = new Map<string, MessageKey>([
	["array-body", "apiCoverage.requestFields.arrayReason"],
	["unknown-body", "apiCoverage.requestFields.unknownBodyReason"],
	["union-body", "apiCoverage.requestFields.unionReason"],
	["dictionary-body", "apiCoverage.requestFields.dictionaryReason"],
	["unsupported-body", "apiCoverage.requestFields.unsupportedReason"],
]);
const reference = (source: SourceReference) => `${source.file}:${source.line}`;
const operationText = (
	operation: RequestFieldInventory["operations"][number],
) =>
	`${operation.httpVerb} ${operation.path} ${operation.sdkMethod} ${operation.bodyModel} ${operation.reason ?? ""}`;

export function RequestFields({
	inventory,
}: {
	inventory: RequestFieldInventory;
}) {
	const { t } = useT();
	const [search, setSearch] = useState("");
	const [page, setPage] = useState(0);
	const [bodyPage, setBodyPage] = useState(0);
	const filtered = useMemo(() => {
		const query = search.trim().toLowerCase();
		const matches = (text: string) => text.toLowerCase().includes(query);
		return {
			fields: inventory.operations.flatMap((operation) =>
				operation.expansion === "expanded"
					? operation.fields
							.filter((field) =>
								matches(
									[
										operationText(operation),
										field.name,
										field.type,
										...[field.sdkEvidence, ...field.evidence].map(reference),
									].join(" "),
								),
							)
							.map((field) => ({ operation, field }))
					: [],
			),
			bodies: inventory.operations.filter(
				(operation) =>
					operation.expansion === "unexpanded" &&
					matches(operationText(operation)),
			),
		};
	}, [inventory, search]);
	const safePage = Math.min(
		page,
		Math.max(0, Math.ceil(filtered.fields.length / PAGE_SIZE) - 1),
	);
	const safeBodyPage = Math.min(
		bodyPage,
		Math.max(0, Math.ceil(filtered.bodies.length / PAGE_SIZE) - 1),
	);
	const rows = filtered.fields.slice(
		safePage * PAGE_SIZE,
		(safePage + 1) * PAGE_SIZE,
	);
	const bodies = filtered.bodies.slice(
		safeBodyPage * PAGE_SIZE,
		(safeBodyPage + 1) * PAGE_SIZE,
	);
	return (
		<details
			data-testid="request-field-inventory"
			className="rounded-lg border border-zinc-800 p-4 text-xs text-zinc-400"
		>
			<summary className="cursor-pointer font-medium text-zinc-200 focus-visible:outline-2 focus-visible:outline-emerald-500">
				{t("apiCoverage.requestFields.title")}
			</summary>
			<p className="mt-3">{t("apiCoverage.requestFields.scopeNotice")}</p>
			<p className="mt-2">{t("apiCoverage.requestFields.assignmentNotice")}</p>
			<dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
				{summaryKeys.map((key) => (
					<div key={key}>
						<dt>{t(`apiCoverage.requestFields.${key}`)}</dt>
						<dd className="font-medium text-zinc-200">
							{inventory.summary[key]}
						</dd>
					</div>
				))}
			</dl>
			<Input
				aria-label={t("apiCoverage.requestFields.searchLabel")}
				placeholder={t("apiCoverage.requestFields.searchPlaceholder")}
				value={search}
				className="mt-4 w-full sm:w-80"
				onChange={(event) => {
					setSearch(event.target.value);
					setPage(0);
					setBodyPage(0);
				}}
			/>
			<p className="mt-2">
				{t("apiCoverage.matchCount", { n: filtered.fields.length })}
			</p>
			<div className="mt-2 overflow-x-auto">
				<table
					data-testid="request-fields-table"
					aria-label={t("apiCoverage.requestFields.title")}
					className="w-full min-w-[64rem] text-left text-xs"
				>
					<thead>
						<tr className="border-zinc-800 border-b">
							{columnKeys.map((key) => (
								<th key={key} scope="col" className={cell}>
									{t(`apiCoverage.${key}`)}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map(({ operation, field }) => (
							<tr
								key={`${operation.sdkMethod}:${operation.bodyParameterIndex}:${field.name}`}
								className="border-zinc-900 border-b"
							>
								<td className={`${cell} break-all font-mono`}>
									{operation.httpVerb} {operation.path}
									<div>{operation.sdkMethod}</div>
								</td>
								<td className={`${cell} break-all font-mono`}>
									{operation.bodyModel}
								</td>
								<th scope="row" className={`${cell} break-all font-normal`}>
									<code>{field.name}</code>
									<div className="font-mono text-zinc-400">{field.type}</div>
								</th>
								<td className={cell}>
									{t(
										field.status === "source-assigned"
											? "apiCoverage.requestFields.sourceAssigned"
											: "apiCoverage.unconfirmed",
									)}
								</td>
								<td className={`${cell} break-all`}>
									<div>
										{t("apiCoverage.requestFields.sdkDeclaration")}:{" "}
										<code>{reference(field.sdkEvidence)}</code>
									</div>
									{field.evidence.map((source) => (
										<div key={reference(source)}>
											<code>{reference(source)}</code>
										</div>
									))}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{rows.length === 0 && (
				<p role="status" className="py-3">
					{t("apiCoverage.requestFields.noMatches")}
				</p>
			)}
			<Pages
				count={filtered.fields.length}
				page={safePage}
				onPage={setPage}
				kind="Fields"
			/>
			<section data-testid="request-bodies-unexpanded" className="mt-5">
				<h2 className="font-medium text-zinc-200">
					{t("apiCoverage.requestFields.unexpandedTitle")}
				</h2>
				<p className="mt-2">
					{t("apiCoverage.matchCount", { n: filtered.bodies.length })}
				</p>
				<ul className="mt-2 space-y-2">
					{bodies.map((operation) => (
						<li
							key={operation.sdkMethod}
							className="break-all rounded border border-zinc-800 p-2"
						>
							<code>
								{operation.httpVerb} {operation.path}
							</code>
							<div className="font-mono">{operation.sdkMethod}</div>
							<div>
								{t("apiCoverage.requestFields.model")}:{" "}
								<code>{operation.bodyModel}</code>
							</div>
							<div>
								{t("apiCoverage.requestFields.unexpandedReason")}:{" "}
								{t(
									reasonKeys.get(operation.reason ?? "") ??
										"apiCoverage.requestFields.unknownReason",
								)}
							</div>
						</li>
					))}
				</ul>
				{bodies.length === 0 && (
					<p className="py-3">{t("apiCoverage.requestFields.noUnexpanded")}</p>
				)}
				<Pages
					count={filtered.bodies.length}
					page={safeBodyPage}
					onPage={setBodyPage}
					kind="Bodies"
				/>
			</section>
		</details>
	);
}

function Pages({
	count,
	page,
	onPage,
	kind,
}: {
	count: number;
	page: number;
	onPage: (page: number) => void;
	kind: "Fields" | "Bodies";
}) {
	const { t } = useT();
	const pageCount = Math.max(1, Math.ceil(count / PAGE_SIZE));
	return (
		<div className="mt-3 flex items-center gap-3">
			<button
				type="button"
				className={buttonClass}
				disabled={page === 0}
				aria-label={t(`apiCoverage.requestFields.previous${kind}`)}
				onClick={() => onPage(page - 1)}
			>
				{t("apiCoverage.prev")}
			</button>
			<span>
				{page + 1} / {pageCount}
			</span>
			<button
				type="button"
				className={buttonClass}
				disabled={page + 1 >= pageCount}
				aria-label={t(`apiCoverage.requestFields.next${kind}`)}
				onClick={() => onPage(page + 1)}
			>
				{t("apiCoverage.next")}
			</button>
		</div>
	);
}
