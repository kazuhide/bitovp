import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 *  (review-87b I-5): the [id] routes had zero tests. GET's
 * BigInt serialization, PATCH's reversible-knobs contract (including the
 * I-3 template refine — an update must not bypass the create door), and
 * DELETE's count-gated 404.
 */

const ruleFindUnique = vi.fn();
const ruleUpdateMany = vi.fn();
const ruleDeleteMany = vi.fn();
const objectFindMany = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			watchRule: {
				findUnique: ruleFindUnique,
				updateMany: ruleUpdateMany,
				deleteMany: ruleDeleteMany,
			},
			watchedObject: { findMany: objectFindMany },
		},
	}),
}));

import { DELETE, GET, PATCH } from "./route";

const RULE_ID = "00000000-0000-4000-8000-0000000000c1";
const params = { params: Promise.resolve({ id: RULE_ID }) };

const RULE = {
	id: RULE_ID,
	name: "drop",
	enabled: true,
	credential: { label: "prod-s3" },
	preset: { name: "mezz-1080p" },
};

beforeEach(() => {
	vi.clearAllMocks();
	ruleFindUnique.mockResolvedValue({ ...RULE });
	objectFindMany.mockResolvedValue([
		{
			id: "obj-1",
			objectKey: "in/a.mp4",
			state: "SUBMITTED",
			size: 123n,
			encodingJob: { id: "job-1", status: "RUNNING", name: "a" },
		},
	]);
	ruleUpdateMany.mockResolvedValue({ count: 1 });
	ruleDeleteMany.mockResolvedValue({ count: 1 });
});

describe("GET /api/watch-rules/[id]", () => {
	it("flattens credential/preset labels and serializes BigInt sizes", async () => {
		const res = await GET(new Request("http://test"), params);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.credentialLabel).toBe("prod-s3");
		expect(body.presetName).toBe("mezz-1080p");
		expect(body.objects[0].size).toBe(123);
	});

	it("404 on unknown rule", async () => {
		ruleFindUnique.mockResolvedValue(null);
		expect((await GET(new Request("http://test"), params)).status).toBe(404);
	});
});

describe("PATCH /api/watch-rules/[id]", () => {
	const patch = (body: unknown) =>
		PATCH(
			new Request("http://test", {
				method: "PATCH",
				body: JSON.stringify(body),
			}),
			params,
		);

	it("updates the reversible knobs and echoes them", async () => {
		const res = await patch({ enabled: false, maxConcurrentJobs: 5 });
		expect(res.status).toBe(200);
		expect(ruleUpdateMany).toHaveBeenCalledWith({
			where: { id: RULE_ID },
			data: { enabled: false, maxConcurrentJobs: 5 },
		});
		expect(await res.json()).toEqual({
			id: RULE_ID,
			enabled: false,
			maxConcurrentJobs: 5,
		});
	});

	it("REFUSES a template without a uniquifying token — PATCH cannot bypass the create door (I-3)", async () => {
		const res = await patch({ outputPrefixTemplate: "watch/out" });
		expect(res.status).toBe(400);
		expect(ruleUpdateMany).not.toHaveBeenCalled();
	});

	it("accepts a template carrying {uuid}", async () => {
		const res = await patch({ outputPrefixTemplate: "watch/{uuid}" });
		expect(res.status).toBe(200);
	});

	it("enabling a reset-disarmed rule REFUSES without the acknowledgement (ledger #132)", async () => {
		ruleFindUnique.mockResolvedValue({
			...RULE,
			disarmedByResetAt: new Date("2026-08-21T00:00:00.000Z"),
		});
		const res = await patch({ enabled: true });
		expect(res.status).toBe(409);
		// The refusal must SAY it is about billing, and nothing may be written.
		expect(JSON.stringify(await res.json())).toMatch(/billable/);
		expect(ruleUpdateMany).not.toHaveBeenCalled();
	});

	it("the acknowledgement enables AND consumes the stamp (ledger #132)", async () => {
		ruleFindUnique.mockResolvedValue({
			...RULE,
			disarmedByResetAt: new Date("2026-08-21T00:00:00.000Z"),
		});
		const res = await patch({ enabled: true, acknowledgeRedetection: true });
		expect(res.status).toBe(200);
		expect(ruleUpdateMany).toHaveBeenCalledWith({
			where: { id: RULE_ID },
			// The stamp clears WITH the enable: the next reset stamps again,
			// and until then re-enabling needs no ceremony.
			data: { enabled: true, disarmedByResetAt: null },
		});
		// The ack is a request field, not a column — it must not be echoed.
		expect(await res.json()).toEqual({ id: RULE_ID, enabled: true });
	});

	it("an un-stamped rule enables without ceremony (ledger #132)", async () => {
		ruleFindUnique.mockResolvedValue({ ...RULE, disarmedByResetAt: null });
		const res = await patch({ enabled: true });
		expect(res.status).toBe(200);
		expect(ruleUpdateMany).toHaveBeenCalledWith({
			where: { id: RULE_ID },
			data: { enabled: true },
		});
	});

	it("DISABLING a stamped rule needs no acknowledgement (ledger #132)", async () => {
		ruleFindUnique.mockResolvedValue({
			...RULE,
			disarmedByResetAt: new Date("2026-08-21T00:00:00.000Z"),
		});
		const res = await patch({ enabled: false });
		expect(res.status).toBe(200);
		expect(ruleUpdateMany).toHaveBeenCalledWith({
			where: { id: RULE_ID },
			data: { enabled: false },
		});
	});

	it("rejects non-knob fields (strict)", async () => {
		const res = await patch({ bucket: "elsewhere" });
		expect(res.status).toBe(400);
	});

	it("404 when nothing matched", async () => {
		ruleUpdateMany.mockResolvedValue({ count: 0 });
		expect((await patch({ enabled: true })).status).toBe(404);
	});
});

describe("DELETE /api/watch-rules/[id]", () => {
	it("deletes and reports; 404 when already gone", async () => {
		const res = await DELETE(new Request("http://test"), params);
		expect(await res.json()).toEqual({ id: RULE_ID, deleted: true });
		ruleDeleteMany.mockResolvedValue({ count: 0 });
		expect((await DELETE(new Request("http://test"), params)).status).toBe(404);
	});
});
