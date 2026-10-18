import { afterEach, expect, it, vi } from "vitest";

const list = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({ bitmovinAccounts: { list } }),
}));

import { GET } from "./route";

const ACCOUNT = "0f8edfe4-fc30-4a9a-89e3-a3e89d5245df";
const OTHER = "2f8edfe4-fc30-4a9a-89e3-a3e89d5245df";
afterEach(() => vi.unstubAllEnvs());
it.each([
	undefined,
	ACCOUNT,
	"main",
])("computes internal capability from exact configured identity (%s)", async (configured) => {
	vi.stubEnv("BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID", configured);
	list.mockResolvedValue([
		{ id: ACCOUNT, label: "renamed" },
		{ id: OTHER, label: "main" },
	]);
	expect(await (await GET()).json()).toEqual([
		{ id: ACCOUNT, label: "renamed", internalHevcV2: configured === ACCOUNT },
		{ id: OTHER, label: "main", internalHevcV2: false },
	]);
});
