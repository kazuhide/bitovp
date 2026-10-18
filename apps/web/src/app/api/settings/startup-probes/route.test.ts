import { beforeEach, describe, expect, it, vi } from "vitest";

const settingFindUnique = vi.fn();
const settingUpsert = vi.fn();
const credentialGet = vi.fn();
const revealSecret = vi.fn();
const accountGet = vi.fn();
const verifyDeletePermission = vi.fn();
const auditCreate = vi.fn(async () => ({ id: "audit-1" }));

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			appSetting: { findUnique: settingFindUnique, upsert: settingUpsert },
			auditLog: { create: auditCreate },
		},
		credentials: { get: credentialGet, revealSecret },
		bitmovinAccounts: { get: accountGet },
	}),
}));

vi.mock("@bitovp/storage", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	probeReaperForCredential: () => ({
		deleteObjectsUnderPrefix: async () => ({ deleted: 0 }),
		verifyDeletePermission: (input: unknown) => verifyDeletePermission(input),
	}),
}));

import { PUT } from "./route";
import { POST as RUN } from "./run/route";

const probeQueueAdd = vi.fn();
vi.mock("@/lib/server/queue", () => ({
	getStartupProbeQueue: () => ({ add: probeQueueAdd }),
}));

const CRED = "00000000-0000-4000-8000-00000000c0de";
const ACCT = "00000000-0000-4000-8000-00000000acc7";

function put(body: Record<string, unknown>) {
	return new Request("http://test/api/settings/startup-probes", {
		method: "PUT",
		body: JSON.stringify(body),
	});
}

function run(body: Record<string, unknown>) {
	return new Request("http://test/api/settings/startup-probes/run", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	settingFindUnique.mockResolvedValue(null);
	credentialGet.mockResolvedValue({ provider: "AWS_S3", config: {} });
	accountGet.mockResolvedValue({ id: ACCT, label: "main" });
	revealSecret.mockResolvedValue(
		JSON.stringify({ accessKeyId: "a", secretAccessKey: "s" }),
	);
	verifyDeletePermission.mockResolvedValue({ ok: true, detail: "accepted" });
	auditCreate.mockClear();
});

/**
 *  PR4 control 2 — designation-time delete verification: a
 * list-only credential fails HERE, loudly, before any probe leaks output.
 */
describe("PUT /api/settings/startup-probes", () => {
	it("verifies DELETE permission before saving — and normalizes the prefix", async () => {
		const res = await PUT(
			put({
				credentialId: CRED,
				bitmovinAccountId: ACCT,
				bucket: "probe-bucket",
				prefix: "probes/startup",
				abandonDeadlineMinutes: 8,
			}),
		);
		expect(res.status).toBe(200);
		expect(verifyDeletePermission).toHaveBeenCalledWith({
			bucket: "probe-bucket",
			prefix: "probes/startup/",
		});
		expect(settingUpsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					value: expect.objectContaining({
						prefix: "probes/startup/",
						// The Bitmovin account is saved — provision needs it, and
						// its absence made the probe harness unrunnable (fix 2026-08-23).
						bitmovinAccountId: ACCT,
					}),
				}),
			}),
		);
	});

	it("an unknown Bitmovin account is refused before the canary runs", async () => {
		accountGet.mockResolvedValue(null);
		const res = await PUT(
			put({
				credentialId: CRED,
				bitmovinAccountId: ACCT,
				bucket: "probe-bucket",
				prefix: "probes/startup/",
			}),
		);
		expect(res.status).toBe(422);
		expect(verifyDeletePermission).not.toHaveBeenCalled();
		expect(settingUpsert).not.toHaveBeenCalled();
	});

	it("a list-only credential is refused at designation, not after ten probes", async () => {
		verifyDeletePermission.mockResolvedValue({
			ok: false,
			detail: "access denied",
		});
		const res = await PUT(
			put({
				credentialId: CRED,
				bitmovinAccountId: ACCT,
				bucket: "probe-bucket",
				prefix: "probes/startup/",
			}),
		);
		expect(res.status).toBe(422);
		expect(settingUpsert).not.toHaveBeenCalled();
	});

	it("a short prefix never reaches the verifier — control 3 at the schema", async () => {
		const res = await PUT(
			put({
				credentialId: CRED,
				bitmovinAccountId: ACCT,
				bucket: "b",
				prefix: "p/",
			}),
		);
		expect(res.status).toBe(400);
		expect(verifyDeletePermission).not.toHaveBeenCalled();
	});
});

describe("POST /api/settings/startup-probes/run", () => {
	it("refuses without the worst-case acknowledgement — absence is a 400, not a default", async () => {
		const res = await RUN(run({ regions: ["EUROPE"], perRegion: 2 }));
		expect(res.status).toBe(400);
		expect(probeQueueAdd).not.toHaveBeenCalled();
	});

	it("refuses without a designation", async () => {
		const res = await RUN(
			run({
				regions: ["EUROPE"],
				perRegion: 2,
				acknowledgeWorstCase: true,
			}),
		);
		expect(res.status).toBe(422);
	});

	it("enqueues one batch job with the request id as the dedupe", async () => {
		settingFindUnique.mockResolvedValue({
			key: "live:startup-probe",
			value: {
				credentialId: CRED,
				// review-287 B1: a COMPLETE designation carries the account.
				bitmovinAccountId: ACCT,
				bucket: "b",
				prefix: "probes/startup/",
			},
		});
		const res = await RUN(
			run({
				regions: ["EUROPE"],
				perRegion: 3,
				acknowledgeWorstCase: true,
			}),
		);
		expect(res.status).toBe(202);
		const [name, job, opts] = probeQueueAdd.mock.calls[0] ?? [];
		expect(name).toBe("probe-batch");
		expect(job).toMatchObject({ regions: ["EUROPE"], perRegion: 3 });
		expect(String(opts.jobId)).toContain(job.requestId);
		// The consent row IS written on the happy path — proving the negative
		// assertion above is a live discriminator, not a dead mock.
		expect(auditCreate).toHaveBeenCalledTimes(1);
	});

	it("a LEGACY designation without an account is refused 422 — no 202, no billing-consent audit row, no enqueue (review-287 B1)", async () => {
		// The exact install state before the account requirement: the row
		// exists (truthiness passes) but carries no bitmovinAccountId. The
		// first cut enqueued a batch that then died silently at provision.
		settingFindUnique.mockResolvedValue({
			key: "live:startup-probe",
			value: { credentialId: CRED, bucket: "b", prefix: "probes/startup/" },
		});
		const res = await RUN(
			run({ regions: ["EUROPE"], perRegion: 1, acknowledgeWorstCase: true }),
		);
		expect(res.status).toBe(422);
		expect((await res.json()).error).toMatch(/account/i);
		expect(probeQueueAdd).not.toHaveBeenCalled();
		// review-287 n2: the title claims "no billing-consent audit row" — so
		// MEASURE it. The refusal returns before writeAuditLog, so no row.
		expect(auditCreate).not.toHaveBeenCalled();
	});
});
