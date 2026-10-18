import type {
	VerificationDispatchFence,
	VerificationIntentKind,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	assertVerificationDispatchFence,
	VerificationDispatchFenceError,
} from "./verification-dispatch";

const FENCE: VerificationDispatchFence = {
	verificationRunId: "00000000-0000-4000-8000-000000000031",
	runGeneration: 4,
	intentId: "00000000-0000-4000-8000-000000000032",
	intentGeneration: 9,
	token: "verify-dispatch:44444444-4444-4444-8444-444444444444",
};
const KEY = "verify:run:scenario:VOD_JOB";
const SHA = "a".repeat(64);

type LockedRun = {
	id: string;
	status: string;
	recoveryGeneration: number;
	recoveryOwner: string | null;
};
type LockedIntent = {
	id: string;
	verificationRunId: string;
	kind: string;
	verificationKey: string;
	requestSha256: string;
	state: string;
	cleanupState: string;
	recoveryOwner: string | null;
	recoveryGeneration: number;
	recoveryLeaseUntil: Date | null;
};

function authority(
	overrides: { run?: Partial<LockedRun>; intent?: Partial<LockedIntent> } = {},
) {
	const calls: { sql: string; values: unknown[] }[] = [];
	const run: LockedRun = {
		id: FENCE.verificationRunId,
		status: "RUNNING",
		recoveryGeneration: FENCE.runGeneration,
		recoveryOwner: null,
		...overrides.run,
	};
	const intent: LockedIntent = {
		id: FENCE.intentId,
		verificationRunId: FENCE.verificationRunId,
		kind: "VOD_JOB",
		verificationKey: KEY,
		requestSha256: SHA,
		state: "SUBMITTED",
		cleanupState: "PENDING",
		recoveryOwner: FENCE.token,
		recoveryGeneration: FENCE.intentGeneration,
		// Expiry alone does not revoke a producer. Recovery must first win the
		// parent/child generations; the product transaction races that claim.
		recoveryLeaseUntil: new Date("2000-01-01T00:00:00.000Z"),
		...overrides.intent,
	};
	const tx = {
		$queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
			const sql = Array.from(strings).join("?");
			calls.push({ sql, values });
			if (sql.includes('FROM "VerificationRun"')) return [run];
			if (sql.includes('FROM "VerificationResourceIntent"')) return [intent];
			throw new Error("unexpected SQL");
		},
	};
	return { tx, calls };
}

const input = (
	fence: VerificationDispatchFence = FENCE,
	kind: VerificationIntentKind = "VOD_JOB",
) => ({
	fence,
	kind,
	verificationKey: KEY,
	requestSha256: SHA,
});

describe("assertVerificationDispatchFence", () => {
	it("locks parent before child and accepts an expired lease whose owner/generations remain current", async () => {
		const { tx, calls } = authority();
		await expect(
			assertVerificationDispatchFence(tx as never, input()),
		).resolves.toBeUndefined();
		expect(calls.map((call) => call.sql.match(/FROM "([^"]+)"/)?.[1])).toEqual([
			"VerificationRun",
			"VerificationResourceIntent",
		]);
		expect(calls.every((call) => call.sql.includes("FOR UPDATE"))).toBe(true);
		// Values are carried separately from SQL text; bearer tokens never enter
		// query/error/audit prose.
		expect(calls[0]?.values).toEqual([FENCE.verificationRunId]);
		expect(calls[1]?.values).toEqual([FENCE.intentId]);
		expect(calls.some((call) => call.sql.includes(FENCE.token))).toBe(false);
	});

	it.each([
		[
			"run id",
			{
				fence: {
					...FENCE,
					verificationRunId: "00000000-0000-4000-8000-000000000099",
				},
			},
		],
		[
			"run generation",
			{ fence: { ...FENCE, runGeneration: FENCE.runGeneration + 1 } },
		],
		[
			"intent generation",
			{ fence: { ...FENCE, intentGeneration: FENCE.intentGeneration + 1 } },
		],
		["token", { fence: { ...FENCE, token: `${FENCE.token}-stale` } }],
		["kind", { kind: "LIVE_CHANNEL" as const }],
		["key", { verificationKey: `${KEY}-stale` }],
		["SHA", { requestSha256: "b".repeat(64) }],
	] as const)("rejects an exact-fence %s mismatch", async (_name, change) => {
		const { tx } = authority();
		await expect(
			assertVerificationDispatchFence(tx as never, {
				...input(),
				...change,
			}),
		).rejects.toBeInstanceOf(VerificationDispatchFenceError);
	});

	it("rejects at the parent lock after recovery wins, before the child can be trusted", async () => {
		const { tx, calls } = authority({
			run: {
				status: "INCOMPLETE",
				recoveryGeneration: FENCE.runGeneration + 1,
				recoveryOwner: "verify-recover:new-owner",
			},
		});
		await expect(
			assertVerificationDispatchFence(tx as never, input()),
		).rejects.toBeInstanceOf(VerificationDispatchFenceError);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.sql).toContain('FROM "VerificationRun"');
	});
});
