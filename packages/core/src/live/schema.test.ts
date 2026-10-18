import { describe, expect, it } from "vitest";
import type { LiveChannelPlanInput } from "./schema";
import { liveChannelPlanSchema, liveMuxingSchema } from "./schema";

/** Minimal valid RTMP channel; tests mutate copies of this raw input. */
function minimalInput(): LiveChannelPlanInput {
	return {
		planVersion: 1,
		name: "channel",
		bitmovin: {},
		liveInput: { key: "main", kind: "RTMP" },
		outputs: [
			{
				key: "out",
				kind: "S3",
				credentialId: "00000000-0000-4000-8000-000000000002",
				bucket: "b",
			},
		],
		ingest: [{ key: "video" }],
		renditions: [
			{
				key: "v",
				codec: "H264",
				ingestKey: "video",
				height: 720,
				bitrate: 3000000,
			},
		],
		muxings: [
			{
				key: "v",
				kind: "FMP4",
				streamKey: "v",
				destination: { outputKey: "out", path: "live/v" },
			},
		],
		liveManifests: [
			{
				key: "hls",
				kind: "HLS",
				destination: { outputKey: "out", path: "live" },
			},
		],
		start: { streamKey: "myStreamKey" },
	};
}

function withLiveInput(
	liveInput: LiveChannelPlanInput["liveInput"],
): LiveChannelPlanInput {
	return { ...minimalInput(), liveInput };
}

describe("liveChannelPlanSchema", () => {
	it("parses the minimal plan and materializes defaults", () => {
		const plan = liveChannelPlanSchema.parse(minimalInput());
		expect(plan.bitmovin.cloudRegion).toBe("AUTO");
		expect(plan.bitmovin.encoderVersion).toBe("STABLE");
		expect(plan.ingest[0]?.inputPath).toBe("live");
		expect(plan.ingest[0]?.position).toBe(0);
		const manifest = plan.liveManifests[0];
		expect(manifest?.kind === "HLS" && manifest.manifestName).toBe(
			"stream.m3u8",
		);
	});

	it("rejects unknown keys (strict objects)", () => {
		const input = minimalInput();
		const result = liveChannelPlanSchema.safeParse({
			...input,
			liveInput: { key: "main", kind: "RTMP", bogus: true },
		});
		expect(result.success).toBe(false);
	});

	describe("automatic shutdown API minimums", () => {
		it.each([
			["bytesReadTimeoutSeconds", 30],
			["streamTimeoutMinutes", 5],
			["waitingForFirstConnectTimeoutMinutes", 5],
		] as const)("rejects %s below its minimum and accepts the boundary", (field, minimum) => {
			const base = minimalInput();
			const below = liveChannelPlanSchema.safeParse({
				...base,
				start: { ...base.start, autoShutdown: { [field]: minimum - 1 } },
			});
			expect(below.success).toBe(false);
			if (!below.success) {
				expect(below.error.issues[0]?.path).toEqual([
					"start",
					"autoShutdown",
					field,
				]);
			}
			expect(
				liveChannelPlanSchema.safeParse({
					...base,
					start: { ...base.start, autoShutdown: { [field]: minimum } },
				}).success,
			).toBe(true);
		});

		it("rejects the two-minute total timeout that the provider refused", () => {
			const base = minimalInput();
			expect(
				liveChannelPlanSchema.safeParse({
					...base,
					start: { ...base.start, autoShutdown: { streamTimeoutMinutes: 2 } },
				}).success,
			).toBe(false);
		});

		it("leaves automatic shutdown and its individual knobs optional", () => {
			const base = minimalInput();
			expect(liveChannelPlanSchema.safeParse(base).success).toBe(true);
			expect(
				liveChannelPlanSchema.safeParse({
					...base,
					start: { ...base.start, autoShutdown: {} },
				}).success,
			).toBe(true);
		});
	});

	describe("ESAM group (P5 PR-3)", () => {
		it("requires poisEndpoint WITHIN the group (the group itself stays optional)", () => {
			const base = minimalInput();
			// Absent group: fine — an untouched wizard emits no key at all.
			expect(liveChannelPlanSchema.safeParse(base).success).toBe(true);
			// http endpoint: rejected — the POIS pair would cross the network in
			// cleartext (secretEgressUrlSchema).
			expect(
				liveChannelPlanSchema.safeParse({
					...base,
					start: {
						...base.start,
						esam: { poisEndpoint: "http://pois.example.com/esam" },
					},
				}).success,
			).toBe(false);
			// Userinfo is rejected: plans persist raw (secret-free by
			// construction), so user:pass@host would store a password.
			expect(
				liveChannelPlanSchema.safeParse({
					...base,
					start: {
						...base.start,
						esam: { poisEndpoint: "https://u:p@pois.example.com/esam" },
					},
				}).success,
			).toBe(false);
			// A non-URL string is rejected too (a typo used to reach the encoder).
			expect(
				liveChannelPlanSchema.safeParse({
					...base,
					start: { ...base.start, esam: { poisEndpoint: "pois.example.com" } },
				}).success,
			).toBe(false);
			// Group without an endpoint: rejected. Otherwise the executor would
			// decrypt a POIS basic-auth pair with nowhere to send it.
			const endpointless = liveChannelPlanSchema.safeParse({
				...base,
				start: {
					...base.start,
					esam: { poisCredentialId: "00000000-0000-4000-8000-0000000000e5" },
				},
			});
			expect(endpointless.success).toBe(false);
			// With the endpoint: accepted.
			expect(
				liveChannelPlanSchema.safeParse({
					...base,
					start: {
						...base.start,
						esam: {
							poisEndpoint: "https://pois.example.com/esam",
							poisCredentialId: "00000000-0000-4000-8000-0000000000e5",
						},
					},
				}).success,
			).toBe(true);
		});
	});

	it("rejects empty liveManifests (a channel needs a playback surface)", () => {
		const result = liveChannelPlanSchema.safeParse({
			...minimalInput(),
			liveManifests: [],
		});
		expect(result.success).toBe(false);
	});

	describe("stream key format (^[a-zA-Z]{3,20}$)", () => {
		const accept = ["abc", "myStreamKey", "ABCDEFGHIJKLMNOPQRST"];
		const reject = ["ab", "ABCDEFGHIJKLMNOPQRSTU", "abc123", "my-key", ""];
		for (const value of accept) {
			it(`accepts "${value}"`, () => {
				const input = minimalInput();
				input.start = { streamKey: value };
				expect(liveChannelPlanSchema.safeParse(input).success).toBe(true);
			});
		}
		for (const value of reject) {
			it(`rejects "${value}"`, () => {
				const input = minimalInput();
				input.start = { streamKey: value };
				expect(liveChannelPlanSchema.safeParse(input).success).toBe(false);
			});
		}
	});

	describe("SRT refinements", () => {
		const srtBase = {
			key: "main",
			kind: "SRT",
			mode: "CALLER",
			host: "203.0.113.10",
			port: 7000,
		} as const;

		it("accepts a CALLER with host on any port", () => {
			expect(
				liveChannelPlanSchema.safeParse(withLiveInput({ ...srtBase })).success,
			).toBe(true);
		});

		it("rejects a CALLER without host", () => {
			const result = liveChannelPlanSchema.safeParse(
				withLiveInput({ ...srtBase, host: undefined }),
			);
			expect(result.success).toBe(false);
		});

		it("rejects a LISTENER with host (CALLER-only field)", () => {
			const result = liveChannelPlanSchema.safeParse(
				withLiveInput({ ...srtBase, mode: "LISTENER", port: 2088 }),
			);
			expect(result.success).toBe(false);
		});

		for (const port of [2088, 2089, 2090, 2091]) {
			it(`accepts LISTENER port ${port}`, () => {
				expect(
					liveChannelPlanSchema.safeParse(
						withLiveInput({
							key: "main",
							kind: "SRT",
							mode: "LISTENER",
							port,
						}),
					).success,
				).toBe(true);
			});
		}

		for (const port of [2087, 2092, 7000]) {
			it(`rejects LISTENER port ${port}`, () => {
				expect(
					liveChannelPlanSchema.safeParse(
						withLiveInput({
							key: "main",
							kind: "SRT",
							mode: "LISTENER",
							port,
						}),
					).success,
				).toBe(false);
			});
		}

		it("rejects keyLength without a passphrase credential", () => {
			expect(
				liveChannelPlanSchema.safeParse(
					withLiveInput({ ...srtBase, keyLength: 256 }),
				).success,
			).toBe(false);
		});

		it("accepts keyLength with a credentialId (vault passphrase)", () => {
			expect(
				liveChannelPlanSchema.safeParse(
					withLiveInput({
						...srtBase,
						credentialId: "00000000-0000-4000-8000-000000000003",
						keyLength: 256,
					}),
				).success,
			).toBe(true);
		});

		it("refines backup connections with the same rules", () => {
			const result = liveChannelPlanSchema.safeParse(
				withLiveInput({
					...srtBase,
					backup: {
						delayThreshold: 10,
						// CALLER without host inside the backup list.
						srtInputs: [{ mode: "CALLER", port: 7001 }],
					},
				}),
			);
			expect(result.success).toBe(false);
		});
	});

	describe("REDUNDANT_RTMP ingest-point XOR", () => {
		const dynamic = [{ applicationName: "liveA", streamKey: "feedA" }];
		const stat = [{ name: "static-a" }];

		it("accepts dynamic ingestPoints only", () => {
			expect(
				liveChannelPlanSchema.safeParse(
					withLiveInput({
						key: "main",
						kind: "REDUNDANT_RTMP",
						ingestPoints: dynamic,
					}),
				).success,
			).toBe(true);
		});

		it("accepts staticIngestPoints only", () => {
			expect(
				liveChannelPlanSchema.safeParse(
					withLiveInput({
						key: "main",
						kind: "REDUNDANT_RTMP",
						staticIngestPoints: stat,
					}),
				).success,
			).toBe(true);
		});

		it("rejects both lists (the SDK forbids mixing)", () => {
			expect(
				liveChannelPlanSchema.safeParse(
					withLiveInput({
						key: "main",
						kind: "REDUNDANT_RTMP",
						ingestPoints: dynamic,
						staticIngestPoints: stat,
					}),
				).success,
			).toBe(false);
		});

		it("rejects neither list", () => {
			expect(
				liveChannelPlanSchema.safeParse(
					withLiveInput({ key: "main", kind: "REDUNDANT_RTMP" }),
				).success,
			).toBe(false);
		});

		it("requires streamKeyId iff streamKeyConfiguration is ASSIGN", () => {
			const assignWithout = liveChannelPlanSchema.safeParse(
				withLiveInput({
					key: "main",
					kind: "REDUNDANT_RTMP",
					staticIngestPoints: [{ streamKeyConfiguration: { type: "ASSIGN" } }],
				}),
			);
			expect(assignWithout.success).toBe(false);
			const generateWith = liveChannelPlanSchema.safeParse(
				withLiveInput({
					key: "main",
					kind: "REDUNDANT_RTMP",
					staticIngestPoints: [
						{
							streamKeyConfiguration: {
								type: "GENERATE",
								streamKeyId: "00000000-0000-4000-8000-000000000007",
							},
						},
					],
				}),
			);
			expect(generateWith.success).toBe(false);
			const assignWith = liveChannelPlanSchema.safeParse(
				withLiveInput({
					key: "main",
					kind: "REDUNDANT_RTMP",
					staticIngestPoints: [
						{
							streamKeyConfiguration: {
								type: "ASSIGN",
								streamKeyId: "00000000-0000-4000-8000-000000000007",
							},
						},
					],
				}),
			);
			expect(assignWith.success).toBe(true);
		});
	});

	it("requires the Zixi credentialId (password/decryptionKey are vault-only)", () => {
		// Deliberately type-invalid input — fed through safeParse(unknown).
		const result = liveChannelPlanSchema.safeParse({
			...minimalInput(),
			liveInput: {
				key: "main",
				kind: "ZIXI",
				host: "h",
				port: 2077,
				stream: "s",
			},
		});
		expect(result.success).toBe(false);
	});

	it("accepts an HLS live input with adMarkersSource", () => {
		expect(
			liveChannelPlanSchema.safeParse(
				withLiveInput({
					key: "main",
					kind: "HLS",
					url: "https://example.com/master.m3u8",
					adMarkersSource: "MANIFEST",
				}),
			).success,
		).toBe(true);
	});

	describe("start-option minimums (API: ≥30s)", () => {
		it("rejects autoRestart timeouts below 30", () => {
			const input = minimalInput();
			input.start = {
				streamKey: "myStreamKey",
				autoRestart: { segmentsWrittenTimeout: 29 },
			};
			expect(liveChannelPlanSchema.safeParse(input).success).toBe(false);
		});

		it("accepts autoRestart timeouts at exactly 30", () => {
			const input = minimalInput();
			input.start = {
				streamKey: "myStreamKey",
				autoRestart: { segmentsWrittenTimeout: 30 },
			};
			expect(liveChannelPlanSchema.safeParse(input).success).toBe(true);
		});

		it("rejects reupload intervals below 30", () => {
			const input = minimalInput();
			input.start = {
				streamKey: "myStreamKey",
				reupload: { dashManifestInterval: 29 },
			};
			expect(liveChannelPlanSchema.safeParse(input).success).toBe(false);
		});

		it("accepts explicit null reupload intervals (SDK: null disables)", () => {
			// ReuploadSettings documents null as "never re-upload" — distinct
			// from absent, the payload carries the null through.
			const input = minimalInput();
			input.start = {
				streamKey: "myStreamKey",
				reupload: { dashManifestInterval: null, muxingInitFileInterval: null },
			};
			const parsed = liveChannelPlanSchema.safeParse(input);
			expect(parsed.success).toBe(true);
			if (parsed.success) {
				expect(parsed.data.start.reupload).toEqual({
					dashManifestInterval: null,
					muxingInitFileInterval: null,
				});
			}
		});
	});

	it("admits live segments and MP4 archives, but not WEBM/CHUNKED_TEXT", () => {
		expect(
			liveMuxingSchema.safeParse({
				key: "m",
				kind: "MP4",
				streamKey: "v",
				filename: "v.mp4",
			}).success,
		).toBe(true);
		for (const kind of ["WEBM", "CHUNKED_TEXT"]) {
			expect(
				liveMuxingSchema.safeParse({
					key: "m",
					kind,
					streamKey: "v",
					filename: "v.webm",
				}).success,
			).toBe(false);
		}
		expect(
			liveMuxingSchema.safeParse({ key: "m", kind: "TS", streamKey: "v" })
				.success,
		).toBe(true);
	});

	it("rejects non-positive manifest timeshift", () => {
		const input = minimalInput();
		input.liveManifests = [
			{
				key: "hls",
				kind: "HLS",
				destination: { outputKey: "out", path: "live" },
				timeshift: 0,
			},
		];
		expect(liveChannelPlanSchema.safeParse(input).success).toBe(false);
	});
});
