import { describe, expect, it } from "vitest";
import { createStoragePresetSchema, objectUri } from "./schemas";

describe("createStoragePresetSchema", () => {
	it("defaults prefix to empty and validates role", () => {
		const parsed = createStoragePresetSchema.parse({
			credentialId: "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11",
			label: "origin",
			bucket: "media",
			role: "OUTPUT",
		});
		expect(parsed.prefix).toBe("");
	});

	it("rejects unknown roles and bad ids", () => {
		expect(
			createStoragePresetSchema.safeParse({
				credentialId: "nope",
				label: "x",
				bucket: "b",
				role: "BOTH",
			}).success,
		).toBe(false);
	});
});

describe("objectUri", () => {
	it("uses the ecosystem scheme per provider", () => {
		expect(objectUri("AWS_S3", "b", "k.mp4")).toBe("s3://b/k.mp4");
		expect(objectUri("AKAMAI_OBJECT_STORAGE", "b", "k.mp4")).toBe(
			"s3://b/k.mp4",
		);
		expect(objectUri("GCS_SERVICE_ACCOUNT", "b", "k.mp4")).toBe("gs://b/k.mp4");
		expect(objectUri("AWS_S3", "b")).toBe("s3://b/");
	});
});
