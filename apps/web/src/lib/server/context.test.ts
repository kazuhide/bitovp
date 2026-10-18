import { describe, expect, it, vi } from "vitest";
import { createLazyCipher } from "./context";

vi.mock("@bitovp/db", () => ({
	createBitmovinAccountStore: vi.fn(),
	createCredentialStore: vi.fn(),
	getPrisma: vi.fn(),
}));

describe("createLazyCipher", () => {
	it("does not construct the real cipher until a secret is touched", async () => {
		const factory = vi.fn(() => ({
			encrypt: async () => "blob",
			decrypt: async () => "plain",
		}));
		const cipher = createLazyCipher(factory);
		expect(factory).not.toHaveBeenCalled();

		await expect(cipher.encrypt("x")).resolves.toBe("blob");
		await expect(cipher.decrypt("blob")).resolves.toBe("plain");
		expect(factory).toHaveBeenCalledTimes(1);
	});

	it("surfaces factory failures only at use time (read routes stay alive)", async () => {
		const cipher = createLazyCipher(() => {
			throw new Error("MASTER_KEY is not set");
		});
		// Construction itself must not throw — that is the regression that
		// turned empty settings lists into 503s.
		await expect(cipher.encrypt("x")).rejects.toThrow(/MASTER_KEY/);
	});
});
