import { afterEach, expect, it, vi } from "vitest";
import { createBitmovinSdkOps, type Destination } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

it.each([
	["hls", "missing-acl"],
	["dash", "public-acl"],
	["smooth", "missing-output"],
	["hls", "second-mirror-public"],
	["hls", "exact"],
	["hls", "non-role"],
] as const)("uses the %s manual manifest's role ACL proof for %s", async (family, observation) => {
	const twoMirrors = observation === "second-mirror-public";
	const mirrorIds = twoMirrors
		? ["role-output", "second-role"]
		: ["role-output"];
	const destination: Destination = {
		outputId: "primary",
		outputPath: "main/",
		acl: "PUBLIC_READ",
		mirrorOutputIds: mirrorIds,
		mirrorOutputPaths: twoMirrors ? ["mirror/", "second/"] : ["mirror/"],
		mirrorOutputAcls: mirrorIds.map(() => "PRIVATE"),
		...(observation !== "non-role" ? { roleOutputIds: mirrorIds } : {}),
	};
	const mirror = {
		outputId: "role-output",
		outputPath: "mirror/",
		...(observation === "public-acl"
			? { acl: [{ permission: "PUBLIC_READ" }] }
			: observation === "exact" || twoMirrors
				? { acl: [{ permission: "PRIVATE" }] }
				: {}),
	};
	const identity =
		family === "smooth"
			? { serverManifestName: "stream.ism", clientManifestName: "stream.ismc" }
			: { manifestName: family === "hls" ? "stream.m3u8" : "stream.mpd" };
	const path = `/v1/encoding/manifests/${family}`;
	const creates: Record<string, unknown>[] = [];
	const wire = vi.fn(async (raw: string, init: RequestInit) => {
		const url = new URL(raw);
		expect(url.pathname).toBe(path);
		if (init.method === "GET")
			return Response.json({
				data: {
					result: {
						items: [
							{
								id: "older",
								...identity,
								outputs: [
									{ outputId: "primary", outputPath: "main/" },
									...(observation === "missing-output" ? [] : [mirror]),
									...(twoMirrors
										? [
												{
													outputId: "second-role",
													outputPath: "second/",
													acl: [{ permission: "PUBLIC_READ" }],
												},
											]
										: []),
								],
							},
						],
					},
				},
			});
		expect(init.method).toBe("POST");
		creates.push(JSON.parse(String(init.body)));
		return Response.json({ data: { result: { id: "fresh" } } });
	});
	vi.stubGlobal("fetch", wire);
	const sdk = createBitmovinSdkOps(
		{ apiKey: "synthetic-only" },
		async () => {},
	);
	const params = { name: "Manifest", destination };
	const id =
		family === "smooth"
			? await sdk.createSmoothManifest({
					...params,
					serverManifestName: "stream.ism",
					clientManifestName: "stream.ismc",
				})
			: family === "dash"
				? await sdk.createDashManifest({
						...params,
						manifestName: "stream.mpd",
					})
				: await sdk.createHlsManifest({
						...params,
						manifestName: "stream.m3u8",
					});
	if (observation === "exact" || observation === "non-role") {
		expect(id).toBe("older");
		expect(creates).toHaveLength(0);
	} else {
		expect(id).toBe("fresh");
		expect(creates).toEqual([
			expect.objectContaining({
				outputs: expect.arrayContaining([
					{
						outputId: "role-output",
						outputPath: "mirror/",
						acl: [{ permission: "PRIVATE" }],
					},
					...(twoMirrors
						? [
								{
									outputId: "second-role",
									outputPath: "second/",
									acl: [{ permission: "PRIVATE" }],
								},
							]
						: []),
				]),
			}),
		]);
	}
});
