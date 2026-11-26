import { version as installedSdkVersion } from "@bitmovin/api-sdk/package.json";
import { afterEach, describe, expect, it, vi } from "vitest";
import current from "@/data/api-coverage/current.json";
import summary from "@/data/api-coverage/summary.json";
import { evaluateRole } from "@/lib/auth/roles";
import { GET } from "./route";

afterEach(() => vi.unstubAllGlobals());

describe("GET /api/settings/api-coverage", () => {
	it("returns current source observations separately from historical parameters without network access", async () => {
		const fetch = vi.fn(() => {
			throw new Error("Unexpected network access");
		});
		vi.stubGlobal("fetch", fetch);
		const response = await GET(
			new Request("http://test/api/settings/api-coverage"),
		);
		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data).toMatchObject({
			sdk: {
				installed: installedSdkVersion,
				surveyed: current.provenance.sdkVersion,
				stale: installedSdkVersion !== current.provenance.sdkVersion,
			},
			current,
			parameterSnapshot: {
				surveyedSdk: summary.surveyedSdk,
				surveyedAt: summary.surveyedAt,
				paramTotals: summary.paramTotals,
				paramFamilies: summary.paramFamilies,
				fields: summary.headline.paramFields,
				operatorReachable: summary.headline.paramOperatorReachable,
			},
		});
		const { operations, summary: ledgerSummary } = data.operationLedger;
		expect(Object.keys(operations)).toHaveLength(
			current.summary.totalOperations,
		);
		expect(ledgerSummary).toMatchObject({
			total: current.summary.totalOperations,
			providerVerified: 0,
		});
		expect(operations["encoding.errorDefinitions.list"]).toMatchObject({
			reachability: "app-confirmed",
			contract: "transport-confirmed",
			provider: "unverified",
			proof: { scope: "settings" },
		});
		expect(operations["encoding.configurations.video.h264.create"]).toEqual({
			reachability: "unreviewed",
			contract: "unverified",
			provider: "unverified",
			proof: null,
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it("exports matching ledger rows across the entire canonical denominator", async () => {
		const response = await GET(
			new Request("http://test/api/settings/api-coverage?format=csv"),
		);
		expect(response.headers.get("content-type")).toBe(
			"text/csv; charset=utf-8",
		);
		expect(response.headers.get("content-disposition")).toBe(
			'attachment; filename="encoding-api-coverage.csv"',
		);
		const csv = await response.text();
		expect(csv.trimEnd().split("\r\n")).toHaveLength(
			current.summary.totalOperations + 1,
		);
		expect(csv).toContain(
			'"source-confirmed","unreviewed","unverified","unverified"',
		);
	});

	it("intersects family, source, reachability, workflow scope and search in the export", async () => {
		const response = await GET(
			new Request(
				"http://test/api/settings/api-coverage?format=csv&family=errorDefinitions&source=source-confirmed&reachability=app-confirmed&scope=settings&q=GET%20%2Fencoding%2Ferror-definitions",
			),
		);
		const [header, row, ...others] = (await response.text())
			.trimEnd()
			.split("\r\n");
		expect(others).toEqual([]);
		expect(header).toContain(
			'"Source evidence","Reachability","SDK transport","Provider"',
		);
		expect(row).toContain('"encoding.errorDefinitions.list"');
		expect(row).toContain(
			'"app-confirmed","transport-confirmed","unverified","settings"',
		);
		expect(row).toContain('"GET /api/encoding-error-definitions"');
		expect(row).toContain("route.sdk.test.ts");
	});

	it("retains the proxy VIEWER read floor", () => {
		expect(
			evaluateRole("VIEWER", "/api/settings/api-coverage", "GET"),
		).toMatchObject({ allowed: true, minRole: "VIEWER" });
	});
});
