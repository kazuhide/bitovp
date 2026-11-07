import { describe, expect, it } from "vitest";
import {
	aisaActionBodySchema,
	aisaAnalysisSchema,
	aisaCreateBodySchema,
	aisaIngestSchema,
	aisaResultSchema,
} from "./contracts";

const accountId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const encodingId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const outputId = "cccccccc-cccc-4ccc-accc-cccccccccccc";
const destination = { outputId, outputPath: "synthetic/analysis" };
const create = {
	bitmovinAccountId: accountId,
	analysis: {
		name: "Synthetic tennis analysis",
		input: { type: "RTMP", streamKey: "synthetickey" },
		recording: {
			outputs: [{ ...destination, outputPath: "synthetic/recording" }],
		},
		outputs: [destination],
	},
};

describe("AISA Live request contracts", () => {
	it("accepts a typed input and omits a blank Encoder release", () => {
		const parsed = aisaCreateBodySchema.parse({
			...create,
			analysis: { ...create.analysis, encoderVersion: "  " },
		});
		expect(parsed.analysis.input).toEqual(create.analysis.input);
		expect(parsed.analysis.encoderVersion).toBeUndefined();
	});

	it("preserves a signed HLS query without accepting user info or fragments", () => {
		const withUrl = (url: string) => ({
			...create,
			analysis: { ...create.analysis, input: { type: "HLS", url } },
		});
		const url = "https://example.org/live.m3u8?signature=a%2Fb&v=1";
		expect(aisaCreateBodySchema.parse(withUrl(url)).analysis.input).toEqual({
			type: "HLS",
			url,
		});
		for (const invalid of [
			"https://user:pass@example.org/live.m3u8",
			"https://example.org/live.m3u8#fragment",
			"file:///tmp/live.m3u8",
		]) {
			expect(aisaCreateBodySchema.safeParse(withUrl(invalid)).success).toBe(
				false,
			);
		}
	});

	it("requires existing Output references and rejects embedded secrets", () => {
		expect(
			aisaCreateBodySchema.safeParse({
				...create,
				analysis: {
					...create.analysis,
					outputs: [{ ...destination, output: { secretKey: "forbidden" } }],
				},
			}).success,
		).toBe(false);
		expect(
			aisaCreateBodySchema.safeParse({ ...create, apiKey: "forbidden" })
				.success,
		).toBe(false);
	});

	it("accepts an existing Input reference without inventing a stream key", () => {
		const parsed = aisaCreateBodySchema.parse({
			...create,
			analysis: {
				...create.analysis,
				input: { type: "REFERENCE", inputId: encodingId },
			},
		});
		expect(parsed.analysis.input).toEqual({
			type: "REFERENCE",
			inputId: encodingId,
		});
	});

	it("does not offer EXTERNAL or malformed RTMP keys", () => {
		for (const partial of [
			{ cloudRegion: "EXTERNAL" },
			{ input: { type: "RTMP", streamKey: "invalid-key" } },
		]) {
			expect(
				aisaCreateBodySchema.safeParse({
					...create,
					analysis: { ...create.analysis, ...partial },
				}).success,
			).toBe(false);
		}
	});

	it("keeps component overrides separate from create and permits them only on start", () => {
		const action = {
			bitmovinAccountId: accountId,
			action: "start",
			esVersion: "develop.test-123",
		};
		expect(aisaActionBodySchema.parse(action).esVersion).toBe(
			"develop.test-123",
		);
		expect(
			aisaActionBodySchema.safeParse({ ...action, action: "stop" }).success,
		).toBe(false);
		expect(
			aisaActionBodySchema.safeParse({
				...action,
				esVersion: "valid\r\nInjected: x",
			}).success,
		).toBe(false);
	});
});

const resultFixture = () => ({
	analysisId: accountId,
	encodingId,
	sequence: 1,
	producedAt: "2026-11-07T00:00:00Z",
	mediaTimeOriginUnixMs: 1794009600000,
	isFinal: false,
	analyzedStartTimeSeconds: 0,
	analyzedEndTimeSeconds: 20,
	metadata: { version: "synthetic", disclaimer: "Synthetic data" },
	observations: [
		{
			id: "observation-a",
			text: "A tennis player wins the point.",
			startTimeSeconds: 0,
			endTimeSeconds: 10,
		},
	],
	keyMoments: [
		{
			id: "moment-a",
			lastUpdatedSequence: 1,
			importanceLevel: 1,
			startInSeconds: 1,
			endInSeconds: 9,
			anchorInSeconds: 5,
			observations: ["observation-a"],
			categories: ["sport/tennis", "future/unrecognized"],
		},
	],
});

describe("AISA Live public response contracts", () => {
	it("strips ingest, storage credentials and unknown fields from resource detail", () => {
		expect(
			aisaAnalysisSchema.parse({
				analysisId: accountId,
				encodingId,
				status: "RUNNING",
				createdAt: new Date("2026-11-07T00:00:00Z"),
				rtmpIngest: { streamKey: "must-not-escape" },
				outputs: [{ secretKey: "must-not-escape" }],
			}),
		).toEqual({
			analysisId: accountId,
			encodingId,
			status: "RUNNING",
			createdAt: "2026-11-07T00:00:00.000Z",
		});
	});

	it("normalizes omitted cumulative collections and retains future categories", () => {
		const snapshot = aisaResultSchema.parse(resultFixture());
		expect(snapshot.sourceGaps).toEqual([]);
		const moment = snapshot.keyMoments.find((item) => item.id === "moment-a");
		expect(moment?.categories).toContain("future/unrecognized");
		const {
			observations: _observations,
			keyMoments: _moments,
			...empty
		} = resultFixture();
		expect(aisaResultSchema.parse(empty)).toMatchObject({
			observations: [],
			keyMoments: [],
			sourceGaps: [],
		});
	});

	it("rejects references to absent observations, duplicate IDs and invalid anchors", () => {
		const fixture = resultFixture();
		for (const keyMoments of [
			[{ ...fixture.keyMoments[0], observations: ["missing"] }],
			[fixture.keyMoments[0], fixture.keyMoments[0]],
			[{ ...fixture.keyMoments[0], anchorInSeconds: 99 }],
		]) {
			expect(
				aisaResultSchema.safeParse({ ...fixture, keyMoments }).success,
			).toBe(false);
		}
	});

	it("does not expose upstream extras in the operator ingest contract", () => {
		expect(
			aisaIngestSchema.parse({
				rtmpIngest: { encoderIp: "192.0.2.1", streamKey: "synthetickey" },
				apiKey: "must-not-escape",
			}),
		).toEqual({
			rtmpIngest: { encoderIp: "192.0.2.1", streamKey: "synthetickey" },
		});
	});
});
