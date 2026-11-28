import { afterEach, expect, it, vi } from "vitest";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

it("recovers the owned default Smooth manifest by encoding, both filenames, and request identity", async () => {
	const root = "/v1/encoding/manifests/smooth";
	const seed = {
		encodingId: "fixture-encoding",
		serverManifestName: "stream.ism",
		clientManifestName: "stream.ismc",
		name: "Default Smooth",
		destination: { outputId: "fixture-output", outputPath: "smooth/" },
	};
	const mock = vi.fn();
	let created: { id: string; customData?: unknown } | undefined;
	const ok = (result: unknown) =>
		Response.json({ status: "SUCCESS", data: { result } });
	vi.stubGlobal("fetch", mock);
	mock.mockImplementation(async (url: string, init: RequestInit) => {
		const address = new URL(url);
		if (init.method === "GET" && address.pathname === root) {
			expect(address.searchParams.get("encodingId")).toBe(seed.encodingId);
			return ok({
				items: created
					? [
							{ ...created, id: "other", clientManifestName: "other.ismc" },
							created,
						]
					: [],
			});
		}
		if (init.method === "POST" && address.pathname === `${root}/default`) {
			created = { id: "created", ...JSON.parse(String(init.body)) };
			return ok(created);
		}
		if (
			init.method === "GET" &&
			address.pathname === `${root}/created/customData`
		)
			return ok({ customData: created?.customData });
		throw new Error("Unexpected mock SDK request");
	});
	const sdk = createBitmovinSdkOps(
		{
			apiKey: "fixture",
			tenantOrgId: "fixture-organization",
			stamp: { jobId: "fixture-job", currentStep: () => "manifest:smooth" },
		},
		async () => {},
	);
	expect(await sdk.createSmoothManifest(seed)).toBe("created");
	expect(await sdk.createSmoothManifest(seed)).toBe("created");
	await expect(
		sdk.createSmoothManifest({ ...seed, name: "Changed" }),
	).rejects.toThrow("request identity conflict");
	expect(
		mock.mock.calls.filter(([, init]) => init.method === "POST"),
	).toHaveLength(1);
});
