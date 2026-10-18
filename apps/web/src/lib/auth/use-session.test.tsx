import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const querySpy = vi.hoisted(() => vi.fn());
const apiFetch = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
	useQuery: (...args: unknown[]) => querySpy(...args),
}));
vi.mock("@/lib/api", () => ({
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import {
	SESSION_QUERY_KEY,
	SESSION_REFRESH_INTERVAL_MS,
	useSession,
} from "./use-session";

beforeEach(() => {
	querySpy.mockReset();
	apiFetch.mockReset();
	apiFetch.mockResolvedValue({});
	querySpy.mockReturnValue({
		data: undefined,
		status: "pending",
		refetch: vi.fn(),
	});
});

describe("useSession refresh contract", () => {
	it("revalidates a persistent shell on focus and at least once every 60 seconds without consulting an HTTP cache", async () => {
		renderHook(() => useSession());
		const options = querySpy.mock.calls[0]?.[0] as
			| Record<string, unknown>
			| undefined;
		expect(options?.queryKey).toBe(SESSION_QUERY_KEY);
		expect(options?.refetchOnWindowFocus).toBe("always");
		expect(options?.refetchInterval).toBe(SESSION_REFRESH_INTERVAL_MS);
		expect(SESSION_REFRESH_INTERVAL_MS).toBeGreaterThan(0);
		expect(SESSION_REFRESH_INTERVAL_MS).toBeLessThanOrEqual(60_000);
		await (options?.queryFn as () => Promise<unknown>)();
		expect(apiFetch).toHaveBeenCalledWith("/api/auth/session", {
			cache: "no-store",
		});
	});
});
