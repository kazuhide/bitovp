import { describe, expect, it } from "vitest";
import {
	createFeederSessionSchema,
	feederRtmpTargetSchema,
	feederSrtTargetSchema,
} from "./schemas";

const uuid = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";

describe("feeder target schemas", () => {
	it("RTMP target requires an rtmp(s) URL and a stream key", () => {
		expect(
			feederRtmpTargetSchema.parse({
				url: "rtmp://1.2.3.4/live",
				streamKey: "sk-1",
			}).streamKey,
		).toBe("sk-1");
		expect(() =>
			feederRtmpTargetSchema.parse({ url: "https://x/live", streamKey: "sk" }),
		).toThrow();
		expect(() =>
			feederRtmpTargetSchema.parse({ url: "rtmp://x/live", streamKey: "" }),
		).toThrow();
	});

	it("SRT target carries a vault ref, never a passphrase", () => {
		const parsed = feederSrtTargetSchema.parse({
			host: "ingest.example",
			port: 2088,
			passphraseCredentialId: uuid,
		});
		expect(parsed.passphraseCredentialId).toBe(uuid);
		// A literal passphrase field must be rejected, not silently carried
		// (or worse: silently stripped while the client believes it applied).
		expect(() =>
			feederSrtTargetSchema.parse({
				host: "h",
				port: 2088,
				passphrase: "super-secret-16ch",
			}),
		).toThrow();
		expect(() => feederSrtTargetSchema.parse({ host: "h", port: 0 })).toThrow();
	});

	it("create request pins the target shape to the protocol", () => {
		const base = {
			liveChannelId: uuid,
			source: { credentialId: uuid, bucket: "b", key: "loop.mp4" },
		};
		expect(
			createFeederSessionSchema.parse({
				...base,
				protocol: "RTMP",
				target: { url: "rtmp://h/live", streamKey: "sk" },
			}).protocol,
		).toBe("RTMP");
		expect(() =>
			createFeederSessionSchema.parse({
				...base,
				protocol: "SRT_CALLER",
				target: { url: "rtmp://h/live", streamKey: "sk" },
			}),
		).toThrow();
		expect(() =>
			createFeederSessionSchema.parse({
				...base,
				protocol: "SRT_LISTENER",
				target: { host: "h", port: 2088 },
			}),
		).toThrow();
	});
});
