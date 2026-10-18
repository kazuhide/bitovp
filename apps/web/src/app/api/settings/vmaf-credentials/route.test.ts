import { randomBytes } from "node:crypto";
import { AesGcmCipher } from "@bitovp/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateRole } from "@/lib/auth/roles";

const cipher = new AesGcmCipher(randomBytes(32));
const rows = new Map<string, Record<string, unknown>>();
const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
	rows.set(data.id as string, data);
	const { encryptedSecret: _secret, ...summary } = data;
	return summary;
});
const audit = vi.fn(async () => ({}));
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		cipher,
		prisma: {
			vmafComputeCredential: {
				create,
				findMany: async () =>
					[...rows.values()].map(
						({ encryptedSecret: _secret, ...rest }) => rest,
					),
			},
			auditLog: { create: audit },
		},
	}),
}));

import { GET, POST } from "./route";

const body = {
	label: "Test",
	secret: {
		provider: "AWS",
		accessKeyId: "ACCESS",
		secretAccessKey: "SECRET-MATERIAL",
	},
};
const request = (payload: unknown) =>
	new Request("http://test/api/settings/vmaf-credentials", {
		method: "POST",
		body: JSON.stringify(payload),
		headers: { "content-type": "application/json" },
	});
beforeEach(() => {
	rows.clear();
	create.mockClear();
	audit.mockClear();
});
describe("cloud credential HTTP boundary", () => {
	it("allows only admins to inventory and mutate profiles and credentials", () => {
		for (const path of [
			"/api/settings/vmaf-profiles",
			"/api/settings/vmaf-credentials",
			"/api/settings/vmaf-credentials/id",
		])
			for (const method of ["GET", "POST", "DELETE"]) {
				expect(evaluateRole("OPERATOR", path, method).allowed).toBe(false);
				expect(evaluateRole("VIEWER", path, method).allowed).toBe(false);
				expect(evaluateRole("ADMIN", path, method).allowed).toBe(true);
			}
	});
	it("returns metadata and audits identifiers, never material or ciphertext", async () => {
		const response = await POST(request(body));
		expect(response.status).toBe(201);
		expect(await response.text()).not.toMatch(
			/SECRET-MATERIAL|encryptedSecret/,
		);
		expect(await (await GET()).text()).not.toMatch(
			/SECRET-MATERIAL|encryptedSecret/,
		);
		expect(JSON.stringify(audit.mock.calls)).not.toMatch(
			/SECRET-MATERIAL|encryptedSecret/,
		);
		expect([...rows.values()][0]?.encryptedSecret).toBeTypeOf("string");
	});
	it("does not echo unknown secret field names through validation", async () => {
		const response = await POST(
			request({
				...body,
				secret: { ...body.secret, "SECRET-MATERIAL": "bad" },
			}),
		);
		expect(response.status).toBe(400);
		expect(await response.text()).not.toContain("SECRET-MATERIAL");
		expect(create).not.toHaveBeenCalled();
	});
	it("does not log ORM failures that can include secret arguments", async () => {
		create.mockRejectedValueOnce(new Error("SECRET-MATERIAL"));
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const response = await POST(request(body));
			expect(response.status).toBe(500);
			expect(await response.text()).not.toContain("SECRET-MATERIAL");
			expect(log).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
		}
	});
});
