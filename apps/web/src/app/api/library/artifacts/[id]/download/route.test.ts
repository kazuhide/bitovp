import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
	findArtifact: vi.fn(),
	getObject: vi.fn(),
	browser: vi.fn(),
}));
const org = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000002";
const other = "00000000-0000-4000-8000-000000000003";
const size = 6 * 1024 * 1024;
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		tenant: { organizationId: org },
		prisma: { renderArtifact: { findUnique: holder.findArtifact } },
	}),
}));
vi.mock("@/lib/server/storage", () => ({
	browserForCredentialId: (...args: unknown[]) => holder.browser(...args),
}));

import { GET } from "./route";

function artifact() {
	return {
		id,
		organizationId: org,
		size: BigInt(size),
		run: { state: "SUCCEEDED" },
		storage: {
			credentialId: org,
			bucket: "private",
			key: "export.mp4",
			size,
			expect: { etag: '"fixed"', versionId: "export-v1" },
		},
	};
}
const call = (
	query = `expectedOrganizationId=${org}`,
	artifactId = id,
	method = "GET",
) =>
	GET(
		new Request(
			`http://localhost/api/library/artifacts/${artifactId}/download?${query}`,
			{ method },
		),
		{ params: Promise.resolve({ id: artifactId }) },
	);
beforeEach(() => {
	holder.findArtifact.mockReset().mockResolvedValue(artifact());
	holder.getObject
		.mockReset()
		.mockImplementation(async ({ range }) =>
			Readable.from([Buffer.alloc(range.end - range.start + 1, 7)]),
		);
	holder.browser.mockReset().mockImplementation(async () => ({
		getObject: holder.getObject,
		dispose: vi.fn(),
	}));
});
describe("GET artifact download", () => {
	it("downloads a >4MiB artifact as a full 200 attachment through its tenant and fixed version", async () => {
		const response = await call();
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Disposition")).toBe(
			`attachment; filename="${id}.mp4"`,
		);
		expect(response.headers.get("Content-Length")).toBe(String(size));
		expect((await response.arrayBuffer()).byteLength).toBe(size);
		expect(holder.findArtifact).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id, organizationId: org } }),
		);
		expect(holder.getObject).toHaveBeenCalledTimes(2);
		for (const [input] of holder.getObject.mock.calls)
			expect(input.expect).toEqual({
				size,
				etag: '"fixed"',
				versionId: "export-v1",
			});
	});
	it("allows native HEAD without constructing a streaming body", async () => {
		const response = await call(undefined, id, "HEAD");
		expect(response.status).toBe(200);
		expect(response.body).toBeNull();
		expect(response.headers.get("Content-Length")).toBe(String(size));
		expect(holder.getObject).toHaveBeenCalledTimes(1);
	});
	it.each([
		["", 409],
		[`expectedOrganizationId=${other}`, 409],
		[`expectedOrganizationId=${org}&expectedOrganizationId=${org}`, 400],
		[`expectedOrganizationId=${org}&key=other`, 400],
	] as const)("requires one matching organization marker before DB/storage reads: %s", async (query, status) => {
		expect((await call(query)).status).toBe(status);
		expect(holder.findArtifact).not.toHaveBeenCalled();
		expect(holder.browser).not.toHaveBeenCalled();
	});
	it("rejects invalid artifact IDs before DB access", async () => {
		expect((await call(undefined, "invalid")).status).toBe(400);
		expect(holder.findArtifact).not.toHaveBeenCalled();
	});
	it.each([
		"missing",
		"unfinished",
		"other-tenant",
	])("never opens storage for an unavailable %s artifact", async (change) => {
		const row = artifact();
		if (change === "unfinished") row.run.state = "RENDERING";
		if (change === "other-tenant") row.organizationId = other;
		holder.findArtifact.mockResolvedValue(change === "missing" ? null : row);
		expect((await call()).status).toBe(404);
		expect(holder.browser).not.toHaveBeenCalled();
	});
	it("does not read an artifact when stored size contradicts its immutable evidence", async () => {
		const row = artifact();
		row.storage.size = 17;
		holder.findArtifact.mockResolvedValue(row);
		expect((await call()).status).toBe(422);
		expect(holder.browser).not.toHaveBeenCalled();
	});
});
