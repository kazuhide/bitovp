import { describe, expect, it } from "vitest";
import {
	contentRegisterSchema,
	contentUpdateSchema,
	librarySourceSnapshotSchema,
} from "./contracts";

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

describe("derived library source snapshots", () => {
	const snapshot = {
		schemaVersion: 2,
		kind: "DERIVED_RENDER",
		name: "Portrait clip",
		planHash: "a".repeat(64),
		identity: "VERIFIED",
		inputs: [],
		playbackLinks: [],
		renderRunId: "11111111-1111-4111-8111-111111111111",
		renderArtifactId: "22222222-2222-4222-8222-222222222222",
		qcVerdict: "PASS",
	};
	it("retains render provenance without inventing provider jobs", () => {
		expect(librarySourceSnapshotSchema.parse(snapshot)).toEqual(snapshot);
	});
	it("rejects an unsupported snapshot kind", () => {
		expect(
			librarySourceSnapshotSchema.safeParse({ ...snapshot, kind: "EXTERNAL" })
				.success,
		).toBe(false);
	});
	it("requires render artifact provenance", () => {
		expect(
			librarySourceSnapshotSchema.safeParse({
				...snapshot,
				renderArtifactId: undefined,
			}).success,
		).toBe(false);
	});
	it("does not accept provider-only fields on derived sources", () => {
		expect(
			librarySourceSnapshotSchema.safeParse({
				...snapshot,
				analysisOutput: { path: "wrong" },
			}).success,
		).toBe(false);
	});
});
