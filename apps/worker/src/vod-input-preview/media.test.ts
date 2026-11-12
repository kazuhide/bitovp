import { describe, expect, it } from "vitest";
import {
	inspectVodInputProbe,
	vodInputPreviewCanvas,
	vodInputPreviewReadArgs,
} from "./media";

const identity = { size: 1000, etag: '"source-v1"' };
const probe = () => ({
	streams: [
		{
			index: 2,
			codec_type: "video",
			width: 1920,
			height: 1080,
			duration: "8.125",
			avg_frame_rate: "30000/1001",
		},
		{ index: 3, codec_type: "audio", sample_rate: "48000", channels: 2 },
	],
	format: { duration: "8.2", format_name: "mov,mp4" },
});

describe("CPU input timeline metadata admission", () => {
	it("preserves absolute selected indices and the measured video duration", () => {
		expect(inspectVodInputProbe("source", probe(), identity)).toEqual({
			key: "source",
			durationMs: 8125,
			video: {
				streamIndex: 2,
				width: 1920,
				height: 1080,
				frameRate: { num: 30000, den: 1001 },
			},
			audio: { streamIndex: 3, sampleRate: 48000, channels: 2 },
			identity,
		});
	});
	it("retains absent audio and rejects impossible/oversized media instead of claiming readiness", () => {
		const value = probe();
		value.streams.pop();
		expect(inspectVodInputProbe("source", value, identity).audio).toBeNull();
		for (const patch of [
			{ duration: "Infinity" },
			{ width: 32768 },
			{ width: -1 },
			{ disposition: { attached_pic: 1 } },
		]) {
			const invalid = probe();
			const first = invalid.streams[0];
			if (!first) throw new Error("Missing test video");
			Object.assign(first, patch);
			expect(() => inspectVodInputProbe("source", invalid, identity)).toThrow();
		}
	});
	it("fits the main source aspect into an even bounded preview canvas", () => {
		expect(vodInputPreviewCanvas(1920, 1080)).toEqual({
			width: 640,
			height: 360,
		});
		expect(vodInputPreviewCanvas(640, 480)).toEqual({
			width: 480,
			height: 360,
		});
		expect(vodInputPreviewCanvas(1080, 1920)).toEqual({
			width: 202,
			height: 360,
		});
	});
	it("only permits bridge HTTP and bounded supported container parsing", () => {
		const args = vodInputPreviewReadArgs("http://127.0.0.1:1234/token/0");
		expect(args).toContain("http,tcp");
		expect(args).toContain("mov,matroska,webm,mpegts");
		expect(() =>
			vodInputPreviewReadArgs("https://customer/source.mp4"),
		).toThrow();
		expect(() => vodInputPreviewReadArgs("file:///etc/passwd")).toThrow();
	});
});
