import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { liveChannelPlanSchema } from "../live/schema";
import { encodingPlanSchema } from "../plan/schema";
import {
	liveManifestPlaybackLinks,
	manifestPlaybackLinks,
	planOutputBucket,
} from "./manifest-links";

/**
 * Manifest-level derivation, over real plan fixtures.
 *
 * These assertions moved here from `apps/web/src/app/vod/jobs/[id]` when the
 * derivation did: it is one helper now, shared by the job detail view, the
 * live channel panel and the storage browser, so it is tested where it lives.
 */

const fixturesDir = join(__dirname, "../plan/__fixtures__");

function loadPlan(name: string) {
	return encodingPlanSchema.parse(
		JSON.parse(readFileSync(join(fixturesDir, `${name}.plan.json`), "utf8")),
	);
}

const CREDENTIAL_ID = "00000000-0000-4000-8000-000000000002";
const awsCredential = [
	{
		id: CREDENTIAL_ID,
		provider: "AWS_S3" as const,
		config: { region: "ap-northeast-1" },
	},
];

describe("manifestPlaybackLinks", () => {
	it("builds public S3 playback URLs from the credential region", () => {
		const links = manifestPlaybackLinks(
			loadPlan("fixed-bitrate-hls-on-aws"),
			awsCredential,
		);
		expect(links).toHaveLength(1);
		expect(links[0]?.url).toBe(
			"https://sample-output-bucket.s3.ap-northeast-1.amazonaws.com/output/h264-aac-fmp4-fixed-bitrate-hls-aws/stream.m3u8",
		);
		expect(links[0]?.via).toBe("derived");
		expect(links[0]?.reason).toBeUndefined();
	});

	it("degrades to path-only when the credential is unknown/deleted", () => {
		const links = manifestPlaybackLinks(
			loadPlan("fixed-bitrate-hls-on-aws"),
			[],
		);
		expect(links[0]?.url).toBeNull();
		expect(links[0]?.path).toContain("stream.m3u8");
		expect(links[0]?.reason?.code).toBe("NO_CREDENTIAL");
	});

	it("uses path-style URLs for dotted bucket names", () => {
		const plan = loadPlan("fixed-bitrate-hls-on-aws");
		const output = plan.outputs[0];
		if (output?.kind !== "S3") {
			throw new Error("fixture output missing");
		}
		output.bucket = "cdn.example.com";
		const links = manifestPlaybackLinks(plan, awsCredential);
		expect(links[0]?.url).toBe(
			"https://s3.ap-northeast-1.amazonaws.com/cdn.example.com/output/h264-aac-fmp4-fixed-bitrate-hls-aws/stream.m3u8",
		);
	});

	it("returns path-only links for SFTP outputs, and says why", () => {
		const links = manifestPlaybackLinks(
			loadPlan("dash-hls-sftp-output-just-in-time"),
			awsCredential,
		);
		expect(links).toHaveLength(2);
		for (const link of links) {
			expect(link.url).toBeNull();
			expect(link.path).toContain("/content/encoding_test/");
			// The SFTP credential is not in the list either, so what the panel
			// must not do is claim SFTP is playable once it is.
			expect(link.reason?.code).toBe("NO_CREDENTIAL");
		}
		const withSftp = manifestPlaybackLinks(
			loadPlan("dash-hls-sftp-output-just-in-time"),
			[
				{
					id: links.length > 0 ? sftpCredentialId() : "",
					provider: "SFTP",
					config: { host: "sftp.example.com", username: "u" },
				},
			],
		);
		for (const link of withSftp) {
			expect(link.url).toBeNull();
			expect(link.reason).toEqual({ code: "NO_PATTERN", provider: "SFTP" });
		}
	});

	it("keys the URL shape off the CREDENTIAL, not the plan output kind", () => {
		/**
		 * The whole reason this helper replaced the S3-only predecessor. One
		 * `GENERIC_S3` output is Akamai, OCI or a MinIO depending only on which
		 * credential it points at, and `output.kind` cannot tell them apart —
		 * so the old `output.kind === "S3"` test derived nothing for any of them.
		 */
		const plan = loadPlan("generic-s3-akamai-io");
		const output = plan.outputs.find((o) => o.kind === "GENERIC_S3");
		expect(output, "fixture must carry a GENERIC_S3 output").toBeDefined();
		if (output?.kind !== "GENERIC_S3") {
			throw new Error("unreachable");
		}
		const akamai = manifestPlaybackLinks(plan, [
			{
				id: output.credentialId,
				provider: "AKAMAI_OBJECT_STORAGE",
				config: { host: "jp-osa-1.linodeobjects.com" },
			},
		]);
		const oci = manifestPlaybackLinks(plan, [
			{
				id: output.credentialId,
				provider: "OCI_OBJECT_STORAGE",
				config: { namespace: "ns1", region: "ap-osaka-1" },
			},
		]);
		expect(akamai[0]?.url).toContain("jp-osa-1.linodeobjects.com/");
		expect(akamai[0]?.url).toContain(`/${output.bucket}/`);
		// Same plan, same output, different credential → deliberately no URL.
		expect(oci[0]?.url).toBeNull();
		expect(oci[0]?.reason).toEqual({
			code: "NO_PATTERN",
			provider: "OCI_OBJECT_STORAGE",
		});
	});

	it("carries the manifest identity through unchanged", () => {
		const plan = loadPlan("fixed-bitrate-hls-on-aws");
		const links = manifestPlaybackLinks(plan, awsCredential);
		expect(links[0]?.key).toBe(plan.manifests[0]?.key);
		expect(links[0]?.kind).toBe("HLS");
		expect(links[0]?.label).toBe(plan.manifests[0]?.name);
	});
});

/** The SFTP fixture's output credential id, read from the fixture itself. */
function sftpCredentialId(): string {
	const plan = loadPlan("dash-hls-sftp-output-just-in-time");
	const sftp = plan.outputs.find((o) => o.kind === "SFTP");
	if (!sftp) {
		throw new Error("fixture has no SFTP output");
	}
	return sftp.credentialId;
}

describe("planOutputBucket", () => {
	it("reads bucket or container per output kind", () => {
		const bases = { key: "o", credentialId: CREDENTIAL_ID, name: "n" };
		expect(planOutputBucket({ ...bases, kind: "S3", bucket: "b" })).toBe("b");
		expect(
			planOutputBucket({ ...bases, kind: "GENERIC_S3", bucket: "b" }),
		).toBe("b");
		expect(planOutputBucket({ ...bases, kind: "GCS", bucket: "b" })).toBe("b");
		expect(
			planOutputBucket({ ...bases, kind: "GCS_SERVICE_ACCOUNT", bucket: "b" }),
		).toBe("b");
		// Azure names it `container`, matching the SDK and the plan schema.
		expect(planOutputBucket({ ...bases, kind: "AZURE", container: "c" })).toBe(
			"c",
		);
		expect(planOutputBucket({ ...bases, kind: "SFTP" })).toBeNull();
	});
});

describe("destination paths are directories, not prefixes", () => {
	/**
	 * `destinationSchema` does not force a trailing slash, and the LIVE wizard
	 * does not produce one — every live fixture's path is `output/live-…` with no
	 * slash. Concatenation there yields `output/live-rtmp-simplestream.m3u8`.
	 *
	 * Every VOD fixture happens to end in `/`, which is why neither this builder
	 * nor `verify/expected.ts` showed it. `plan/compiler.ts` has carried
	 * `joinFilePath` for precisely this reason since the first single-file
	 * reference, and `verify/expected-live.ts` normalised for it — three places
	 * that knew, two that did not.
	 */
	it("joins a slash-less VOD path with a separator", () => {
		const plan = loadPlan("fixed-bitrate-hls-on-aws");
		const manifest = plan.manifests[0];
		if (!manifest) {
			throw new Error("fixture has no manifest");
		}
		manifest.destination.path = "output/no-slash";
		const links = manifestPlaybackLinks(plan, awsCredential);
		expect(links[0]?.path).toBe("output/no-slash/stream.m3u8");
		expect(links[0]?.url).toBe(
			"https://sample-output-bucket.s3.ap-northeast-1.amazonaws.com/output/no-slash/stream.m3u8",
		);
	});

	it("does not double the separator when the path already has one", () => {
		const links = manifestPlaybackLinks(
			loadPlan("fixed-bitrate-hls-on-aws"),
			awsCredential,
		);
		expect(links[0]?.path).not.toContain("//");
		expect(links[0]?.url).toMatch(/amazonaws\.com\/output\//);
	});

	it("puts a manifest at the bucket root when the path is empty", () => {
		const plan = loadPlan("fixed-bitrate-hls-on-aws");
		const manifest = plan.manifests[0];
		if (!manifest) {
			throw new Error("fixture has no manifest");
		}
		manifest.destination.path = "";
		expect(manifestPlaybackLinks(plan, awsCredential)[0]?.path).toBe(
			"stream.m3u8",
		);
	});
});

describe("liveManifestPlaybackLinks", () => {
	function loadLivePlan(name: string) {
		return liveChannelPlanSchema.parse(
			JSON.parse(
				readFileSync(
					join(__dirname, "../live/__fixtures__", `${name}.plan.json`),
					"utf8",
				),
			),
		);
	}

	it("derives both live manifests from the same helper as VOD", () => {
		const plan = loadLivePlan("live-rtmp-simple");
		// The live fixture has no ACL — see the next case — so declare the base
		// instead, which is the path §2.2 gives for exactly this situation.
		const links = liveManifestPlaybackLinks(plan, [
			{
				// The fixture reads the credential field defensively rather than
				// asserting every output has one — the union has grown before and
				// will again. (This said AKAMAI_MSL "has no credential"; that was
				// true until the 2026-08-19 remodel, .)
				id:
					plan.outputs[0] && "credentialId" in plan.outputs[0]
						? plan.outputs[0].credentialId
						: "",
				provider: "AWS_S3",
				config: {
					region: "ap-northeast-1",
					publicBaseUrls: {
						"sample-output-bucket": "https://cdn.example.com",
					},
				},
			},
		]);
		expect(links.map((l) => l.kind)).toEqual(["HLS", "DASH"]);
		// The slash the live plan does not carry.
		expect(links[0]?.url).toBe(
			"https://cdn.example.com/output/live-rtmp-simple/stream.m3u8",
		);
		expect(links[1]?.url).toBe(
			"https://cdn.example.com/output/live-rtmp-simple/stream.mpd",
		);
	});

	/**
	 * The Akamai MSL link (2026-09-02). Measured before this: every MSL channel
	 * answered `NO_PATTERN / OTHER` (channel 0645c2f1), because MSL is an ingest
	 * with no bucket and Bitmovin never learns the delivery hostname. The
	 * credential now declares it, and the link is that root + the manifest
	 * NAME — the destination path is ingest-side and does not appear on the
	 * edge (the measured MSL4 master is `<root>/stream.m3u8`).
	 */
	describe("AKAMAI_MSL outputs", () => {
		const ROOT =
			"https://bitmovinmsl4hlsjp.akamaized.net/hls/live/2126636/bitmovinhlsjp20260821";

		function mslCredential(
			plan: ReturnType<typeof loadLivePlan>,
			edge?: string,
		) {
			const output = plan.outputs.find((o) => o.kind === "AKAMAI_MSL");
			if (output?.kind !== "AKAMAI_MSL") {
				throw new Error("fixture has no AKAMAI_MSL output");
			}
			return {
				id: output.credentialId,
				provider: "AKAMAI_MSL" as const,
				config: {
					streamId: 2126636,
					eventName: "bitmovinhlsjp20260821",
					...(edge !== undefined ? { edgeBaseUrl: edge } : {}),
				},
			};
		}

		it("derives <edgeBaseUrl>/<manifestName> from the credential for every manifest on the MSL output", () => {
			const plan = loadLivePlan("live-akamai-msl");
			const links = liveManifestPlaybackLinks(plan, [
				mslCredential(plan, ROOT),
			]);
			expect(links.map((l) => [l.kind, l.url, l.via])).toEqual([
				["HLS", `${ROOT}/stream.m3u8`, "credential-edge"],
				["DASH", `${ROOT}/stream.mpd`, "credential-edge"],
			]);
			for (const link of links) {
				expect(link.reason).toBeUndefined();
			}
		});

		it("appends the manifest NAME, not the plan's destination path", () => {
			const plan = loadLivePlan("live-akamai-msl-ts");
			const manifest = plan.liveManifests[0];
			if (!manifest) {
				throw new Error("fixture has no manifest");
			}
			// An ingest-side path the encoder was told to write under.
			manifest.destination.path = "output/live-akamai-msl-ts";
			const [link] = liveManifestPlaybackLinks(plan, [
				mslCredential(plan, ROOT),
			]);
			expect(link?.url).toBe(`${ROOT}/stream.m3u8`);
			// The origin path stays copyable and still carries the directory.
			expect(link?.path).toBe("output/live-akamai-msl-ts/stream.m3u8");
		});

		it("names the credential, not a pattern, when no edge root is declared", () => {
			const plan = loadLivePlan("live-akamai-msl");
			const credential = mslCredential(plan);
			const links = liveManifestPlaybackLinks(plan, [credential]);
			expect(links).toHaveLength(2);
			for (const link of links) {
				expect(link.url).toBeNull();
				expect(link.via).toBe("none");
				expect(link.reason).toEqual({
					code: "MSL_EDGE_URL_NOT_CONFIGURED",
					credentialId: credential.id,
				});
			}
		});

		it("degrades to NO_CREDENTIAL when the MSL credential row is gone", () => {
			const plan = loadLivePlan("live-akamai-msl");
			for (const link of liveManifestPlaybackLinks(plan, [])) {
				expect(link.url).toBeNull();
				expect(link.reason?.code).toBe("NO_CREDENTIAL");
			}
		});

		it("does not touch a storage-origin channel whose MSL is only a mirror", () => {
			// `live-akamai-msl-storage`: manifests land on the GENERIC_S3 origin;
			// the MSL output is a deliveryMirror and has no manifest of its own,
			// so the links are the origin's and the mirror's edge is not offered.
			const plan = loadLivePlan("live-akamai-msl-storage");
			const origin = plan.outputs.find((o) => o.kind === "GENERIC_S3");
			if (origin?.kind !== "GENERIC_S3") {
				throw new Error("fixture has no GENERIC_S3 origin");
			}
			const links = liveManifestPlaybackLinks(plan, [
				{
					id: origin.credentialId,
					provider: "AKAMAI_OBJECT_STORAGE",
					config: { host: "jp-osa-1.linodeobjects.com" },
				},
				mslCredential(plan, ROOT),
			]);
			expect(links).toHaveLength(2);
			for (const link of links) {
				expect(link.via).not.toBe("credential-edge");
				expect(link.reason?.code).toBe("NOT_PUBLIC");
			}
		});
	});

	it("reports NOT_PUBLIC for every live channel authored today", () => {
		/**
		 * Design §6: the live wizard has no ACL control, so derivation rule 2 can
		 * never fire for a live channel — `publicBaseUrls` is the only route until
		 * the ACL field lands. Asserted rather than assumed, because "live
		 * playback does not work" would otherwise look like a bug in the player.
		 */
		const plan = loadLivePlan("live-rtmp-simple");
		const links = liveManifestPlaybackLinks(plan, [
			{
				// The fixture reads the credential field defensively rather than
				// asserting every output has one — the union has grown before and
				// will again. (This said AKAMAI_MSL "has no credential"; that was
				// true until the 2026-08-19 remodel, .)
				id:
					plan.outputs[0] && "credentialId" in plan.outputs[0]
						? plan.outputs[0].credentialId
						: "",
				provider: "AWS_S3",
				config: { region: "ap-northeast-1" },
			},
		]);
		for (const link of links) {
			expect(link.url).toBeNull();
			expect(link.reason?.code).toBe("NOT_PUBLIC");
		}
	});
});
