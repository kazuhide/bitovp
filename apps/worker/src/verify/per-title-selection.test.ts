import type { PerTitleActualPopulations } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	scopedPerTitleResults,
	scopedPerTitleVideoFamilies,
} from "./per-title-selection";

const complete = (
	results: Extract<
		PerTitleActualPopulations,
		{ status: "complete" }
	>["results"],
): PerTitleActualPopulations => ({
	status: "complete",
	results,
	qc: [],
	deliveryMuxings: [],
});

describe("scopedPerTitleVideoFamilies", () => {
	it("allows a pruned flexible template while retaining required fixed templates", () => {
		const population = complete([
			{ streamId: "one", templateRendition: "selected", codecType: "H264" },
		]);
		expect(
			scopedPerTitleVideoFamilies(population, [
				{ renditionKey: "selected" },
				{ renditionKey: "pruned", optional: true },
			]),
		).toEqual({ status: "complete", families: ["H264"], results: 1 });
		expect(
			scopedPerTitleVideoFamilies(population, [
				{ renditionKey: "selected" },
				{ renditionKey: "missing-fixed" },
			]),
		).toMatchObject({ status: "incomplete" });
	});
	it("can bind selected RESULT identities even when legacy capture lacks codec metadata", () => {
		const results = [{ streamId: "one", templateRendition: "selected" }];
		const population = complete(results),
			selection = [{ renditionKey: "selected" }];
		expect(scopedPerTitleResults(population, selection)).toEqual({
			status: "complete",
			results,
		});
		expect(scopedPerTitleVideoFamilies(population, selection)).toMatchObject({
			status: "incomplete",
			reason: expect.stringContaining("codec"),
		});
	});
	it("uses captured codec types and selected RESULT counts, including HEVCv2 normalization", () => {
		const population = complete([
			{ streamId: "one", templateRendition: "selected", codecType: "H265V2" },
			{ streamId: "two", templateRendition: "selected", codecType: "H265" },
			{ streamId: "foreign", templateRendition: "another", codecType: "H264" },
		]);
		expect(
			scopedPerTitleVideoFamilies(population, [{ renditionKey: "selected" }]),
		).toEqual({ status: "complete", families: ["H265"], results: 2 });
	});
	it("does not replace a captured wrong or unknown codec with a plan family", () => {
		const population = complete([
			{
				streamId: "one",
				templateRendition: "selected",
				codecType: "UnexpectedCodec",
			},
		]);
		expect(
			scopedPerTitleVideoFamilies(population, [{ renditionKey: "selected" }]),
		).toEqual({
			status: "complete",
			families: ["UnexpectedCodec"],
			results: 1,
		});
	});
	it("does not certify duplicate RESULT identities even when their codec types agree", () => {
		const population = complete([
			{ streamId: "one", templateRendition: "selected", codecType: "H264" },
			{ streamId: "one", templateRendition: "selected", codecType: "H264" },
		]);
		expect(
			scopedPerTitleVideoFamilies(population, [{ renditionKey: "selected" }]),
		).toMatchObject({
			status: "incomplete",
			reason: expect.stringContaining("duplicate"),
		});
	});
	it("does not certify absent compiler selection metadata", () => {
		const population = complete([
			{ streamId: "one", templateRendition: "selected", codecType: "H264" },
		]);
		for (const selection of [undefined, []])
			expect(scopedPerTitleVideoFamilies(population, selection)).toMatchObject({
				status: "incomplete",
			});
	});
});
