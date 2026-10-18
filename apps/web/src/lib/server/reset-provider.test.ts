import { describe, expect, it, vi } from "vitest";
import { readResetEncoding } from "./reset-provider";

const snapshot = {
	id: "account-a",
	updatedAt: new Date("2026-08-01T00:00:00Z"),
	tenantOrgId: null,
	encryptedApiKey: "opaque-ciphertext",
};
const absent = { httpStatusCode: 404, errorCode: 1001 };
const client = () => ({
	encoding: {
		encodings: {
			status: vi.fn().mockRejectedValue(absent),
			get: vi.fn().mockRejectedValue(absent),
			list: vi.fn().mockResolvedValue({ items: [{ id: "visible-other" }] }),
		},
	},
});

describe("reset-only missing encoding evidence", () => {
	it("requires exact entity absence plus a successful account-scoped list", async () => {
		const api = client();
		expect(await readResetEncoding(api, "missing-encoding", snapshot)).toEqual({
			kind: "missing",
			account: snapshot,
		});
		expect(api.encoding.encodings.get).toHaveBeenCalledWith("missing-encoding");
		expect(api.encoding.encodings.list).toHaveBeenCalledWith({ limit: 1 });
	});
	it.each([
		{},
		{ httpStatusCode: 404 },
		{ httpStatusCode: 404, errorCode: 1002 },
		{ httpStatusCode: 401, errorCode: 1001 },
		{ httpStatusCode: 503, errorCode: 1001 },
	])("keeps ambiguous status failures closed: %j", async (err) => {
		const api = client();
		api.encoding.encodings.status.mockRejectedValue(err);
		expect(await readResetEncoding(api, "id", snapshot)).toMatchObject({
			kind: "unverified",
		});
		expect(api.encoding.encodings.get).not.toHaveBeenCalled();
	});
	it.each([
		"exists",
		"generic404",
		"auth",
		"network",
		"malformed-list",
		"contradictory-list",
	])("keeps %s follow-up evidence closed", async (failure) => {
		const api = client();
		if (failure === "exists")
			api.encoding.encodings.get.mockResolvedValue({ id: "id" });
		if (failure === "generic404")
			api.encoding.encodings.get.mockRejectedValue({ httpStatusCode: 404 });
		if (failure === "auth")
			api.encoding.encodings.list.mockRejectedValue({ httpStatusCode: 403 });
		if (failure === "network")
			api.encoding.encodings.list.mockRejectedValue(
				new Error("secret-request"),
			);
		if (failure === "malformed-list")
			api.encoding.encodings.list.mockResolvedValue({});
		if (failure === "contradictory-list")
			api.encoding.encodings.list.mockResolvedValue({ items: [{ id: "id" }] });
		const state = await readResetEncoding(api, "id", snapshot);
		expect(state).toMatchObject({ kind: "unverified" });
		expect(JSON.stringify(state)).not.toContain("secret-request");
	});
});
