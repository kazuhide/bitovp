import { afterEach, beforeEach, vi } from "vitest";
import * as readiness from "@/lib/server/local-semantic-readiness";

/** Opt in only suites that exercise an enabled editing environment. No I/O. */
export function enableClipEditingForTests() {
	let restoreAvailability = () => {};
	beforeEach(() => {
		// These route suites test their own authorization/data boundaries. GPU
		// admission has dedicated fail-closed tests with real registry fixtures.
		const availability = vi
			.spyOn(readiness, "readWorkerClipAvailability")
			.mockResolvedValue(true);
		restoreAvailability = () => availability.mockRestore();
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
	afterEach(() => {
		restoreAvailability();
		vi.unstubAllEnvs();
	});
}
