import { UnsupportedBrowseError } from "@bitovp/storage";
import { describe, expect, it } from "vitest";
import { storageErrorResponse } from "@/lib/server/storage";

/**
 * The WIRE contract: a storage failure carries its classified `{code, status}`.
 *
 * review-282 mutation (e): deleting `details` from `storageErrorResponse` left
 * the whole suite green — 258 files, 2,707 tests — because every test of this
 * feature hand-builds `new ApiError(502, …, {code, status})` and so pins the
 * CONSUMER while nothing pinned the PRODUCER. One line could have silently
 * reverted the feature to raw English messages with the suite agreeing.
 *
 * Also the C20 boundary, asserted rather than assumed: `details` must carry the
 * classified pair and NOTHING else. The vendor's own `message` is what C20
 * forbids, and `code`/`status` were already inside the `error` string via
 * `storageErrorText`, so this response is a strict subset of what it already
 * said — but only as long as something checks.
 */
function s3Error(code: string, status: number): unknown {
	// The shape aws-sdk-v3 actually throws: `Code` plus `$metadata`.
	return Object.assign(new Error("vendor text that must never ship"), {
		name: code,
		Code: code,
		$metadata: { httpStatusCode: status },
	});
}

describe("storageErrorResponse's wire contract", () => {
	it("carries the classified code and status in details", async () => {
		const res = storageErrorResponse(s3Error("AccessDenied", 403));
		expect(res.status).toBe(502);
		const body = (await res.json()) as {
			error: string;
			details?: { code?: string; status?: number };
		};
		expect(body.details).toEqual({ code: "AccessDenied", status: 403 });
	});

	it("distinguishes the credential codes the UI branches on", async () => {
		// If these arrived without a code the UI would fall back to the bucket
		// sentence and tell someone with a mistyped secret to pick another
		// bucket — the exact defect review-282 found.
		for (const code of ["SignatureDoesNotMatch", "AuthenticationFailed"]) {
			const res = storageErrorResponse(s3Error(code, 403));
			const body = (await res.json()) as { details?: { code?: string } };
			expect(body.details?.code, code).toBe(code);
		}
	});

	it("codes unsupported browsing without exposing its provider prose", async () => {
		const res = storageErrorResponse(
			new UnsupportedBrowseError("provider-specific browse diagnostic"),
		);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.details).toEqual({ code: "STORAGE_BROWSE_UNSUPPORTED" });
		expect(JSON.stringify(body)).not.toContain("provider-specific");
	});

	it("never puts the vendor's message in the response", async () => {
		const res = storageErrorResponse(s3Error("AccessDenied", 403));
		const raw = JSON.stringify(await res.json());
		// C20: the SDK concatenates request bodies into `message`, so echoing it
		// is how a secret reaches a log or an API consumer.
		expect(raw).not.toContain("vendor text that must never ship");
		expect(raw).toBe(
			JSON.stringify({
				error: "Storage request failed: AccessDenied (upstream 403)",
				details: { code: "AccessDenied", status: 403 },
			}),
		);
	});
});
