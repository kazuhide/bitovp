import { afterEach, beforeEach, vi } from "vitest";

/** Opt in only suites that exercise an enabled editing environment. No I/O. */
export function enableClipEditingForTests() {
	beforeEach(() => {
		const settings = {
			ENABLED: "1",
			GATEWAY_URL: "https://127.0.0.1:11437",
			GATEWAY_TOKEN: "local-test-fixture-token-".repeat(3),
			CA_FILE: "/test/bitovp/gateway-ca.pem",
			PROFILE: "nvidia",
			CONFIG_ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		};
		for (const [name, value] of Object.entries(settings))
			vi.stubEnv(`BITOVP_LOCAL_SEMANTIC_${name}`, value);
	});
	afterEach(() => vi.unstubAllEnvs());
}
