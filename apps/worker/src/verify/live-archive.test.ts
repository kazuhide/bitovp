import { describe, expect, it } from "vitest";
import { archiveMediaFacts, writeArchiveBytes } from "./live-archive";

describe("bounded post-stop archive evidence", () => {
	it.each([
		["video", "h264", 2, null],
		["audio", "aac", null, 2],
	] as const)("accepts the planned %s-only archive without inventing A/V durations", (type, codec, video, audio) => {
		expect(
			archiveMediaFacts(
				{
					streams: [
						{
							codec_type: type,
							codec_name: codec,
							duration: "2",
							nb_read_frames: "60",
						},
					],
				},
				[codec],
			),
		).toMatchObject({
			videoDurationSeconds: video,
			audioDurationSeconds: audio,
			durationDifferenceSeconds: null,
			avSync: "UNVERIFIED",
		});
	});
	it("rejects the wrong media type even when the codec name matches", () => {
		expect(() =>
			archiveMediaFacts(
				{
					streams: [
						{
							codec_type: "audio",
							codec_name: "h264",
							duration: "2",
							nb_read_frames: "60",
						},
					],
				},
				["h264"],
			),
		).toThrow();
	});
	it("rejects truncated and overlong object bodies", async () => {
		const chunks = async function* () {
			yield Buffer.from("abc");
		};
		await expect(
			writeArchiveBytes(chunks(), 4, async () => {}),
		).rejects.toThrow();
		await expect(
			writeArchiveBytes(chunks(), 2, async () => {}),
		).rejects.toThrow();
	});
	it("hashes all exact bytes", async () => {
		const chunks = async function* () {
			yield Buffer.from("a");
			yield Buffer.from("bc");
		};
		const out: Buffer[] = [];
		expect(
			await writeArchiveBytes(chunks(), 3, async (b) => {
				out.push(b);
			}),
		).toEqual({
			bytes: 3,
			sha256:
				"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		});
		expect(Buffer.concat(out).toString()).toBe("abc");
	});
	it("requires both decoded video and audio and never calls duration equality lip-sync", () => {
		const video = {
			codec_type: "video",
			codec_name: "h264",
			duration: "2",
			nb_read_frames: "60",
		};
		const audio = {
			codec_type: "audio",
			codec_name: "aac",
			duration: "2.02",
			nb_read_frames: "94",
		};
		expect(() =>
			archiveMediaFacts({ streams: [video] }, ["h264", "aac"]),
		).toThrow();
		const facts = archiveMediaFacts({ streams: [video, audio] }, [
			"h264",
			"aac",
		]);
		expect(facts.avSync).toBe("UNVERIFIED");
		expect(facts.durationDifferenceSeconds).toBeCloseTo(0.02);
		expect(() =>
			archiveMediaFacts(
				{ streams: [video, { ...audio, nb_read_frames: "0" }] },
				["h264", "aac"],
			),
		).toThrow();
	});
});
