import { describe, expect, it } from "vitest";
import { buildLabelUsageSeries } from "./labels";

const account = { id: "account-1", label: "Main" };
const record = {
	label: "customer-a",
	bytesEncoded: 2048,
	timeEncoded: 120,
	billableEncodingMinutes: [
		{ codec: "H264", live: false, billableMinutes: { HD: 2 } },
		{ codec: "AAC", live: true, billableMinutes: { AUDIO: 1 } },
	],
	billableEgressBytes: [{ bytes: 1024 }],
};
const build = (rows: unknown[], to = "2026-10-01") =>
	buildLabelUsageSeries({
		account,
		label: "customer-a",
		from: "2026-10-01",
		to,
		rows,
		readAt: new Date("2026-10-02T00:00:00Z"),
	});

describe("label usage series", () => {
	it("reports one combined series without duplicating usage into VOD and Live", () => {
		const data = build([{ date: "2026-10-01", labels: [record] }]);
		expect(data.scope).toBe("LABEL");
		expect(data.label).toBe("customer-a");
		expect(data.days).toEqual([
			{
				date: "2026-10-01",
				billableEncodingMinutes: 3,
				bytesEncoded: 2048,
				billableEgressBytes: 1024,
			},
		]);
		expect(data.totals.billableEncodingMinutes).toBe(3);
		expect(data).not.toHaveProperty("VOD");
		expect(data.totals).not.toHaveProperty("LIVE");
		expect(data.breakdown).toEqual([
			{ codec: "H264", resolution: "HD", billableMinutes: 2 },
			{ codec: "AAC", resolution: "AUDIO", billableMinutes: 1 },
		]);
	});
	it("keeps omitted days and period totals unknown instead of inventing measured zeros", () => {
		const data = build(
			[{ date: "2026-10-01", labels: [record] }],
			"2026-10-02",
		);
		expect(data.days[1]).toEqual({
			date: "2026-10-02",
			billableEncodingMinutes: null,
			bytesEncoded: null,
			billableEgressBytes: null,
		});
		expect(data.totals).toEqual({
			billableEncodingMinutes: null,
			bytesEncoded: null,
			billableEgressBytes: null,
		});
		expect(data.coverage.missingDays).toBe(1);
	});
	it("keeps an absent metric unknown while preserving an explicit zero", () => {
		const data = build([
			{
				date: "2026-10-01",
				labels: [{ label: "customer-a", bytesEncoded: 0 }],
			},
		]);
		expect(data.days[0]).toMatchObject({
			bytesEncoded: 0,
			billableEncodingMinutes: null,
			billableEgressBytes: null,
		});
	});
	it("never combines overlapping labels in one day", () => {
		expect(() =>
			build([
				{
					date: "2026-10-01",
					labels: [record, { ...record, label: "customer-b" }],
				},
			]),
		).toThrow();
	});
	it.each(
		[
			[{ date: "2026-10-03", labels: [record] }],
			[{ date: "not-a-date", labels: [record] }],
			[{ date: "2026-10-01", labels: [{ ...record, date: "2026-10-02" }] }],
			[{ date: "2026-10-01", labels: [record, record] }],
			[
				{ date: "2026-10-01", labels: [record] },
				{ date: "2026-10-01", labels: [record] },
			],
			[{ date: "2026-10-01", labels: [{ ...record, bytesEncoded: "bad" }] }],
		].map((rows) => ({ rows })),
	)("rejects malformed, duplicate or out-of-range provider rows", ({
		rows,
	}) => {
		expect(() => build(rows)).toThrow();
	});
	it("does not infer zero minutes from an entry missing every billing class", () => {
		const data = build([
			{
				date: "2026-10-01",
				labels: [
					{
						label: "customer-a",
						billableEncodingMinutes: [{ billableMinutes: {} }],
					},
				],
			},
		]);
		expect(data.totals.billableEncodingMinutes).toBeNull();
	});
	it("preserves negative provider minutes", () => {
		const data = build([
			{
				date: "2026-10-01",
				labels: [
					{
						...record,
						billableEncodingMinutes: [
							{ codec: "H264", billableMinutes: { HD: -2 } },
						],
					},
				],
			},
		]);
		expect(data.totals.billableEncodingMinutes).toBe(-2);
	});
});
