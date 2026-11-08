import { randomBytes } from "node:crypto";
import { AesGcmCipher } from "@bitovp/core";
import type { AppTransactionClient } from "@bitovp/db";
import { describe, expect, it } from "vitest";
import { DIALOGUE_SOURCE_ID, dialogueSourceSnapshot } from "./dialogue-fixture";
import {
	DIALOGUE_ACCOUNT_ID,
	DIALOGUE_ENCODING_ID,
	DIALOGUE_JOB_ID,
	ensureDialoguePreviewSource,
} from "./dialogue-source";

type Row = Record<string, unknown>;
function fixture() {
	const organizationId = "00000000-0000-4000-8000-000000000001";
	const tables = {
		account: [] as Row[],
		job: [] as Row[],
		source: [] as Row[],
	};
	const table = (rows: Row[], source = false) => ({
		findUnique: async ({ where }: { where: Row }) =>
			rows.find((row) => row.id === where.id) ?? null,
		create: async ({ data }: { data: Row }) => {
			if (
				source &&
				(data.sourceKind !== "VOD_JOB" ||
					!data.originalJobId ||
					!data.encodingId ||
					!data.accountId ||
					data.renderArtifactId != null)
			)
				throw new Error("LibrarySource_kind_check");
			const row = {
				organizationId,
				createdAt: new Date("2026-11-02T00:00:00Z"),
				updatedAt: new Date("2026-11-02T00:00:00Z"),
				...data,
			};
			rows.push(row);
			return row;
		},
	});
	const tx = {
		bitmovinAccount: table(tables.account),
		encodingJob: table(tables.job),
		librarySource: table(tables.source, true),
		$executeRaw: async () => 1,
	} as unknown as AppTransactionClient;
	const cipher = new AesGcmCipher(randomBytes(32));
	return {
		tables,
		run: () => ensureDialoguePreviewSource(tx, { organizationId, cipher }),
	};
}

describe("isolated dialogue fixture source origin", () => {
	it("creates the actual account/job/source triple admitted by the VOD source constraint", async () => {
		const f = fixture();
		const result = await f.run();
		expect(result.created).toBe(true);
		expect(result.source).toMatchObject({
			id: DIALOGUE_SOURCE_ID,
			sourceKind: "VOD_JOB",
			jobId: DIALOGUE_JOB_ID,
			originalJobId: DIALOGUE_JOB_ID,
			encodingId: DIALOGUE_ENCODING_ID,
			accountId: DIALOGUE_ACCOUNT_ID,
			snapshot: dialogueSourceSnapshot(),
		});
		expect(f.tables.account).toHaveLength(1);
		expect(f.tables.job[0]).toMatchObject({
			id: DIALOGUE_JOB_ID,
			status: "FINISHED",
			bitmovinAccountId: DIALOGUE_ACCOUNT_ID,
			bitmovinEncodingId: DIALOGUE_ENCODING_ID,
			libraryCaptureSuppressed: true,
			plan: { providerExecution: false, fixtureOnly: true },
		});
	});
	it("keeps the second seed byte-for-byte without rotating account ciphertext or timestamps", async () => {
		const f = fixture();
		await f.run();
		const before = JSON.stringify(f.tables);
		const again = await f.run();
		expect(again.created).toBe(false);
		expect(JSON.stringify(f.tables)).toBe(before);
	});
	it.each([
		"jobId",
		"originalJobId",
		"encodingId",
		"accountId",
		"sourceKind",
	])("rejects a changed source %s without repairing rows", async (field) => {
		const f = fixture();
		await f.run();
		const source = f.tables.source[0];
		if (!source) throw new Error("Missing fixture source");
		source[field] = "operator-change";
		const before = JSON.stringify(f.tables);
		await expect(f.run()).rejects.toThrow("PREVIEW_DIALOGUE_ORIGIN_CHANGED");
		expect(JSON.stringify(f.tables)).toBe(before);
	});
	it.each([
		"status",
		"bitmovinAccountId",
		"bitmovinEncodingId",
		"plan",
		"libraryCaptureSuppressed",
	])("rejects a changed fixture job %s", async (field) => {
		const f = fixture();
		await f.run();
		const job = f.tables.job[0];
		if (!job) throw new Error("Missing fixture job");
		job[field] = "operator-change";
		const before = JSON.stringify(f.tables);
		await expect(f.run()).rejects.toThrow("PREVIEW_DIALOGUE_ORIGIN_CHANGED");
		expect(JSON.stringify(f.tables)).toBe(before);
	});
	it("does not repurpose an account from another fixture namespace", async () => {
		const f = fixture();
		await f.run();
		const account = f.tables.account[0];
		if (!account) throw new Error("Missing fixture account");
		account.label = "Existing operator account";
		const before = JSON.stringify(f.tables);
		await expect(f.run()).rejects.toThrow("PREVIEW_DIALOGUE_ORIGIN_CHANGED");
		expect(JSON.stringify(f.tables)).toBe(before);
	});
});
