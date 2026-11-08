import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LOCAL_CAPTION_CONTEXT_POLICY_FINGERPRINT,
	PLAMO_CAPTION_TEMPLATE_HASH,
} from "@bitovp/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isClipEditingAvailable } from "./library-editing-feature";

const readiness = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("./local-semantic-readiness", () => ({
	readWorkerClipAvailability: readiness.read,
}));
beforeEach(() => {
	readiness.read.mockReset().mockResolvedValue(true);
	requestContext.mockReset().mockResolvedValue({ tenant: { organizationId } });
});

const organizationId = "22222222-2222-4222-8222-222222222222";
const requestContext = vi.hoisted(() => vi.fn());
vi.mock("./context", () => ({ getServerContext: requestContext }));
const valid = {
	BITOVP_LOCAL_SEMANTIC_ENABLED: "1",
	BITOVP_LOCAL_SEMANTIC_GATEWAY_URL: "https://fixture.invalid:11437",
	BITOVP_LOCAL_SEMANTIC_GATEWAY_TOKEN: "test-fixture-token-".repeat(3),
	BITOVP_LOCAL_SEMANTIC_CA_FILE: "/unused/test-ca.pem",
	BITOVP_LOCAL_SEMANTIC_PROFILE: "nvidia",
	BITOVP_LOCAL_SEMANTIC_CONFIG_ID: "11111111-1111-4111-8111-111111111111",
};
afterEach(() => vi.unstubAllEnvs());
describe("server-only clip editing availability", () => {
	it("uses only the authenticated request organization for the Gateway token's scoped readiness", async () => {
		readiness.read.mockImplementation(
			async (_config, authorizedOrganization) =>
				authorizedOrganization === organizationId,
		);
		expect(await isClipEditingAvailable(valid)).toBe(true);
		expect(readiness.read.mock.calls[0]?.[1]).toBe(organizationId);
		requestContext.mockResolvedValueOnce({
			tenant: { organizationId: "33333333-3333-4333-8333-333333333333" },
		});
		expect(await isClipEditingAvailable(valid)).toBe(false);
		requestContext.mockRejectedValueOnce(new Error("unauthenticated"));
		readiness.read.mockClear();
		expect(await isClipEditingAvailable(valid)).toBe(false);
		expect(readiness.read).not.toHaveBeenCalled();
	});
	it("rejects configured but unreachable, CPU-only or unknown GPU evidence", async () => {
		readiness.read.mockResolvedValue(false);
		expect(await isClipEditingAvailable(valid)).toBe(false);
	});
	it.each([
		{ BITOVP_LOCAL_CAPTION_PROVIDER: "PLAMO" },
		{
			BITOVP_LOCAL_CAPTION_PROVIDER: "PLAMO",
			BITOVP_LOCAL_CAPTION_MANIFEST_FILE: "/not-installed/fixture.json",
		},
		{ BITOVP_LOCAL_CAPTION_PROVIDER: "unknown" },
		{
			BITOVP_LOCAL_CAPTION_PROVIDER: "QWEN",
			BITOVP_LOCAL_CAPTION_MANIFEST_FILE: "/not-installed/fixture.json",
		},
	])("fails closed for missing or invalid explicit caption provider metadata %#", async (caption) => {
		expect(await isClipEditingAvailable({ ...valid, ...caption })).toBe(false);
	});
	it("accepts public installed metadata for the selected profile only, with worker-verified GPU availability", async () => {
		const dir = mkdtempSync(join(tmpdir(), "caption-gate-")),
			file = join(dir, "public.json");
		try {
			writeFileSync(
				file,
				JSON.stringify({
					version: "bitovp-plamo-installed-manifest-v1",
					configId: valid.BITOVP_LOCAL_SEMANTIC_CONFIG_ID,
					modelId: "pfnet/plamo-3-translate-31b",
					sourceRevision: "01eac57bf80ef8114decd998f8f3a803ba795557",
					weightSha256: "a".repeat(64),
					weightBytes: 1234,
					quantization: "Q8_0",
					promptTemplateHash: PLAMO_CAPTION_TEMPLATE_HASH,
					contextPolicyFingerprint: LOCAL_CAPTION_CONTEXT_POLICY_FINGERPRINT,
					runtimes: {
						nvidia: {
							sourceRevision: "a".repeat(40),
							binarySha256: "b".repeat(64),
						},
					},
				}),
				{ mode: 0o644 },
			);
			const env = {
				...valid,
				BITOVP_LOCAL_CAPTION_PROVIDER: "PLAMO",
				BITOVP_LOCAL_CAPTION_MANIFEST_FILE: file,
			};
			expect(await isClipEditingAvailable(env)).toBe(true);
			expect(
				await isClipEditingAvailable({
					...env,
					BITOVP_LOCAL_SEMANTIC_PROFILE: "amd",
				}),
			).toBe(false);
			writeFileSync(file, "{}");
			expect(await isClipEditingAvailable(env)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it.each([
		{},
		{ BITOVP_LOCAL_SEMANTIC_ENABLED: "1" },
		{ ...valid, BITOVP_LOCAL_SEMANTIC_ENABLED: "0" },
		{ ...valid, BITOVP_LOCAL_SEMANTIC_ENABLED: "true" },
	])("is disabled for absent, partial or non-enabled settings %#", async (env) =>
		expect(await isClipEditingAvailable(env)).toBe(false));
	it.each([
		["BITOVP_LOCAL_SEMANTIC_GATEWAY_URL", "http://fixture.invalid"],
		[
			"BITOVP_LOCAL_SEMANTIC_GATEWAY_URL",
			"https://user:private@fixture.invalid",
		],
		["BITOVP_LOCAL_SEMANTIC_GATEWAY_TOKEN", "invalid-private-value"],
		["BITOVP_LOCAL_SEMANTIC_CA_FILE", "relative.pem"],
		["BITOVP_LOCAL_SEMANTIC_PROFILE", "external-provider"],
		["BITOVP_LOCAL_SEMANTIC_CONFIG_ID", "invalid-private-identity"],
	])("fails closed without throwing or logging config for invalid %s", async (key, value) => {
		const log = vi.spyOn(console, "error").mockImplementation(async () => {});
		expect(await isClipEditingAvailable({ ...valid, [key]: value })).toBe(
			false,
		);
		expect(log).not.toHaveBeenCalled();
		log.mockRestore();
	});
	it.each([
		"amd",
		"nvidia",
	])("accepts a validated local %s profile with worker-verified GPU availability", async (profile) =>
		expect(
			await isClipEditingAvailable({
				...valid,
				BITOVP_LOCAL_SEMANTIC_PROFILE: profile,
			}),
		).toBe(true));
	it("uses current process settings each time rather than retaining stale availability", async () => {
		for (const [key, value] of Object.entries(valid)) vi.stubEnv(key, value);
		expect(await isClipEditingAvailable()).toBe(true);
		vi.stubEnv("BITOVP_LOCAL_SEMANTIC_ENABLED", "0");
		expect(await isClipEditingAvailable()).toBe(false);
	});
});
