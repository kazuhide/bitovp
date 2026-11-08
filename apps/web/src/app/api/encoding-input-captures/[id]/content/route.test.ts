import { Readable } from "node:stream";
import {
	createInputCaptureCredentials,
	hashEditingEvidence,
} from "@bitovp/core";
import { ObjectVersionMismatchError } from "@bitovp/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	context: vi.fn(),
	receipt: vi.fn(),
	job: vi.fn(),
	browser: vi.fn(),
	object: vi.fn(),
}));
vi.mock("@/lib/server/context", () => ({
	contextForOrganization: mocks.context,
}));
vi.mock("@/lib/server/storage", () => ({
	browserForCredentialId: mocks.browser,
}));

import { GET, HEAD } from "./route";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const instant = new Date("2026-11-02T00:00:00.000Z");
const secret = "test-capture-key-0123456789abcdef0123456789";
const size = 6 * 1024 * 1024 + 1;
const url = `https://capture.example.test/api/encoding-input-captures/${id(2)}/content`;
function proof() {
	return {
		schemaVersion: 1,
		profile: "PINNED_HTTP_INPUT_V1",
		organizationId: id(1),
		jobId: id(3),
		encodingId: id(4),
		expiresAt: instant.getTime() / 1000 + 86400,
		storage: {
			credentialId: id(5),
			bucket: "private",
			key: "source.mov",
			size,
			expect: { versionId: "fixed-version" },
		},
		sha256: "a".repeat(64),
		sourceFacts: {
			width: 320,
			height: 180,
			codec: "h264",
			fps: { num: 25, den: 1 },
			timeBase: { num: 1, den: 12800 },
			frameCount: 50,
			durationUs: 2_000_000,
			videoPtsHash: "b".repeat(64),
			colorProfile: "BT709_8BIT_LIMITED",
			audio: null,
		},
		ingestKey: "video",
		planHash: hashEditingEvidence({ name: "job" }),
	};
}
function receipt() {
	const value = proof();
	return {
		id: id(2),
		organizationId: id(1),
		sourceId: null,
		jobId: id(3),
		encodingId: id(4),
		kind: "INPUT_CAPTURE",
		proof: value,
		proofHash: hashEditingEvidence(value),
	};
}
function authorization(
	org = id(1),
	receiptId = id(2),
	expiry = proof().expiresAt,
) {
	const auth = createInputCaptureCredentials({
		secret,
		organizationId: org,
		receiptId,
		expiresAt: expiry,
		now: instant.getTime() / 1000,
	});
	return `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
}
const request = (method = "GET", headers: Record<string, string> = {}) =>
	new Request(url, {
		method,
		headers: {
			host: "capture.example.test",
			authorization: authorization(),
			...headers,
		},
	});
const call = (req = request(), receiptId = id(2)) =>
	GET(req, { params: Promise.resolve({ id: receiptId }) });
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(instant);
	vi.stubEnv("BITOVP_CAPTURE_INPUT_BASE_URL", "https://capture.example.test");
	vi.stubEnv("BITOVP_CAPTURE_INPUT_SECRET", secret);
	mocks.receipt.mockReset().mockResolvedValue(receipt());
	mocks.job.mockReset().mockResolvedValue({
		id: id(3),
		organizationId: id(1),
		bitmovinEncodingId: id(4),
		plan: { name: "job" },
		status: "RUNNING",
	});
	mocks.context.mockReset().mockReturnValue({
		prisma: {
			libraryEvidenceReceipt: { findUnique: mocks.receipt },
			encodingJob: { findUnique: mocks.job },
		},
	});
	mocks.object
		.mockReset()
		.mockImplementation(async ({ range }) =>
			Readable.from([Buffer.alloc(range.end - range.start + 1, 7)]),
		);
	mocks.browser.mockReset().mockImplementation(async () => ({
		getObject: mocks.object,
		dispose: vi.fn(),
	}));
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});
describe("signed provider input gateway", () => {
	it("streams the exact immutable input through a scoped read-only context", async () => {
		const response = await call();
		expect(response.status).toBe(200);
		expect((await response.arrayBuffer()).byteLength).toBe(size);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(mocks.context).toHaveBeenCalledExactlyOnceWith(id(1), true);
		for (const [arg] of mocks.object.mock.calls)
			expect(arg).toMatchObject({
				bucket: "private",
				key: "source.mov",
				expect: { versionId: "fixed-version", size },
			});
		expect(mocks.object).toHaveBeenCalledTimes(2);
	});
	it("supports bounded Range and HEAD without returning a body for HEAD", async () => {
		const range = await call(request("GET", { range: "bytes=1-3" }));
		expect(range.status).toBe(206);
		expect((await range.arrayBuffer()).byteLength).toBe(3);
		expect(range.headers.get("Content-Range")).toBe(`bytes 1-3/${size}`);
		const head = await HEAD(request("HEAD"), {
			params: Promise.resolve({ id: id(2) }),
		});
		expect(head.status).toBe(200);
		expect(head.body).toBeNull();
		expect(head.headers.get("Content-Length")).toBe(String(size));
	});
	it.each([
		"unsigned",
		"forged-org",
		"expired",
		"wrong-path-id",
		"POST",
		"wrong-host",
	])("rejects %s before a tenant context or storage read", async (change) => {
		let req = request();
		let receiptId = id(2);
		if (change === "unsigned") req = request("GET", { authorization: "" });
		if (change === "forged-org") {
			const token = authorization();
			const value = Buffer.from(token.slice(6), "base64")
				.toString()
				.replace(id(1), id(99));
			req = request("GET", {
				authorization: `Basic ${Buffer.from(value).toString("base64")}`,
			});
		}
		if (change === "expired") {
			const token = authorization();
			vi.setSystemTime(new Date(instant.getTime() + 86401_000));
			req = request("GET", { authorization: token });
		}
		if (change === "wrong-path-id") receiptId = id(99);
		if (change === "POST") req = request("POST");
		if (change === "wrong-host")
			req = request("GET", { host: "evil.example.test" });
		expect((await call(req, receiptId)).status).toBe(
			change === "POST" ? 405 : 401,
		);
		expect(mocks.context).not.toHaveBeenCalled();
		expect(mocks.object).not.toHaveBeenCalled();
	});
	it.each([
		"org",
		"id",
		"job",
		"encoding",
		"proof-hash",
		"expiry",
		"mutable",
		"oversize",
	])("rejects a mismatching stored %s receipt", async (change) => {
		const row = receipt();
		if (change === "org") row.organizationId = id(99);
		if (change === "id") row.id = id(99);
		if (change === "job") row.jobId = id(99);
		if (change === "encoding") row.encodingId = id(99);
		if (change === "proof-hash") row.proofHash = "f".repeat(64);
		if (change === "expiry") row.proof.expiresAt++;
		if (change === "mutable") row.proof.storage.expect.versionId = "null";
		if (change === "oversize") row.proof.storage.size = 4 * 1024 ** 3 + 1;
		if (change !== "proof-hash") row.proofHash = hashEditingEvidence(row.proof);
		mocks.receipt.mockResolvedValue(row);
		expect((await call()).status).toBe(404);
		expect(mocks.browser).not.toHaveBeenCalled();
	});
	it("does not follow a replacement object or disclose storage failures", async () => {
		mocks.object.mockRejectedValue(
			new ObjectVersionMismatchError("private", "path", { versionId: "fixed" }),
		);
		const response = await call();
		expect(response.status).toBe(409);
		expect(await response.text()).not.toContain("private/path");
	});
	it("keeps the route disabled when either gateway configuration value is absent", async () => {
		vi.stubEnv("BITOVP_CAPTURE_INPUT_SECRET", "");
		expect((await call()).status).toBe(401);
		expect(mocks.context).not.toHaveBeenCalled();
	});
});
