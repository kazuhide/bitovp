import { describe, expect, it, vi } from "vitest";
import {
	releaseTemporaryStreamKeys,
	type StreamKeyClient,
} from "./release-stream-keys";

/**
 *  — the reset's post-commit stream-key release.
 *
 * The stakes are asymmetric: over-deleting touches keys OTHER encodings (or
 * another install on the same account) still need, and under-deleting is just
 * the accumulation this exists to stop. So the tests lean on the negative
 * space — what must NOT be deleted, and what must NOT fail the report.
 */

function client(
	keys: { id: string; assignedEncodingId?: string }[],
	options?: { failDelete?: Set<string>; failList?: boolean },
): StreamKeyClient & { deleted: string[] } {
	const deleted: string[] = [];
	return {
		deleted,
		list: async ({ offset, limit }) => {
			if (options?.failList) throw new Error("listing down");
			return {
				items: keys.slice(offset, offset + limit),
				totalCount: keys.length,
			};
		},
		delete: async (id) => {
			if (options?.failDelete?.has(id)) throw new Error(`delete ${id} refused`);
			deleted.push(id);
			return {};
		},
	};
}

const pointer = (enc: string, account: string | null) => ({
	bitmovinEncodingId: enc,
	bitmovinAccountId: account,
});

describe("releaseTemporaryStreamKeys (ledger #152)", () => {
	it("deletes exactly the keys assigned to the wiped encodings", async () => {
		const c = client([
			{ id: "k1", assignedEncodingId: "enc-a" },
			// Another install's live run on the SAME account — must survive.
			{ id: "k2", assignedEncodingId: "enc-foreign" },
			// Unassigned temporary key — no encoding match, must survive.
			{ id: "k3" },
		]);
		const report = await releaseTemporaryStreamKeys(
			[pointer("enc-a", "acct-1")],
			async () => c,
		);
		expect(c.deleted).toEqual(["k1"]);
		expect(report).toEqual({
			released: 1,
			failed: 0,
			skippedNoAccount: 0,
			accountErrors: 0,
		});
	});

	it("pages through more than one page (C6)", async () => {
		const keys = Array.from({ length: 150 }, (_, i) => ({
			id: `k${i}`,
			assignedEncodingId: i === 149 ? "enc-a" : `other-${i}`,
		}));
		const c = client(keys);
		const report = await releaseTemporaryStreamKeys(
			[pointer("enc-a", "acct-1")],
			async () => c,
		);
		// The match sits on page TWO; a single-page implementation reports a
		// clean zero and the accumulation continues looking handled.
		expect(c.deleted).toEqual(["k149"]);
		expect(report.released).toBe(1);
	});

	it("one account's failure does not lose the other account's cleanup", async () => {
		const good = client([{ id: "kg", assignedEncodingId: "enc-b" }]);
		const report = await releaseTemporaryStreamKeys(
			[pointer("enc-a", "acct-down"), pointer("enc-b", "acct-up")],
			async (accountId) =>
				accountId === "acct-down" ? client([], { failList: true }) : good,
		);
		expect(good.deleted).toEqual(["kg"]);
		expect(report.released).toBe(1);
		expect(report.accountErrors).toBe(1);
	});

	it("a refused delete is counted, never thrown", async () => {
		const c = client(
			[
				{ id: "k1", assignedEncodingId: "enc-a" },
				{ id: "k2", assignedEncodingId: "enc-b" },
			],
			{ failDelete: new Set(["k1"]) },
		);
		const report = await releaseTemporaryStreamKeys(
			[pointer("enc-a", "acct-1"), pointer("enc-b", "acct-1")],
			async () => c,
		);
		expect(c.deleted).toEqual(["k2"]);
		expect(report.released).toBe(1);
		expect(report.failed).toBe(1);
	});

	it("pointers with no recorded account are counted, not guessed at", async () => {
		const clientFor = vi.fn(async () => client([]));
		const report = await releaseTemporaryStreamKeys(
			[pointer("enc-a", null)],
			clientFor,
		);
		// Guessing an account here would mean listing SOMEONE'S keys on the
		// strength of nothing — the refusal-path pointers deliberately carry
		// null and must never trigger remote calls.
		expect(clientFor).not.toHaveBeenCalled();
		expect(report.skippedNoAccount).toBe(1);
	});
});
