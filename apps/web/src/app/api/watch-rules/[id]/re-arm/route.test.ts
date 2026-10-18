import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 *  (review-87b I-5): the route that SPENDS MONEY had zero tests
 * while carrying two Critical holes. These pin the refusal ladder in
 * order — disabled rule (N-7), allowlist (C-2), pending dedup (C-1), the
 * same-millisecond P2002 collision (N-10) — and the 201 body (N-11).
 */

const ruleFindUnique = vi.fn();
const objectFindFirst = vi.fn();
const objectCreate = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			watchRule: { findUnique: ruleFindUnique },
			watchedObject: { findFirst: objectFindFirst, create: objectCreate },
		},
	}),
}));

import { POST } from "./route";

const RULE_ID = "00000000-0000-4000-8000-0000000000d1";
const OBJECT_ID = "00000000-0000-4000-8000-0000000000d2";

const SOURCE = {
	id: OBJECT_ID,
	watchRuleId: RULE_ID,
	objectKey: "in/show.mp4",
	contentId: "1000:1723600000000",
	state: "SUBMITTED",
	size: 1000n,
	mtimeMs: 1_723_600_000_000,
	stableCount: 2,
};

const post = (objectId: string = OBJECT_ID) =>
	POST(
		new Request(`http://test/api/watch-rules/${RULE_ID}/re-arm`, {
			method: "POST",
			body: JSON.stringify({ objectId }),
		}),
		{ params: Promise.resolve({ id: RULE_ID }) },
	);

beforeEach(() => {
	vi.clearAllMocks();
	ruleFindUnique.mockResolvedValue({ enabled: true, extensions: ["mp4"] });
	// First findFirst call resolves the source row; the second is the
	// pending-dedup probe. mockResolvedValueOnce chains model that order.
	objectFindFirst.mockResolvedValueOnce({ ...SOURCE }).mockResolvedValue(null);
	objectCreate.mockImplementation(async (args: { data: object }) => ({
		id: "00000000-0000-4000-8000-0000000000d9",
		...(args.data as Record<string, unknown>),
	}));
});

describe("POST /api/watch-rules/[id]/re-arm", () => {
	it("201: creates a STABLE bump row and returns ITS identity", async () => {
		const res = await post();
		expect(res.status).toBe(201);
		const body = await res.json();
		// N-11: the body is asserted AGAINST THE CREATE, not a hardcoded
		// lookalike — the response projection is what the UI keys off.
		expect(objectCreate).toHaveBeenCalledTimes(1);
		const data = objectCreate.mock.calls[0]?.[0]?.data as Record<
			string,
			unknown
		>;
		expect(data.state).toBe("STABLE");
		expect(data.objectKey).toBe("in/show.mp4");
		expect(String(data.contentId)).toMatch(/^1000:1723600000000#rearm-\d+$/);
		expect(body).toEqual({
			id: "00000000-0000-4000-8000-0000000000d9",
			objectKey: "in/show.mp4",
			state: "STABLE",
		});
	});

	it("409 when the rule is DISABLED — the sweep would never pick the row up (N-7)", async () => {
		ruleFindUnique.mockResolvedValue({ enabled: false, extensions: [] });
		const res = await post();
		expect(res.status).toBe(409);
		expect(objectCreate).not.toHaveBeenCalled();
	});

	it("422 when the object's extension is outside the allowlist — no laundering SKIPPED files into paid encodings (C-2)", async () => {
		objectFindFirst.mockReset();
		objectFindFirst.mockResolvedValueOnce({
			...SOURCE,
			objectKey: "in/notes.txt",
			state: "SKIPPED",
		});
		const res = await post();
		expect(res.status).toBe(422);
		expect((await res.json()).error).toContain("allowlist");
		expect(objectCreate).not.toHaveBeenCalled();
	});

	it("an EMPTY allowlist admits every extension — parity with the sweep", async () => {
		ruleFindUnique.mockResolvedValue({ enabled: true, extensions: [] });
		objectFindFirst.mockReset();
		objectFindFirst
			.mockResolvedValueOnce({ ...SOURCE, objectKey: "in/any.bin" })
			.mockResolvedValue(null);
		const res = await post();
		expect(res.status).toBe(201);
	});

	it("409 when the key already has a pending or in-flight row — the double-click bills ONCE (C-1)", async () => {
		objectFindFirst.mockReset();
		objectFindFirst
			.mockResolvedValueOnce({ ...SOURCE })
			.mockResolvedValueOnce({ id: "other", state: "STABLE" });
		const res = await post();
		expect(res.status).toBe(409);
		expect((await res.json()).error).toContain("bill twice");
		expect(objectCreate).not.toHaveBeenCalled();
		// And the dedup probe carried the money-relevant predicate: pending
		// states OR an unlinked/active SUBMITTED row.
		const where = objectFindFirst.mock.calls[1]?.[0]?.where as {
			objectKey: string;
			OR: unknown[];
		};
		expect(where.objectKey).toBe("in/show.mp4");
		expect(where.OR).toHaveLength(3);
	});

	it("409 (not 500) when two re-arms land in the same millisecond (N-10)", async () => {
		const err = new Error("unique") as Error & { code: string };
		err.code = "P2002";
		objectCreate.mockRejectedValue(err);
		const res = await post();
		expect(res.status).toBe(409);
	});

	it("404 when the rule does not exist", async () => {
		ruleFindUnique.mockResolvedValue(null);
		expect((await post()).status).toBe(404);
	});

	it("404 when the object is not IN the rule", async () => {
		objectFindFirst.mockReset();
		objectFindFirst.mockResolvedValue(null);
		expect((await post()).status).toBe(404);
	});
});
