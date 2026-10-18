import { NextResponse } from "next/server";
import { afterEach, expect, it, vi } from "vitest";
import { cloudProfile } from "@/test/vmaf-cloud-profile";

const rows = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: { vmafExecutionProfile: { findMany: rows } },
	}),
}));

const gate = vi.hoisted(() =>
	vi.fn(async (): Promise<Response | null> => null),
);
vi.mock("@/lib/server/feature-flags", () => ({ requireQcVmafEnabled: gate }));

import { GET } from "./route";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
	rows.mockResolvedValue([]);
});
it("only returns safe explicit profile summary fields", async () => {
	vi.stubEnv("VMAF_COMPUTE_PROFILES", JSON.stringify([cloudProfile]));
	const response = await GET();
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(await response.json()).toEqual({
		items: [
			{
				id: "aws-test",
				label: "AWS test",
				provider: "AWS_BATCH",
				region: "us-east-1",
				timeoutSeconds: 3600,
				queueTimeoutSeconds: 600,
				maxCostUsdPerHour: 2,
				transferUsdPerGiB: 0.1,
				overheadUsd: 0.2,
			},
		],
	});
});
it("supports an unconfigured local-only deployment", async () => {
	vi.stubEnv("VMAF_COMPUTE_PROFILES", "");
	expect(await (await GET()).json()).toEqual({ items: [] });
});
it("fails closed without reflecting invalid private configuration", async () => {
	vi.stubEnv("VMAF_COMPUTE_PROFILES", "private-secret-invalid");
	const response = await GET();
	expect(response.status).toBe(503);
	expect(await response.text()).not.toContain("private-secret");
});
it("honors the QC feature gate", async () => {
	gate.mockResolvedValueOnce(
		NextResponse.json({ error: "Not found" }, { status: 404 }),
	);
	expect((await GET()).status).toBe(404);
});

it("loads enabled DB profiles without exposing saved credential references", async () => {
	vi.stubEnv("VMAF_COMPUTE_PROFILES", "");
	rows.mockResolvedValue([
		{
			id: cloudProfile.id,
			label: "Saved AWS",
			config: cloudProfile,
			version: 4,
			enabled: true,
		},
	]);
	const response = await GET();
	expect(response.status).toBe(200);
	const body = await response.json();
	expect(body.items[0].label).toBe("Saved AWS");
	expect(body.items[0]).not.toHaveProperty("profileVersion");
	expect(body.items[0]).not.toHaveProperty("jobQueue");
});
