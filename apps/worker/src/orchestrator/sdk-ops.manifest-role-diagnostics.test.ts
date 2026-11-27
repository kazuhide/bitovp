import { inspect } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { createBitmovinSdkOps } from "./sdk-ops";

const role = "arn:aws:iam::111122223333:role/manifest-diagnostic-fixture";
const external = "fixture-global-role-external-id";
const providerFailure = () =>
	Response.json(
		{
			status: "ERROR",
			requestId: external,
			data: {
				code: 2104,
				message: `Role ${role} reported ${external}`,
				developerMessage: role,
			},
		},
		{ status: 403 },
	);

const destination = { outputId: "fixture-output", outputPath: "manifest/" };
const resultResponse = (result: object) => Response.json({ data: { result } });

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it.each([
	["hls", "provider", true],
	["dash", "provider", true],
	["smooth", "provider", true],
	["hls", "transport", true],
	["hls", "provider", false],
] as const)("projects manual %s manifest %s failures with protection %s", async (kind, failure, protectedJob) => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const wire = vi.fn(async (raw: string, init: RequestInit) => {
		expect(new URL(raw).pathname).toBe(`/v1/encoding/manifests/${kind}`);
		if (init.method === "GET") {
			if (failure === "transport")
				throw new TypeError(`Connection failed for ${role} ${external}`);
			return providerFailure();
		}
		expect(init.method).toBe("POST");
		return resultResponse({ id: "manifest-created" });
	});
	vi.stubGlobal("fetch", wire);
	const sdk = createBitmovinSdkOps(
		{
			apiKey: "fixture-only",
			...(protectedJob ? { withholdProviderDetails: true } : {}),
		},
		async () => {},
	);
	const base = { name: "Fixture manifest", destination };
	const result =
		kind === "hls"
			? sdk.createHlsManifest({ ...base, manifestName: "stream.m3u8" })
			: kind === "dash"
				? sdk.createDashManifest({ ...base, manifestName: "stream.mpd" })
				: sdk.createSmoothManifest({
						...base,
						serverManifestName: "stream.ism",
						clientManifestName: "stream.ismc",
					});
	await expect(result).resolves.toBe("manifest-created");
	const diagnostics = inspect(warn.mock.calls);
	expect(diagnostics).toContain("creating without adoption");
	if (protectedJob) {
		expect(diagnostics).not.toContain(role);
		expect(diagnostics).not.toContain(external);
	} else {
		expect(diagnostics).toContain(role);
	}
});

it.each([
	["hls", "list"],
	["hls", "custom-data"],
	["dash", "list"],
	["dash", "custom-data"],
] as const)("keeps default %s manifest %s lookup evidence private", async (kind, failure) => {
	const manifestName = kind === "hls" ? "stream.m3u8" : "stream.mpd";
	const path = `/v1/encoding/manifests/${kind}`;
	const wire = vi.fn(async (raw: string, init: RequestInit) => {
		const url = new URL(raw);
		if (init.method !== "GET")
			throw new Error("Unverified lookup must not send CREATE");
		if (url.pathname === path) {
			expect(url.searchParams.get("encodingId")).toBe("fixture-encoding");
			return failure === "list"
				? providerFailure()
				: resultResponse({
						items: [
							{ id: "fixture-manifest", manifestName, outputs: [destination] },
						],
					});
		}
		expect(url.pathname).toBe(`${path}/fixture-manifest/customData`);
		return providerFailure();
	});
	vi.stubGlobal("fetch", wire);
	const sdk = createBitmovinSdkOps(
		{
			apiKey: "fixture-only",
			withholdProviderDetails: true,
			stamp: { jobId: "fixture-job", currentStep: () => "manifest:fixture" },
		},
		async () => {},
	);
	const params = {
		encodingId: "fixture-encoding",
		name: "Fixture manifest",
		manifestName,
		destination,
	};
	const attempt =
		kind === "hls"
			? sdk.createDefaultHlsManifest(params)
			: sdk.createDefaultDashManifest(params);
	const error = await attempt.catch((reason: unknown) => reason);
	expect(error).toBeInstanceOf(Error);
	expect((error as Error).message).toMatch(
		/manifest identity lookup failed.*2104/,
	);
	const serialized = inspect(error, { depth: 6 });
	expect(serialized).not.toContain(role);
	expect(serialized).not.toContain(external);
	expect(wire.mock.calls.map(([, init]) => init.method)).toEqual(
		failure === "list" ? ["GET"] : ["GET", "GET"],
	);
});
