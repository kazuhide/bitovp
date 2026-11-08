import { describe, expect, it } from "vitest";
import { readLocalSemanticConfiguration } from "./local-semantic-config";

const configured = {
	BITOVP_LOCAL_SEMANTIC_ENABLED: "1",
	BITOVP_LOCAL_SEMANTIC_GATEWAY_URL: "https://192.168.68.62:11437",
	BITOVP_LOCAL_SEMANTIC_GATEWAY_TOKEN: "private-test-value-".repeat(3),
	BITOVP_LOCAL_SEMANTIC_CA_FILE: "/run/bitovp-local-semantic/gateway-ca.pem",
	BITOVP_LOCAL_SEMANTIC_PROFILE: "amd",
	BITOVP_LOCAL_SEMANTIC_CONFIG_ID: "61ac833f-0aa4-4000-a000-000000000001",
};
describe("explicit local semantic runtime configuration", () => {
	it("stays disabled even if a token/URL is present without opt-in", () => {
		expect(
			readLocalSemanticConfiguration({
				...configured,
				BITOVP_LOCAL_SEMANTIC_ENABLED: undefined,
			}),
		).toBeUndefined();
	});
	it("uses the operator's fixed profile and configuration identity", () => {
		expect(readLocalSemanticConfiguration(configured)).toMatchObject({
			profile: "amd",
			configId: configured.BITOVP_LOCAL_SEMANTIC_CONFIG_ID,
		});
	});
	it.each([
		{ BITOVP_LOCAL_SEMANTIC_GATEWAY_URL: "http://192.168.68.62:11437" },
		{ BITOVP_LOCAL_SEMANTIC_GATEWAY_URL: "https://a:b@192.168.68.62" },
		{ BITOVP_LOCAL_SEMANTIC_GATEWAY_URL: "https://192.168.68.62/api" },
		{
			BITOVP_LOCAL_SEMANTIC_GATEWAY_URL: "https://192.168.68.62/?model=remote",
		},
		{ BITOVP_LOCAL_SEMANTIC_PROFILE: "cpu" },
		{ BITOVP_LOCAL_SEMANTIC_GATEWAY_TOKEN: undefined },
		{ BITOVP_LOCAL_SEMANTIC_CONFIG_ID: "not-a-uuid" },
	])("rejects incomplete or unsafe connection settings without leaking values", (change) => {
		expect(() =>
			readLocalSemanticConfiguration({ ...configured, ...change }),
		).toThrowError("LOCAL_SEMANTIC_CONFIG_INVALID");
	});
});
