import { credentialSummaryWireSchema } from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";

const create = vi.fn();
const list = vi.fn();
const listWithSecretPresence = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		credentials: { create, list, listWithSecretPresence },
	}),
}));

import { GET, POST } from "./route";

function jsonRequest(body: unknown): Request {
	return new Request("http://test/api/credentials", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("POST /api/credentials", () => {
	it("rejects invalid payloads with field details", async () => {
		const res = await POST(
			jsonRequest({ provider: "AWS_S3", label: "", config: {}, secret: {} }),
		);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe("Validation failed");
		expect(create).not.toHaveBeenCalled();
	});

	it("serializes the secret before handing it to the store", async () => {
		create.mockResolvedValueOnce({ id: "1" });
		const res = await POST(
			jsonRequest({
				provider: "AWS_S3",
				label: "prod",
				config: { region: "us-east-1" },
				secret: { accessKeyId: "a", secretAccessKey: "s" },
			}),
		);
		expect(res.status).toBe(201);
		expect(create).toHaveBeenCalledWith({
			label: "prod",
			provider: "AWS_S3",
			config: { region: "us-east-1" },
			secret: JSON.stringify({ accessKeyId: "a", secretAccessKey: "s" }),
		});
	});

	it("persists publicBaseUrls verbatim, and rejects an unusable base", async () => {
		// The map is the operator's declaration that a bucket is public; the
		// store writes `config` straight into the Json column, so this route is
		// the last place a malformed base can be stopped.
		create.mockResolvedValueOnce({ id: "1" });
		const ok = await POST(
			jsonRequest({
				provider: "AWS_S3",
				label: "prod",
				config: {
					region: "us-east-1",
					publicBaseUrls: { out: "https://cdn.example.com/vod" },
				},
				secret: { accessKeyId: "a", secretAccessKey: "s" },
			}),
		);
		expect(ok.status).toBe(201);
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				config: {
					region: "us-east-1",
					publicBaseUrls: { out: "https://cdn.example.com/vod" },
				},
			}),
		);

		create.mockClear();
		const bad = await POST(
			jsonRequest({
				provider: "AWS_S3",
				label: "prod",
				config: {
					region: "us-east-1",
					publicBaseUrls: { out: "cdn.example.com" },
				},
				secret: { accessKeyId: "a", secretAccessKey: "s" },
			}),
		);
		expect(bad.status).toBe(400);
		expect(create).not.toHaveBeenCalled();
	});

	it("persists an AKAMAI_MSL edge base URL as readable config, and refuses one a viewer could not use", async () => {
		// The same last-stop argument as publicBaseUrls: the store writes
		// `config` straight into the Json column, and every viewer's player
		// receives this value plus `/<manifestName>`.
		create.mockResolvedValueOnce({ id: "1" });
		const ok = await POST(
			jsonRequest({
				provider: "AKAMAI_MSL",
				label: "msl4-jp",
				config: {
					streamId: 2126636,
					eventName: "ev",
					edgeBaseUrl:
						"https://bitmovinmsl4hlsjp.akamaized.net/hls/live/2126636/ev",
				},
			}),
		);
		expect(ok.status).toBe(201);
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				config: {
					streamId: 2126636,
					eventName: "ev",
					edgeBaseUrl:
						"https://bitmovinmsl4hlsjp.akamaized.net/hls/live/2126636/ev",
				},
				secret: JSON.stringify({}),
			}),
		);

		create.mockClear();
		for (const edgeBaseUrl of [
			"http://bitmovinmsl4hlsjp.akamaized.net/hls/live/2126636/ev",
			"https://bitmovinmsl4hlsjp.akamaized.net/hls/live/2126636/ev/",
			"https://10.0.0.5/hls/live/2126636/ev",
		]) {
			const bad = await POST(
				jsonRequest({
					provider: "AKAMAI_MSL",
					label: "msl4-jp",
					config: { streamId: 2126636, eventName: "ev", edgeBaseUrl },
				}),
			);
			expect(bad.status, edgeBaseUrl).toBe(400);
			expect(create).not.toHaveBeenCalled();
		}
	});

	it("rejects non-JSON bodies", async () => {
		const res = await POST(
			new Request("http://test/api/credentials", {
				method: "POST",
				body: "not json",
			}),
		);
		expect(res.status).toBe(400);
	});
});

describe("GET /api/credentials", () => {
	it("returns the store list", async () => {
		listWithSecretPresence.mockResolvedValueOnce([{ id: "1", label: "x" }]);
		const res = await GET();
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([{ id: "1", label: "x" }]);
	});

	/**
	 * THE LINK THAT DID NOT EXIST — .
	 *
	 * `credentialSummaryWireSchema` describes this route's response and is
	 * consumed as a TYPE by ten client fetches. Nothing connected the two:
	 * `NextResponse.json` accepts anything, so the route could return a shape
	 * missing a required wire field and tsc would say nothing. That is how
	 * `hasSecret` would have been added to the contract and never produced.
	 *
	 * Parsing here is what makes the wire type a checked claim rather than a
	 * shared belief. It also pins the METHOD: `list` does not carry
	 * `hasSecret`, so a route that calls it fails this arm.
	 */
	it("returns a response that satisfies the WIRE CONTRACT", async () => {
		listWithSecretPresence.mockResolvedValueOnce([
			{
				id: "00000000-0000-4000-8000-000000000001",
				label: "prod bucket",
				provider: "AWS_S3",
				config: { region: "us-east-1" },
				createdAt: "2026-08-27T00:00:00.000Z",
				updatedAt: "2026-08-27T00:00:00.000Z",
				hasSecret: true,
			},
		]);
		const body: unknown = await (await GET()).json();
		const parsed = credentialSummaryWireSchema.array().safeParse(body);
		expect(
			parsed.error?.issues,
			"the route's response no longer satisfies the wire type its ten client fetches assume",
		).toBeUndefined();
		// And the ciphertext column never rides along, whatever the store returns.
		expect(JSON.stringify(body)).not.toContain("encryptedSecret");
	});

	it("uses the method that CARRIES secret presence, not the bare list", async () => {
		// The arm that catches the route being pointed back at `list`: that
		// method returns rows with no `hasSecret`, so the contract arm above
		// would fail — but only if the mock is not also stubbed. This asserts
		// the call directly, so a future refactor cannot satisfy the contract by
		// accident while dropping the decryption the badge depends on.
		listWithSecretPresence.mockResolvedValueOnce([]);
		await GET();
		expect(listWithSecretPresence).toHaveBeenCalled();
		expect(list).not.toHaveBeenCalled();
	});
});
