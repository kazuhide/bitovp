import { describe, expect, it } from "vitest";
import { projectIntegerBitrateSlots } from "./per-title-output-count.js";

const base = {
	minimumBitrate: 100,
	ceiling: 500,
	minimumStep: 1.5,
	maximumStep: 2,
	count: 4,
};

describe("integer bitrate slot projection", () => {
	it("narrows earlier slots to the rates that can finish a complete chain", () => {
		expect(projectIntegerBitrateSlots(base)).toEqual({
			status: "conditional",
			slots: [
				{ minimum: 100, maximum: 100 },
				{ minimum: 150, maximum: 200 },
				{ minimum: 225, maximum: 333 },
				{ minimum: 338, maximum: 500 },
			],
		});
	});

	it("uses the serialized decimal ratio without binary roundoff at an integer boundary", () => {
		expect(
			projectIntegerBitrateSlots({
				minimumBitrate: 100_000,
				ceiling: 4_000_000,
				minimumStep: 1.9,
				maximumStep: 1.9,
				count: 6,
			}),
		).toEqual({
			status: "conditional",
			slots: [100_000, 190_000, 361_000, 685_900, 1_303_210, 2_476_099].map(
				(value) => ({ minimum: value, maximum: value }),
			),
		});
	});

	it.each([
		10_001, 10_003,
	])("keeps a genuine fractional step from %i infeasible", (minimumBitrate) => {
		expect(
			projectIntegerBitrateSlots({
				...base,
				minimumBitrate,
				ceiling: 30_000,
				minimumStep: 1.5,
				maximumStep: 1.5,
				count: 2,
			}),
		).toEqual({
			status: "infeasible",
			reason: "integer-chain-infeasible",
		});
	});

	it("supports a single starting slot without selecting the ceiling", () => {
		expect(projectIntegerBitrateSlots({ ...base, count: 1 })).toEqual({
			status: "conditional",
			slots: [{ minimum: 100, maximum: 100 }],
		});
	});

	it("can certify 256 small integer slots without logarithmic count rounding", () => {
		const result = projectIntegerBitrateSlots({
			minimumBitrate: 1,
			ceiling: 256,
			minimumStep: 1.0001,
			maximumStep: 2,
			count: 256,
		});
		expect(result.status).toBe("conditional");
		if (result.status !== "conditional") throw new Error("Expected slots");
		expect(result.slots).toEqual(
			Array.from({ length: 256 }, (_, index) => ({
				minimum: index + 1,
				maximum: index + 1,
			})),
		);
	});

	it("handles exponent-form bounds without overflowing numeric products", () => {
		expect(
			projectIntegerBitrateSlots({ ...base, maximumStep: 1e308, count: 2 }),
		).toEqual({
			status: "conditional",
			slots: [
				{ minimum: 100, maximum: 100 },
				{ minimum: 150, maximum: 500 },
			],
		});
		expect(
			projectIntegerBitrateSlots({
				...base,
				minimumStep: 1e21,
				maximumStep: 1e308,
				count: 2,
			}),
		).toEqual({ status: "infeasible", reason: "integer-chain-infeasible" });
	});

	it.each([
		0,
		-1,
		1.5,
		Number.NaN,
		Infinity,
	])("rejects invalid count %s before constructing slots", (count) => {
		expect(projectIntegerBitrateSlots({ ...base, count })).toEqual({
			status: "unavailable",
			reason: "invalid-count",
		});
	});

	it("distinguishes the local count limit from invalid or infeasible parameters", () => {
		expect(projectIntegerBitrateSlots({ ...base, count: 257 })).toEqual({
			status: "unavailable",
			reason: "model-limit",
		});
	});

	it.each([
		{ minimumBitrate: 0 },
		{ minimumBitrate: 1.5 },
		{ minimumBitrate: Number.MAX_SAFE_INTEGER },
		{ ceiling: 99 },
		{ ceiling: 2_147_483_648 },
		{ minimumStep: 1 },
		{ minimumStep: 0.5 },
		{ minimumStep: Number.NaN },
		{ maximumStep: Infinity },
		{ maximumStep: 1.49 },
	])("keeps invalid arithmetic inputs unavailable (%j)", (override) => {
		expect(projectIntegerBitrateSlots({ ...base, ...override })).toEqual({
			status: "unavailable",
			reason: "invalid-input",
		});
	});

	it("matches enumerated integer chains, including every value between projected endpoints", () => {
		const ratios = [
			[6, 5, 6, 5],
			[6, 5, 5, 4],
			[5, 4, 3, 2],
			[3, 2, 3, 2],
			[3, 2, 7, 4],
			[3, 2, 2, 1],
			[19, 10, 2, 1],
			[2, 1, 5, 2],
		] as const;
		for (const [sn, sd, tn, td] of ratios)
			for (let minimumBitrate = 1; minimumBitrate <= 6; minimumBitrate++)
				for (let ceiling = minimumBitrate; ceiling <= 24; ceiling++)
					for (let count = 1; count <= 5; count++) {
						const connects = (x: number, y: number) =>
							y * sd >= x * sn && y * td <= x * tn;
						const forward = [new Set([minimumBitrate])];
						for (let index = 1; index < count; index++) {
							const next = new Set<number>();
							for (const x of forward[index - 1] ?? [])
								for (let y = x + 1; y <= ceiling; y++)
									if (connects(x, y)) next.add(y);
							forward.push(next);
						}
						const supported = forward.map((values) => new Set(values));
						for (let index = count - 2; index >= 0; index--)
							for (const x of supported[index] ?? [])
								if (
									![...(supported[index + 1] ?? [])].some((y) => connects(x, y))
								)
									supported[index]?.delete(x);
						const result = projectIntegerBitrateSlots({
							minimumBitrate,
							ceiling,
							minimumStep: sn / sd,
							maximumStep: tn / td,
							count,
						});
						const context = JSON.stringify({
							sn,
							sd,
							tn,
							td,
							minimumBitrate,
							ceiling,
							count,
						});
						if (supported[count - 1]?.size === 0) {
							expect(result, context).toEqual({
								status: "infeasible",
								reason: "integer-chain-infeasible",
							});
							continue;
						}
						expect(result.status, context).toBe("conditional");
						if (result.status !== "conditional") throw new Error(context);
						for (const [index, slot] of result.slots.entries())
							expect(
								Array.from(
									{ length: slot.maximum - slot.minimum + 1 },
									(_, offset) => slot.minimum + offset,
								),
								context,
							).toEqual([...(supported[index] ?? [])].sort((a, b) => a - b));
					}
	});
});
