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
		expect(await response.json()).toEqual({
			sdk: {
				installed: installedSdkVersion,
				surveyed: current.provenance.sdkVersion,
				stale: installedSdkVersion !== current.provenance.sdkVersion,
			},
			current,
			parameterSnapshot: {
				surveyedSdk: summary.surveyedSdk,
				surveyedAt: summary.surveyedAt,
				surveyedAtRepo: summary.surveyedAtRepo,
				paramTotals: summary.paramTotals,
				paramFamilies: summary.paramFamilies,
				fields: summary.headline.paramFields,
				operatorReachable: summary.headline.paramOperatorReachable,
			},
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it("retains the proxy VIEWER read floor", () => {
		expect(
			evaluateRole("VIEWER", "/api/settings/api-coverage", "GET"),
		).toMatchObject({ allowed: true, minRole: "VIEWER" });
	});
});
