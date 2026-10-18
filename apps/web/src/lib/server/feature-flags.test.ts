import { describe, expect, it, vi } from "vitest";

/**
 *  / review-265 131-A3. The property under test is not "it reads
 * the row" — it is that NOTHING it touches can reject. The root layout awaits
 * this on every page render, including /login, which has to work before the
 * database (or even the environment) is usable.
 */
const throwingContext = vi.fn(() => {
	throw new Error("Invalid environment: DATABASE_URL missing");
});
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => throwingContext(),
}));

import { readFeatureFlags } from "./feature-flags";

describe("readFeatureFlags (ledger #131)", () => {
	it("degrades to defaults when the CONTEXT itself throws — /login must still render", async () => {
		// As a default parameter this threw outside the try and rejected.
		await expect(readFeatureFlags()).resolves.toEqual({ qcVmaf: false });
	});

	it("degrades to defaults when the QUERY throws", async () => {
		const prisma = {
			appSetting: {
				findUnique: async () => {
					throw new Error("db unreachable");
				},
			},
		} as never;
		await expect(readFeatureFlags(prisma)).resolves.toEqual({ qcVmaf: false });
	});

	it("reads an explicit flag through the client it was handed", async () => {
		const prisma = {
			appSetting: { findUnique: async () => ({ value: { qcVmaf: true } }) },
		} as never;
		await expect(readFeatureFlags(prisma)).resolves.toEqual({ qcVmaf: true });
	});
});
