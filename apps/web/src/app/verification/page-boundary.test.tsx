import { describe, expect, it, vi } from "vitest";

const { redirect } = vi.hoisted(() => ({
	redirect: vi.fn((href: string) => {
		throw new Error(`NEXT_REDIRECT:${href}`);
	}),
}));

vi.mock("next/navigation", () => ({ redirect }));

import VerificationRunPage from "./[id]/page";
import VerificationPage from "./page";

describe("verification pages — customer product boundary", () => {
	it("redirects the list away from the release harness evidence", () => {
		expect(() => VerificationPage()).toThrow("NEXT_REDIRECT:/");
		expect(redirect).toHaveBeenCalledWith("/");
	});

	it("redirects a run detail away from the release harness evidence", async () => {
		await expect(
			VerificationRunPage({ params: Promise.resolve({ id: "run-1" }) }),
		).rejects.toThrow("NEXT_REDIRECT:/");
		expect(redirect).toHaveBeenCalledWith("/");
	});
});
