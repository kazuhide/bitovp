import { beforeEach, describe, expect, it, vi } from "vitest";

const channelFindUnique = vi.fn();
const findMany = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			liveChannel: { findUnique: channelFindUnique },
			slateNormalization: { findMany },
		},
	}),
}));

import { ACTOR_HEADER } from "@/lib/auth/api-token-gate";
import { ROLE_HEADER } from "@/lib/auth/roles";
import { GET } from "./route";

const CHANNEL_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const params = { params: Promise.resolve({ id: CHANNEL_ID }) };

beforeEach(() => {
	vi.clearAllMocks();
	channelFindUnique.mockResolvedValue({ id: CHANNEL_ID });
});

describe("GET /api/live-channels/[id]/insertable-content/normalizations (row #330)", () => {
	it("lists the channel's rows in flight plus a day of outcomes, without the credential id", async () => {
		findMany.mockResolvedValueOnce([
			{
				id: "row-1",
				liveChannelId: CHANNEL_ID,
				bitmovinAccountId: "acct",
				credentialId: "cred-secret-ref",
				name: "brb",
				bucket: "in",
				sourceKey: "slates/brb.mp4",
				status: "NORMALIZING",
				target: { width: 1280 },
				note: "preparing the file",
				error: null,
				registeredKey: null,
				normalized: false,
				insertableContentId: null,
				createdAt: new Date("2026-09-13T12:00:00Z"),
				updatedAt: new Date("2026-09-13T12:00:01Z"),
			},
		]);
		const res = await GET(new Request("http://test/normalizations"), params);
		expect(res.status).toBe(200);
		const body = JSON.stringify(await res.json());
		expect(body).toContain("NORMALIZING");
		expect(body).toContain("slates/brb.mp4");
		expect(body).not.toContain("cred-secret-ref");
		expect(body).not.toContain("liveChannelId");
		const where = findMany.mock.calls[0]?.[0]?.where as {
			liveChannelId: string;
			OR: unknown[];
		};
		expect(where.liveChannelId).toBe(CHANNEL_ID);
		expect(where.OR).toHaveLength(2);
	});

	it("strips the technical text (error, note) unless the caller is the owner session or a resolved ADMIN", async () => {
		const rows = [
			{
				id: "row-e",
				liveChannelId: CHANNEL_ID,
				bitmovinAccountId: "acct",
				credentialId: "cred",
				name: null,
				bucket: "in",
				sourceKey: "slates/bad.mp4",
				status: "ERROR",
				target: null,
				note: "preparing the file",
				error: "ffmpeg could not convert the file (exit 1): bad data",
				registeredKey: null,
				normalized: false,
				insertableContentId: null,
				createdAt: new Date("2026-09-13T12:00:00Z"),
				updatedAt: new Date("2026-09-13T12:00:01Z"),
			},
		];
		findMany.mockResolvedValue(rows);
		const viewer = await GET(
			new Request("http://test/n", {
				headers: { [ACTOR_HEADER]: "token:abc", [ROLE_HEADER]: "VIEWER" },
			}),
			params,
		);
		const viewerBody = JSON.stringify(await viewer.json());
		expect(viewerBody).toContain("ERROR");
		expect(viewerBody).not.toContain("ffmpeg");
		expect(viewerBody).not.toContain("preparing the file");
		const admin = await GET(
			new Request("http://test/n", {
				headers: { [ACTOR_HEADER]: "user:kazu", [ROLE_HEADER]: "ADMIN" },
			}),
			params,
		);
		expect(JSON.stringify(await admin.json())).toContain("ffmpeg");
		const session = await GET(
			new Request("http://test/n", { headers: { [ACTOR_HEADER]: "session" } }),
			params,
		);
		expect(JSON.stringify(await session.json())).toContain(
			"preparing the file",
		);
		const unresolved = await GET(
			new Request("http://test/n", {
				headers: { [ACTOR_HEADER]: "token:unresolved", [ROLE_HEADER]: "ADMIN" },
			}),
			params,
		);
		expect(JSON.stringify(await unresolved.json())).not.toContain("ffmpeg");
	});

	it("404s a channel that does not exist and 400s a malformed id", async () => {
		channelFindUnique.mockResolvedValueOnce(null);
		expect((await GET(new Request("http://test/n"), params)).status).toBe(404);
		expect(
			(
				await GET(new Request("http://test/n"), {
					params: Promise.resolve({ id: "nope" }),
				})
			).status,
		).toBe(400);
		expect(findMany).toHaveBeenCalledTimes(0);
	});
});
