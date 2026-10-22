import type { PerTitleGoal } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { perTitleAdviceFieldKey } from "./per-title-simulator-advice-fields";
import { protectedPerTitleRangeMap } from "./per-title-simulator-joint-mapping";

const source = (): PerTitleGoal => ({
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 100_000,
	maxBitrate: 4_000_000,
	countPolicy: { kind: "unrestricted" },
	rows: [
		{ id: "low", height: 240, minBitrate: 200_000, maxBitrate: 400_000 },
		{ id: "top", height: 1080, minBitrate: 2_000_000, maxBitrate: 4_000_000 },
	],
});
const pin = (rowId: string, key: "minBitrate" | "maxBitrate") =>
	perTitleAdviceFieldKey({ scope: "stream", rowId, key });

describe("protected rendition range mapping", () => {
	it("retains a rendition at the previous global cap while the cap grows", () => {
		const before = source();
		const map = protectedPerTitleRangeMap(
			before,
			{ ...before, maxBitrate: 8_000_000 },
			new Set([pin("top", "maxBitrate")]),
		);
		expect(map).not.toBeNull();
		expect(map?.(4_000_000)).toBe(4_000_000);
		expect(map?.(2_000_000)).toBe(2_000_000);
	});

	it("keeps an independently protected endpoint and expands only above it", () => {
		const before = source();
		const map = protectedPerTitleRangeMap(
			before,
			{ ...before, maxBitrate: 8_000_000 },
			new Set([pin("low", "maxBitrate")]),
		);
		expect(map?.(200_000)).toBe(200_000);
		expect(map?.(400_000)).toBe(400_000);
		expect(map?.(2_000_000)).toBeGreaterThan(2_000_000);
		expect(map?.(4_000_000)).toBe(8_000_000);
	});

	it("rejects incompatible targets sharing the same source endpoint", () => {
		const before = source();
		before.rows = [
			...(before.rows ?? []),
			{
				id: "peer",
				height: 360,
				minBitrate: 400_000,
				maxBitrate: 600_000,
			},
		];
		const current = structuredClone(before);
		current.maxBitrate = 8_000_000;
		const peer = current.rows?.find((row) => row.id === "peer");
		if (!peer) throw new Error("Missing fixture row.");
		peer.minBitrate = 500_000;
		expect(
			protectedPerTitleRangeMap(
				before,
				current,
				new Set([pin("low", "maxBitrate"), pin("peer", "minBitrate")]),
			),
		).toBeNull();
	});

	it("rejects protected targets whose bitrate ordering is reversed", () => {
		const before = source();
		const current = structuredClone(before);
		current.maxBitrate = 8_000_000;
		const row = current.rows?.[0];
		if (!row) throw new Error("Missing fixture row.");
		row.minBitrate = 500_000;
		expect(
			protectedPerTitleRangeMap(
				before,
				current,
				new Set([pin("low", "minBitrate"), pin("low", "maxBitrate")]),
			),
		).toBeNull();
	});
});
