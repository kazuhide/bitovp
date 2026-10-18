import { describe, expect, it } from "vitest";
import { contentRegisterSchema, contentUpdateSchema } from "./contracts";

describe("content write contracts", () => {
	it("PATCH must not insert defaults into omitted metadata", () => {
		expect(
			contentUpdateSchema.parse({ expectedRevision: 1, archived: true }),
		).toEqual({ expectedRevision: 1, archived: true });
	});
	it("registration still defaults optional metadata", () => {
		expect(
			contentRegisterSchema.parse({
				sourceId: "11111111-1111-4111-8111-111111111111",
				title: "Movie",
				locale: "ja",
			}),
		).toMatchObject({ description: "", tags: [] });
	});
});
