import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteMany = vi.fn();
const findFirst = vi.fn();
const create = vi.fn();
const updateMany = vi.fn();
vi.mock("@bitovp/db", () => ({
	getIdentityPrisma: () => ({
		setupCode: { deleteMany, findFirst, create, updateMany },
	}),
}));

import {
	consumeSetupCode,
	ensureSetupCode,
	hashSetupCode,
	SETUP_CODE_TTL_MS,
} from "./setup-code";

/**
 *  §3c — the setup code's mechanics: hash-only storage, ≥128-bit
 * entropy rendered typably, mint-once (no reprint spam), expiry re-mint,
 * and the CAS burn (two holders of one leaked code cannot both pass).
 */

beforeEach(() => {
	deleteMany.mockReset().mockResolvedValue({ count: 0 });
	findFirst.mockReset();
	create.mockReset().mockImplementation(async ({ data }) => data);
	updateMany.mockReset();
});

describe("ensureSetupCode", () => {
	it("mints once: the plaintext returns for PRINTING, only the SHA-256 is stored", async () => {
		findFirst.mockResolvedValue(null);
		const { minted } = await ensureSetupCode(1_000_000);
		expect(minted).not.toBeNull();
		const stored = create.mock.calls[0]?.[0].data;
		expect(stored.codeHash).toBe(hashSetupCode(minted as string));
		expect(stored.codeHash).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(stored)).not.toContain(minted);
		expect(stored.expiresAt.getTime()).toBe(1_000_000 + SETUP_CODE_TTL_MS);
		// Typable shape: grouped base32-ish, no confusable 0/1/l/o digits.
		expect(minted).toMatch(/^[a-z2-9]{8}(-[a-z2-9]{8}){3}$/);
		expect(minted).not.toMatch(/[01lo]/);
	});

	it("a LIVE code is not re-minted — re-printing would multiply the secret in the log", async () => {
		findFirst.mockResolvedValue({ id: "live-1" });
		const { minted } = await ensureSetupCode(1_000_000);
		expect(minted).toBeNull();
		expect(create).not.toHaveBeenCalled();
	});

	it("expired unused rows are swept before the mint decision", async () => {
		findFirst.mockResolvedValue(null);
		await ensureSetupCode(2_000_000);
		expect(deleteMany.mock.calls[0]?.[0].where).toMatchObject({
			usedAt: null,
		});
	});
});

describe("consumeSetupCode (the CAS burn)", () => {
	it("burns exactly once: the usedAt:null CAS is the race decider", async () => {
		findFirst.mockResolvedValue({ id: "code-1" });
		updateMany.mockResolvedValue({ count: 1 });
		expect(await consumeSetupCode("abc-def")).toBe(true);
		expect(updateMany.mock.calls[0]?.[0].where).toMatchObject({
			id: "code-1",
			usedAt: null,
		});
	});

	it("the SECOND holder of a leaked code loses the CAS and is refused", async () => {
		findFirst.mockResolvedValue({ id: "code-1" });
		updateMany.mockResolvedValue({ count: 0 });
		expect(await consumeSetupCode("abc-def")).toBe(false);
	});

	it("wrong or expired codes never reach the burn", async () => {
		findFirst.mockResolvedValue(null);
		expect(await consumeSetupCode("wrong")).toBe(false);
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("verification is case- and hyphen-insensitive — the operator retypes from a log", async () => {
		expect(hashSetupCode("ABCD-efgh")).toBe(hashSetupCode("abcdefgh"));
	});
});
