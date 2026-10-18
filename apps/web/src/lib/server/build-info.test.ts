import { afterEach, describe, expect, it, vi } from "vitest";
import { version } from "../../../package.json";
import { getWebBuildInfo } from "./build-info";

afterEach(() => vi.unstubAllEnvs());

describe("this Web build's public information", () => {
	it("returns only bundled version and exact runtime commit", () => {
		vi.stubEnv("BITOVP_COMMIT", "a".repeat(40));
		vi.stubEnv("DEPLOYMENT_PROFILE", "UNRESTRICTED");
		vi.stubEnv("MASTER_KEY", "must-not-reach-client");
		expect(getWebBuildInfo()).toEqual({
			version,
			commit: "a".repeat(40),
		});
	});

	it.each([
		undefined,
		"",
		"unknown",
		"a".repeat(39),
		"a".repeat(41),
		"g".repeat(40),
		`${"a".repeat(40)}\n`,
		` ${"a".repeat(40)}`,
	])("does not guess or normalize malformed commit %j", (commit) => {
		vi.stubEnv("BITOVP_COMMIT", commit);
		expect(getWebBuildInfo().commit).toBeNull();
	});

	it("reads runtime values per call, not once at module import", () => {
		vi.stubEnv("BITOVP_COMMIT", "A".repeat(40));
		expect(getWebBuildInfo().commit).toBe("A".repeat(40));
		vi.stubEnv("BITOVP_COMMIT", "b".repeat(40));
		expect(getWebBuildInfo()).toEqual({
			version,
			commit: "b".repeat(40),
		});
	});
});
