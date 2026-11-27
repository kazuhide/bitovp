import { version as installedSdkVersion } from "@bitmovin/api-sdk/package.json";
import { NextResponse } from "next/server";
import current from "@/data/api-coverage/current.json";
import audit from "@/data/api-coverage/implementation-audit.json";
import summary from "@/data/api-coverage/summary.json";
import {
	buildOperationLedger,
	filterCoverageOperations,
	operationEvidence,
} from "@/lib/api-coverage/operation-ledger";

const operationLedger = buildOperationLedger(
	current,
	audit,
	installedSdkVersion,
);

function csvRow(values: string[]) {
	return values
		.map((value) => {
			const safe = /^[\s]*[=+@-]/.test(value) ? `'${value}` : value;
			return `"${safe.replaceAll('"', '""')}"`;
		})
		.join(",");
}

function csvDownload(query: URLSearchParams) {
	const endpoints = filterCoverageOperations(
		current.endpoints,
		operationLedger,
		{
			family: query.get("family") ?? "",
			source: query.get("source") ?? "",
			reachability: query.get("reachability") ?? "",
			scope: query.get("scope") ?? "",
			q: query.get("q") ?? "",
		},
	);
	const csv = [
		csvRow([
			"Surveyed SDK",
			"Family",
			"SDK method",
			"HTTP method",
			"Path",
			"Source evidence",
			"Reachability",
			"SDK transport",
			"Provider",
			"Scope",
			"Workflow",
			"App route",
			"Route anchor",
			"SDK call file",
			"SDK call anchor",
			"Contract test file",
			"Contract test anchor",
			"Source locations",
		]),
		...endpoints.map((row) => {
			const { reachability, contract, provider, proof } = operationEvidence(
				operationLedger,
				row.sdkMethod,
			);
			return csvRow([
				operationLedger.sdkVersion,
				row.family,
				row.sdkMethod,
				row.httpVerb,
				row.path,
				row.status,
				reachability,
				contract,
				provider,
				proof?.scope ?? "",
				proof?.scenario ?? "",
				proof ? `${proof.entrypoint.httpVerb} ${proof.entrypoint.path}` : "",
				proof?.entrypoint.anchor ?? "",
				proof?.transport.file ?? "",
				proof?.transport.anchor ?? "",
				proof?.contractTest.file ?? "",
				proof?.contractTest.anchor ?? "",
				row.evidence.map(({ file, line }) => `${file}:${line}`).join(" | "),
			]);
		}),
	].join("\r\n");
	return new NextResponse(`${csv}\r\n`, {
		headers: {
			"content-type": "text/csv; charset=utf-8",
			"content-disposition": 'attachment; filename="encoding-api-coverage.csv"',
		},
	});
}

/** Read-only bundled evidence with the proxy's VIEWER read floor. */
export async function GET(request: Request) {
	const query = new URL(request.url).searchParams;
	if (query.get("format") === "csv") return csvDownload(query);
	return NextResponse.json({
		sdk: {
			installed: installedSdkVersion,
			surveyed: current.provenance.sdkVersion,
			stale: installedSdkVersion !== current.provenance.sdkVersion,
		},
		current,
		operationLedger,
		parameterSnapshot: {
			surveyedSdk: summary.surveyedSdk,
			surveyedAt: summary.surveyedAt,
			paramTotals: summary.paramTotals,
			paramFamilies: summary.paramFamilies,
			fields: summary.headline.paramFields,
			operatorReachable: summary.headline.paramOperatorReachable,
		},
	});
}
