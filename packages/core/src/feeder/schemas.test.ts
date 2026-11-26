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

describe("feeder playback mode", () => {
	const request = {
		liveChannelId: uuid,
		source: { credentialId: uuid, bucket: "media", key: "full-match.mp4" },
		protocol: "RTMP",
		target: { url: "rtmp://h/live", streamKey: "sk" },
	};

	it("keeps legacy requests in LOOP mode", () => {
		expect(createFeederSessionSchema.parse(request).playbackMode).toBe("LOOP");
	});

	it.each(["LOOP", "ONCE"])("accepts an explicit %s mode", (playbackMode) => {
		expect(
			createFeederSessionSchema.parse({ ...request, playbackMode })
				.playbackMode,
		).toBe(playbackMode);
	});

	it("accepts single-pass SRT with the same source contract", () => {
		expect(
			createFeederSessionSchema.parse({
				...request,
				protocol: "SRT_CALLER",
				target: { host: "h", port: 2088 },
				playbackMode: "ONCE",
			}).playbackMode,
		).toBe("ONCE");
	});

	it.each([
		null,
		"once",
		"REPEAT",
		1,
	])("rejects unknown mode %s", (playbackMode) => {
		expect(
			createFeederSessionSchema.safeParse({ ...request, playbackMode }).success,
		).toBe(false);
	});

	it("refuses a staged switch for ONCE rather than replaying it on takeover", () => {
		expect(
			createFeederSessionSchema.safeParse({
				...request,
				playbackMode: "ONCE",
				switchFromActive: true,
			}).success,
		).toBe(false);
		expect(
			createFeederSessionSchema.parse({
				...request,
				playbackMode: "ONCE",
				switchFromActive: false,
			}).playbackMode,
		).toBe("ONCE");
	});

	it("does not accept client-written dispatch or EOF receipts", () => {
		expect(
			createFeederSessionSchema.safeParse({
				...request,
				playbackMode: "ONCE",
				playbackDispatchedAt: "2026-11-09T00:00:00.000Z",
				playbackReceipt: { completed: true },
			}).success,
		).toBe(false);
	});
});
