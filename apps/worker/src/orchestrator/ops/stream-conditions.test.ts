import { AndConjunction, Condition, OrConjunction } from "@bitmovin/api-sdk";
import type { StreamCondition } from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import { createBitmovinSdkOps } from "../sdk-ops";
import { conditions } from "./shared";

describe("Stream conditions on SDK stream requests", () => {
	it.each([
		"VOD",
		"Live",
	])("sends the authored OR tree through the %s stream-create request", async (mode) => {
		const input: StreamCondition = {
			type: "OR",
			conditions: ["ja", "en"].map((value) => ({
				attribute: "LANGUAGE",
				operator: "EQUAL",
				value,
			})),
		};
		const requests: { path: string; method: string; body: unknown }[] = [];
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (url, init) => {
				requests.push({
					path: new URL(String(url)).pathname,
					method: init?.method ?? "GET",
					body: JSON.parse(String(init?.body)),
				});
				return Response.json({ data: { result: { id: "stream-id" } } });
			});
		try {
			const ops = createBitmovinSdkOps(
				{ apiKey: "test-local" },
				async () => {},
			);
			const location =
				mode === "VOD"
					? { inputStreamId: "ingest-id" }
					: { inputId: "live-id", position: 1 };
			await expect(
				ops.createStream("encoding-id", {
					codecConfigId: "audio-config",
					...location,
					conditions: input,
					mode: "STANDARD",
				}),
			).resolves.toBe("stream-id");
			expect(requests).toMatchObject([
				{
					path: "/v1/encoding/encodings/encoding-id/streams",
					method: "POST",
					body: {
						inputStreams: [location],
						conditions: {
							type: "OR",
							conditions: ["ja", "en"].map((value) => ({
								type: "CONDITION",
								attribute: "LANGUAGE",
								operator: "==",
								value,
							})),
						},
					},
				},
			]);
		} finally {
			fetch.mockRestore();
		}
	});
	it("uses official SDK models and wire operators at every depth", () => {
		const leaf = {
			attribute: "HEIGHT",
			operator: "GREATER_THAN_OR_EQUAL",
			value: "1080",
		} as const;
		const input: StreamCondition = {
			type: "AND",
			conditions: [
				leaf,
				{
					type: "OR",
					conditions: [
						leaf,
						{ attribute: "WIDTH", operator: "NOT_EQUAL", value: "640" },
					],
				},
			],
		};
		const root = conditions(input);
		expect(root).toBeInstanceOf(AndConjunction);
		const children = (root as AndConjunction).conditions ?? [];
		expect(children[0]).toBeInstanceOf(Condition);
		expect(children[1]).toBeInstanceOf(OrConjunction);
		const comparison = {
			type: "CONDITION",
			attribute: "HEIGHT",
			operator: ">=",
			value: "1080",
		};
		expect(JSON.parse(JSON.stringify(root))).toEqual({
			type: "AND",
			conditions: [
				comparison,
				{
					type: "OR",
					conditions: [
						comparison,
						{
							type: "CONDITION",
							attribute: "WIDTH",
							operator: "!=",
							value: "640",
						},
					],
				},
			],
		});
		expect(conditions(undefined)).toBeUndefined();
	});
});
