import { describe, expect, it, vi } from "vitest";
import {
	CreateRequestUniqueConflictError,
	createRequestIdentity,
	InvalidCreateRequestError,
	isCreateRequestUniqueConflict,
	recordCreateRequest,
} from "./create-request";

const request = (key?: string) =>
	new Request("http://test/api/encoding-jobs", {
		headers: key === undefined ? {} : { "Idempotency-Key": key },
	});

describe("ordinary create request identity", () => {
	it("leaves legacy requests outside the retry contract", () => {
		expect(createRequestIdentity(request(), { plan: {} })).toBeUndefined();
	});
	it("ignores object order, preserves array order and includes template and schedule identity", () => {
		const hash = (body: object) =>
			createRequestIdentity(request("gui:1"), body)?.requestSha256;
		const original = hash({
			plan: { name: "one", streams: ["a", "b"] },
			presetId: "id",
			presetRevision: 1,
			schedule: { at: "later" },
		});
		expect(original).toBe(
			hash({
				schedule: { at: "later" },
				presetRevision: 1,
				presetId: "id",
				plan: { streams: ["a", "b"], name: "one" },
			}),
		);
		expect(original).not.toBe(
			hash({
				plan: { name: "one", streams: ["b", "a"] },
				presetId: "id",
				presetRevision: 1,
				schedule: { at: "later" },
			}),
		);
		expect(original).not.toBe(
			hash({
				plan: { name: "one", streams: ["a", "b"] },
				presetId: "id",
				presetRevision: 2,
				schedule: { at: "later" },
			}),
		);
		expect(original).not.toBe(
			hash({
				plan: { name: "one", streams: ["a", "b"] },
				presetId: "id",
				presetRevision: 1,
				schedule: { at: "another time" },
			}),
		);
	});
	it("keeps JSON special property names distinct", () => {
		const identity = (body: object) =>
			createRequestIdentity(request("gui:1"), body)?.requestSha256;
		expect(
			identity(JSON.parse('{"plan":{"__proto__":"one","constructor":"two"}}')),
		).not.toBe(identity({ plan: { constructor: "two" } }));
	});
	it.each([
		"",
		"has spaces",
		"bad,key",
		"a".repeat(201),
	])("rejects an invalid header key: %s", (key) => {
		expect(() => createRequestIdentity(request(key), { plan: {} })).toThrow(
			InvalidCreateRequestError,
		);
	});
	it.each([
		"verificationKey",
		"requestSha256",
		"verificationDispatch",
	])("rejects mixing %s with ordinary retries", (field) => {
		expect(() =>
			createRequestIdentity(request("gui:1"), { plan: {}, [field]: null }),
		).toThrow(InvalidCreateRequestError);
	});
	it("recognizes only collisions tagged at the exact receipt insert", async () => {
		const identity = { requestKey: "gui:1", requestSha256: "a".repeat(64) };
		const insert = vi.fn().mockRejectedValue({
			code: "P2002",
			meta: { modelName: "CreateRequest", target: null },
		});
		const tx = { createRequest: { create: insert } } as unknown as Parameters<
			typeof recordCreateRequest
		>[0];
		const collision = await recordCreateRequest(
			tx,
			"VOD_JOB",
			identity,
			"00000000-0000-4000-8000-000000000001",
		).catch((error: unknown) => error);
		expect(collision).toBeInstanceOf(CreateRequestUniqueConflictError);
		expect(isCreateRequestUniqueConflict(collision)).toBe(true);
		expect(
			isCreateRequestUniqueConflict({
				code: "P2002",
				meta: { modelName: "EncodingJob", target: null },
			}),
		).toBe(false);
		expect(
			isCreateRequestUniqueConflict({
				code: "P2002",
				meta: { target: ["organizationId", "kind", "requestKey"] },
			}),
		).toBe(false);
		const outage = new Error("database unavailable");
		insert.mockRejectedValue(outage);
		await expect(
			recordCreateRequest(
				tx,
				"LIVE_CHANNEL",
				identity,
				"00000000-0000-4000-8000-000000000001",
			),
		).rejects.toBe(outage);
	});
});
