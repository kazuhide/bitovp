import type { CompiledOperation } from "@bitovp/core";
import {
	CREDENTIAL_PROVIDERS,
	OPERATION_KINDS,
	PROVIDERS_FOR_IO_KIND,
	perTitleCaptureOutcomeSchema,
} from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ExecutorContext,
	executeStep,
	type ResolvedCredential,
} from "./executor";
import { fakeSdk } from "./fake-sdk";
import { BitmovinCallError, type SdkOps } from "./sdk-ops";

function ctx(
	sdk: SdkOps,
	ids: Record<string, string> = {},
	credential?: ResolvedCredential,
): ExecutorContext {
	return {
		sdk,
		ids: new Map(Object.entries(ids)),
		resolveCredential: vi.fn(async () =>
			credential
				? credential
				: {
						// A COHERENT AWS_S3 credential. It used to carry SFTP's
						// host/port/username/password too, so the SFTP arm below
						// built an SFTP output from an AWS_S3 credential — the
						// default asserted the very mismatch AA972-CONTRACT-001
						// is about. Nothing else read those fields (grepped).
						provider: "AWS_S3",
						config: {},
						secret: {
							accessKeyId: "AKIA-RESOLVED",
							secretAccessKey: "RESOLVED-SECRET",
						},
					},
		),
		poll: { intervalMs: 1, timeoutMs: 50, sleep: () => Promise.resolve() },
	};
}

const s3InputOp: CompiledOperation = {
	step: "input:main",
	kind: "CREATE_INPUT_S3",
	payload: {
		name: "Test S3 Input",
		credentialId: "00000000-0000-4000-8000-000000000001",
		bucketName: "bucket",
	},
	refs: {},
};

const DRM_CRED: ResolvedCredential = {
	provider: "DRM_CENC",
	config: {},
	secret: { key: "12341234123412341234123412341234" },
};

const cencOp: CompiledOperation = {
	step: "drm:v1080-cenc",
	kind: "CREATE_DRM_CENC",
	payload: {
		muxingKind: "FMP4",
		credentialId: "00000000-0000-4000-8000-000000000005",
		kid: "43214321432143214321432143214321",
		encryptionMode: "CBC",
		ivSize: "IV_16_BYTES",
		widevine: { pssh: "PSSH-BASE64" },
		playReady: { laUrl: "http://pr.example/rm.asmx" },
		fairPlay: { iv: "00000000000000000000000000000000", uri: "skd://token" },
		outputPath: "output/video/1080p",
		acl: "PUBLIC_READ",
		name: "Video FMP4 CENC",
	},
	refs: {
		encodingId: "encoding",
		muxingId: "muxing:v1080",
		outputId: "output:origin",
	},
};

const cencIds = {
	encoding: "bm-enc",
	"muxing:v1080": "bm-muxing",
	"output:origin": "bm-output",
};

describe("executeStep", () => {
	it("resolves vault secrets for inputs without leaking them into snapshots", async () => {
		const sdk = fakeSdk();
		const result = await executeStep(s3InputOp, ctx(sdk));
		expect(sdk.createS3Input).toHaveBeenCalledWith({
			name: "Test S3 Input",
			bucketName: "bucket",
			accessKey: "AKIA-RESOLVED",
			secretKey: "RESOLVED-SECRET",
		});
		expect(result.resourceId).toBe("bm-1");
		expect(JSON.stringify(result.request)).not.toContain("RESOLVED");
		expect(JSON.stringify(result.response)).not.toContain("RESOLVED");
	});

	it("builds SFTP outputs from credential config + secret", async () => {
		const sdk = fakeSdk();
		await executeStep(
			{
				step: "output:origin",
				kind: "CREATE_OUTPUT_SFTP",
				payload: { name: "Test SFTP Output", credentialId: "c" },
				refs: {},
			},
			ctx(
				sdk,
				{},
				{
					provider: "SFTP",
					config: { host: "sftp.example.com", port: 2222, username: "ops" },
					secret: { password: "RESOLVED-PASSWORD" },
				},
			),
		);
		expect(sdk.createSftpOutput).toHaveBeenCalledWith({
			name: "Test SFTP Output",
			host: "sftp.example.com",
			port: 2222,
			username: "ops",
			password: "RESOLVED-PASSWORD",
		});
	});

	it("builds Azure inputs from credential config (accountName) + secret", async () => {
		const sdk = fakeSdk();
		await executeStep(
			{
				step: "input:main",
				kind: "CREATE_INPUT_AZURE",
				payload: {
					name: "Test Azure Input",
					credentialId: "c",
					container: "sample-container",
				},
				refs: {},
			},
			ctx(
				sdk,
				{},
				{
					provider: "AZURE_BLOB",
					config: { accountName: "storageacct" },
					secret: { accountKey: "AZURE-KEY" },
				},
			),
		);
		expect(sdk.createAzureInput).toHaveBeenCalledWith({
			name: "Test Azure Input",
			container: "sample-container",
			accountName: "storageacct",
			accountKey: "AZURE-KEY",
		});
	});

	it("creates HTTPS inputs without resolving any credential", async () => {
		const sdk = fakeSdk();
		const context = ctx(sdk);
		await executeStep(
			{
				step: "input:main",
				kind: "CREATE_INPUT_HTTPS",
				payload: { name: "Test HTTPS Input", host: "inputs.example.com" },
				refs: {},
			},
			context,
		);
		expect(sdk.createHttpsInput).toHaveBeenCalledWith({
			name: "Test HTTPS Input",
			host: "inputs.example.com",
		});
		expect(context.resolveCredential).not.toHaveBeenCalled();
	});

	describe("GenericS3 / GCS storage I/O (ledger #17)", () => {
		const genericInputOp: CompiledOperation = {
			step: "input:main",
			kind: "CREATE_INPUT_GENERIC_S3",
			payload: {
				name: "Generic Input",
				credentialId: "00000000-0000-4000-8000-000000000001",
				bucketName: "in-bucket",
			},
			refs: {},
		};
		const genericOutputOp: CompiledOperation = {
			...genericInputOp,
			step: "output:origin",
			kind: "CREATE_OUTPUT_GENERIC_S3",
			payload: { ...genericInputOp.payload, name: "Generic Output" },
		};
		const AKAMAI_CRED: ResolvedCredential = {
			provider: "AKAMAI_OBJECT_STORAGE",
			config: { host: "jp-osa-1.linodeobjects.com" },
			secret: { accessKeyId: "AKAMAI-KEY", secretAccessKey: "AKAMAI-SECRET" },
		};
		const OCI_CRED: ResolvedCredential = {
			provider: "OCI_OBJECT_STORAGE",
			config: { namespace: "myns", region: "us-ashburn-1" },
			secret: { accessKeyId: "OCI-KEY", secretAccessKey: "OCI-SECRET" },
		};
		const GENERIC_CRED: ResolvedCredential = {
			provider: "GENERIC_S3",
			config: {
				host: "minio.example.com",
				port: 9000,
				ssl: false,
				signatureVersion: "S3_V2",
			},
			secret: { accessKeyId: "MINIO-KEY", secretAccessKey: "MINIO-SECRET" },
		};
		const GCS_HMAC_CRED: ResolvedCredential = {
			provider: "GCS_HMAC",
			config: {},
			secret: { accessKey: "GCS-HMAC-KEY", secret: "GCS-HMAC-SECRET" },
		};
		const GCS_SA_CRED: ResolvedCredential = {
			provider: "GCS_SERVICE_ACCOUNT",
			config: {},
			secret: {
				serviceAccountJson:
					'{"client_email":"x@y.iam","private_key":"PRIVATE"}',
			},
		};

		it("sends Akamai's host, port 443, ssl and V4 — and hides the keys", async () => {
			/**
			 * This test used to assert `port: undefined, ssl: undefined`, and a real run showed
			 * what that means at the other end: Bitmovin applied its GenericS3 defaults and the
			 * encoder tried `bitmovin-api-jp-osa-1-input.jp-osa-1.linodeobjects.com:8000`, got
			 * `Connection refused`, and reported
			 * `Download of input file failed. File not found on your GENERIC_S3 storage.` — a
			 * file-not-found for a port that was never open.
			 *
			 * Linode Object Storage serves S3 over HTTPS on 443. Omitting the fields did not mean
			 * "let the host decide"; it meant "let Bitmovin decide", and it decided 8000.
			 */
			const sdk = fakeSdk();
			const result = await executeStep(
				genericInputOp,
				ctx(sdk, {}, AKAMAI_CRED),
			);
			expect(sdk.createGenericS3Input).toHaveBeenCalledWith({
				name: "Generic Input",
				bucketName: "in-bucket",
				host: "jp-osa-1.linodeobjects.com",
				port: 443,
				ssl: true,
				signatureVersion: "V4",
				accessKey: "AKAMAI-KEY",
				secretKey: "AKAMAI-SECRET",
			});
			// The snapshot (request) is op.payload + resolved refs — NO key material.
			expect(JSON.stringify(result.request)).not.toContain("AKAMAI-KEY");
			expect(JSON.stringify(result.request)).not.toContain("AKAMAI-SECRET");
		});
		it("lets the credential override the port and ssl", async () => {
			/**
			 * 443/HTTPS is the DEFAULT for Akamai, not a hardcode — an install behind a proxy must
			 * still be able to say otherwise. Without this the fix would trade one wrong constant
			 * for another.
			 */
			const sdk = fakeSdk();
			await executeStep(
				genericInputOp,
				ctx(
					sdk,
					{},
					{
						...AKAMAI_CRED,
						config: { ...AKAMAI_CRED.config, port: 9000, ssl: false },
					},
				),
			);
			expect(sdk.createGenericS3Input).toHaveBeenCalledWith(
				expect.objectContaining({ port: 9000, ssl: false }),
			);
		});

		it("derives the OCI S3-compat host from namespace + region (V4)", async () => {
			const sdk = fakeSdk();
			await executeStep(genericOutputOp, ctx(sdk, {}, OCI_CRED));
			expect(sdk.createGenericS3Output).toHaveBeenCalledWith({
				name: "Generic Output",
				bucketName: "in-bucket",
				host: "myns.compat.objectstorage.us-ashburn-1.oraclecloud.com",
				port: undefined,
				ssl: undefined,
				signatureVersion: "V4",
				accessKey: "OCI-KEY",
				secretKey: "OCI-SECRET",
			});
		});

		it("carries GenericS3 port/ssl/signatureVersion (S3_V2 → V2) from config", async () => {
			const sdk = fakeSdk();
			await executeStep(genericInputOp, ctx(sdk, {}, GENERIC_CRED));
			expect(sdk.createGenericS3Input).toHaveBeenCalledWith({
				name: "Generic Input",
				bucketName: "in-bucket",
				host: "minio.example.com",
				port: 9000,
				ssl: false,
				signatureVersion: "V2",
				accessKey: "MINIO-KEY",
				secretKey: "MINIO-SECRET",
			});
		});

		it("rejects a plain-S3 op backed by a non-AWS_S3 credential (review-109pr1 P1 — the F4 class, ported)", async () => {
			// A GCS_HMAC secret's field names differ, so before the guard this
			// fell through ?? "" into an S3 input with BLANK credentials —
			// created at Bitmovin, failing late and vendor-side.
			const sdk = fakeSdk();
			await expect(
				executeStep(
					{
						...genericInputOp,
						kind: "CREATE_INPUT_S3",
						payload: {
							name: "Generic Input",
							bucketName: "in-bucket",
							credentialId: "00000000-0000-4000-8000-00000000cccc",
						},
					},
					ctx(sdk, {}, GCS_HMAC_CRED),
				),
			).rejects.toThrow(/needs an AWS_S3 credential/);
			expect(sdk.createS3Input).not.toHaveBeenCalled();
		});

		it("rejects a GENERIC_S3 op backed by a non-S3-compatible credential", async () => {
			const sdk = fakeSdk();
			await expect(
				executeStep(genericInputOp, ctx(sdk)), // default cred is AWS_S3
			).rejects.toThrow(/needs an Akamai\/OCI\/GenericS3 credential/);
			expect(sdk.createGenericS3Input).not.toHaveBeenCalled();
		});

		it("rejects a GenericS3 credential missing its access key — never empty", async () => {
			const sdk = fakeSdk();
			await expect(
				executeStep(
					genericInputOp,
					ctx(sdk, {}, { ...AKAMAI_CRED, secret: {} }),
				),
			).rejects.toThrow(/carries no accessKeyId/);
		});

		it("builds a GCS-HMAC input from { accessKey, secret } + optional region", async () => {
			const sdk = fakeSdk();
			const result = await executeStep(
				{
					...genericInputOp,
					kind: "CREATE_INPUT_GCS",
					payload: { ...genericInputOp.payload, cloudRegion: "EUROPE_WEST_1" },
				},
				ctx(sdk, {}, GCS_HMAC_CRED),
			);
			expect(sdk.createGcsInput).toHaveBeenCalledWith({
				name: "Generic Input",
				bucketName: "in-bucket",
				cloudRegion: "EUROPE_WEST_1",
				accessKey: "GCS-HMAC-KEY",
				secretKey: "GCS-HMAC-SECRET",
			});
			expect(JSON.stringify(result.request)).not.toContain("GCS-HMAC");
		});

		it("rejects a GCS op backed by a GCS_SERVICE_ACCOUNT credential", async () => {
			const sdk = fakeSdk();
			await expect(
				executeStep(
					{ ...genericInputOp, kind: "CREATE_INPUT_GCS" },
					ctx(sdk, {}, GCS_SA_CRED),
				),
			).rejects.toThrow(/needs a GCS_HMAC credential/);
		});

		it("passes the service-account JSON to the SDK but never into the snapshot", async () => {
			const sdk = fakeSdk();
			const result = await executeStep(
				{
					...genericOutputOp,
					kind: "CREATE_OUTPUT_GCS_SERVICE_ACCOUNT",
					payload: { ...genericOutputOp.payload, cloudRegion: "US_EAST_1" },
				},
				ctx(sdk, {}, GCS_SA_CRED),
			);
			expect(sdk.createGcsServiceAccountOutput).toHaveBeenCalledWith({
				name: "Generic Output",
				bucketName: "in-bucket",
				cloudRegion: "US_EAST_1",
				serviceAccountCredentials:
					'{"client_email":"x@y.iam","private_key":"PRIVATE"}',
			});
			// The private key must not appear in the persisted request/response.
			expect(JSON.stringify(result.request)).not.toContain("PRIVATE");
			expect(JSON.stringify(result.response)).not.toContain("PRIVATE");
		});

		it("rejects a GCS_SERVICE_ACCOUNT op with no serviceAccountJson", async () => {
			const sdk = fakeSdk();
			await expect(
				executeStep(
					{ ...genericInputOp, kind: "CREATE_INPUT_GCS_SERVICE_ACCOUNT" },
					ctx(sdk, {}, { ...GCS_SA_CRED, secret: {} }),
				),
			).rejects.toThrow(/carries no serviceAccountJson/);
		});
	});

	it("substitutes resolved ids for refs", async () => {
		const sdk = fakeSdk();
		await executeStep(
			{
				step: "stream:v360",
				kind: "CREATE_STREAM",
				payload: { name: "Stream H264 360p", mode: "STANDARD" },
				refs: {
					encodingId: "encoding",
					codecConfigId: "codec:v360",
					inputStreamId: "ingest:video",
				},
			},
			ctx(sdk, {
				encoding: "bm-enc",
				"codec:v360": "bm-codec",
				"ingest:video": "bm-ingest",
			}),
		);
		expect(sdk.createStream).toHaveBeenCalledWith("bm-enc", {
			codecConfigId: "bm-codec",
			inputStreamId: "bm-ingest",
			name: "Stream H264 360p",
			mode: "STANDARD",
			conditions: undefined,
		});
	});

	it("fails fast when a ref has not resolved", async () => {
		await expect(
			executeStep(
				{
					step: "stream:v360",
					kind: "CREATE_STREAM",
					payload: { name: "x", mode: "STANDARD" },
					refs: {
						encodingId: "encoding",
						codecConfigId: "codec:v360",
						inputStreamId: "ingest:video",
					},
				},
				ctx(fakeSdk()),
			),
		).rejects.toThrow(/has not resolved/);
	});

	it("forwards the full H265 payload surface with enum NAMES untranslated", async () => {
		const sdk = fakeSdk();
		await executeStep(
			{
				step: "codec:dv-v2160",
				kind: "CREATE_CODEC_H265",
				payload: {
					name: "H265 DV 2160p",
					height: 2160,
					bitrate: 15_000_000,
					level: null, // explicit null → omitted for the SDK
					rcLookahead: 60,
					subMe: 5,
					maxCTUSize: "S64",
					motionSearch: "STAR",
					tuIntraDepth: "D4",
					tuInterDepth: "D4",
					weightPredictionOnPSlice: true,
					adaptiveQuantizationMode: "AUTO_VARIANCE_DARK_SCENES",
					dynamicRangeFormat: "DOLBY_VISION_PROFILE_5",
					maxBitrate: 30_000_000,
					bufsize: 60_000_000,
					levelHighTier: false,
					colorConfig: {
						colorSpace: "BT2020_NCL",
						colorPrimaries: "BT2020",
						colorTransfer: "SMPTE2084",
					},
				},
				refs: {},
			},
			ctx(sdk),
		);
		// Translation happens inside sdk-ops; the facade gets NAMES.
		expect(sdk.createH265Config).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "H265 DV 2160p",
				height: 2160,
				bitrate: 15_000_000,
				level: undefined,
				subMe: 5,
				maxCTUSize: "S64",
				motionSearch: "STAR",
				tuIntraDepth: "D4",
				tuInterDepth: "D4",
				weightPredictionOnPSlice: true,
				adaptiveQuantizationMode: "AUTO_VARIANCE_DARK_SCENES",
				dynamicRangeFormat: "DOLBY_VISION_PROFILE_5",
				maxBitrate: 30_000_000,
				bufsize: 60_000_000,
				levelHighTier: false,
				colorConfig: {
					colorSpace: "BT2020_NCL",
					colorPrimaries: "BT2020",
					colorTransfer: "SMPTE2084",
				},
			}),
		);
	});

	it("omits per-title null height/bitrate from the H264 facade call", async () => {
		const sdk = fakeSdk();
		await executeStep(
			{
				step: "codec:v180",
				kind: "CREATE_CODEC_H264",
				payload: {
					height: 180,
					level: null,
					profile: "BASELINE",
					subMe: "RD_REF_IP",
					trellis: "ENABLED_ALL",
					motionEstimationMethod: "UMH",
					mvPredictionMode: "AUTO",
					weightedPredictionPFrames: "SMART",
				},
				refs: {},
			},
			ctx(sdk),
		);
		expect(sdk.createH264Config).toHaveBeenCalledWith(
			expect.objectContaining({
				height: 180,
				bitrate: undefined,
				level: undefined,
				profile: "BASELINE",
				subMe: "RD_REF_IP",
				trellis: "ENABLED_ALL",
				motionEstimationMethod: "UMH",
				mvPredictionMode: "AUTO",
				weightedPredictionPFrames: "SMART",
			}),
		);
	});

	it("carries explicit H264 output width to the facade", async () => {
		const sdk = fakeSdk();
		await executeStep(
			{
				step: "codec:hd",
				kind: "CREATE_CODEC_H264",
				payload: { width: 1280, height: 720, rate: 30 },
				refs: {},
			},
			ctx(sdk),
		);
		expect(sdk.createH264Config).toHaveBeenCalledWith(
			expect.objectContaining({ width: 1280, height: 720, rate: 30 }),
		);
	});

	it("nests Dolby Atmos loudnessControl on the codec facade call", async () => {
		const sdk = fakeSdk();
		await executeStep(
			{
				step: "codec:atmos448",
				kind: "CREATE_CODEC_DOLBY_ATMOS",
				payload: {
					name: "Atmos Codec Configuration",
					bitrate: 448_000,
					rate: 48_000,
					loudnessControl: {
						meteringMode: "ITU_R_BS_1770_4",
						dialogueIntelligence: "ENABLED",
						speechThreshold: 15,
					},
				},
				refs: {},
			},
			ctx(sdk),
		);
		expect(sdk.createDolbyAtmosConfig).toHaveBeenCalledWith({
			name: "Atmos Codec Configuration",
			bitrate: 448_000,
			rate: 48_000,
			loudnessControl: {
				meteringMode: "ITU_R_BS_1770_4",
				dialogueIntelligence: "ENABLED",
				speechThreshold: 15,
			},
		});
	});

	it("attaches stream filters with positions paired to resolved ids", async () => {
		const sdk = fakeSdk();
		const result = await executeStep(
			{
				step: "stream-filters:v1080",
				kind: "CREATE_STREAM_FILTERS",
				payload: { positions: [0] },
				refs: {
					encodingId: "encoding",
					streamId: "stream:v1080",
					filterIds: ["filter:v1080:deint"],
				},
			},
			ctx(sdk, {
				encoding: "bm-enc",
				"stream:v1080": "bm-stream",
				"filter:v1080:deint": "bm-filter",
			}),
		);
		expect(sdk.createStreamFilters).toHaveBeenCalledWith(
			"bm-enc",
			"bm-stream",
			[{ id: "bm-filter", position: 0 }],
		);
		expect(result.resourceId).toBeUndefined();
	});

	it("creates muxings without outputs when DRM owns the destination", async () => {
		const sdk = fakeSdk();
		await executeStep(
			{
				step: "muxing:v1080",
				kind: "CREATE_MUXING_FMP4",
				payload: {
					segmentLength: 6,
					segmentNaming: "segment_%number%.m4s",
					initSegmentName: "init.mp4",
					name: "Video FMP4 Muxing 1080p",
				},
				refs: { encodingId: "encoding", streamId: "stream:v1080" },
			},
			ctx(sdk, { encoding: "bm-enc", "stream:v1080": "bm-stream" }),
		);
		expect(sdk.createFmp4Muxing).toHaveBeenCalledWith("bm-enc", {
			streamId: "bm-stream",
			segmentLength: 6,
			segmentNaming: "segment_%number%.m4s",
			initSegmentName: "init.mp4",
			destination: undefined,
			name: "Video FMP4 Muxing 1080p",
		});
	});

	/**
	 * WP-C6 (2026-09-02). The compiler omits `segmentNaming` whenever the plan
	 * carries a template; the executor's `str` coercion turned that absence
	 * into `""` and sent an EMPTY literal beside the template — which the SDK
	 * forbids ("If segmentNamingTemplate is set, segmentNaming must not be
	 * set"). Every Akamai MSL template arm ever run (2026-08-21) went through
	 * that line, so its refusal is suspected to be ours. These arms read the
	 * sent VALUES field by field, so the mutation `optStr → str` turns exactly
	 * the literal's assertion red.
	 */
	describe("templated naming reaches the SDK with the literal ABSENT, never empty", () => {
		it("TS: segmentNamingTemplate alone — segmentNaming is undefined, not ''", async () => {
			const sdk = fakeSdk();
			await executeStep(
				{
					step: "muxing:v1080",
					kind: "CREATE_MUXING_TS",
					payload: {
						segmentLength: 2,
						segmentNamingTemplate: "seg-{segment_rand_chars:8}-%number%.ts",
						outputPath: "output/live/video/1080p",
						name: "Video TS Muxing 1080p",
					},
					refs: {
						encodingId: "encoding",
						streamId: "stream:v1080",
						outputId: "output:origin",
					},
				},
				ctx(sdk, {
					encoding: "bm-enc",
					"stream:v1080": "bm-stream",
					"output:origin": "bm-output",
				}),
			);
			const sent = vi.mocked(sdk.createTsMuxing).mock.calls[0]?.[1] as Record<
				string,
				unknown
			>;
			expect(sent.segmentNamingTemplate).toBe(
				"seg-{segment_rand_chars:8}-%number%.ts",
			);
			expect(sent.segmentNaming).toBeUndefined();
			expect(sent.segmentNaming).not.toBe("");
		});

		it("fMP4: the same — no empty literal is manufactured beside the template", async () => {
			const sdk = fakeSdk();
			await executeStep(
				{
					step: "muxing:v1080",
					kind: "CREATE_MUXING_FMP4",
					payload: {
						segmentLength: 6,
						segmentNamingTemplate: "seg-{segment_rand_chars:8}-%number%.m4s",
						initSegmentName: "init.mp4",
						outputPath: "output/live/video/1080p",
						name: "Video FMP4 Muxing 1080p",
					},
					refs: {
						encodingId: "encoding",
						streamId: "stream:v1080",
						outputId: "output:origin",
					},
				},
				ctx(sdk, {
					encoding: "bm-enc",
					"stream:v1080": "bm-stream",
					"output:origin": "bm-output",
				}),
			);
			const sent = vi.mocked(sdk.createFmp4Muxing).mock.calls[0]?.[1] as Record<
				string,
				unknown
			>;
			expect(sent.segmentNamingTemplate).toBe(
				"seg-{segment_rand_chars:8}-%number%.m4s",
			);
			expect(sent.segmentNaming).toBeUndefined();
			expect(sent.initSegmentName).toBe("init.mp4");
		});

		it("the literal path is unchanged — a plain plan still sends its literal names", async () => {
			const sdk = fakeSdk();
			await executeStep(
				{
					step: "muxing:v1080",
					kind: "CREATE_MUXING_FMP4",
					payload: {
						segmentLength: 6,
						segmentNaming: "segment_%number%.m4s",
						initSegmentName: "init.mp4",
						name: "Video FMP4 Muxing 1080p",
					},
					refs: { encodingId: "encoding", streamId: "stream:v1080" },
				},
				ctx(sdk, { encoding: "bm-enc", "stream:v1080": "bm-stream" }),
			);
			const sent = vi.mocked(sdk.createFmp4Muxing).mock.calls[0]?.[1] as Record<
				string,
				unknown
			>;
			expect(sent.segmentNaming).toBe("segment_%number%.m4s");
			expect(sent.initSegmentName).toBe("init.mp4");
			expect(sent.segmentNamingTemplate).toBeUndefined();
		});
	});

	it("maps MP4 muxing dolbyVisionConfiguration and fragment fields", async () => {
		const sdk = fakeSdk();
		await executeStep(
			{
				step: "muxing:dv-v2160",
				kind: "CREATE_MUXING_MP4",
				payload: {
					filename: "video.mp4",
					fragmentedMP4MuxingManifestType: "DASH_ON_DEMAND",
					fragmentDuration: 6000,
					dolbyVisionConfiguration: { trackSampleEntryName: "DVH1" },
					outputPath: "output/video/dv/2160p/",
					acl: "PUBLIC_READ",
					name: "Video MP4 DV 2160p",
				},
				refs: {
					encodingId: "encoding",
					streamId: "stream:dv",
					outputId: "output:origin",
				},
			},
			ctx(sdk, {
				encoding: "bm-enc",
				"stream:dv": "bm-stream",
				"output:origin": "bm-output",
			}),
		);
		expect(sdk.createMp4Muxing).toHaveBeenCalledWith("bm-enc", {
			streamId: "bm-stream",
			filename: "video.mp4",
			fragmentDuration: 6000,
			fragmentedMP4MuxingManifestType: "DASH_ON_DEMAND",
			dolbyVisionTrackSampleEntryName: "DVH1",
			destination: {
				outputId: "bm-output",
				outputPath: "output/video/dv/2160p/",
				acl: "PUBLIC_READ",
			},
			name: "Video MP4 DV 2160p",
		});
	});

	describe("DRM security", () => {
		it("rejects non-DRM credentials (provider mismatch)", async () => {
			const sdk = fakeSdk();
			await expect(
				executeStep(cencOp, ctx(sdk, cencIds)), // default cred is AWS_S3
			).rejects.toThrow(/needs a DRM_CENC credential/);
			expect(sdk.createCencDrm).not.toHaveBeenCalled();
		});

		it("rejects DRM credentials without a key — never falls back to empty", async () => {
			const sdk = fakeSdk();
			await expect(
				executeStep(
					cencOp,
					ctx(sdk, cencIds, { provider: "DRM_CENC", config: {}, secret: {} }),
				),
			).rejects.toThrow(/carries no content key/);
			expect(sdk.createCencDrm).not.toHaveBeenCalled();
		});

		it("rejects a content key equal to the kid (paste error)", async () => {
			const sdk = fakeSdk();
			await expect(
				executeStep(
					cencOp,
					ctx(sdk, cencIds, {
						provider: "DRM_CENC",
						config: {},
						secret: { key: String(cencOp.payload.kid) },
					}),
				),
			).rejects.toThrow(/must not equal kid/);
			expect(sdk.createCencDrm).not.toHaveBeenCalled();
		});

		it("passes the key to the facade but keeps it out of the snapshot", async () => {
			const sdk = fakeSdk();
			const result = await executeStep(cencOp, ctx(sdk, cencIds, DRM_CRED));
			expect(sdk.createCencDrm).toHaveBeenCalledWith("bm-enc", "bm-muxing", {
				muxingKind: "FMP4",
				key: DRM_CRED.secret.key,
				kid: "43214321432143214321432143214321",
				encryptionMode: "CBC",
				ivSize: "IV_16_BYTES",
				widevine: { pssh: "PSSH-BASE64" },
				playReady: { laUrl: "http://pr.example/rm.asmx" },
				fairPlay: {
					iv: "00000000000000000000000000000000",
					uri: "skd://token",
				},
				destination: {
					outputId: "bm-output",
					outputPath: "output/video/1080p",
					acl: "PUBLIC_READ",
				},
				name: "Video FMP4 CENC",
			});
			expect(JSON.stringify(result.request)).not.toContain(DRM_CRED.secret.key);
			expect(JSON.stringify(result.response)).not.toContain(
				DRM_CRED.secret.key,
			);
		});

		it("applies the same gate to FairPlay and forwards public iv/uri", async () => {
			const sdk = fakeSdk();
			const op: CompiledOperation = {
				step: "drm:v180-fp",
				kind: "CREATE_DRM_FAIRPLAY",
				payload: {
					muxingKind: "TS",
					credentialId: "c",
					iv: "00000000000000000000000000000000",
					uri: "skd://expressplay_token",
					name: "Video TS FairPlay",
				},
				refs: { encodingId: "encoding", muxingId: "muxing:v180-ts" },
			};
			const ids = { encoding: "bm-enc", "muxing:v180-ts": "bm-muxing" };
			await expect(executeStep(op, ctx(sdk, ids))).rejects.toThrow(
				/needs a DRM_CENC credential/,
			);
			const result = await executeStep(op, ctx(sdk, ids, DRM_CRED));
			expect(sdk.createFairPlayDrm).toHaveBeenCalledWith(
				"bm-enc",
				"bm-muxing",
				{
					muxingKind: "TS",
					key: DRM_CRED.secret.key,
					iv: "00000000000000000000000000000000",
					uri: "skd://expressplay_token",
					destination: undefined,
					name: "Video TS FairPlay",
				},
			);
			expect(JSON.stringify(result.request)).not.toContain(DRM_CRED.secret.key);
		});

		it("gates NexGuard on provider + license and hides the license", async () => {
			const sdk = fakeSdk();
			const op: CompiledOperation = {
				step: "nexguard:v1080",
				kind: "CREATE_NEXGUARD_FILE_MARKER",
				payload: {
					credentialId: "c",
					watermarkType: "OTT",
					preset: "sample-nexguard-preset",
					strength: "DEFAULT",
				},
				refs: { encodingId: "encoding", streamId: "stream:v1080" },
			};
			const ids = { encoding: "bm-enc", "stream:v1080": "bm-stream" };
			await expect(executeStep(op, ctx(sdk, ids))).rejects.toThrow(
				/needs a NEXGUARD credential/,
			);
			await expect(
				executeStep(
					op,
					ctx(sdk, ids, { provider: "NEXGUARD", config: {}, secret: {} }),
				),
			).rejects.toThrow(/carries no license/);
			const result = await executeStep(
				op,
				ctx(sdk, ids, {
					provider: "NEXGUARD",
					config: {},
					secret: { license: "NEXGUARD-LICENSE" },
				}),
			);
			expect(sdk.createNexGuardFileMarker).toHaveBeenCalledWith(
				"bm-enc",
				"bm-stream",
				{
					license: "NEXGUARD-LICENSE",
					watermarkType: "OTT",
					preset: "sample-nexguard-preset",
					strength: "DEFAULT",
					payload: undefined,
				},
			);
			expect(JSON.stringify(result.request)).not.toContain("NEXGUARD-LICENSE");
		});
	});

	it("maps JIT start request manifest refs to ids", async () => {
		const sdk = fakeSdk();
		await executeStep(
			{
				step: "start",
				kind: "START_ENCODING",
				payload: { manifestGenerator: "V2" },
				refs: {
					encodingId: "encoding",
					vodHlsManifestIds: ["manifest:hls"],
					vodDashManifestIds: ["manifest:dash"],
				},
			},
			ctx(sdk, {
				encoding: "bm-enc",
				"manifest:hls": "bm-hls",
				"manifest:dash": "bm-dash",
			}),
		);
		expect(sdk.startEncoding).toHaveBeenCalledWith("bm-enc", {
			manifestGenerator: "V2",
			vodHlsManifestIds: ["bm-hls"],
			vodDashManifestIds: ["bm-dash"],
		});
	});

	it("maps preview manifest refs + tweaks/handleVariableInputFps onto the start request", async () => {
		const sdk = fakeSdk();
		await executeStep(
			{
				step: "start",
				kind: "START_ENCODING",
				payload: {
					manifestGenerator: "V2",
					tweaks: { audioVideoSyncMode: "RESYNC_AT_START" },
					handleVariableInputFps: true,
				},
				refs: {
					encodingId: "encoding",
					vodHlsManifestIds: ["manifest:hls"],
					previewHlsManifestIds: ["manifest:hls"],
					previewDashManifestIds: ["manifest:dash"],
				},
			},
			ctx(sdk, {
				encoding: "bm-enc",
				"manifest:hls": "bm-hls",
				"manifest:dash": "bm-dash",
			}),
		);
		expect(sdk.startEncoding).toHaveBeenCalledWith("bm-enc", {
			manifestGenerator: "V2",
			vodHlsManifestIds: ["bm-hls"],
			previewHlsManifestIds: ["bm-hls"],
			previewDashManifestIds: ["bm-dash"],
			audioVideoSyncMode: "RESYNC_AT_START",
			handleVariableInputFps: true,
		});
	});

	it("resolves the KANTAR login pair from the vault and refuses wrong/partial credentials", async () => {
		const kantarOp: CompiledOperation = {
			step: "kantar:encoding",
			kind: "CREATE_KANTAR_WATERMARK",
			payload: {
				credentialId: "00000000-0000-4000-8000-0000000000b1",
				licenseId: 4711,
				channelName: "Demo",
				contentReference: "ep01",
				serverUrl: "https://kantar.example.com/watermark",
				reportPath: "reports",
				reportAcl: "PRIVATE",
			},
			refs: { encodingId: "encoding", reportOutputId: "output:origin" },
		};
		const ids = { encoding: "bm-enc", "output:origin": "bm-output" };
		const sdk = fakeSdk();
		const good = ctx(sdk, ids, {
			provider: "KANTAR",
			config: {},
			secret: { login: "kantar-user", password: "KANTAR-CANARY" },
		});
		await executeStep(kantarOp, good);
		expect(sdk.createKantarWatermark).toHaveBeenCalledWith("bm-enc", {
			login: "kantar-user",
			password: "KANTAR-CANARY",
			licenseId: 4711,
			channelName: "Demo",
			contentReference: "ep01",
			serverUrl: "https://kantar.example.com/watermark",
			report: {
				outputId: "bm-output",
				outputPath: "reports",
				acl: "PRIVATE",
			},
		});
		// The compiled payload (what the step log persists) carries the vault
		// REF only — never the pair.
		expect(JSON.stringify(kantarOp.payload)).not.toContain("KANTAR-CANARY");

		const wrongProvider = ctx(fakeSdk(), ids, {
			provider: "NEXGUARD",
			config: {},
			secret: { license: "nexguard" },
		});
		await expect(executeStep(kantarOp, wrongProvider)).rejects.toThrow(
			/needs a KANTAR credential but got provider "NEXGUARD"/,
		);

		const halfPair = ctx(fakeSdk(), ids, {
			provider: "KANTAR",
			config: {},
			secret: { login: "kantar-user" },
		});
		await expect(executeStep(kantarOp, halfPair)).rejects.toThrow(
			/missing its login\/password pair/,
		);
	});

	describe("credential-egress host allowlist at the POINT OF EGRESS (C22)", () => {
		/**
		 * Create-time plan validation is not enough, and a review proved it:
		 * job retry, live-channel start/restart, capture-vmaf and live-to-vod all
		 * replay an ALREADY-PERSISTED plan into the queue without revalidating.
		 * A plan authored while the allowlist was unset therefore reached the
		 * encoder unchecked once the operator configured one. These tests pin the
		 * check on the path every replay converges on.
		 */
		const kantarOp = (serverUrl: string): CompiledOperation => ({
			step: "kantar:encoding",
			kind: "CREATE_KANTAR_WATERMARK",
			payload: {
				credentialId: "00000000-0000-4000-8000-0000000000b1",
				licenseId: 4711,
				channelName: "Demo",
				contentReference: "ep01",
				serverUrl,
				reportPath: "reports",
			},
			refs: { encodingId: "encoding", reportOutputId: "output:origin" },
		});
		const ids = { encoding: "bm-enc", "output:origin": "bm-output" };
		const kantarCred = {
			provider: "KANTAR" as const,
			config: {},
			secret: { login: "kantar-user", password: "KANTAR-CANARY" },
		};

		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it("REFUSES the step when the host is not allowlisted", async () => {
			vi.stubEnv("SECRET_EGRESS_ALLOWED_HOSTS", "kantar.example.com");
			const sdk = fakeSdk();
			await expect(
				executeStep(
					kantarOp("https://attacker.example.net/wm"),
					ctx(sdk, ids, kantarCred),
				),
			).rejects.toThrow(/attacker\.example\.net/);
			// The pair must not have left, which is the whole point — asserting
			// only the throw would pass even if the call happened first.
			expect(sdk.createKantarWatermark).not.toHaveBeenCalled();
		});

		it("allows the step when the host IS allowlisted", async () => {
			vi.stubEnv("SECRET_EGRESS_ALLOWED_HOSTS", "kantar.example.com");
			const sdk = fakeSdk();
			await executeStep(
				kantarOp("https://kantar.example.com/wm"),
				ctx(sdk, ids, kantarCred),
			);
			expect(sdk.createKantarWatermark).toHaveBeenCalledTimes(1);
		});

		it("proceeds with no allowlist configured (fail-open, by design)", async () => {
			vi.stubEnv("SECRET_EGRESS_ALLOWED_HOSTS", "");
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const sdk = fakeSdk();
			await executeStep(
				kantarOp("https://whoever.example.net/wm"),
				ctx(sdk, ids, kantarCred),
			);
			expect(sdk.createKantarWatermark).toHaveBeenCalledTimes(1);
			// The worker is the process that POSTs the pair, so this is where the
			// unrestricted case has to be visible.
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("whoever.example.net"),
			);
			warn.mockRestore();
		});

		/**
		 * The ESAM half had NO test: a reviewer deleted the entire
		 * `assertSecretEgressAllowed` block from START_LIVE_ENCODING and all 327
		 * worker tests still passed. That is the heuristic this repo keeps
		 * relearning — "which changed behaviour would still pass every test if I
		 * deleted the implementation?" — and the answer was the exact half I had
		 * singled out as the one judgement call in the fix.
		 */
		const liveStartOp = (poisEndpoint: string, withCredential: boolean) =>
			({
				step: "start:live",
				kind: "START_LIVE_ENCODING",
				payload: {
					esamSettings: {
						poisEndpoint,
						acquisitionPointIdentity: "AP",
						...(withCredential
							? { poisCredentialId: "00000000-0000-4000-8000-0000000000c1" }
							: {}),
					},
				},
				refs: { encodingId: "encoding" },
			}) as unknown as CompiledOperation;

		it("REFUSES a live start whose POIS endpoint is not allowlisted", async () => {
			vi.stubEnv("SECRET_EGRESS_ALLOWED_HOSTS", "pois.example.com");
			const sdk = fakeSdk();
			await expect(
				executeStep(
					liveStartOp("https://attacker.example.net/esam", true),
					ctx(
						sdk,
						{ encoding: "bm-live-enc" },
						{
							provider: "POIS_ENDPOINT",
							config: {},
							secret: { username: "pois-user", password: "POIS-CANARY" },
						},
					),
				),
			).rejects.toThrow(/attacker\.example\.net/);
			// The pair must not have left — a throw after the call would pass a
			// test that only asserted the throw.
			expect(sdk.startLiveEncoding).not.toHaveBeenCalled();
		});

		it("allows an unauthenticated POIS endpoint outside the allowlist", async () => {
			// The carve-out, pinned as a DECISION rather than an omission: with no
			// poisCredentialId nothing vaulted egresses, and C22 scopes the rail by
			// "does a vaulted secret egress here", not by "is this field a URL".
			// Railing this case would extend the constraint past what it says.
			vi.stubEnv("SECRET_EGRESS_ALLOWED_HOSTS", "pois.example.com");
			const sdk = fakeSdk();
			await executeStep(
				liveStartOp("https://whoever.example.net/esam", false),
				ctx(sdk, { encoding: "bm-live-enc" }),
			);
			expect(sdk.startLiveEncoding).toHaveBeenCalledTimes(1);
		});

		it("REFUSES on a misconfigured allowlist rather than degrading to warn", async () => {
			vi.stubEnv("SECRET_EGRESS_ALLOWED_HOSTS", ",");
			const sdk = fakeSdk();
			await expect(
				executeStep(
					kantarOp("https://kantar.example.com/wm"),
					ctx(sdk, ids, kantarCred),
				),
			).rejects.toThrow(/lists no hostnames/);
			expect(sdk.createKantarWatermark).not.toHaveBeenCalled();
		});
	});

	it("refuses to execute a runtime record, naming the kind", async () => {
		// Compile-enforced but behaviourally untested until a review pointed it
		// out. The replay loop now skips these by KIND, so reaching the executor
		// means something upstream mis-seeded one — and re-firing signalling into
		// a live stream is worse than a loud failure.
		for (const kind of ["SCTE35_CUE", "ESAM_MEDIA_POINT"] as const) {
			await expect(
				executeStep(
					{
						step: `${kind.toLowerCase()}:x`,
						kind,
						payload: {},
						refs: {},
					} as CompiledOperation,
					ctx(fakeSdk(), {}),
				),
			).rejects.toThrow(`${kind} is a runtime record, not an executable step`);
		}
	});

	it("passes labels/infrastructure/staticIpId through CREATE_ENCODING", async () => {
		const sdk = fakeSdk();
		await executeStep(
			{
				step: "encoding",
				kind: "CREATE_ENCODING",
				payload: {
					name: "enc",
					// C18: an infrastructure-pinned encoding uses cloudRegion
					// EXTERNAL — the in-infrastructure region rides the
					// InfrastructureSettings block.
					cloudRegion: "EXTERNAL",
					encoderVersion: "STABLE",
					labels: ["p5", "cloud-connect"],
					infrastructure: {
						infrastructureId: "infra-1",
						cloudRegion: "AWS_AP_NORTHEAST_1",
					},
					staticIpId: "ip-1",
				},
				refs: {},
			},
			ctx(sdk, {}),
		);
		expect(sdk.createEncoding).toHaveBeenCalledWith({
			name: "enc",
			cloudRegion: "EXTERNAL",
			encoderVersion: "STABLE",
			labels: ["p5", "cloud-connect"],
			infrastructure: {
				infrastructureId: "infra-1",
				cloudRegion: "AWS_AP_NORTHEAST_1",
			},
			staticIpId: "ip-1",
		});
	});

	it("forwards aiSceneAnalysis with the asset-description output resolved", async () => {
		const sdk = fakeSdk();
		await executeStep(
			{
				step: "start",
				kind: "START_ENCODING",
				payload: {
					perTitle: { h264Configuration: { targetQualityCrf: 17 } },
					aiSceneAnalysis: {
						features: {
							assetDescription: {
								filename: "item-001.json",
								outputPath: "output/item-001/ai",
								acl: "PUBLIC_READ",
							},
							automaticAdPlacement: {
								allSceneBoundaries: { isEnabled: true, insertCueTags: true },
							},
							outputLanguageCodes: { outputLanguageCodes: ["ja", "ko"] },
						},
					},
				},
				refs: {
					encodingId: "encoding",
					aiAssetDescriptionOutputId: "output:origin",
				},
			},
			ctx(sdk, { encoding: "bm-enc", "output:origin": "bm-output" }),
		);
		expect(sdk.startEncoding).toHaveBeenCalledWith("bm-enc", {
			manifestGenerator: undefined,
			vodHlsManifestIds: undefined,
			vodDashManifestIds: undefined,
			vodSmoothManifestIds: undefined,
			perTitle: { h264Configuration: { targetQualityCrf: 17 } },
			encodingMode: undefined,
			aiSceneAnalysis: {
				assetDescription: {
					filename: "item-001.json",
					outputId: "bm-output",
					outputPath: "output/item-001/ai",
					acl: "PUBLIC_READ",
				},
				automaticAdPlacement: {
					allSceneBoundaries: { isEnabled: true, insertCueTags: true },
				},
				outputLanguageCodes: ["ja", "ko"],
			},
		});
	});

	it("fails loud when aiSceneAnalysis carries no assetDescription", async () => {
		const sdk = fakeSdk();
		await expect(
			executeStep(
				{
					step: "start",
					kind: "START_ENCODING",
					payload: { aiSceneAnalysis: { features: {} } },
					refs: { encodingId: "encoding" },
				},
				ctx(sdk, { encoding: "bm-enc" }),
			),
		).rejects.toThrow(/carries no assetDescription/);
		expect(sdk.startEncoding).not.toHaveBeenCalled();
	});

	describe("HLS variant audio group", () => {
		const variantOp = (audio?: string): CompiledOperation => ({
			step: "hls-variant:hls:v1080",
			kind: "CREATE_HLS_STREAM_INFO",
			payload: {
				...(audio !== undefined ? { audio } : {}),
				closedCaptions: "NONE",
				segmentPath: "video/1080p/",
				uri: "video_4000000.m3u8",
			},
			refs: {
				manifestId: "manifest:hls",
				encodingId: "encoding",
				streamId: "stream:v1080",
				muxingId: "muxing:v1080",
			},
		});
		const ids = {
			"manifest:hls": "bm-hls",
			encoding: "bm-enc",
			"stream:v1080": "bm-stream",
			"muxing:v1080": "bm-muxing",
		};

		it("an OMITTED audio group stays omitted on the wire — never an empty string", async () => {
			/*
			 * The compiler omits `audio` on a self-contained muxed-TS variant
			 * (C33: there is no EXT-X-MEDIA group to point at). The executor
			 * coerced that omission with `str(p.audio)` → "", and two paid AWS
			 * runs (cases 3 and 4) produced masters whose every variant read
			 * `AUDIO=""` — an attribute the API doc says MUST match a GROUP-ID.
			 * The TS bytes were correct; the signaling was not.
			 */
			const sdk = fakeSdk();
			await executeStep(variantOp(), ctx(sdk, ids));
			const [, payload] = vi.mocked(sdk.createHlsStreamInfo).mock.calls[0] as [
				string,
				Record<string, unknown>,
			];
			// `undefined`, never "". The key itself is still present on the
			// literal (an object spread does not erase it), and that is fine:
			// the facade hands this to `new StreamInfo(p)` and the client
			// JSON-serializes the model, which DROPS undefined-valued keys and
			// KEEPS empty strings — pinned against the installed SDK in
			// `ops/manifests.test.ts`. The first cut of this assertion checked
			// `"audio" in payload` and failed on the unmutated code, which is
			// how the real wire boundary got its own test.
			expect(payload.audio).toBeUndefined();
			expect(payload.closedCaptions).toBe("NONE");
		});

		it("a PRESENT audio group passes through unchanged", async () => {
			const sdk = fakeSdk();
			await executeStep(variantOp("audio"), ctx(sdk, ids));
			expect(sdk.createHlsStreamInfo).toHaveBeenCalledWith(
				"bm-hls",
				expect.objectContaining({ audio: "audio" }),
			);
		});
	});

	describe("VP9 QC mirror as a progressive WebM", () => {
		it("routes CREATE_MUXING_PROGRESSIVE_WEBM to the progressive-webm facade", async () => {
			const sdk = fakeSdk();
			const result = await executeStep(
				{
					step: "qc-muxing:v1080",
					kind: "CREATE_MUXING_PROGRESSIVE_WEBM",
					payload: {
						filename: "v1080.webm",
						outputPath: "output/x/video/1080p/qc/",
						name: "QC VMAF Mirror v1080",
					},
					refs: {
						encodingId: "encoding",
						streamId: "stream:v1080",
						outputId: "output:origin",
					},
				},
				ctx(sdk, {
					encoding: "bm-enc",
					"stream:v1080": "bm-stream",
					"output:origin": "bm-output",
				}),
			);
			expect(sdk.createProgressiveWebmMuxing).toHaveBeenCalledWith(
				"bm-enc",
				expect.objectContaining({
					streamId: "bm-stream",
					filename: "v1080.webm",
					name: "QC VMAF Mirror v1080",
				}),
			);
			expect(sdk.createMp4Muxing).not.toHaveBeenCalled();
			expect(result.resourceId).toBe("bm-1");
		});
	});

	describe("static WebM DASH representations", () => {
		const ids = {
			"manifest:dash": "bm-dash",
			"manifest:dash:period": "bm-period",
			"manifest:dash:aset-video": "bm-aset",
			"manifest:dash:rep:v1080": "bm-rep",
			encoding: "bm-enc",
			"muxing:v1080": "bm-muxing",
			"drm:v1080": "bm-drm",
		};

		it("routes CREATE_DASH_REPRESENTATION_WEBM to the webm endpoint", async () => {
			const sdk = fakeSdk();
			const result = await executeStep(
				{
					step: "manifest:dash:rep:v1080",
					kind: "CREATE_DASH_REPRESENTATION_WEBM",
					payload: { type: "TEMPLATE", segmentPath: "video/1080p/" },
					refs: {
						manifestId: "manifest:dash",
						periodId: "manifest:dash:period",
						adaptationSetId: "manifest:dash:aset-video",
						encodingId: "encoding",
						muxingId: "muxing:v1080",
					},
				},
				ctx(sdk, ids),
			);
			expect(sdk.createDashWebmRepresentation).toHaveBeenCalledWith(
				"bm-dash",
				"bm-period",
				"bm-aset",
				{
					type: "TEMPLATE",
					segmentPath: "video/1080p/",
					encodingId: "bm-enc",
					muxingId: "bm-muxing",
				},
			);
			expect(sdk.createDashFmp4Representation).not.toHaveBeenCalled();
			expect(result.resourceId).toBe("bm-1");
		});

		it("a content protection on a WebM representation names the webm endpoint", async () => {
			// The URL differs per representation kind; before this the executor
			// hard-coded FMP4, which was true only because no static WebM rep
			// could exist.
			const sdk = fakeSdk();
			await executeStep(
				{
					step: "manifest:dash:rep:v1080:cp",
					kind: "CREATE_DASH_CONTENT_PROTECTION",
					payload: { representationKind: "WEBM" },
					refs: {
						manifestId: "manifest:dash",
						periodId: "manifest:dash:period",
						adaptationSetId: "manifest:dash:aset-video",
						representationId: "manifest:dash:rep:v1080",
						drmId: "drm:v1080",
						encodingId: "encoding",
						muxingId: "muxing:v1080",
					},
				},
				ctx(sdk, ids),
			);
			expect(sdk.createDashContentProtection).toHaveBeenCalledWith(
				expect.objectContaining({ representationKind: "WEBM" }),
				expect.anything(),
			);
		});

		it("a content protection with NO kind stays FMP4 — every existing golden", async () => {
			const sdk = fakeSdk();
			await executeStep(
				{
					step: "manifest:dash:rep:v1080:cp",
					kind: "CREATE_DASH_CONTENT_PROTECTION",
					payload: {},
					refs: {
						manifestId: "manifest:dash",
						periodId: "manifest:dash:period",
						adaptationSetId: "manifest:dash:aset-video",
						representationId: "manifest:dash:rep:v1080",
						drmId: "drm:v1080",
						encodingId: "encoding",
						muxingId: "muxing:v1080",
					},
				},
				ctx(sdk, ids),
			);
			expect(sdk.createDashContentProtection).toHaveBeenCalledWith(
				expect.objectContaining({ representationKind: "FMP4" }),
				expect.anything(),
			);
		});
	});

	describe("per-title expansions", () => {
		const hlsExpansionOp: CompiledOperation = {
			step: "hls-pertitle:hls",
			kind: "CREATE_HLS_PER_TITLE_VARIANTS",
			payload: {
				muxingKind: "FMP4",
				subtitles: "SUBTITLE",
				streamModeFilter: "PER_TITLE_RESULT",
				audio: "audio",
				closedCaptions: "NONE",
				uriTemplate: "video_{avgBitrate}.m3u8",
				stripBase: "output/item/",
			},
			refs: { manifestId: "manifest:hls", encodingId: "encoding" },
		};
		const expansionIds = { "manifest:hls": "bm-hls", encoding: "bm-enc" };

		it("fails loud when an expansion matches zero muxings", async () => {
			const sdk = fakeSdk({
				listMuxings: vi.fn(() =>
					Promise.resolve([
						{
							id: "mux-template",
							streamId: "stream-template",
							outputPath: "output/item/video/template/",
						},
					]),
				),
				getStreamContext: vi.fn(() =>
					Promise.resolve({
						mode: "PER_TITLE_TEMPLATE",
						codecConfigId: "cfg",
					}),
				),
			});
			await expect(
				executeStep(hlsExpansionOp, ctx(sdk, expansionIds)),
			).rejects.toThrow(/no PER_TITLE_RESULT FMP4 muxings matched/);
			expect(sdk.createHlsStreamInfo).not.toHaveBeenCalled();
		});

		it.each([
			"FMP4",
			"TS",
			"MP4",
		])("creates HLS variants ONLY for PER_TITLE_RESULT %s muxings", async (muxingKind) => {
			const sdk = fakeSdk({
				listMuxings: vi.fn(() =>
					Promise.resolve([
						{
							id: "mux-result",
							streamId: "stream-result",
							outputPath: "output/item/video/540p_1200000_abc/",
							avgBitrate: 1_234_567,
						},
						{
							id: "mux-audio",
							streamId: "stream-audio",
							outputPath: "output/item/audio/",
							avgBitrate: 128_000,
						},
					]),
				),
				getStreamContext: vi.fn((_encodingId: string, streamId: string) =>
					Promise.resolve({
						mode:
							streamId === "stream-result" ? "PER_TITLE_RESULT" : "STANDARD",
						codecConfigId: "bm-codec",
					}),
				),
			});
			const result = await executeStep(
				{
					...hlsExpansionOp,
					payload: { ...hlsExpansionOp.payload, muxingKind },
				},
				ctx(sdk, expansionIds),
			);
			expect(sdk.listMuxings).toHaveBeenCalledWith("bm-enc", muxingKind);
			expect(sdk.createHlsStreamInfo).toHaveBeenCalledTimes(1);
			expect(sdk.createHlsStreamInfo).toHaveBeenCalledWith("bm-hls", {
				audio: "audio",
				subtitles: "SUBTITLE",
				closedCaptions: "NONE",
				segmentPath: "video/540p_1200000_abc/",
				uri: "video_1234567.m3u8",
				encodingId: "bm-enc",
				streamId: "stream-result",
				muxingId: "mux-result",
				drmId: undefined,
			});
			expect(result.response).toMatchObject({ created: 1 });
		});

		it("uses the codec bitrate for {codecBitrate} templates", async () => {
			const sdk = fakeSdk({
				listMuxings: vi.fn(() =>
					Promise.resolve([
						{
							id: "mux-result",
							streamId: "stream-result",
							outputPath: "output/item/video/x/",
						},
					]),
				),
				getStreamContext: vi.fn(() =>
					Promise.resolve({
						mode: "PER_TITLE_RESULT",
						codecConfigId: "bm-codec",
					}),
				),
				getVideoConfigBitrate: vi.fn(() => Promise.resolve(2_500_000)),
			});
			await executeStep(
				{
					...hlsExpansionOp,
					payload: {
						...hlsExpansionOp.payload,
						uriTemplate: "video_{codecBitrate}.m3u8",
					},
				},
				ctx(sdk, expansionIds),
			);
			expect(sdk.getVideoConfigBitrate).toHaveBeenCalledWith("bm-codec");
			expect(sdk.createHlsStreamInfo).toHaveBeenCalledWith(
				"bm-hls",
				expect.objectContaining({ uri: "video_2500000.m3u8" }),
			);
		});

		it("fails LOUD when a result muxing carries two same-kind DRMs", async () => {
			// Two CENC DRMs = two encrypted copies at two paths; a manifest entry
			// references one base path, and `drms[0]` would silently omit the other
			// copy's segments (review of PR #147 — the repo's fourth first-of-many
			// bug). No fixture produces this shape, which is why the guard exists.
			const sdk = fakeSdk({
				listMuxings: vi.fn(() =>
					Promise.resolve([{ id: "mux-dual", streamId: "s1" }]),
				),
				getStreamContext: vi.fn(() =>
					Promise.resolve({
						mode: "PER_TITLE_RESULT",
						codecConfigId: "bm-codec",
					}),
				),
				listMuxingDrm: vi.fn(() =>
					Promise.resolve([
						{ id: "drm-a", outputPath: "output/item/video/enc_a/" },
						{ id: "drm-b", outputPath: "output/item/video/enc_b/" },
					]),
				),
			});
			await expect(
				executeStep(
					{
						...hlsExpansionOp,
						payload: { ...hlsExpansionOp.payload, drm: { kind: "CENC" } },
					},
					ctx(sdk, expansionIds),
				),
			).rejects.toThrow(/carries 2 CENC DRMs/);
			expect(sdk.createHlsStreamInfo).not.toHaveBeenCalled();
		});

		it("derives DRM'd variant paths from the DRM output and skips DRM-less muxings", async () => {
			const sdk = fakeSdk({
				listMuxings: vi.fn(() =>
					Promise.resolve([
						// DRM owns the outputs — the muxing itself has none.
						{ id: "mux-drm", streamId: "s1", avgBitrate: 900_000 },
						{ id: "mux-nodrm", streamId: "s2", avgBitrate: 901_000 },
					]),
				),
				getStreamContext: vi.fn(() =>
					Promise.resolve({
						mode: "PER_TITLE_RESULT",
						codecConfigId: "bm-codec",
					}),
				),
				listMuxingDrm: vi.fn((_e: string, muxingId: string) =>
					Promise.resolve(
						muxingId === "mux-drm"
							? [{ id: "drm-1", outputPath: "output/item/video/drm_900/" }]
							: [],
					),
				),
			});
			await executeStep(
				{
					...hlsExpansionOp,
					payload: {
						...hlsExpansionOp.payload,
						muxingKind: "TS",
						drm: { kind: "FAIRPLAY" },
					},
				},
				ctx(sdk, expansionIds),
			);
			expect(sdk.listMuxingDrm).toHaveBeenCalledWith(
				"bm-enc",
				"mux-drm",
				"TS",
				"FAIRPLAY",
			);
			expect(sdk.createHlsStreamInfo).toHaveBeenCalledTimes(1);
			expect(sdk.createHlsStreamInfo).toHaveBeenCalledWith(
				"bm-hls",
				expect.objectContaining({
					segmentPath: "video/drm_900/",
					muxingId: "mux-drm",
					drmId: "drm-1",
				}),
			);
		});

		it("creates WEBM DASH representations plus content protection", async () => {
			const sdk = fakeSdk({
				listMuxings: vi.fn(() =>
					Promise.resolve([{ id: "mux-webm", streamId: "s1" }]),
				),
				getStreamContext: vi.fn(() =>
					Promise.resolve({
						mode: "PER_TITLE_RESULT",
						codecConfigId: "bm-codec",
					}),
				),
				listMuxingDrm: vi.fn(() =>
					Promise.resolve([
						{ id: "drm-webm", outputPath: "output/item/video/p/" },
					]),
				),
				createDashWebmRepresentation: vi.fn(() => Promise.resolve("rep-1")),
			});
			const result = await executeStep(
				{
					step: "manifest:dash:pertitle-reps",
					kind: "CREATE_DASH_PER_TITLE_REPRESENTATIONS",
					payload: {
						muxingKind: "WEBM",
						streamModeFilter: "PER_TITLE_RESULT",
						type: "TEMPLATE",
						stripBase: "output/item/",
						drm: { kind: "CENC" },
					},
					refs: {
						manifestId: "manifest:dash",
						periodId: "manifest:dash:period",
						adaptationSetId: "manifest:dash:aset-video",
						encodingId: "encoding",
					},
				},
				ctx(sdk, {
					"manifest:dash": "bm-dash",
					"manifest:dash:period": "bm-period",
					"manifest:dash:aset-video": "bm-aset",
					encoding: "bm-enc",
				}),
			);
			expect(sdk.createDashWebmRepresentation).toHaveBeenCalledWith(
				"bm-dash",
				"bm-period",
				"bm-aset",
				{
					type: "TEMPLATE",
					segmentPath: "video/p/",
					encodingId: "bm-enc",
					muxingId: "mux-webm",
				},
			);
			expect(sdk.createDashContentProtection).toHaveBeenCalledWith(
				{
					manifestId: "bm-dash",
					periodId: "bm-period",
					adaptationSetId: "bm-aset",
					representationId: "rep-1",
					representationKind: "WEBM",
				},
				{ drmId: "drm-webm", encodingId: "bm-enc", muxingId: "mux-webm" },
			);
			expect(result.response).toMatchObject({ created: 1 });
		});

		it("builds smooth entries from MP4 filenames and wires content protection", async () => {
			const sdk = fakeSdk({
				listMuxings: vi.fn(() =>
					Promise.resolve([
						{ id: "mux-mp4", streamId: "s1", filename: "video.ismv" },
					]),
				),
				getStreamContext: vi.fn(() =>
					Promise.resolve({
						mode: "PER_TITLE_RESULT",
						codecConfigId: "bm-codec",
					}),
				),
				listMuxingDrm: vi.fn(() =>
					Promise.resolve([
						{ id: "drm-mp4", outputPath: "output/smooth/video/540p_1200_x/" },
					]),
				),
			});
			await executeStep(
				{
					step: "manifest:smooth:pertitle",
					kind: "CREATE_SMOOTH_PER_TITLE_ENTRIES",
					payload: {
						muxingKind: "MP4",
						streamModeFilter: "PER_TITLE_RESULT",
						stripBase: "output/smooth/",
						language: "en",
						trackName: "video",
						drm: { kind: "CENC" },
					},
					refs: { manifestId: "manifest:smooth", encodingId: "encoding" },
				},
				ctx(sdk, { "manifest:smooth": "bm-smooth", encoding: "bm-enc" }),
			);
			expect(sdk.createSmoothMp4Representation).toHaveBeenCalledWith(
				"bm-smooth",
				{
					mediaFile: "video/540p_1200_x/video.ismv",
					language: "en",
					trackName: "video",
					encodingId: "bm-enc",
					muxingId: "mux-mp4",
				},
			);
			expect(sdk.createSmoothContentProtection).toHaveBeenCalledWith(
				"bm-smooth",
				{ drmId: "drm-mp4", encodingId: "bm-enc", muxingId: "mux-mp4" },
			);
		});

		it("fails loud when a result muxing has no derivable output path", async () => {
			const sdk = fakeSdk({
				listMuxings: vi.fn(() =>
					Promise.resolve([{ id: "mux-broken", streamId: "s1" }]),
				),
				getStreamContext: vi.fn(() =>
					Promise.resolve({
						mode: "PER_TITLE_RESULT",
						codecConfigId: "bm-codec",
					}),
				),
			});
			await expect(
				executeStep(hlsExpansionOp, ctx(sdk, expansionIds)),
			).rejects.toThrow(/has no output path/);
		});
	});

	it("attaches Dolby Vision stream HDR metadata with the sidecar ref", async () => {
		const sdk = fakeSdk();
		await executeStep(
			{
				step: "stream-hdr:v1080",
				kind: "CREATE_STREAM_HDR_DOLBY_VISION",
				payload: { profile: "DVHE_05", metadataSource: "INPUT_STREAM" },
				refs: {
					encodingId: "encoding",
					streamId: "stream:v1080",
					metadataInputStreamId: "dolby:dv-meta",
				},
			},
			ctx(sdk, {
				encoding: "bm-enc",
				"stream:v1080": "bm-stream",
				"dolby:dv-meta": "bm-meta",
			}),
		);
		expect(sdk.createDolbyVisionStreamHdr).toHaveBeenCalledWith(
			"bm-enc",
			"bm-stream",
			{
				profile: "DVHE_05",
				metadataSource: "INPUT_STREAM",
				metadataInputStreamId: "bm-meta",
			},
		);
	});

	it("routes smooth manifest start/await through the smooth facade", async () => {
		const statuses = ["RUNNING", "FINISHED"];
		const sdk = fakeSdk({
			getSmoothManifestStatus: vi.fn(() =>
				Promise.resolve({ status: statuses.shift() ?? "FINISHED" }),
			),
		});
		await executeStep(
			{
				step: "manifest-start:smooth",
				kind: "START_MANIFEST_SMOOTH",
				payload: { manifestGenerator: "V2" },
				refs: { manifestId: "manifest:smooth" },
			},
			ctx(sdk, { "manifest:smooth": "bm-smooth" }),
		);
		expect(sdk.startSmoothManifest).toHaveBeenCalledWith("bm-smooth", {
			manifestGenerator: "V2",
		});
		const result = await executeStep(
			{
				step: "manifest-await:smooth",
				kind: "AWAIT_MANIFEST_SMOOTH",
				payload: {},
				refs: { manifestId: "manifest:smooth" },
			},
			ctx(sdk, { "manifest:smooth": "bm-smooth" }),
		);
		expect(result.response).toMatchObject({ status: "FINISHED" });
	});

	it("skips re-starting a smooth manifest already started in the crash window", async () => {
		const sdk = fakeSdk({
			getSmoothManifestStatus: vi.fn(() =>
				Promise.resolve({ status: "RUNNING" }),
			),
		});
		const result = await executeStep(
			{
				step: "manifest-start:smooth",
				kind: "START_MANIFEST_SMOOTH",
				payload: { manifestGenerator: "V2" },
				refs: { manifestId: "manifest:smooth" },
			},
			ctx(sdk, { "manifest:smooth": "bm-smooth" }),
			{ wasRunning: true },
		);
		expect(sdk.startSmoothManifest).not.toHaveBeenCalled();
		expect(result.response).toMatchObject({ resumed: true });
	});

	it("polls AWAIT_ENCODING until FINISHED", async () => {
		const statuses = ["RUNNING", "RUNNING", "FINISHED"];
		const sdk = fakeSdk({
			getEncodingStatus: vi.fn(() =>
				Promise.resolve({ status: statuses.shift() ?? "FINISHED" }),
			),
		});
		const result = await executeStep(
			{
				step: "await:encoding",
				kind: "AWAIT_ENCODING",
				payload: {},
				refs: { encodingId: "encoding" },
			},
			ctx(sdk, { encoding: "bm-enc" }),
		);
		expect(sdk.getEncodingStatus).toHaveBeenCalledTimes(3);
		expect(result.response).toMatchObject({ status: "FINISHED" });
	});

	describe("CAPTURE_PER_TITLE_RESULTS", () => {
		const captureOp = (templates: unknown[] = []) => ({
			step: "per-title-results",
			kind: "CAPTURE_PER_TITLE_RESULTS" as const,
			payload: { streamModeFilter: "PER_TITLE_RESULT", templates },
			refs: { encodingId: "encoding" },
		});

		it("captures the RESULT streams with their configs and muxings", async () => {
			const sdk = fakeSdk({
				listEncodingStreams: vi.fn(() =>
					Promise.resolve({
						items: [
							{ streamId: "s-tpl", mode: "PER_TITLE_TEMPLATE" },
							{
								streamId: "s-res",
								mode: "PER_TITLE_RESULT",
								codecConfigId: "cfg-res",
								appliedSettings: { width: 1920, height: 1080 },
							},
						],
						complete: true,
					}),
				),
				listAllMuxings: vi.fn(() =>
					Promise.resolve({
						items: [
							{
								muxingId: "m1",
								muxingType: "FMP4",
								streamIds: ["s-res"],
								avgBitrate: 4_200_000,
								segmentsMuxed: 120,
								// The resolved C4 path — the one thing about a result the plan
								// can never state, since the template carries placeholders.
								outputs: [
									{
										outputId: "out-1",
										outputPath: "video/1080p_4200000_a1b2c3/",
									},
								],
								drm: [],
							},
						],
						complete: true,
					}),
				),
				getCodecConfigDetail: vi.fn(() =>
					Promise.resolve({
						codecType: "H264",
						params: { bitrate: 4_200_000, profile: "HIGH" },
					}),
				),
			});
			const result = await executeStep(
				captureOp([{ rendition: "v1080", codec: "H264" }]),
				ctx(sdk, { encoding: "bm-enc" }),
			);
			const outcome = perTitleCaptureOutcomeSchema.parse(result.response);
			expect(outcome.captured).toBe(true);
			if (!outcome.captured) {
				return;
			}
			expect(sdk.listEncodingStreams).toHaveBeenCalledWith("bm-enc");
			expect(outcome.snapshot.streams).toHaveLength(1);
			const row = outcome.snapshot.streams[0];
			expect(row?.streamId).toBe("s-res");
			// The template row must NOT appear — it is intent, not result.
			expect(row?.params).toEqual({ bitrate: 4_200_000, profile: "HIGH" });
			expect(row?.muxings[0]?.segmentsMuxed).toBe(120);
			// Captured through the whole chain: stream → muxing → output → path.
			expect(row?.muxings[0]?.outputs).toEqual([
				{ outputId: "out-1", outputPath: "video/1080p_4200000_a1b2c3/" },
			]);
			// Attributed as the sole H264 candidate the payload declared.
			expect(row?.templateRendition).toBe("v1080");
			expect(outcome.snapshot.scan).toMatchObject({
				streamsListed: 2,
				templatesListed: 1,
				resultsCaptured: 1,
				unattributed: 0,
			});
		});

		it("records a capture failure in the response instead of failing the job", async () => {
			// The encode has already SUCCEEDED when this step runs. Throwing here
			// would turn a good encoding into a failed job over a metadata read.
			const sdk = fakeSdk({
				listEncodingStreams: vi.fn(() =>
					Promise.reject(new Error("502 Bad Gateway")),
				),
			});
			const result = await executeStep(
				captureOp(),
				ctx(sdk, { encoding: "bm-enc" }),
			);
			const outcome = perTitleCaptureOutcomeSchema.parse(result.response);
			expect(outcome.captured).toBe(false);
			if (outcome.captured) {
				return;
			}
			// And it says WHY, in the step log, where an operator can read it.
			expect(outcome.error).toContain("502");
		});

		it("says so in the scan when the payload declared no usable templates", async () => {
			// The executor parses the template list out of the PERSISTED payload, and a
			// payload from an older build no longer parses. Attribution then abstains
			// on every row — and `templatesDeclared: 0` beside `templatesListed: 1` is
			// what tells a reader that we asked with nothing, rather than that the API
			// reported no templates.
			const sdk = fakeSdk({
				listEncodingStreams: vi.fn(() =>
					Promise.resolve({
						items: [
							{ streamId: "s-tpl", mode: "PER_TITLE_TEMPLATE" },
							{
								streamId: "s-res",
								mode: "PER_TITLE_RESULT",
								codecConfigId: "c",
							},
						],
						complete: true,
					}),
				),
				getCodecConfigDetail: vi.fn(() =>
					Promise.resolve({ codecType: "H264", params: {} }),
				),
			});
			const result = await executeStep(
				{
					...captureOp(),
					// The shape PR 4a emitted, before the measured finding removed it.
					payload: {
						templates: [
							{ rendition: "v1080", codec: "H264", streamName: "Stream H264" },
						],
					},
				},
				ctx(sdk, { encoding: "bm-enc" }),
			);
			const outcome = perTitleCaptureOutcomeSchema.parse(result.response);
			expect(outcome.captured).toBe(true);
			if (!outcome.captured) {
				return;
			}
			expect(outcome.snapshot.scan).toMatchObject({
				templatesListed: 1,
				templatesDeclared: 0,
				unattributed: 1,
			});
		});

		it("ignores a payload whose templates are the wrong shape", async () => {
			// The step log is data on disk; a hand-edited or older entry must not be
			// able to steer attribution through arbitrary shapes.
			const sdk = fakeSdk({
				listEncodingStreams: vi.fn(() =>
					Promise.resolve({
						items: [
							{
								streamId: "s-res",
								mode: "PER_TITLE_RESULT",
								codecConfigId: "c",
							},
						],
						complete: true,
					}),
				),
				getCodecConfigDetail: vi.fn(() =>
					Promise.resolve({ codecType: "H264", params: {} }),
				),
			});
			const result = await executeStep(
				{
					...captureOp(),
					payload: { templates: [{ rendition: 7 }, "nonsense"] },
				},
				ctx(sdk, { encoding: "bm-enc" }),
			);
			const outcome = perTitleCaptureOutcomeSchema.parse(result.response);
			expect(outcome.captured).toBe(true);
			if (!outcome.captured) {
				return;
			}
			// Captured, unattributed — not crashed, and not attributed to garbage.
			expect(outcome.snapshot.scan.resultsCaptured).toBe(1);
			expect(outcome.snapshot.scan.unattributed).toBe(1);
		});

		it("is read-only — no create/start call is made", async () => {
			const sdk = fakeSdk();
			await executeStep(captureOp(), ctx(sdk, { encoding: "bm-enc" }));
			// What makes the step safe to re-run on crash-resume.
			expect(sdk.startEncoding).not.toHaveBeenCalled();
			expect(sdk.createStream).not.toHaveBeenCalled();
		});
	});

	it("surfaces encoder error messages on AWAIT failure", async () => {
		const sdk = fakeSdk({
			getEncodingStatus: vi.fn(() =>
				Promise.resolve({
					status: "ERROR",
					messages: ["Input file not found"],
				}),
			),
		});
		await expect(
			executeStep(
				{
					step: "await:encoding",
					kind: "AWAIT_ENCODING",
					payload: {},
					refs: { encodingId: "encoding" },
				},
				ctx(sdk, { encoding: "bm-enc" }),
			),
		).rejects.toThrow(/ended ERROR: Input file not found/);
	});

	it("treats TRANSFER_ERROR as terminal", async () => {
		const sdk = fakeSdk({
			getEncodingStatus: vi.fn(() =>
				Promise.resolve({ status: "TRANSFER_ERROR" }),
			),
		});
		await expect(
			executeStep(
				{
					step: "await:encoding",
					kind: "AWAIT_ENCODING",
					payload: {},
					refs: { encodingId: "encoding" },
				},
				ctx(sdk, { encoding: "bm-enc" }),
			),
		).rejects.toThrow(/TRANSFER_ERROR/);
	});

	it("skips re-starting after a crash window when the encoding already runs", async () => {
		const sdk = fakeSdk({
			getEncodingStatus: vi.fn(() => Promise.resolve({ status: "RUNNING" })),
		});
		const result = await executeStep(
			{
				step: "start",
				kind: "START_ENCODING",
				payload: { manifestGenerator: "V2" },
				refs: { encodingId: "encoding" },
			},
			ctx(sdk, { encoding: "bm-enc" }),
			{ wasRunning: true },
		);
		expect(sdk.startEncoding).not.toHaveBeenCalled();
		expect(result.response).toMatchObject({ resumed: true });
	});

	it("still starts when the crash-window check finds CREATED", async () => {
		const sdk = fakeSdk({
			getEncodingStatus: vi.fn(() => Promise.resolve({ status: "CREATED" })),
		});
		await executeStep(
			{
				step: "start",
				kind: "START_ENCODING",
				payload: {},
				refs: { encodingId: "encoding" },
			},
			ctx(sdk, { encoding: "bm-enc" }),
			{ wasRunning: true },
		);
		expect(sdk.startEncoding).toHaveBeenCalled();
	});

	it("snapshots resolved ref ids in the request", async () => {
		const sdk = fakeSdk();
		const result = await executeStep(
			{
				step: "await:encoding",
				kind: "AWAIT_ENCODING",
				payload: {},
				refs: { encodingId: "encoding" },
			},
			ctx(sdk, { encoding: "bm-enc" }),
		);
		expect(result.request).toMatchObject({ refs: { encodingId: "bm-enc" } });
	});

	it("times out a never-finishing AWAIT", async () => {
		const sdk = fakeSdk({
			getEncodingStatus: vi.fn(() => Promise.resolve({ status: "RUNNING" })),
		});
		await expect(
			executeStep(
				{
					step: "await:encoding",
					kind: "AWAIT_ENCODING",
					payload: {},
					refs: { encodingId: "encoding" },
				},
				{
					...ctx(sdk, { encoding: "bm-enc" }),
					poll: { intervalMs: 1, timeoutMs: 0, sleep: () => Promise.resolve() },
				},
			),
		).rejects.toThrow(/timed out/);
	});

	describe("live operations", () => {
		const SRT_CRED: ResolvedCredential = {
			provider: "SRT_PASSPHRASE",
			config: {},
			secret: { passphrase: "0123456789abcdef0123456789abcdef" },
		};
		const ZIXI_CRED: ResolvedCredential = {
			provider: "ZIXI",
			config: {},
			secret: { password: "ZIXI-PASSWORD", decryptionKey: "ZIXI-DECRYPT-KEY" },
		};

		it("resolves the account-default RTMP input by listing (no POST exists)", async () => {
			const sdk = fakeSdk({
				listRtmpInputs: vi.fn(() =>
					Promise.resolve([{ id: "bm-rtmp-1", name: "Default" }]),
				),
			});
			const result = await executeStep(
				{
					step: "live-input:main",
					kind: "CREATE_INPUT_RTMP",
					payload: {},
					refs: {},
				},
				ctx(sdk),
			);
			expect(result.resourceId).toBe("bm-rtmp-1");
			expect(result.response).toMatchObject({
				id: "bm-rtmp-1",
				resolved: "account-default",
				available: 1,
			});
		});

		it("uses a plan-pinned RTMP input id verbatim, without listing (ledger #6)", async () => {
			// Pinning is what makes a multi-input account usable — the pinned
			// path must not touch listRtmpInputs at all (the list is exactly
			// what forces the single-input restriction).
			const sdk = fakeSdk({
				listRtmpInputs: vi.fn(() =>
					Promise.resolve([{ id: "bm-rtmp-1" }, { id: "bm-rtmp-2" }]),
				),
			});
			const result = await executeStep(
				{
					step: "live-input:main",
					kind: "CREATE_INPUT_RTMP",
					payload: { inputId: "bm-rtmp-2" },
					refs: {},
				},
				ctx(sdk),
			);
			expect(result.resourceId).toBe("bm-rtmp-2");
			expect(result.response).toMatchObject({
				id: "bm-rtmp-2",
				resolved: "plan-pinned",
			});
			expect(sdk.listRtmpInputs).not.toHaveBeenCalled();
		});

		it("refuses ambiguity when the account has several RTMP inputs", async () => {
			// List order is not contractual — silently binding the channel to
			// inputs[0] would pick an arbitrary ingest endpoint.
			const sdk = fakeSdk({
				listRtmpInputs: vi.fn(() =>
					Promise.resolve([
						{ id: "bm-rtmp-1", name: "Default" },
						{ id: "bm-rtmp-2", name: "Second" },
					]),
				),
			});
			await expect(
				executeStep(
					{
						step: "live-input:main",
						kind: "CREATE_INPUT_RTMP",
						payload: {},
						refs: {},
					},
					ctx(sdk),
				),
			).rejects.toThrow(/2 RTMP inputs \(bm-rtmp-1, bm-rtmp-2\)/);
		});

		it("fails with a clear error when the account has no RTMP input", async () => {
			const sdk = fakeSdk({
				listRtmpInputs: vi.fn(() => Promise.resolve([])),
			});
			await expect(
				executeStep(
					{
						step: "live-input:main",
						kind: "CREATE_INPUT_RTMP",
						payload: {},
						refs: {},
					},
					ctx(sdk),
				),
			).rejects.toThrow(/has no RTMP input to resolve/);
		});

		it("forwards redundant RTMP ingest points untouched", async () => {
			const sdk = fakeSdk();
			const result = await executeStep(
				{
					step: "live-input:main",
					kind: "CREATE_INPUT_REDUNDANT_RTMP",
					payload: {
						name: "Redundant RTMP Input",
						delayThreshold: 10,
						ingestPoints: [
							{ applicationName: "primary", streamKey: "streamOne" },
							{ applicationName: "backup", streamKey: "streamTwo" },
						],
					},
					refs: {},
				},
				ctx(sdk),
			);
			expect(sdk.createRedundantRtmpInput).toHaveBeenCalledWith({
				name: "Redundant RTMP Input",
				delayThreshold: 10,
				ingestPoints: [
					{ applicationName: "primary", streamKey: "streamOne" },
					{ applicationName: "backup", streamKey: "streamTwo" },
				],
				staticIngestPoints: undefined,
			});
			expect(result.resourceId).toBe("bm-1");
		});

		it("resolves the SRT passphrase from the vault without leaking it into the snapshot", async () => {
			const sdk = fakeSdk();
			const result = await executeStep(
				{
					step: "live-input:main",
					kind: "CREATE_INPUT_SRT",
					payload: {
						name: "SRT Input",
						mode: "LISTENER",
						port: 2088,
						latency: 120,
						credentialId: "00000000-0000-4000-8000-000000000007",
						keyLength: 256,
					},
					refs: {},
				},
				ctx(sdk, {}, SRT_CRED),
			);
			expect(sdk.createSrtInput).toHaveBeenCalledWith(
				expect.objectContaining({
					name: "SRT Input",
					mode: "LISTENER",
					port: 2088,
					passphrase: "0123456789abcdef0123456789abcdef",
					keyLength: 256,
				}),
			);
			expect(JSON.stringify(result.request)).not.toContain("0123456789abcdef");
			expect(JSON.stringify(result.response)).not.toContain("0123456789abcdef");
		});

		it("resolves backup SRT passphrases too", async () => {
			const sdk = fakeSdk();
			await executeStep(
				{
					step: "live-input:main",
					kind: "CREATE_INPUT_SRT",
					payload: {
						name: "SRT Input",
						mode: "LISTENER",
						port: 2088,
						backupSrtInputs: {
							delayThreshold: 9,
							srtInputs: [
								{
									mode: "CALLER",
									host: "backup.example.com",
									port: 7001,
									credentialId: "00000000-0000-4000-8000-000000000007",
									keyLength: 256,
								},
							],
						},
					},
					refs: {},
				},
				ctx(sdk, {}, SRT_CRED),
			);
			expect(sdk.createSrtInput).toHaveBeenCalledWith(
				expect.objectContaining({
					passphrase: undefined,
					backupSrtInputs: {
						delayThreshold: 9,
						srtInputs: [
							expect.objectContaining({
								mode: "CALLER",
								host: "backup.example.com",
								passphrase: "0123456789abcdef0123456789abcdef",
							}),
						],
					},
				}),
			);
		});

		it("rejects non-SRT credentials on SRT inputs (provider mismatch)", async () => {
			const sdk = fakeSdk();
			await expect(
				executeStep(
					{
						step: "live-input:main",
						kind: "CREATE_INPUT_SRT",
						payload: {
							name: "SRT Input",
							mode: "LISTENER",
							port: 2088,
							credentialId: "00000000-0000-4000-8000-000000000007",
						},
						refs: {},
					},
					ctx(sdk), // default credential is AWS_S3
				),
			).rejects.toThrow(/needs an SRT_PASSPHRASE credential/);
			expect(sdk.createSrtInput).not.toHaveBeenCalled();
		});

		it("rejects SRT credentials without a passphrase — never falls back to empty", async () => {
			const sdk = fakeSdk();
			await expect(
				executeStep(
					{
						step: "live-input:main",
						kind: "CREATE_INPUT_SRT",
						payload: {
							name: "SRT Input",
							mode: "LISTENER",
							port: 2088,
							credentialId: "00000000-0000-4000-8000-000000000007",
						},
						refs: {},
					},
					ctx(sdk, {}, { provider: "SRT_PASSPHRASE", config: {}, secret: {} }),
				),
			).rejects.toThrow(/carries no passphrase/);
		});

		it("rejects a keyLength that does not match the vaulted passphrase length", async () => {
			const sdk = fakeSdk();
			await expect(
				executeStep(
					{
						step: "live-input:main",
						kind: "CREATE_INPUT_SRT",
						payload: {
							name: "SRT Input",
							mode: "LISTENER",
							port: 2088,
							credentialId: "00000000-0000-4000-8000-000000000007",
							// AES-128 needs 16 chars; the vault holds 32.
							keyLength: 128,
						},
						refs: {},
					},
					ctx(sdk, {}, SRT_CRED),
				),
			).rejects.toThrow(/keyLength 128 needs a 16-char passphrase/);
			expect(sdk.createSrtInput).not.toHaveBeenCalled();
		});

		it("resolves Zixi password/decryptionKey from the vault without leaking them", async () => {
			const sdk = fakeSdk();
			const result = await executeStep(
				{
					step: "live-input:main",
					kind: "CREATE_INPUT_ZIXI",
					payload: {
						name: "Zixi Input",
						host: "zixi-feeder.example.com",
						port: 2077,
						stream: "channelOne",
						credentialId: "00000000-0000-4000-8000-000000000004",
						latency: 4000,
						minBitrate: 800000,
						decryptionType: "AES_128",
					},
					refs: {},
				},
				ctx(sdk, {}, ZIXI_CRED),
			);
			expect(sdk.createZixiInput).toHaveBeenCalledWith({
				name: "Zixi Input",
				host: "zixi-feeder.example.com",
				port: 2077,
				stream: "channelOne",
				password: "ZIXI-PASSWORD",
				decryptionKey: "ZIXI-DECRYPT-KEY",
				latency: 4000,
				minBitrate: 800000,
				decryptionType: "AES_128",
			});
			expect(JSON.stringify(result.request)).not.toContain("ZIXI-");
			expect(JSON.stringify(result.response)).not.toContain("ZIXI-");
		});

		it("rejects non-Zixi credentials on Zixi inputs (provider mismatch)", async () => {
			const sdk = fakeSdk();
			await expect(
				executeStep(
					{
						step: "live-input:main",
						kind: "CREATE_INPUT_ZIXI",
						payload: {
							name: "Zixi Input",
							host: "h",
							port: 1,
							stream: "s",
							credentialId: "00000000-0000-4000-8000-000000000004",
						},
						refs: {},
					},
					ctx(sdk),
				),
			).rejects.toThrow(/needs a ZIXI credential/);
		});

		it("rejects Zixi credentials carrying neither password nor decryptionKey", async () => {
			const sdk = fakeSdk();
			await expect(
				executeStep(
					{
						step: "live-input:main",
						kind: "CREATE_INPUT_ZIXI",
						payload: {
							name: "Zixi Input",
							host: "h",
							port: 1,
							stream: "s",
							credentialId: "00000000-0000-4000-8000-000000000004",
						},
						refs: {},
					},
					ctx(sdk, {}, { provider: "ZIXI", config: {}, secret: {} }),
				),
			).rejects.toThrow(/neither password nor decryptionKey/);
			expect(sdk.createZixiInput).not.toHaveBeenCalled();
		});

		it("creates HLS live inputs without any credential", async () => {
			const sdk = fakeSdk();
			const resolveCredential = vi.fn();
			await executeStep(
				{
					step: "live-input:main",
					kind: "CREATE_INPUT_HLS_LIVE",
					payload: {
						name: "HLS Input",
						url: "https://origin.example.com/live/stream.m3u8",
						adMarkersSource: "MANIFEST",
					},
					refs: {},
				},
				{ ...ctx(sdk), resolveCredential },
			);
			expect(sdk.createHlsLiveInput).toHaveBeenCalledWith({
				name: "HLS Input",
				url: "https://origin.example.com/live/stream.m3u8",
				adMarkersSource: "MANIFEST",
			});
			expect(resolveCredential).not.toHaveBeenCalled();
		});

		const startLiveOp: CompiledOperation = {
			step: "start",
			kind: "START_LIVE_ENCODING",
			payload: {
				streamKey: "myStreamKey",
				hlsManifests: {
					// Deliberately NOT in ref order in the object literal — the
					// zip must key by plan manifest key, not object position.
					backupHls: { timeshift: 300 },
					mainHls: { timeshift: 7200, insertProgramDateTime: true },
				},
				dashManifests: {
					mainDash: { timeshift: 7200, suggestedPresentationDelay: 6000 },
				},
				manifestGenerator: "V2",
				reuploadSettings: { muxingInitFileInterval: null },
			},
			refs: {
				encodingId: "encoding",
				liveHlsManifestIds: ["manifest:mainHls", "manifest:backupHls"],
				liveDashManifestIds: ["manifest:mainDash"],
			},
		};
		const startLiveIds = {
			encoding: "bm-enc",
			"manifest:mainHls": "bm-hls-main",
			"manifest:backupHls": "bm-hls-backup",
			"manifest:mainDash": "bm-dash-main",
		};

		it.each([
			"HD",
			"CUSTOM",
		] as const)("forwards the resolved %s option without recalculating it", async (encodingOption) => {
			const sdk = fakeSdk();
			await executeStep(
				{ ...startLiveOp, payload: { ...startLiveOp.payload, encodingOption } },
				ctx(sdk, startLiveIds),
			);
			expect(sdk.startLiveEncoding).toHaveBeenCalledWith(
				"bm-enc",
				expect.objectContaining({ encodingOption }),
			);
		});

		it("zips per-manifest start options onto the right manifest ids", async () => {
			const sdk = fakeSdk({
				getEncodingStatus: vi.fn(() => Promise.resolve({ status: "CREATED" })),
			});
			const result = await executeStep(startLiveOp, ctx(sdk, startLiveIds));
			expect(sdk.startLiveEncoding).toHaveBeenCalledWith("bm-enc", {
				streamKey: "myStreamKey",
				hlsManifests: [
					{
						manifestId: "bm-hls-main",
						timeshift: 7200,
						insertProgramDateTime: true,
					},
					{ manifestId: "bm-hls-backup", timeshift: 300 },
				],
				dashManifests: [
					{
						manifestId: "bm-dash-main",
						timeshift: 7200,
						suggestedPresentationDelay: 6000,
					},
				],
				liveEncodingMode: undefined,
				reuploadSettings: { muxingInitFileInterval: null },
				manifestGenerator: "V2",
				autoRestartConfiguration: undefined,
				autoShutdownConfiguration: undefined,
				esamSettings: undefined,
				cacheControlSettings: undefined,
				adInsertionSettings: undefined,
			});
			expect(result.response).toMatchObject({ started: true });
		});

		it("threads PDT settings, cacheControl and adInsertion onto the start request", async () => {
			const sdk = fakeSdk({
				getEncodingStatus: vi.fn(() => Promise.resolve({ status: "CREATED" })),
			});
			await executeStep(
				{
					...startLiveOp,
					payload: {
						...startLiveOp.payload,
						hlsManifests: {
							mainHls: {
								timeshift: 7200,
								programDateTimeSettings: {
									source: "SYSTEM_CLOCK",
									placement: { mode: "SECONDS_INTERVAL", interval: 30 },
								},
							},
							backupHls: { timeshift: 300 },
						},
						cacheControlSettings: {
							hls: { variantPlaylist: { cacheControl: "max-age=2" } },
						},
						adInsertionSettings: {
							enableEsamMediaPointInsertion: true,
							clockSynchronizationMode: "SYSTEM_CLOCK",
						},
					},
				},
				ctx(sdk, startLiveIds),
			);
			expect(sdk.startLiveEncoding).toHaveBeenCalledWith(
				"bm-enc",
				expect.objectContaining({
					hlsManifests: [
						{
							manifestId: "bm-hls-main",
							timeshift: 7200,
							programDateTimeSettings: {
								source: "SYSTEM_CLOCK",
								placement: { mode: "SECONDS_INTERVAL", interval: 30 },
							},
						},
						{ manifestId: "bm-hls-backup", timeshift: 300 },
					],
					cacheControlSettings: {
						hls: { variantPlaylist: { cacheControl: "max-age=2" } },
					},
					adInsertionSettings: {
						enableEsamMediaPointInsertion: true,
						clockSynchronizationMode: "SYSTEM_CLOCK",
					},
				}),
			);
		});

		it("resolves the POIS basic-auth pair from the vault at start (payload keeps only the ref)", async () => {
			const sdk = fakeSdk({
				getEncodingStatus: vi.fn(() => Promise.resolve({ status: "CREATED" })),
			});
			const context = ctx(sdk, startLiveIds, {
				provider: "POIS_ENDPOINT",
				config: {},
				secret: { username: "pois-user", password: "pois-pass" },
			});
			await executeStep(
				{
					...startLiveOp,
					payload: {
						...startLiveOp.payload,
						esamSettings: {
							poisEndpoint: "https://pois.example.com/esam",
							acquisitionPointIdentity: "ap-1",
							zoneIdentity: "zone-1",
							adAvailOffset: 250,
							poisCredentialId: "00000000-0000-4000-8000-0000000000e5",
						},
					},
				},
				context,
			);
			expect(context.resolveCredential).toHaveBeenCalledWith(
				"00000000-0000-4000-8000-0000000000e5",
			);
			expect(sdk.startLiveEncoding).toHaveBeenCalledWith(
				"bm-enc",
				expect.objectContaining({
					esamSettings: {
						poisEndpoint: "https://pois.example.com/esam",
						acquisitionPointIdentity: "ap-1",
						zoneIdentity: "zone-1",
						adAvailOffset: 250,
						username: "pois-user",
						password: "pois-pass",
					},
				}),
			);
			// The compiled payload (what the step log persists) never carries
			// the pair — only the vault ref.
			const [, sent] = vi.mocked(sdk.startLiveEncoding).mock.calls[0] ?? [];
			expect(JSON.stringify(startLiveOp.payload)).not.toContain("pois-pass");
			expect(sent).toBeDefined();
		});

		it("refuses a non-POIS credential and a pair-less POIS credential", async () => {
			const wrongProvider = ctx(
				fakeSdk({
					getEncodingStatus: vi.fn(() =>
						Promise.resolve({ status: "CREATED" }),
					),
				}),
				startLiveIds,
				{
					provider: "SRT_PASSPHRASE",
					config: {},
					secret: { passphrase: "0123456789abcdef" },
				},
			);
			const withEsam = {
				...startLiveOp,
				payload: {
					...startLiveOp.payload,
					esamSettings: {
						poisEndpoint: "https://pois.example.com/esam",
						poisCredentialId: "00000000-0000-4000-8000-0000000000e5",
					},
				},
			};
			await expect(executeStep(withEsam, wrongProvider)).rejects.toThrow(
				/needs a POIS_ENDPOINT credential but got provider "SRT_PASSPHRASE"/,
			);
			const halfPair = ctx(
				fakeSdk({
					getEncodingStatus: vi.fn(() =>
						Promise.resolve({ status: "CREATED" }),
					),
				}),
				startLiveIds,
				{
					provider: "POIS_ENDPOINT",
					config: {},
					secret: { username: "pois-user" },
				},
			);
			await expect(executeStep(withEsam, halfPair)).rejects.toThrow(
				/missing its username\/password pair/,
			);
		});

		it("fails loud when a referenced manifest has no start-options entry", async () => {
			const sdk = fakeSdk();
			const broken: CompiledOperation = {
				...startLiveOp,
				payload: {
					...startLiveOp.payload,
					hlsManifests: { mainHls: { timeshift: 7200 } }, // backupHls missing
				},
			};
			await expect(executeStep(broken, ctx(sdk, startLiveIds))).rejects.toThrow(
				/no start options entry for manifest key "backupHls"/,
			);
			expect(sdk.startLiveEncoding).not.toHaveBeenCalled();
		});

		it.each([
			undefined,
			"HD",
		] as const)("skips re-starting a %s live encoding already started in the crash window", async (encodingOption) => {
			for (const status of ["QUEUED", "RUNNING"]) {
				const sdk = fakeSdk({
					getEncodingStatus: vi.fn(() => Promise.resolve({ status })),
				});
				const result = await executeStep(
					{
						...startLiveOp,
						payload: {
							...startLiveOp.payload,
							...(encodingOption ? { encodingOption } : {}),
						},
					},
					ctx(sdk, startLiveIds),
					{
						wasRunning: true,
					},
				);
				expect(sdk.startLiveEncoding).not.toHaveBeenCalled();
				expect(result.response).toMatchObject({ resumed: true, status });
			}
		});

		it("still starts when the crash-window check finds CREATED", async () => {
			const sdk = fakeSdk({
				getEncodingStatus: vi.fn(() => Promise.resolve({ status: "CREATED" })),
			});
			await executeStep(startLiveOp, ctx(sdk, startLiveIds), {
				wasRunning: true,
			});
			expect(sdk.startLiveEncoding).toHaveBeenCalled();
		});

		it("diagnoses an input-not-found (2025) start failure with the BAKED vs resolvable ids", async () => {
			const sdk = fakeSdk({
				getEncodingStatus: vi.fn(() => Promise.resolve({ status: "CREATED" })),
				// Reject with what the FACADE now produces (review catch R3):
				// sdk-ops rethrows a BitmovinCallError whose message is
				// `<METHOD> <path> failed (<status>): <shortMessage> (code N)`
				// — a bare SDK message never reaches the executor any more. The
				// C13 diagnosis gate must still match through that wrapper.
				startLiveEncoding: vi.fn(() =>
					Promise.reject(
						new BitmovinCallError(
							"POST",
							"/encoding/encodings/bm-enc/live/start",
							{
								httpStatusCode: 400,
								errorCode: 2025,
								shortMessage:
									"The input with the id: bm-stale could not be found in the system.",
							},
						),
					),
				),
				listRtmpInputs: vi.fn(() => Promise.resolve([{ id: "bm-current" }])),
				// Ground truth: the encoding's ingest stream baked the STALE id —
				// distinct from what this run resolved (bm-current).
				listIngestInputStreams: vi.fn(() =>
					Promise.resolve([{ id: "is-1", inputId: "bm-stale" }]),
				),
			});
			const ids = { ...startLiveIds, "live-input:main": "bm-current" };
			const thrown = await executeStep(startLiveOp, ctx(sdk, ids)).then(
				() => {
					throw new Error("expected the start to reject");
				},
				(e: unknown) => (e instanceof Error ? e : new Error(String(e))),
			);
			// Reports the encoding's actual baked id (ground truth), the account's
			// resolvable id, and what this run resolved — the mismatch is now visible.
			expect(thrown.message).toMatch(/ingest streams reference \[bm-stale\]/);
			expect(thrown.message).toMatch(/resolvable \[bm-current\]/);
			expect(thrown.message).toContain("this run resolved [bm-current]");
			// It must read GROUND TRUTH from the encoding, not just ctx.ids.
			expect(sdk.listIngestInputStreams).toHaveBeenCalledWith("bm-enc");
			// And never leak the start request's streamKey.
			expect(thrown.message).not.toContain("myStreamKey");
		});

		it("passes a non-input live-start failure through untouched", async () => {
			const sdk = fakeSdk({
				getEncodingStatus: vi.fn(() => Promise.resolve({ status: "CREATED" })),
				startLiveEncoding: vi.fn(() =>
					Promise.reject(
						new BitmovinCallError(
							"POST",
							"/encoding/encodings/bm-enc/live/start",
							{ httpStatusCode: 402, shortMessage: "encoder quota exceeded" },
						),
					),
				),
			});
			const thrown = await executeStep(
				startLiveOp,
				ctx(sdk, startLiveIds),
			).then(
				() => null,
				(err: unknown) => err as Error,
			);
			// Not an input error ⇒ passed through with no diagnosis appended,
			// and the facade's curated text is what surfaces.
			expect(thrown?.message).toContain("encoder quota exceeded");
			expect(thrown?.message).not.toContain("live-start input diagnosis");
		});

		const awaitLiveOp: CompiledOperation = {
			step: "await:running",
			kind: "AWAIT_LIVE_RUNNING",
			payload: {},
			refs: { encodingId: "encoding" },
		};

		it("polls AWAIT_LIVE_RUNNING until RUNNING (the steady state)", async () => {
			const statuses = ["CREATED", "QUEUED", "QUEUED", "RUNNING"];
			const sdk = fakeSdk({
				getEncodingStatus: vi.fn(() =>
					Promise.resolve({ status: statuses.shift() ?? "RUNNING" }),
				),
			});
			const result = await executeStep(
				awaitLiveOp,
				ctx(sdk, { encoding: "bm-enc" }),
			);
			expect(sdk.getEncodingStatus).toHaveBeenCalledTimes(4);
			expect(result.response).toMatchObject({ status: "RUNNING" });
		});

		it("reports provider cancellation as a typed signal with its exact task", async () => {
			const task = {
				status: "CANCELED",
				messages: ["Encoding stopped by user"],
			};
			await expect(
				executeStep(
					awaitLiveOp,
					ctx(
						fakeSdk({
							getEncodingStatus: vi.fn(async () => task),
						}),
						{ encoding: "bm-enc" },
					),
				),
			).rejects.toMatchObject({
				name: "LiveEncodingCanceled",
				encodingId: "bm-enc",
				task,
			});
		});

		it("treats ERROR/CANCELED as terminal failures with encoder messages", async () => {
			for (const status of ["ERROR", "CANCELED"]) {
				const sdk = fakeSdk({
					getEncodingStatus: vi.fn(() =>
						Promise.resolve({ status, messages: ["ingest refused"] }),
					),
				});
				await expect(
					executeStep(awaitLiveOp, ctx(sdk, { encoding: "bm-enc" })),
				).rejects.toThrow(
					new RegExp(`ended ${status} before reaching RUNNING: ingest refused`),
				);
			}
		});

		it("treats FINISHED before RUNNING as a failure (stopped before coming up)", async () => {
			const sdk = fakeSdk({
				getEncodingStatus: vi.fn(() => Promise.resolve({ status: "FINISHED" })),
			});
			await expect(
				executeStep(awaitLiveOp, ctx(sdk, { encoding: "bm-enc" })),
			).rejects.toThrow(/ended FINISHED before reaching RUNNING/);
		});

		it("fails fast on states outside the startup allowlist (IDLE & co)", async () => {
			// Polling is allowlisted to CREATED/QUEUED — IDLE (or any future
			// SDK state) must fail immediately, not wedge until the timeout.
			for (const status of ["IDLE", "SOME_FUTURE_STATE"]) {
				const sdk = fakeSdk({
					getEncodingStatus: vi.fn(() => Promise.resolve({ status })),
				});
				await expect(
					executeStep(awaitLiveOp, ctx(sdk, { encoding: "bm-enc" })),
				).rejects.toThrow(
					new RegExp(`ended ${status} before reaching RUNNING`),
				);
				expect(sdk.getEncodingStatus).toHaveBeenCalledTimes(1);
			}
		});

		it("times out a live await stuck in QUEUED", async () => {
			const sdk = fakeSdk({
				getEncodingStatus: vi.fn(() => Promise.resolve({ status: "QUEUED" })),
			});
			await expect(
				executeStep(awaitLiveOp, {
					...ctx(sdk, { encoding: "bm-enc" }),
					poll: { intervalMs: 1, timeoutMs: 0, sleep: () => Promise.resolve() },
				}),
			).rejects.toThrow(/timed out .*last status QUEUED/);
		});
	});
});

describe("executeStep — trimming + concatenation input streams", () => {
	const baseIds = { encoding: "bm-enc", "ingest:video": "bm-ingest" };

	it("creates a time-based trimming input stream over its source", async () => {
		const sdk = fakeSdk();
		const result = await executeStep(
			{
				step: "trim:trim",
				kind: "CREATE_TRIMMING_TIME_BASED",
				payload: { offset: 10, duration: 30 },
				refs: { encodingId: "encoding", inputStreamId: "ingest:video" },
			},
			ctx(sdk, baseIds),
		);
		expect(sdk.createTimeBasedTrimmingInputStream).toHaveBeenCalledWith(
			"bm-enc",
			{ inputStreamId: "bm-ingest", offset: 10, duration: 30 },
		);
		expect(result.resourceId).toBe("bm-1");
	});

	it("creates a timecode-track trimming input stream", async () => {
		const sdk = fakeSdk();
		await executeStep(
			{
				step: "trim:t2",
				kind: "CREATE_TRIMMING_TIMECODE_TRACK",
				payload: {
					startTimeCode: "00:00:10:00",
					endTimeCode: "00:00:40:00",
				},
				refs: { encodingId: "encoding", inputStreamId: "ingest:video" },
			},
			ctx(sdk, baseIds),
		);
		expect(sdk.createTimecodeTrackTrimmingInputStream).toHaveBeenCalledWith(
			"bm-enc",
			{
				inputStreamId: "bm-ingest",
				startTimeCode: "00:00:10:00",
				endTimeCode: "00:00:40:00",
			},
		);
	});

	it("creates an h264-picture-timing trimming input stream", async () => {
		const sdk = fakeSdk();
		await executeStep(
			{
				step: "trim:t3",
				kind: "CREATE_TRIMMING_H264_PICTURE_TIMING",
				payload: { startPicTiming: "10s", endPicTiming: "40s" },
				refs: { encodingId: "encoding", inputStreamId: "ingest:video" },
			},
			ctx(sdk, baseIds),
		);
		expect(sdk.createH264PictureTimingTrimmingInputStream).toHaveBeenCalledWith(
			"bm-enc",
			{
				inputStreamId: "bm-ingest",
				startPicTiming: "10s",
				endPicTiming: "40s",
			},
		);
	});

	it("zips concatenation sources to resolved stream ids in order", async () => {
		const sdk = fakeSdk();
		const result = await executeStep(
			{
				step: "concat:joined",
				kind: "CREATE_CONCATENATION_INPUT_STREAM",
				payload: {
					sources: [
						{ sourceRef: "source0", isMain: true, position: 0 },
						{
							sourceRef: "source1",
							position: 1,
							paddingBefore: { duration: 2, unit: "SECONDS" },
							aspectMode: "PAD",
						},
					],
				},
				refs: {
					encodingId: "encoding",
					source0: "ingest:partA",
					source1: "ingest:partB",
				},
			},
			ctx(sdk, {
				encoding: "bm-enc",
				"ingest:partA": "bm-a",
				"ingest:partB": "bm-b",
			}),
		);
		expect(sdk.createConcatenationInputStream).toHaveBeenCalledWith("bm-enc", {
			sources: [
				{
					inputStreamId: "bm-a",
					isMain: true,
					position: 0,
					paddingBefore: undefined,
					paddingAfter: undefined,
					aspectMode: undefined,
				},
				{
					inputStreamId: "bm-b",
					isMain: undefined,
					position: 1,
					paddingBefore: { duration: 2, unit: "SECONDS" },
					paddingAfter: undefined,
					aspectMode: "PAD",
				},
			],
		});
		expect(result.resourceId).toBe("bm-1");
	});

	it("throws when a concatenation source ref is unresolved", async () => {
		const sdk = fakeSdk();
		await expect(
			executeStep(
				{
					step: "concat:joined",
					kind: "CREATE_CONCATENATION_INPUT_STREAM",
					payload: { sources: [{ sourceRef: "source0", isMain: true }] },
					refs: { encodingId: "encoding", source0: "ingest:missing" },
				},
				ctx(sdk, { encoding: "bm-enc" }),
			),
		).rejects.toThrow(/needs ref "source0"/);
	});
});

describe("Akamai NetStorage input and output (ledger #138)", () => {
	const netStorageCred = {
		provider: "AKAMAI_NETSTORAGE",
		config: { host: "example-nsu.akamaihd.net", username: "upload-acct" },
		secret: { password: "s3cret" },
	};

	function ctxWithCred(sdk: ReturnType<typeof fakeSdk>, cred: unknown) {
		const context = ctx(sdk);
		context.resolveCredential = vi.fn(async () => cred) as never;
		return context;
	}

	for (const [kind, method] of [
		["CREATE_INPUT_AKAMAI_NETSTORAGE", "createAkamaiNetStorageInput"],
		["CREATE_OUTPUT_AKAMAI_NETSTORAGE", "createAkamaiNetStorageOutput"],
	] as const) {
		it(`${kind} sends host, username and password from the VAULT`, async () => {
			const sdk = fakeSdk();
			await executeStep(
				{
					step: "io:ns",
					kind,
					payload: { name: "NS", credentialId: "cred-1" },
					refs: {},
				},
				ctxWithCred(sdk, netStorageCred),
			);
			expect(sdk[method]).toHaveBeenCalledWith({
				name: "NS",
				host: "example-nsu.akamaihd.net",
				username: "upload-acct",
				password: "s3cret",
			});
			// The plan never carries the password — that is the whole reason
			// this reads through the credential store.
		});
	}

	it("REFUSES a credential of the wrong provider", async () => {
		// `cred.config.host` reads a host off ANY provider's config, so an S3
		// credential picked by mistake would be sent as a NetStorage host and
		// fail somewhere unrecognisable. Named at the boundary instead.
		const sdk = fakeSdk();
		await expect(
			executeStep(
				{
					step: "io:ns",
					kind: "CREATE_OUTPUT_AKAMAI_NETSTORAGE",
					payload: { name: "NS", credentialId: "cred-1" },
					refs: {},
				},
				ctxWithCred(sdk, {
					provider: "AKAMAI_OBJECT_STORAGE",
					config: { host: "eu-central-1.linodeobjects.com" },
					secret: { accessKey: "a", secretKey: "b" },
				}),
			),
		).rejects.toThrow(/needs an AKAMAI_NETSTORAGE credential/);
		expect(sdk.createAkamaiNetStorageOutput).not.toHaveBeenCalled();
	});

	it("REFUSES an empty password instead of authenticating as nobody", async () => {
		const sdk = fakeSdk();
		await expect(
			executeStep(
				{
					step: "io:ns",
					kind: "CREATE_OUTPUT_AKAMAI_NETSTORAGE",
					payload: { name: "NS", credentialId: "cred-1" },
					refs: {},
				},
				ctxWithCred(sdk, { ...netStorageCred, secret: {} }),
			),
		).rejects.toThrow(/carries no password/);
		expect(sdk.createAkamaiNetStorageOutput).not.toHaveBeenCalled();
	});
});

describe("Akamai MSL output (ledger #137)", () => {
	// Remodelled 2026-08-19 on the owner's call: the provisioned streamId and
	// eventName come from an AKAMAI_MSL vault credential, because you cannot
	// obtain either without an Akamai account. The refusals that guarded the
	// inline values guard the resolved ones now.
	const mslCred = {
		provider: "AKAMAI_MSL",
		config: { streamId: 12345, eventName: "event-a" },
		secret: {},
	};
	const mslOp: CompiledOperation = {
		step: "output:msl",
		kind: "CREATE_OUTPUT_AKAMAI_MSL",
		payload: {
			name: "Akamai MSL Output",
			credentialId: "00000000-0000-4000-8000-000000000003",
			streamFormat: "HLS",
			mslVersion: "MSL4",
		},
		refs: {},
	};

	function ctxWith(sdk: ReturnType<typeof fakeSdk>, cred: unknown) {
		const context = ctx(sdk);
		context.resolveCredential = vi.fn(async () => cred) as never;
		return context;
	}

	it("resolves the identity from the VAULT and sends it with the format", async () => {
		const sdk = fakeSdk();
		await executeStep(mslOp, ctxWith(sdk, mslCred));
		expect(sdk.createAkamaiMslOutput).toHaveBeenCalledWith({
			name: "Akamai MSL Output",
			streamId: 12345,
			eventName: "event-a",
			streamFormat: "HLS",
			mslVersion: "MSL4",
		});
		// The plan never carries the identity — that is the whole point of the
		// remodel, and it is what puts MSL on the credential-first output step
		// with every other kind.
		expect(JSON.stringify(mslOp.payload)).not.toMatch(/12345|event-a/);
	});

	/**
	 * MSL5 publishing auth —  PR 2.
	 *
	 * WHY THESE EXIST AT ALL: the executor's spread compiled GREEN against a
	 * facade signature that did not declare `publishingAuthentication` —
	 * excess-property checking does not reach a spread — so the pair would have
	 * been dropped silently on the way to the SDK, with typecheck, biome and
	 * every test passing. Found by reading the facade. These arms are what make
	 * the next such drop loud.
	 */
	const msl5Op: CompiledOperation = {
		...mslOp,
		payload: { ...mslOp.payload, streamFormat: "CMAF", mslVersion: "MSL5" },
	};
	const withPair = {
		...mslCred,
		secret: { username: "pub-user", password: "S3gm3nt!" },
	};
	const sentArg = (sdk: ReturnType<typeof fakeSdk>) =>
		(
			sdk.createAkamaiMslOutput as unknown as {
				mock: { calls: Record<string, unknown>[][] };
			}
		).mock.calls[0]?.[0];

	it("sends the Digest pair on MSL5, with enabled DERIVED true", async () => {
		const sdk = fakeSdk();
		await executeStep(msl5Op, ctxWith(sdk, withPair));
		expect(sdk.createAkamaiMslOutput).toHaveBeenCalledWith(
			expect.objectContaining({
				mslVersion: "MSL5",
				publishingAuthentication: {
					enabled: true,
					username: "pub-user",
					password: "S3gm3nt!",
				},
			}),
		);
	});

	it("OMITS the object on MSL5 when the credential carries no pair", async () => {
		const sdk = fakeSdk();
		await executeStep(msl5Op, ctxWith(sdk, mslCred));
		// OMITTED, not `enabled: false` — there is deliberately no way to send
		// credentials with auth off, because that state is indistinguishable
		// from "auth is on" on every screen while publishing without it. Legal
		// per the SDK; rail 3b is what warns about it at submit.
		expect(sentArg(sdk)).not.toHaveProperty("publishingAuthentication");
	});

	/**
	 * The mid-migration state, and why the version check is not cosmetic: one
	 * credential legitimately backs an MSL4 output today and an MSL5 output
	 * after migration. The vendor THROWS on the field with MSL4 — "The
	 * MSL5-only field publishingAuthentication cannot be set on MSL4 outputs" —
	 * so sending it would 400 a plan that is otherwise correct.
	 */
	it("NEVER sends it on MSL4, even when the credential has a pair", async () => {
		const sdk = fakeSdk();
		await executeStep(mslOp, ctxWith(sdk, withPair));
		expect(sentArg(sdk)).not.toHaveProperty("publishingAuthentication");
	});

	/**
	 * An ABSENT `mslVersion` must fail toward NOT SENDING — review of PR #319,
	 * and this arm exists because the fix was undetectable without it.
	 *
	 * The first version read `str(p.mslVersion) !== "MSL4"`. `str` returns ""
	 * for a non-string, and this executor replays PERSISTED payloads under
	 * `z.record(z.string, z.unknown)`, so an absent version gave
	 * `"" !== "MSL4"` → true → the MSL5-only field sent on a version we cannot
	 * identify. Now derived from `AKAMAI_MSL_VERSION_BEHAVIOR`, where unknown
	 * has no entry and therefore reads as FORBIDDEN.
	 *
	 * MEASURED as unpinned before this arm: reverting to the string check left
	 * all 129 tests in this file green. The fix without the arm is a claim.
	 */
	it("does NOT send the field when mslVersion is absent — unknown reads as FORBIDDEN", async () => {
		const sdk = fakeSdk();
		const noVersion: CompiledOperation = {
			...mslOp,
			payload: {
				name: mslOp.payload.name,
				credentialId: mslOp.payload.credentialId,
				streamFormat: "CMAF",
				// mslVersion deliberately absent — the persisted-payload shape
				// this executor replays cannot be schema-narrowed.
			},
		};
		await executeStep(noVersion, ctxWith(sdk, withPair));
		expect(sentArg(sdk)).not.toHaveProperty("publishingAuthentication");
	});

	it("REFUSES half a pair rather than sending one half", async () => {
		const sdk = fakeSdk();
		await expect(
			executeStep(
				msl5Op,
				ctxWith(sdk, { ...mslCred, secret: { username: "pub-user" } }),
			),
		).rejects.toThrow(/half a Digest pair/);
		expect(sdk.createAkamaiMslOutput).not.toHaveBeenCalled();
	});

	it("REFUSES the other half too — the guard is symmetric", async () => {
		const sdk = fakeSdk();
		await expect(
			executeStep(
				msl5Op,
				ctxWith(sdk, { ...mslCred, secret: { password: "S3gm3nt!" } }),
			),
		).rejects.toThrow(/half a Digest pair/);
	});

	it("REFUSES a credential of the wrong provider", async () => {
		const sdk = fakeSdk();
		await expect(
			executeStep(
				mslOp,
				ctxWith(sdk, {
					provider: "AKAMAI_NETSTORAGE",
					config: { host: "h", username: "u" },
					secret: { password: "p" },
				}),
			),
		).rejects.toThrow(/needs an AKAMAI_MSL credential/);
		expect(sdk.createAkamaiMslOutput).not.toHaveBeenCalled();
	});

	it("REFUSES a missing stream id instead of sending 0", async () => {
		// `num(x, 0)` would make this a valid-looking number pointing at
		// nothing in Akamai. A stream that goes nowhere and reports success is
		// the failure this codebase keeps finding.
		const sdk = fakeSdk();
		await expect(
			executeStep(
				mslOp,
				ctxWith(sdk, { ...mslCred, config: { eventName: "event-a" } }),
			),
		).rejects.toThrow(/streamId/);
		expect(sdk.createAkamaiMslOutput).not.toHaveBeenCalled();
	});

	it("REFUSES a missing or blank event name for the same reason", async () => {
		for (const eventName of [undefined, "", "   ", 7]) {
			const sdk = fakeSdk();
			await expect(
				executeStep(
					mslOp,
					ctxWith(sdk, {
						...mslCred,
						config: { streamId: 12345, eventName },
					}),
				),
				`eventName ${JSON.stringify(eventName)} must be refused`,
			).rejects.toThrow(/eventName/);
			expect(sdk.createAkamaiMslOutput).not.toHaveBeenCalled();
		}
	});
});

/**
 * Audit AA972-CONTRACT-001. Four credential-backed IO branches resolved a
 * credential and went straight to the vendor with it: `CREATE_INPUT_AZURE`,
 * `CREATE_OUTPUT_S3`, `CREATE_OUTPUT_AZURE`, `CREATE_OUTPUT_SFTP`. A mismatched
 * UUID therefore read fields off the wrong provider's config — `accessKey:
 * cred.secret.accessKeyId ?? ""` sends an EMPTY key rather than refusing — and
 * failed at the vendor, after the run had already created the remote resources
 * of every earlier step. The SFTP gap was even known: the NetStorage branch
 * carried "the provider check the SFTP branch above does NOT do, and should".
 *
 * The gap survived because the existing arms test guarded families one at a
 * time, so a branch with no guard has no test to be missing from. This block
 * derives its population from `OPERATION_KINDS` instead: a new IO op is a
 * FAILING test until someone classifies it, which is the shape  used
 * on `capabilityOfProvider` for the same reason.
 */
describe("no credential-backed IO op reaches the vendor with a mismatched credential", () => {
	const IO_KINDS = OPERATION_KINDS.filter((k) =>
		/^CREATE_(INPUT|OUTPUT)_/.test(k),
	);

	/** Ops that reference no credential at all — nothing to mismatch. */
	const CREDENTIAL_FREE = [
		"CREATE_INPUT_HTTPS",
		"CREATE_INPUT_RTMP",
		"CREATE_INPUT_REDUNDANT_RTMP",
		"CREATE_INPUT_HLS_LIVE",
	];

	/** op kind → the provider it requires, and the call that must NOT happen. */
	/**
	 * op kind → the canonical refusal its provider guard must produce.
	 *
	 * There used to be an `sdk` column too, asserted with
	 * `expect(sdk[spec.sdk]).not.toHaveBeenCalled` and a comment claiming a
	 * typo in it would fail. Review disproved that: naming a real-but-WRONG
	 * method left all arms green, and `keyof SdkOps` already makes a
	 * non-existent name a compile error, so the assertion could only ever pass.
	 * The sweep below asserts no sdk method was called AT ALL, which is both
	 * stronger and unpinnable-by-typo, so the column is gone.
	 */
	const GUARDED: Record<string, RegExp> = {
		CREATE_INPUT_S3: /needs an? AWS_S3 credential but got provider "KANTAR"/,
		CREATE_INPUT_AZURE:
			/needs an? AZURE_BLOB credential but got provider "KANTAR"/,
		CREATE_INPUT_GENERIC_S3:
			/needs an? Akamai\/OCI\/GenericS3 credential but got provider "KANTAR"/,
		CREATE_INPUT_GCS: /needs an? GCS_HMAC credential but got provider "KANTAR"/,
		CREATE_INPUT_GCS_SERVICE_ACCOUNT:
			/needs an? GCS_SERVICE_ACCOUNT credential but got provider "KANTAR"/,
		CREATE_INPUT_AKAMAI_NETSTORAGE:
			/needs an? AKAMAI_NETSTORAGE credential but got provider "KANTAR"/,
		CREATE_INPUT_SRT:
			/needs an? SRT_PASSPHRASE credential but got provider "KANTAR"/,
		CREATE_INPUT_ZIXI: /needs an? ZIXI credential but got provider "KANTAR"/,
		CREATE_OUTPUT_S3: /needs an? AWS_S3 credential but got provider "KANTAR"/,
		CREATE_OUTPUT_AZURE:
			/needs an? AZURE_BLOB credential but got provider "KANTAR"/,
		CREATE_OUTPUT_SFTP: /needs an? SFTP credential but got provider "KANTAR"/,
		CREATE_OUTPUT_AKAMAI_NETSTORAGE:
			/needs an? AKAMAI_NETSTORAGE credential but got provider "KANTAR"/,
		CREATE_OUTPUT_GENERIC_S3:
			/needs an? Akamai\/OCI\/GenericS3 credential but got provider "KANTAR"/,
		CREATE_OUTPUT_GCS:
			/needs an? GCS_HMAC credential but got provider "KANTAR"/,
		CREATE_OUTPUT_GCS_SERVICE_ACCOUNT:
			/needs an? GCS_SERVICE_ACCOUNT credential but got provider "KANTAR"/,
		CREATE_OUTPUT_LIVE_MEDIA_INGEST:
			/needs an? LIVE_MEDIA_INGEST credential but got provider "KANTAR"/,
		CREATE_OUTPUT_AKAMAI_MSL:
			/needs an? AKAMAI_MSL credential but got provider "KANTAR"/,
	};

	it("classifies every IO operation kind — both directions", () => {
		// Set-equality, not a length check: a kind dropped from OPERATION_KINDS
		// and a kind classified here but no longer real are different bugs, and
		// a count would hide one behind the other.
		expect([...IO_KINDS].sort()).toEqual(
			[...CREDENTIAL_FREE, ...Object.keys(GUARDED)].sort(),
		);
	});

	/**
	 * A provider no IO op can ever want, so one arm serves every op. KANTAR is
	 * watermarking — it has neither bucket keys nor a host.
	 */
	const WRONG: ResolvedCredential = {
		provider: "KANTAR",
		config: {},
		secret: {},
	};

	/**
	 * DO NOT DELETE THIS AS REDUNDANT. It is the only layer that kills a wrong
	 * VALUE in `PROVIDERS_FOR_IO_KIND`.
	 *
	 * Core pins the table's key COVERAGE against the plan schema; the web corpus
	 * test pins collector↔table agreement and cannot see a wrong value, because
	 * it reads the same table. Both stay green if a provider in that table is
	 * simply wrong — measured: `GENERIC_S3 → ["AWS_S3"]` leaves core 5/5 and the
	 * web corpus green, and fails only here.
	 *
	 * The sentence is here rather than in core's test file because this is where
	 * the deletion would happen: from the outside this reads as a 40-line loop
	 * building fake SDKs inside an executor test, next to a core test that
	 * already set-equals the same table.
	 *
	 * The picker and the executor must mean the same thing by a kind.
	 *
	 * `PROVIDERS_FOR_IO_KIND` (core) tells the import wizard which credentials
	 * to offer for an IO kind; these guards decide which ones actually work.
	 * When they disagree the operator is offered a credential that fails at the
	 * vendor — which is how AA972-IMPORT-001 read to a user. Rather than trust
	 * two hand-written tables to stay in step, this DERIVES the executor's
	 * accepted set by running every provider through every op and compares.
	 */
	it("agrees with core's PROVIDERS_FOR_IO_KIND, kind by kind", async () => {
		const planKindOf = (op: string) =>
			op.replace(/^CREATE_(INPUT|OUTPUT)_/, "");
		const unmapped: string[] = [];
		for (const opKind of Object.keys(GUARDED)) {
			const planKind = planKindOf(opKind);
			const expected = PROVIDERS_FOR_IO_KIND[planKind];
			if (expected === undefined) {
				unmapped.push(planKind);
				continue;
			}
			const accepted: string[] = [];
			for (const provider of CREDENTIAL_PROVIDERS) {
				const sdk = fakeSdk();
				const step = {
					step: `io:${opKind}`,
					kind: opKind as CompiledOperation["kind"],
					payload: { credentialId: "00000000-0000-4000-8000-0000000000ff" },
					refs: {},
				};
				try {
					await executeStep(
						step,
						ctx(sdk, {}, { provider, config: {}, secret: {} }),
					);
					accepted.push(provider);
				} catch (err) {
					// ONLY the provider guard counts as a refusal. A branch that
					// gets past it and then fails on an empty secret has still
					// ACCEPTED the provider, and conflating the two would let a
					// disagreement hide behind an unrelated error.
					if (!/needs an? .+ credential but got provider/.test(String(err))) {
						accepted.push(provider);
					}
				}
			}
			expect({ [planKind]: [...accepted].sort() }).toEqual({
				[planKind]: [...expected].sort(),
			});
		}
		// Named, not skipped: SRT and ZIXI are live INGEST protocols, so they
		// are not in a table about plan storage kinds. Any other unmapped kind
		// is a real gap and fails here.
		expect([...new Set(unmapped)].sort()).toEqual(["SRT", "ZIXI"]);
	});

	for (const [kind, wants] of Object.entries(GUARDED)) {
		it(`${kind} refuses a mismatched credential before any vendor call`, async () => {
			const sdk = fakeSdk();
			await expect(
				executeStep(
					{
						step: `io:${kind}`,
						kind: kind as CompiledOperation["kind"],
						// Minimal on purpose: every branch resolves its
						// credential FIRST, so the guard has to fire before any
						// payload field is read. A payload that had to be valid
						// would prove a weaker thing.
						payload: {
							credentialId: "00000000-0000-4000-8000-0000000000ff",
						},
						refs: {},
					},
					ctx(sdk, {}, WRONG),
				),
			).rejects.toThrow(wants);
			// The outcome an operator cares about: no remote resource exists to
			// orphan, because the vendor was never called. Asserted over EVERY
			// sdk method, not just the one this op would have used — naming the
			// method makes the assertion vacuous exactly when the name is wrong,
			// which is the case it is supposed to catch.
			const called = Object.entries(sdk)
				.filter(([, fn]) => vi.isMockFunction(fn) && fn.mock.calls.length > 0)
				.map(([name]) => name);
			expect(called).toEqual([]);
		});
	}
});
