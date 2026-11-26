import type { AppTransactionClient } from "@bitovp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	cleanupDeletedMoqArchives,
	snapshotMoqArchiveCleanup,
} from "./moq-archive-cleanup";

const remove = vi.hoisted(() => vi.fn());
vi.mock("./moq-archive", () => ({ removeMoqArchiveFile: remove }));
const ORG = "00000000-0000-4000-8000-000000000001",
	CHANNEL = "00000000-0000-4000-8000-000000000002",
	RUN = "00000000-0000-4000-8000-000000000003",
	SESSION = "00000000-0000-4000-8000-000000000004",
	ENCODING = "00000000-0000-4000-8000-000000000005";
const archive = {
	contentType: "video/webm",
	bytes: 123,
	sha256: "a".repeat(64),
	durationMs: 1_000,
	recordedAt: new Date().toISOString(),
};
const row = () => ({
	id: RUN,
	organizationId: ORG,
	liveChannelId: CHANNEL,
	status: "STOPPED",
	bitmovinEncodingId: ENCODING,
	encoderStoppedConfirmedFor: ENCODING,
	providerStatus: "FINISHED",
	providerTerminalAt: new Date(),
	moqObservations: {
		version: 1,
		sessions: [
			{
				id: SESSION,
				actor: "session",
				startedAt: new Date().toISOString(),
				endedAt: null,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				samples: [],
				events: [],
				archive,
			},
		],
	},
});
function tx(value = row()) {
	return {
		$queryRaw: vi.fn(),
		liveChannelRun: { findMany: vi.fn().mockResolvedValue([value]) },
	} as unknown as AppTransactionClient;
}
beforeEach(() => {
	vi.resetAllMocks();
	remove.mockResolvedValue(true);
});
describe("scoped postcommit MoQ archive cleanup", () => {
	it("snapshots only persisted UUID identities and metadata before deletion, then removes only that set", async () => {
		const snapshot = await snapshotMoqArchiveCleanup(tx(), CHANNEL);
		expect(remove).not.toHaveBeenCalled();
		expect(snapshot).toEqual([
			{
				organizationId: ORG,
				id: CHANNEL,
				runId: RUN,
				sessionId: SESSION,
				archive,
			},
		]);
		expect(await cleanupDeletedMoqArchives(snapshot)).toEqual({
			removed: 1,
			failed: 0,
		});
		expect(remove).toHaveBeenCalledWith(
			ORG,
			{ id: CHANNEL, runId: RUN, sessionId: SESSION },
			archive,
		);
	});
	it("keeps files when provider termination remains uncertain", async () => {
		const value = row();
		value.encoderStoppedConfirmedFor = "";
		value.providerStatus = "UNKNOWN";
		value.providerTerminalAt = null as never;
		await expect(
			snapshotMoqArchiveCleanup(tx(value), CHANNEL),
		).rejects.toMatchObject({
			status: 409,
			code: "MOQ_ARCHIVE_PROVIDER_UNCONFIRMED",
		});
		expect(remove).not.toHaveBeenCalled();
	});
	it("refuses malformed ownership rather than deriving a path", async () => {
		const value = row();
		value.organizationId = "../outside";
		await expect(
			snapshotMoqArchiveCleanup(tx(value), CHANNEL),
		).rejects.toThrow();
		expect(remove).not.toHaveBeenCalled();
	});
	it("retains registered session identities even when a failed upload never committed archive metadata", async () => {
		const value = row();
		value.moqObservations.sessions = value.moqObservations.sessions.map(
			(session) => ({ ...session, archive: null as never }),
		);
		expect(await snapshotMoqArchiveCleanup(tx(value), CHANNEL)).toEqual([
			{
				organizationId: ORG,
				id: CHANNEL,
				runId: RUN,
				sessionId: SESSION,
				archive: null,
			},
		]);
	});
});
