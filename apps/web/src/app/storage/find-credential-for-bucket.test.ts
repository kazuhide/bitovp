import { describe, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch,
}));

import { ApiError } from "@/lib/api";
import {
	findCredentialForBucket,
	MAX_CANDIDATES,
} from "./find-credential-for-bucket";

/**
 * "Then which of my credentials DOES open this bucket?" .
 *
 * The owner reported three times that they still could not browse the Akamai
 * bucket. The app was correct each time — an access key scoped to particular
 * buckets, an account-level `ListBuckets`, so every credential shows all three
 * buckets and opens exactly one. Explaining the refusal did not make it
 * browsable; answering the question does.
 */
const CREDS = [
	{ id: "out", label: "verify-akamai-output" },
	{ id: "in", label: "verify-akamai-input" },
	{ id: "aws", label: "verify-aws" },
];

function denied(): ApiError {
	return new ApiError(
		502,
		"Storage request failed: AccessDenied (upstream 403)",
		{
			code: "AccessDenied",
			status: 403,
		},
	);
}

/** `readable` maps credentialId → the bucket it can open. */
function stub(readable: Record<string, string>): void {
	apiFetch.mockReset();
	apiFetch.mockImplementation(async (url: string) => {
		const id = /credentials\/([^/]+)\//.exec(url)?.[1] ?? "";
		const bucket = new URL(url, "http://x").searchParams.get("bucket") ?? "";
		if (readable[id] !== bucket) throw denied();
		return { objects: [], prefixes: [], nextCursor: undefined };
	});
}

describe("finding a credential that can open a bucket", () => {
	it("names the one that works", async () => {
		stub({ out: "b-out", in: "b-in", aws: "b-aws" });
		expect(await findCredentialForBucket(CREDS, "b-in", "out")).toEqual({
			kind: "found",
			credentialId: "in",
			label: "verify-akamai-input",
		});
	});

	it("never re-tries the credential that just failed", async () => {
		// It is the one credential we already know cannot open it, and offering
		// it back would read as the app not having understood the problem.
		stub({ out: "b-out", in: "b-in", aws: "b-aws" });
		await findCredentialForBucket(CREDS, "b-in", "out");
		const tried = apiFetch.mock.calls.map(
			(call: unknown[]) => /credentials\/([^/]+)\//.exec(String(call[0]))?.[1],
		);
		expect(tried).not.toContain("out");
	});

	it("says none rather than guessing when nothing opens it", async () => {
		// `bitmovin-demo-jp-osa-1` is real and neither key opens it. Offering a
		// credential that does not work would be worse than the plain refusal.
		stub({ out: "b-out", in: "b-in", aws: "b-aws" });
		expect(await findCredentialForBucket(CREDS, "b-demo", "out")).toEqual({
			kind: "none",
			checked: 2,
			truncated: false,
		});
	});

	it("stops at the cap and SAYS the search was truncated", async () => {
		// "None found" after a truncated search must not read as "none exists"
		// — the same account lists 69 buckets through another provider, so a
		// long credential list is realistic.
		const many = Array.from({ length: MAX_CANDIDATES + 3 }, (_, i) => ({
			id: `c${i}`,
			label: `cred ${i}`,
		}));
		stub({});
		const result = await findCredentialForBucket(many, "b-x", "none-of-them");
		expect(result).toEqual({
			kind: "none",
			checked: MAX_CANDIDATES,
			truncated: true,
		});
		expect(apiFetch).toHaveBeenCalledTimes(MAX_CANDIDATES);
	});

	it("asks only whether it MAY read, not for a page of contents", async () => {
		// One request per candidate is the cost of this feature; fetching a full
		// page on each would multiply it for an answer that is just the status.
		stub({ in: "b-in" });
		await findCredentialForBucket(CREDS, "b-in", "out");
		for (const [url] of apiFetch.mock.calls as [string][]) {
			expect(url).toContain("limit=1");
		}
	});

	it("stops as soon as one works — no needless probing", async () => {
		stub({ out: "b", in: "b", aws: "b" });
		await findCredentialForBucket(CREDS, "b", "out");
		expect(apiFetch).toHaveBeenCalledTimes(1);
	});
});
