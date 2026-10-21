import { describe, expect, it } from "vitest";
import { outputFileKeys } from "./output-files";
import type { PlanOutput } from "./schema";

const credential = "00000000-0000-4000-8000-000000000001";
const otherCredential = "00000000-0000-4000-8000-000000000002";

function overlaps(first: PlanOutput, second: PlanOutput) {
	const plan = { outputs: [first, second] };
	const file = { path: "live", filename: "main.m3u8" };
	const keys = outputFileKeys(plan, {
		destination: { outputKey: first.key, path: file.path },
		filename: file.filename,
	});
	return [
		...outputFileKeys(plan, {
			destination: { outputKey: second.key, path: file.path },
			filename: file.filename,
		}),
	].some((key) => keys.has(key));
}

describe("physical storage namespaces", () => {
	it("identifies an S3 bucket independently of the credential used to access it", () => {
		const first = {
			key: "first",
			kind: "S3" as const,
			credentialId: credential,
			bucket: "media",
			name: "First",
		};
		const second = {
			...first,
			key: "second",
			credentialId: otherCredential,
			name: "Second",
		};
		expect(overlaps(first, second)).toBe(true);
		expect(overlaps(first, { ...second, bucket: "other-media" })).toBe(false);
		expect(overlaps(first, { ...second, kind: "GENERIC_S3" })).toBe(false);
	});

	it("shares the GCS bucket namespace across its two authentication methods", () => {
		const first = {
			key: "first",
			kind: "GCS" as const,
			credentialId: credential,
			bucket: "media",
			name: "First",
		};
		const second = {
			...first,
			key: "second",
			kind: "GCS_SERVICE_ACCOUNT" as const,
			credentialId: otherCredential,
		};
		expect(overlaps(first, second)).toBe(true);
		expect(overlaps(first, { ...second, bucket: "other-media" })).toBe(false);
	});

	it("keeps account-scoped containers and compatible S3 hosts separate", () => {
		const azure = {
			key: "first",
			kind: "AZURE" as const,
			credentialId: credential,
			container: "media",
			name: "First",
		};
		expect(overlaps(azure, { ...azure, key: "alias" })).toBe(true);
		expect(
			overlaps(azure, {
				...azure,
				key: "other",
				credentialId: otherCredential,
			}),
		).toBe(false);
		const generic = {
			key: "first",
			kind: "GENERIC_S3" as const,
			credentialId: credential,
			bucket: "media",
			name: "First",
		};
		expect(overlaps(generic, { ...generic, key: "alias" })).toBe(true);
		expect(
			overlaps(generic, {
				...generic,
				key: "other",
				credentialId: otherCredential,
			}),
		).toBe(false);
	});
});
