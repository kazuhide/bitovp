import { describe, expect, it } from "vitest";
import {
	addUtcDays,
	buildUsageSeries,
	summarizeProviderDay,
	type UsageBreakdown,
	usageBreakdownSchema,
	usageFreshness,
	usageSeriesSchema,
	utcDayKey,
} from "./statistics";

describe("encoding-only usage and daily class provenance", () => {
	function series(raws: Parameters<typeof summarizeProviderDay>[1][]) {
		return buildUsageSeries({
			from: "2026-08-23",
			to: "2026-08-25",
			accounts: [],
			accountIds: [],
			cursors: [],
			rows: raws.map((raw) => {
				const row = summarizeProviderDay("LIVE", raw);
				if (!row) throw new Error("missing fixture date");
				return row;
			}),
		});
	}
	it("preserves the legacy combined value but isolates negative provider feature minutes from encoding usage", () => {
		const encoding = 372.375 + 163.6666666667 + 3220.6666666667;
		const result = series([
			{
				date: "2026-08-23",
				billableFeatureMinutes: -144108.83333333334,
				billableTransmuxingMinutes: 0,
				billableEncodingMinutes: [
					{ codec: "AAC", billableMinutes: { AUDIO: 372.375 } },
					{
						codec: "H264",
						billableMinutes: { SD: 163.6666666667, HD: 3220.6666666667 },
					},
				],
			},
		]);
		expect(result.totals.LIVE).toMatchObject({
			billableEncodingMinutes: encoding,
			billableFeatureMinutes: -144108.83333333334,
			billableTransmuxingMinutes: 0,
			billableMinutes: encoding - 144108.83333333334,
		});
		expect(result.days[0]?.LIVE).toEqual(result.totals.LIVE);
		expect(result.days[1]?.LIVE).toMatchObject({
			billableEncodingMinutes: 0,
			billableFeatureMinutes: 0,
			billableTransmuxingMinutes: 0,
		});
		expect(result.totals.VOD).toMatchObject({ billableEncodingMinutes: 0 });
		expect(result.breakdown.codecResolution).toEqual([
			{
				kind: "LIVE",
				codec: "H264",
				resolution: "HD",
				billableMinutes: 3220.6666666667,
				encodedSeconds: null,
				source: "ENCODING_CLASS",
			},
			{
				kind: "LIVE",
				codec: "AAC",
				resolution: "AUDIO",
				billableMinutes: 372.375,
				encodedSeconds: null,
				source: "ENCODING_CLASS",
			},
			{
				kind: "LIVE",
				codec: "H264",
				resolution: "SD",
				billableMinutes: 163.6666666667,
				encodedSeconds: null,
				source: "ENCODING_CLASS",
			},
		]);
	});
	it("persists optional class details and never double-counts them with real streams", () => {
		const raw = {
			date: "2026-08-23",
			billableEncodingMinutes: [{ codec: "H264", billableMinutes: { HD: 2 } }],
			streams: [
				{
					codec: "H264",
					width: 1280,
					height: 720,
					encodedSeconds: 60,
					billableMinutes: 2,
				},
			],
		};
		const row = summarizeProviderDay("LIVE", raw);
		expect(row?.breakdown).toHaveProperty("encodingClasses", [
			{ codec: "H264", resolution: "HD", billableMinutes: 2 },
		]);
		expect(usageBreakdownSchema.safeParse(row?.breakdown).success).toBe(true);
		expect(series([raw]).breakdown.codecResolution).toEqual([
			{
				kind: "LIVE",
				codec: "H264",
				resolution: "1280x720",
				billableMinutes: 2,
				encodedSeconds: 60,
				source: "STREAM",
			},
		]);
	});
	it("keeps absent or invalid stream seconds unknown, including mixed known/unknown aggregation", () => {
		const result = series([
			{
				date: "2026-08-23",
				streams: [
					{
						codec: "H264",
						resolution: "HD",
						billableMinutes: 1,
						encodedSeconds: 60,
					},
				],
			},
			{
				date: "2026-08-24",
				streams: [{ codec: "H264", resolution: "HD", billableMinutes: 2 }],
			},
			{
				date: "2026-08-25",
				streams: [
					{
						codec: "AAC",
						resolution: "AUDIO",
						billableMinutes: 1,
						encodedSeconds: Number.NaN,
					},
				],
			},
		]);
		expect(
			result.breakdown.codecResolution.map((item) => item.encodedSeconds),
		).toEqual([null, null]);
		expect(usageSeriesSchema.safeParse(result).success).toBe(true);
	});
	it("separates STREAM class labels from coarse daily classes across different rows", () => {
		const result = series([
			{
				date: "2026-08-23",
				streams: [
					{
						codec: "H264",
						resolution: "HD",
						encodedSeconds: 60,
						billableMinutes: 1,
					},
				],
			},
			{
				date: "2026-08-24",
				billableEncodingMinutes: [
					{ codec: "H264", billableMinutes: { HD: 2 } },
				],
			},
		]);
		expect(result.breakdown.codecResolution).toHaveLength(2);
		expect(
			result.breakdown.codecResolution.map((item) => item.encodedSeconds),
		).toEqual([null, 60]);
	});
	it("counts missing legacy account-day records, not quiet days or inferred codec classes", () => {
		const raw = {
			date: "2026-08-23",
			billableEncodingMinutes: [{ codec: "H264", billableMinutes: { HD: 2 } }],
		};
		const row = summarizeProviderDay("LIVE", raw);
		if (!row) throw new Error("missing fixture date");
		const legacy = { ...row.breakdown } as Record<string, unknown>;
		delete legacy.encodingClasses;
		const parsed = usageBreakdownSchema.parse(legacy);
		expect(parsed.buckets.HD).toBe(2);
		expect(parsed).not.toHaveProperty("encodingClasses");
		const negative = {
			...row,
			breakdown: { ...parsed, buckets: { ...parsed.buckets, HD: -2 } },
		};
		const result = buildUsageSeries({
			from: "2026-08-23",
			to: "2026-08-25",
			accounts: [],
			accountIds: [],
			cursors: [],
			rows: [{ ...row, breakdown: parsed }, negative, { ...row, kind: "VOD" }],
		});
		expect(result.breakdown).toHaveProperty("codecResolutionMissingRows", {
			LIVE: 2,
			VOD: 0,
		});
		expect(result.totals.LIVE).toHaveProperty("billableEncodingMinutes", 0);
		expect(result.breakdown.codecResolution).toHaveLength(1);
		expect(series([]).breakdown).toHaveProperty("codecResolutionMissingRows", {
			LIVE: 0,
			VOD: 0,
		});
	});
});

describe("summarizeProviderDay (row #314)", () => {
	it("sums the encoding buckets with transmuxing and feature minutes, and keeps the provider's breakdown", () => {
		const row = summarizeProviderDay("VOD", {
			date: new Date("2026-09-05T00:00:00Z"),
			bytesEncoded: 1000,
			timeEncoded: 120,
			bytesEgress: 5000,
			billableTransmuxingMinutes: 1.5,
			billableFeatureMinutes: 0.5,
			billableEncodingMinutes: [
				{ codec: "H264", billableMinutes: { SD: 1, HD: 2 } },
				{ codec: "H265", billableMinutes: { HD: 3, UHD: 4, UNKNOWN: 0 } },
			],
			streams: [
				{
					codec: "H264",
					width: 1920,
					height: 1080,
					encodedSeconds: 60,
					billableMinutes: 2,
				},
				{
					codec: "AAC",
					resolution: "AUDIO",
					encodedSeconds: 60,
					billableMinutes: 0.25,
				},
			],
			features: [{ featureType: "PER_TITLE", billableMinutes: 0.5 }],
			billableEgressBytes: [
				{
					category: "CDN",
					outputType: "S3",
					outputRegion: "AWS_AP_NORTHEAST_1",
					bytes: 5000,
				},
			],
		});
		expect(row).toMatchObject({
			date: "2026-09-05",
			kind: "VOD",
			bytesEncoded: 1000,
			timeEncodedS: 120,
			bytesEgress: 5000,
			billableMinutes: 1 + 2 + 3 + 4 + 1.5 + 0.5,
		});
		expect(row?.breakdown.buckets).toEqual({
			SD: 1,
			HD: 5,
			UHD: 4,
			AUDIO: 0,
			UNKNOWN: 0,
		});
		expect(row?.breakdown.streams[0]).toEqual({
			codec: "H264",
			resolution: "1920x1080",
			encodedSeconds: 60,
			billableMinutes: 2,
		});
		expect(row?.breakdown.egress[0]).toEqual({
			category: "CDN",
			outputType: "S3",
			region: "AWS_AP_NORTHEAST_1",
			bytes: 5000,
		});
	});

	it("a row without a date cannot be stored", () => {
		expect(summarizeProviderDay("LIVE", { bytesEncoded: 1 })).toBeNull();
		expect(summarizeProviderDay("LIVE", { date: "not a date" })).toBeNull();
	});

	it("prefers the stream's exact geometry over the SD/HD/UHD enum (rev426 O3)", () => {
		const day = summarizeProviderDay("VOD", {
			date: "2026-09-01",
			streams: [
				{
					codec: "H264",
					resolution: "HD",
					width: 1920,
					height: 1080,
					encodedSeconds: 60,
					billableMinutes: 1,
				},
				{
					codec: "H265",
					resolution: "UHD",
					encodedSeconds: 60,
					billableMinutes: 1,
				},
			],
		});
		expect(day?.breakdown.streams.map((s) => s.resolution)).toEqual([
			"1920x1080",
			"UHD",
		]);
	});

	it("treats missing and non-finite numbers as zero", () => {
		const row = summarizeProviderDay("LIVE", {
			date: "2026-09-05",
			bytesEncoded: Number.NaN,
			billableEncodingMinutes: [{ billableMinutes: {} }],
		});
		expect(row?.bytesEncoded).toBe(0);
		expect(row?.billableMinutes).toBe(0);
	});
});

describe("buildUsageSeries (row #314)", () => {
	const breakdown = (over: Partial<UsageBreakdown> = {}): UsageBreakdown => ({
		buckets: { SD: 0, HD: 0, UHD: 0, AUDIO: 0, UNKNOWN: 0 },
		transmuxingMinutes: 0,
		featureMinutes: 0,
		streams: [],
		features: [],
		egress: [],
		...over,
	});
	const cursor = (
		bitmovinAccountId: string,
		kind: "VOD" | "LIVE",
		sweptThrough: string,
		sweptAt: string,
	) => ({ bitmovinAccountId, kind, sweptThrough, sweptAt: new Date(sweptAt) });
	it("fills every day of the range, sums accounts, aggregates codec×resolution and egress, and takes freshness from the OLDEST cursor", () => {
		const series = buildUsageSeries({
			from: "2026-09-01",
			to: "2026-09-04",
			accounts: [
				{ id: "a", label: "A" },
				{ id: "b", label: "B" },
			],
			accountIds: ["a", "b"],
			cursors: [
				cursor("a", "VOD", "2026-09-04", "2026-09-05T01:00:00Z"),
				cursor("a", "LIVE", "2026-09-04", "2026-09-05T02:00:00Z"),
				// account b's VOD read stopped at Sept 2: the oldest cursor bounds both
				cursor("b", "VOD", "2026-09-02", "2026-09-05T00:00:00Z"),
				cursor("b", "LIVE", "2026-09-04", "2026-09-05T03:00:00Z"),
			],
			rows: [
				{
					date: "2026-09-01",
					kind: "VOD",
					bytesEncoded: 10,
					timeEncodedS: 60,
					bytesEgress: 100,
					billableMinutes: 5,
					breakdown: breakdown({
						buckets: { SD: 0, HD: 5, UHD: 0, AUDIO: 0, UNKNOWN: 0 },
						streams: [
							{
								codec: "H264",
								resolution: "1920x1080",
								encodedSeconds: 60,
								billableMinutes: 5,
							},
						],
						egress: [
							{ category: "CDN", outputType: "S3", region: "r1", bytes: 100 },
						],
					}),
				},
				{
					date: "2026-09-01",
					kind: "VOD",
					bytesEncoded: 1,
					timeEncodedS: 6,
					bytesEgress: 10,
					billableMinutes: 1,
					breakdown: breakdown({
						buckets: { SD: 1, HD: 0, UHD: 0, AUDIO: 0, UNKNOWN: 0 },
						streams: [
							{
								codec: "H264",
								resolution: "1920x1080",
								encodedSeconds: 6,
								billableMinutes: 1,
							},
						],
						egress: [
							{ category: "CDN", outputType: "GCS", region: "r1", bytes: 10 },
						],
					}),
				},
				{
					date: "2026-09-03",
					kind: "LIVE",
					bytesEncoded: 20,
					timeEncodedS: 600,
					bytesEgress: 0,
					billableMinutes: 10,
					breakdown: breakdown({
						buckets: { SD: 0, HD: 10, UHD: 0, AUDIO: 0, UNKNOWN: 0 },
						streams: [
							{
								codec: "H265",
								resolution: "1280x720",
								encodedSeconds: 600,
								billableMinutes: 10,
							},
						],
					}),
				},
				// outside the range: ignored
				{
					date: "2026-08-31",
					kind: "VOD",
					bytesEncoded: 999,
					timeEncodedS: 9,
					bytesEgress: 9,
					billableMinutes: 99,
					breakdown: breakdown(),
				},
			],
		});
		expect(usageSeriesSchema.safeParse(series).success).toBe(true);
		expect(series.days.map((d) => d.date)).toEqual([
			"2026-09-01",
			"2026-09-02",
			"2026-09-03",
			"2026-09-04",
		]);
		expect(series.days[0]?.VOD).toEqual({
			billableEncodingMinutes: 6,
			billableFeatureMinutes: 0,
			billableTransmuxingMinutes: 0,
			billableMinutes: 6,
			bytesEncoded: 11,
			bytesEgress: 110,
			timeEncodedS: 66,
		});
		expect(series.days[1]?.VOD.billableMinutes).toBe(0);
		expect(series.days[2]?.LIVE.billableMinutes).toBe(10);
		expect(series.totals.VOD.billableMinutes).toBe(6);
		expect(series.totals.LIVE.bytesEncoded).toBe(20);
		expect(series.breakdown.buckets.VOD).toEqual({
			SD: 1,
			HD: 5,
			UHD: 0,
			AUDIO: 0,
			UNKNOWN: 0,
		});
		expect(series.breakdown.codecResolution).toEqual([
			{
				kind: "LIVE",
				source: "STREAM",
				codec: "H265",
				resolution: "1280x720",
				billableMinutes: 10,
				encodedSeconds: 600,
			},
			{
				kind: "VOD",
				source: "STREAM",
				codec: "H264",
				resolution: "1920x1080",
				billableMinutes: 6,
				encodedSeconds: 66,
			},
		]);
		expect(series.breakdown.egress).toEqual([
			{ category: "CDN", region: "r1", bytes: 110 },
		]);
		expect(series.refreshedAt).toBe("2026-09-05T00:00:00.000Z");
		expect(series.pendingDays).toBe(2);
	});

	it("an empty table with no cursors is an all-zero series with no refresh time", () => {
		const series = buildUsageSeries({
			from: "2026-09-01",
			to: "2026-09-02",
			accounts: [],
			rows: [],
			accountIds: [],
			cursors: [],
		});
		expect(series.days).toHaveLength(2);
		expect(series.totals.VOD.billableMinutes).toBe(0);
		expect(series.refreshedAt).toBeNull();
		expect(series.pendingDays).toBe(2);
	});

	describe("usageFreshness (rev426 R2)", () => {
		const range = { from: "2026-09-01", to: "2026-09-04" };
		it("a quiet day is not a pending day: cursors through the end of the range and no rows → nothing pending", () => {
			expect(
				usageFreshness({
					...range,
					accountIds: ["a"],
					cursors: [
						cursor("a", "VOD", "2026-09-04", "2026-09-05T00:00:00Z"),
						cursor("a", "LIVE", "2026-09-04", "2026-09-05T00:00:00Z"),
					],
				}),
			).toEqual({ refreshedAt: "2026-09-05T00:00:00.000Z", pendingDays: 0 });
		});
		it("one unswept kind of one selected account hides every freshness claim", () => {
			expect(
				usageFreshness({
					...range,
					accountIds: ["a", "b"],
					cursors: [
						cursor("a", "VOD", "2026-09-04", "2026-09-05T00:00:00Z"),
						cursor("a", "LIVE", "2026-09-04", "2026-09-05T00:00:00Z"),
						cursor("b", "VOD", "2026-09-04", "2026-09-05T00:00:00Z"),
					],
				}),
			).toEqual({ refreshedAt: null, pendingDays: 4 });
			// … while the fully swept account alone is fine
			expect(
				usageFreshness({
					...range,
					accountIds: ["a"],
					cursors: [
						cursor("a", "VOD", "2026-09-04", "2026-09-05T00:00:00Z"),
						cursor("a", "LIVE", "2026-09-04", "2026-09-05T00:00:00Z"),
						cursor("b", "VOD", "2026-09-04", "2026-09-05T00:00:00Z"),
					],
				}).refreshedAt,
			).toBe("2026-09-05T00:00:00.000Z");
		});
		it("a cursor behind the range start leaves every day pending; the oldest time wins", () => {
			expect(
				usageFreshness({
					...range,
					accountIds: ["a"],
					cursors: [
						cursor("a", "VOD", "2026-08-31", "2026-09-01T00:00:00Z"),
						cursor("a", "LIVE", "2026-09-04", "2026-09-05T00:00:00Z"),
					],
				}),
			).toEqual({ refreshedAt: "2026-09-01T00:00:00.000Z", pendingDays: 4 });
		});
	});

	it("day keys are UTC and step by whole days", () => {
		expect(utcDayKey(new Date("2026-09-05T23:59:59.999Z"))).toBe("2026-09-05");
		expect(addUtcDays("2026-02-28", 1)).toBe("2026-03-01");
		expect(addUtcDays("2026-09-05", -90)).toBe("2026-06-07");
	});
});
