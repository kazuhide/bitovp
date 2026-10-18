import { REDACTED, verificationIntentsSealable } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import {
	classifySendFailure,
	createIntentLedger,
	INTENT_WRITE_ATTEMPTS,
	type IntentCreate,
	type IntentResolvers,
	type IntentRow,
	type IntentStore,
	type IntentUpdate,
	type LocalCandidate,
	mergeIntentTerminalInputs,
	prismaIntentStore,
	verificationLocalResourceKey,
} from "./resource-intent";

/**
 * The durable-intent ledger (audit 5c3d97ca BLOCKER-5 / §14.4 EV-01), driven
 * against a fake store: every state decision lives here where it can be
 * driven; the two spend sites' call ORDER is pinned next door
 * (runner-intent-wiring.test.ts for VOD, runner-live.test.ts for live).
 */

type Fake = {
	store: IntentStore;
	run: {
		status: "RUNNING" | "INCOMPLETE";
		recoveryGeneration: number;
		recoveryOwner: string | null;
		recoveryLeaseUntil: Date | null;
	};
	rows: Map<string, IntentRow & { updates: IntentUpdate[] }>;
	creates: IntentCreate[];
	/** The candidate set the next lookups answer with. */
	answer: (candidates: LocalCandidate[]) => void;
	lookups: { kind: string; marker: Record<string, unknown> }[];
	failNext: (what: "create" | "update", times: number) => void;
};

function fakeStore(): Fake {
	const rows = new Map<string, IntentRow & { updates: IntentUpdate[] }>();
	const creates: IntentCreate[] = [];
	const lookups: { kind: string; marker: Record<string, unknown> }[] = [];
	let candidates: LocalCandidate[] = [];
	const failures = { create: 0, update: 0 };
	const run: Fake["run"] = {
		status: "RUNNING",
		recoveryGeneration: 0,
		recoveryOwner: null,
		recoveryLeaseUntil: null,
	};
	const assertProducerFence = (
		fence:
			| { verificationRunId: string; recoveryGeneration: number }
			| undefined,
	) => {
		if (
			fence?.verificationRunId !== "run-row-1" ||
			run.status !== "RUNNING" ||
			run.recoveryGeneration !== fence.recoveryGeneration ||
			run.recoveryOwner !== null ||
			run.recoveryLeaseUntil !== null
		) {
			throw new Error("verification run producer fence changed");
		}
	};
	let seq = 0;
	const store: IntentStore = {
		create: async (data, producerFence) => {
			assertProducerFence(producerFence);
			if (failures.create > 0) {
				failures.create -= 1;
				throw new Error("intent create rejected");
			}
			creates.push(data);
			seq += 1;
			const id = `intent-${seq}`;
			rows.set(id, {
				id,
				scenario: data.scenario,
				kind: data.kind,
				verificationKey: data.verificationKey,
				requestSha256: data.requestSha256,
				resourceName: data.resourceName ?? null,
				state: "PREPARED",
				localId: null,
				providerId: null,
				providerIds: [],
				candidates: null,
				cleanupState: "PENDING",
				readback: null,
				possiblyCreatedKeys: [],
				cleanedResourceKeys: [],
				closureDigest: null,
				error: null,
				recoveryOwner: null,
				recoveryLeaseUntil: null,
				recoveryGeneration: 0,
				updates: [],
			});
			return { id };
		},
		update: async (id, data, claim, producerFence) => {
			if (failures.update > 0) {
				failures.update -= 1;
				throw new Error("intent update rejected");
			}
			const row = rows.get(id);
			if (!row) {
				throw new Error(`no intent ${id}`);
			}
			if (producerFence) assertProducerFence(producerFence);
			if (
				claim &&
				(row.recoveryOwner !== claim.owner ||
					row.recoveryGeneration !== claim.generation)
			) {
				throw new Error("stale recovery fence");
			}
			if (row.state === "TERMINAL" && data.state !== "TERMINAL") {
				throw new Error("terminal intent cannot regress");
			}
			if (data.dispatchLease) {
				if (
					row.state !== "PREPARED" ||
					(row.recoveryLeaseUntil !== null &&
						row.recoveryLeaseUntil > data.dispatchLease.now)
				) {
					throw new Error("intent dispatch lease rejected");
				}
				row.recoveryGeneration += 1;
				row.recoveryOwner = data.dispatchLease.owner;
				row.recoveryLeaseUntil = new Date(
					data.dispatchLease.now.getTime() + data.dispatchLease.leaseMs,
				);
			}
			row.updates.push(data);
			if (data.state) row.state = data.state;
			if (data.localId !== undefined) row.localId = data.localId;
			if (data.providerId !== undefined) row.providerId = data.providerId;
			if (data.providerIds !== undefined)
				row.providerIds = [...data.providerIds];
			if (data.candidates !== undefined)
				row.candidates = data.candidates.map((candidate) => ({
					...candidate,
					matchedBy: [...candidate.matchedBy],
				}));
			if (data.cleanupState) row.cleanupState = data.cleanupState;
			if (data.readback !== undefined) row.readback = data.readback;
			if (data.possiblyCreatedKeys !== undefined)
				row.possiblyCreatedKeys = [...data.possiblyCreatedKeys];
			if (data.cleanedResourceKeys !== undefined)
				row.cleanedResourceKeys = [...data.cleanedResourceKeys];
			if (data.closureDigest !== undefined)
				row.closureDigest = data.closureDigest;
			if (data.error !== undefined) row.error = data.error;
			if (data.state === "TERMINAL" || data.releaseLease) {
				row.recoveryOwner = null;
				row.recoveryLeaseUntil = null;
			}
			return data.dispatchLease && row.recoveryLeaseUntil
				? {
						claim: {
							owner: data.dispatchLease.owner,
							generation: row.recoveryGeneration,
							leaseUntil: row.recoveryLeaseUntil,
						},
					}
				: row;
		},
		claimForRecovery: async (id, input, producerFence) => {
			if (producerFence) assertProducerFence(producerFence);
			const row = rows.get(id);
			if (!row) throw new Error(`no intent ${id}`);
			if (
				row.recoveryOwner !== input.owner &&
				row.recoveryLeaseUntil !== null &&
				row.recoveryLeaseUntil > input.now
			) {
				return null;
			}
			row.recoveryGeneration += 1;
			row.recoveryOwner = input.owner;
			row.recoveryLeaseUntil = new Date(input.now.getTime() + input.leaseMs);
			return {
				owner: input.owner,
				generation: row.recoveryGeneration,
				leaseUntil: row.recoveryLeaseUntil,
			};
		},
		listForRun: async () =>
			[...rows.values()].map(({ updates: _u, ...row }) => ({ ...row })),
		findLocal: async (kind, marker) => {
			lookups.push({ kind, marker });
			return candidates.map((c) => ({ ...c, matchedBy: [...c.matchedBy] }));
		},
	};
	return {
		store,
		run,
		rows,
		creates,
		lookups,
		answer: (next) => {
			candidates = next;
		},
		failNext: (what, times) => {
			failures[what] = times;
		},
	};
}

const noSleep = async () => {};
const ledgerOver = (fake: Fake) =>
	createIntentLedger(fake.store, {
		verificationRunId: "run-row-1",
		producerRecoveryGeneration: 0,
		recoveryOwner: "worker-test-1",
		sleep: noSleep,
		now: () => 1_760_000_000_000,
	});

const PREPARE = {
	scenario: "h264-hls",
	kind: "VOD_JOB" as const,
	verificationKey: "verify:r1:h264-hls:VOD_JOB",
	requestSha256: "a".repeat(64),
	resourceName: "uc01-h264-hls [verify r1]",
};

const candidate = (
	localId: string,
	matchedBy: LocalCandidate["matchedBy"],
	status = "RUNNING",
	requestSha256: string | null = PREPARE.requestSha256,
): LocalCandidate => ({
	localId,
	matchedBy,
	status,
	providerId: null,
	requestSha256,
});

const resolvers = (
	outcome: (localId: string) => Promise<{ terminal: boolean }>,
): IntentResolvers => ({
	VOD_JOB: async (row) => ({
		...(await outcome(row.localId)),
		readback: { localId: row.localId },
	}),
	LIVE_CHANNEL: async (row) => ({
		...(await outcome(row.localId)),
		readback: { localId: row.localId },
	}),
});

describe("prepare — the durable intent lands BEFORE anything is sent", () => {
	it("creates a PREPARED row carrying key, SHA, kind, scenario and the resource name", async () => {
		const fake = fakeStore();
		const handle = await ledgerOver(fake).prepare(PREPARE);
		expect(fake.creates).toEqual([
			{ verificationRunId: "run-row-1", ...PREPARE },
		]);
		expect(fake.rows.get("intent-1")?.state).toBe("PREPARED");
		expect(handle.key).toBe(PREPARE.verificationKey);
		expect(handle.requestSha256).toBe(PREPARE.requestSha256);
	});

	it("THROWS when the row does not land — no durable intent, no paid create", async () => {
		const fake = fakeStore();
		fake.failNext("create", 1);
		await expect(ledgerOver(fake).prepare(PREPARE)).rejects.toThrow(
			/intent create rejected/,
		);
	});

	it("submitted() is a HARD write: a lost SUBMITTED write throws so the caller does not send", async () => {
		const fake = fakeStore();
		const handle = await ledgerOver(fake).prepare(PREPARE);
		fake.failNext("update", 1);
		await expect(handle.submitted()).rejects.toThrow(/intent update rejected/);
		// The row is still PREPARED — teardown reads it as never sent.
		expect(fake.rows.get("intent-1")?.state).toBe("PREPARED");
	});

	it("walks PREPARED → SUBMITTED → CONFIRMED on the happy path", async () => {
		const fake = fakeStore();
		const handle = await ledgerOver(fake).prepare(PREPARE);
		const fence = await handle.submitted();
		expect(fence).toMatchObject({
			verificationRunId: "run-row-1",
			runGeneration: 0,
			intentId: "intent-1",
			intentGeneration: 1,
			token: expect.stringMatching(/^verify-dispatch:/),
		});
		expect(fake.rows.get("intent-1")?.state).toBe("SUBMITTED");
		await handle.confirmed("job-1");
		const row = fake.rows.get("intent-1");
		expect(row?.state).toBe("CONFIRMED");
		expect(row?.localId).toBe("job-1");
		expect(handle.localId()).toBe("job-1");
	});

	it("issues an unpredictable dispatch bearer independently for each child intent", async () => {
		const fake = fakeStore();
		const ledger = ledgerOver(fake);
		const first = await ledger.prepare(PREPARE);
		const second = await ledger.prepare({
			...PREPARE,
			scenario: "live-rtmp",
			kind: "LIVE_CHANNEL",
			verificationKey: "verify:r1:live-rtmp:LIVE_CHANNEL",
		});
		const [firstFence, secondFence] = await Promise.all([
			first.submitted(),
			second.submitted(),
		]);
		expect(firstFence.token).toMatch(/^verify-dispatch:/);
		expect(secondFence.token).toMatch(/^verify-dispatch:/);
		expect(firstFence.token).not.toBe(secondFence.token);
	});

	it("refuses PREPARED when restart recovery wins the parent run fence first", async () => {
		const fake = fakeStore();
		fake.run.status = "INCOMPLETE";
		fake.run.recoveryGeneration = 1;
		fake.run.recoveryOwner = "restart";
		fake.run.recoveryLeaseUntil = new Date(1_760_000_600_000);

		await expect(ledgerOver(fake).prepare(PREPARE)).rejects.toThrow(
			/producer fence changed/,
		);
		expect(fake.creates).toEqual([]);
		expect(fake.rows.size).toBe(0);
	});

	it("refuses a new intent after recovery completes and clears its lease", async () => {
		const fake = fakeStore();
		fake.run.status = "INCOMPLETE";
		fake.run.recoveryGeneration = 1;

		await expect(ledgerOver(fake).prepare(PREPARE)).rejects.toThrow(
			/producer fence changed/,
		);
		expect(fake.creates).toEqual([]);
	});

	it("recovery can close PREPARED, then a paused producer cannot write SUBMITTED or reach POST", async () => {
		const fake = fakeStore();
		const producer = ledgerOver(fake);
		const paused = await producer.prepare(PREPARE);
		fake.run.status = "INCOMPLETE";
		fake.run.recoveryGeneration = 1;
		fake.run.recoveryOwner = "restart";
		fake.run.recoveryLeaseUntil = new Date(1_760_000_600_000);
		const recovery = createIntentLedger(fake.store, {
			verificationRunId: "run-row-1",
			recoveryOwner: "restart",
			sleep: noSleep,
			now: () => 1_760_000_000_000,
		});
		const recovered = await recovery.teardown(
			resolvers(async () => {
				throw new Error("PREPARED must not resolve");
			}),
		);
		expect(recovered.sealable).toBe(true);
		expect(fake.rows.get("intent-1")?.state).toBe("TERMINAL");

		let posts = 0;
		const submitThenPost = async () => {
			await paused.submitted();
			posts += 1;
		};
		await expect(submitThenPost()).rejects.toThrow(/producer fence changed/);
		expect(posts).toBe(0);
		expect(fake.rows.get("intent-1")?.state).toBe("TERMINAL");
	});

	it("when the SUBMITTED dispatch lease wins first, recovery leaves the in-flight create untouched", async () => {
		const fake = fakeStore();
		const producer = ledgerOver(fake);
		const handle = await producer.prepare(PREPARE);
		await handle.submitted();
		fake.run.status = "INCOMPLETE";
		fake.run.recoveryGeneration = 1;
		fake.run.recoveryOwner = "restart";
		fake.run.recoveryLeaseUntil = new Date(1_760_000_600_000);
		const recovery = createIntentLedger(fake.store, {
			verificationRunId: "run-row-1",
			recoveryOwner: "restart",
			sleep: noSleep,
			now: () => 1_760_000_000_000,
		});
		fake.answer([]);
		const recovered = await recovery.teardown(
			resolvers(async () => {
				throw new Error("zero candidates must not resolve");
			}),
		);
		expect(recovered.sealable).toBe(false);
		expect(recovered.unresolved).toHaveLength(1);
		expect(fake.rows.get("intent-1")).toMatchObject({
			state: "SUBMITTED",
			cleanupState: "PENDING",
		});
	});

	it.each([
		["VOD_JOB", "job-after-dispatch"],
		["LIVE_CHANNEL", "channel-after-dispatch"],
	] as const)("holds a durable %s dispatch lease from SUBMITTED through the paid POST response", async (kind, localId) => {
		const fake = fakeStore();
		const producer = ledgerOver(fake);
		const handle = await producer.prepare({ ...PREPARE, kind });

		// Pause at the exact production race: SUBMITTED is durable, but the paid
		// POST callback has not returned an id yet.
		await handle.submitted();
		const inFlight = fake.rows.get("intent-1");
		expect(inFlight?.state).toBe("SUBMITTED");
		expect(inFlight?.recoveryOwner).toMatch(/^verify-dispatch:/);
		expect(inFlight?.recoveryLeaseUntil?.getTime()).toBeGreaterThan(
			1_760_000_000_000,
		);

		let recoveryCalls = 0;
		const recovery = createIntentLedger(fake.store, {
			verificationRunId: "run-row-1",
			recoveryOwner: "restart-during-paid-post",
			sleep: noSleep,
			now: () => 1_760_000_000_000,
		});
		const raced = await recovery.teardown(
			resolvers(async () => {
				recoveryCalls += 1;
				return { terminal: true };
			}),
		);
		expect(recoveryCalls).toBe(0);
		expect(raced.sealable).toBe(false);
		expect(fake.rows.get("intent-1")?.state).toBe("SUBMITTED");

		// The original producer still owns the response window, captures the id,
		// and only then releases the lease. The resource is never untracked.
		await handle.recordCreateResponseId(localId);
		await handle.confirmed(localId);
		expect(fake.rows.get("intent-1")).toMatchObject({
			state: "CONFIRMED",
			localId,
			recoveryOwner: null,
			recoveryLeaseUntil: null,
		});
	});
});

describe("the send-failure classification — fail closed", () => {
	const withCode = (code: string) => Object.assign(new Error(code), { code });

	it("a refused socket, an unresolvable host or an unreachable net is BEFORE_SEND", () => {
		for (const code of [
			"ECONNREFUSED",
			"ENOTFOUND",
			"EAI_AGAIN",
			"EHOSTUNREACH",
			"ENETUNREACH",
			"UND_ERR_CONNECT_TIMEOUT",
		]) {
			expect(classifySendFailure(withCode(code)), code).toBe("BEFORE_SEND");
			// undici wraps the cause: `TypeError: fetch failed` → cause.code
			expect(
				classifySendFailure(
					Object.assign(new TypeError("fetch failed"), {
						cause: withCode(code),
					}),
				),
				`wrapped ${code}`,
			).toBe("BEFORE_SEND");
		}
		// Happy eyeballs: an AggregateError of refusals.
		expect(
			classifySendFailure(
				Object.assign(new TypeError("fetch failed"), {
					cause: Object.assign(new AggregateError([withCode("ECONNREFUSED")]), {
						code: undefined,
					}),
				}),
			),
		).toBe("BEFORE_SEND");
	});

	it("a timeout after connect, a reset, EPIPE, a parse failure or a codeless error is AMBIGUOUS", () => {
		for (const err of [
			withCode("ECONNRESET"),
			withCode("EPIPE"),
			withCode("UND_ERR_HEADERS_TIMEOUT"),
			withCode("UND_ERR_BODY_TIMEOUT"),
			withCode("UND_ERR_SOCKET"),
			new SyntaxError("Unexpected end of JSON input"),
			new Error("submit returned no job id"),
			"a string",
			undefined,
		]) {
			expect(classifySendFailure(err), String(err)).toBe("AMBIGUOUS");
		}
	});
});

describe("AMBIGUOUS → lookup → adopt exactly one (never a blind re-send)", () => {
	it("records AMBIGUOUS with the reason BEFORE the lookup runs", async () => {
		const fake = fakeStore();
		const handle = await ledgerOver(fake).prepare(PREPARE);
		await handle.submitted();
		await handle.ambiguous("socket hang up");
		const row = fake.rows.get("intent-1");
		expect(row?.state).toBe("AMBIGUOUS");
		expect(row?.updates.at(-1)).toMatchObject({
			state: "AMBIGUOUS",
			error: "socket hang up",
		});
		expect(fake.lookups).toEqual([]);
	});

	it("looks up by key, label AND name, and adopts the single candidate", async () => {
		const fake = fakeStore();
		const handle = await ledgerOver(fake).prepare(PREPARE);
		await handle.submitted();
		await handle.ambiguous("response lost");
		fake.answer([candidate("job-9", ["key", "label"])]);
		const found = await handle.resolve();
		expect(fake.lookups).toEqual([
			{
				kind: "VOD_JOB",
				marker: {
					verificationKey: PREPARE.verificationKey,
					label: `verify-key:${PREPARE.verificationKey}`,
					name: PREPARE.resourceName,
				},
			},
		]);
		expect(found).toMatchObject({ adopted: true, localId: "job-9" });
		const row = fake.rows.get("intent-1");
		expect(row?.state).toBe("CONFIRMED");
		expect(row?.localId).toBe("job-9");
		expect(handle.localId()).toBe("job-9");
	});

	it("adopts the exact key+SHA candidate even when generic-name rows also match", async () => {
		const fake = fakeStore();
		const handle = await ledgerOver(fake).prepare(PREPARE);
		await handle.submitted();
		await handle.ambiguous("response lost");
		fake.answer([
			candidate("job-exact", ["key"], "RUNNING"),
			candidate("job-old-1", ["name"], "FINISHED", "b".repeat(64)),
			candidate("job-old-2", ["name"], "FINISHED", "c".repeat(64)),
		]);
		const found = await handle.resolve();
		expect(found).toMatchObject({ adopted: true, localId: "job-exact" });
	});

	it("never adopts a weak name/label match when the authoritative exact key is absent", async () => {
		const fake = fakeStore();
		const handle = await ledgerOver(fake).prepare(PREPARE);
		await handle.submitted();
		await handle.ambiguous("response lost");
		fake.answer([candidate("job-foreign", ["name"])]);

		const found = await handle.resolve();

		expect(found.adopted).toBe(false);
		expect(fake.rows.get("intent-1")).toMatchObject({
			localId: null,
			cleanupState: "UNRESOLVED",
		});
	});

	it("never adopts an exact-key row whose stored request SHA differs", async () => {
		const fake = fakeStore();
		const handle = await ledgerOver(fake).prepare(PREPARE);
		await handle.submitted();
		await handle.ambiguous("different-SHA conflict");
		fake.answer([candidate("job-old", ["key"], "RUNNING", "b".repeat(64))]);
		const found = await handle.resolve();
		expect(found.adopted).toBe(false);
		if (!found.adopted) {
			expect(found.reason).toMatch(/request SHA/i);
		}
		expect(fake.rows.get("intent-1")?.cleanupState).toBe("UNRESOLVED");
	});

	it("ZERO candidates after a send is UNRESOLVED — the request may still land", async () => {
		const fake = fakeStore();
		const handle = await ledgerOver(fake).prepare(PREPARE);
		await handle.submitted();
		await handle.ambiguous("response lost");
		fake.answer([]);
		const found = await handle.resolve();
		expect(found.adopted).toBe(false);
		if (!found.adopted) {
			expect(found.reason).toMatch(/may still land/);
		}
		const row = fake.rows.get("intent-1");
		expect(row?.state).toBe("AMBIGUOUS");
		expect(row?.cleanupState).toBe("UNRESOLVED");
		expect(handle.localId()).toBeUndefined();
	});

	it("SEVERAL candidates is UNRESOLVED and names each row for the operator", async () => {
		const fake = fakeStore();
		const handle = await ledgerOver(fake).prepare(PREPARE);
		await handle.submitted();
		await handle.ambiguous("response lost");
		fake.answer([
			candidate("job-1", ["key"]),
			candidate("job-2", ["key"], "QUEUED"),
		]);
		const found = await handle.resolve();
		expect(found.adopted).toBe(false);
		if (!found.adopted) {
			expect(found.reason).toMatch(/2 request-SHA-qualified local rows/);
			expect(found.reason).toContain("job-1");
			expect(found.reason).toContain("job-2");
		}
		expect(fake.rows.get("intent-1")?.cleanupState).toBe("UNRESOLVED");
		expect(fake.rows.get("intent-1")?.updates.at(-1)?.candidates).toHaveLength(
			2,
		);
	});

	it("the same row answering under two markers is ONE candidate, not two", async () => {
		const fake = fakeStore();
		const handle = await ledgerOver(fake).prepare(PREPARE);
		await handle.submitted();
		await handle.ambiguous("response lost");
		fake.answer([candidate("job-1", ["key"]), candidate("job-1", ["name"])]);
		const found = await handle.resolve();
		expect(found).toMatchObject({ adopted: true, localId: "job-1" });
		expect(found.candidates).toEqual([
			{
				localId: "job-1",
				matchedBy: ["key", "name"],
				status: "RUNNING",
				providerId: null,
				requestSha256: PREPARE.requestSha256,
			},
		]);
	});
});

describe("closing an intent", () => {
	it("merges every response-loss mismatch into one exact, clean resource-set closure", () => {
		const merged = mergeIntentTerminalInputs(
			{
				cleanupState: "CLEANED",
				readback: { id: "job-created", terminal: true },
				providerId: "encoding-created",
				providerIds: ["encoding-created"],
				possiblyCreatedKeys: [
					"local:VOD_JOB:job-created",
					"provider:BITMOVIN_ENCODING:encoding-created",
				],
				cleanedResourceKeys: [
					"local:VOD_JOB:job-created",
					"provider:BITMOVIN_ENCODING:encoding-created",
				],
			},
			[
				{
					cleanupState: "CLEANED",
					readback: { id: "job-wrong", terminal: true },
					providerId: "encoding-wrong",
					providerIds: ["encoding-wrong"],
					possiblyCreatedKeys: [
						"local:VOD_JOB:job-wrong",
						"provider:BITMOVIN_ENCODING:encoding-wrong",
					],
					cleanedResourceKeys: [
						"local:VOD_JOB:job-wrong",
						"provider:BITMOVIN_ENCODING:encoding-wrong",
					],
				},
			],
		);

		expect(merged).toMatchObject({
			cleanupState: "CLEANED",
			providerIds: ["encoding-created", "encoding-wrong"],
			possiblyCreatedKeys: [
				"local:VOD_JOB:job-created",
				"local:VOD_JOB:job-wrong",
				"provider:BITMOVIN_ENCODING:encoding-created",
				"provider:BITMOVIN_ENCODING:encoding-wrong",
			],
			cleanedResourceKeys: [
				"local:VOD_JOB:job-created",
				"local:VOD_JOB:job-wrong",
				"provider:BITMOVIN_ENCODING:encoding-created",
				"provider:BITMOVIN_ENCODING:encoding-wrong",
			],
		});
	});

	it("CLEANED and NEVER_CREATED clear the transient current error while prior events remain append-only", async () => {
		const fake = fakeStore();
		const ledger = ledgerOver(fake);
		const cleaned = await ledger.prepare({
			...PREPARE,
			verificationKey: "k-cleaned",
		});
		await cleaned.submitted();
		await cleaned.ambiguous("post-create response lost");
		fake.answer([candidate("job-cleaned", ["key"])]);
		await cleaned.resolve();
		await cleaned.terminal({
			cleanupState: "CLEANED",
			readback: { terminal: true },
		});

		const cleanedRow = fake.rows.get("intent-1");
		expect(cleanedRow?.error).toBeNull();
		expect(cleanedRow?.updates.map((update) => update.eventType)).toEqual([
			"SUBMITTED",
			"AMBIGUOUS",
			"ADOPTED",
			"TERMINAL_READBACK",
		]);
		expect(cleanedRow?.updates[1]).toMatchObject({
			error: "post-create response lost",
		});

		const neverCreated = await ledger.prepare({
			...PREPARE,
			verificationKey: "k-never-created",
		});
		await neverCreated.submitted();
		await neverCreated.ambiguous("transient response parser error");
		await neverCreated.refused("provider explicitly refused create");
		const neverCreatedRow = fake.rows.get("intent-2");
		expect(neverCreatedRow?.cleanupState).toBe("NEVER_CREATED");
		expect(neverCreatedRow?.error).toBeNull();
		expect(neverCreatedRow?.updates.map((update) => update.eventType)).toEqual([
			"SUBMITTED",
			"AMBIGUOUS",
			"REFUSED",
		]);
		expect(neverCreatedRow?.updates[1]).toMatchObject({
			error: "transient response parser error",
		});
	});

	it("a direct CLEANED terminal input with an error remains UNRESOLVED and cannot seal", async () => {
		const fake = fakeStore();
		const ledger = ledgerOver(fake);
		const handle = await ledger.prepare(PREPARE);
		await handle.submitted();
		await handle.confirmed("job-1");
		const localKey = verificationLocalResourceKey("VOD_JOB", "job-1");

		await handle.terminal({
			cleanupState: "CLEANED",
			readback: { local: "CANCELED", providerIdentityComplete: false },
			possiblyCreatedKeys: [localKey],
			cleanedResourceKeys: [localKey],
			error: "provider identity incomplete",
		});

		const row = fake.rows.get("intent-1");
		if (!row) throw new Error("fixture row missing");
		const verdict = verificationIntentsSealable([row]);
		expect(verdict.sealable).toBe(false);
		expect(row).toMatchObject({
			cleanupState: "UNRESOLVED",
			error: "provider identity incomplete",
		});
	});

	it("neverSent and refused close as NEVER_CREATED; terminal records the readback", async () => {
		const fake = fakeStore();
		const ledger = ledgerOver(fake);
		const a = await ledger.prepare({ ...PREPARE, verificationKey: "k-a" });
		await a.neverSent("ECONNREFUSED");
		expect(fake.rows.get("intent-1")).toMatchObject({
			state: "TERMINAL",
			cleanupState: "NEVER_CREATED",
		});
		const b = await ledger.prepare({ ...PREPARE, verificationKey: "k-b" });
		await b.submitted();
		await b.refused("submit failed (400): bad plan");
		expect(fake.rows.get("intent-2")).toMatchObject({
			state: "TERMINAL",
			cleanupState: "NEVER_CREATED",
		});
		const c = await ledger.prepare({ ...PREPARE, verificationKey: "k-c" });
		await c.submitted();
		await c.confirmed("job-3");
		await c.terminal({
			cleanupState: "CLEANED",
			readback: { status: "FINISHED" },
			providerId: "enc-3",
		});
		expect(fake.rows.get("intent-3")).toMatchObject({
			state: "TERMINAL",
			cleanupState: "CLEANED",
			localId: "job-3",
			providerId: "enc-3",
		});
		expect(fake.rows.get("intent-3")?.updates.at(-1)).toMatchObject({
			readback: { status: "FINISHED" },
		});
	});

	it("soft writes retry INTENT_WRITE_ATTEMPTS times and never throw — the DB row stays the authority", async () => {
		const fake = fakeStore();
		const handle = await ledgerOver(fake).prepare(PREPARE);
		await handle.submitted();
		fake.failNext("update", INTENT_WRITE_ATTEMPTS - 1);
		await expect(handle.confirmed("job-1")).resolves.toBeUndefined();
		expect(fake.rows.get("intent-1")?.localId).toBe("job-1");
		fake.failNext("update", INTENT_WRITE_ATTEMPTS);
		await expect(
			handle.terminal({ cleanupState: "CLEANED", readback: {} }),
		).resolves.toBeUndefined();
		// All attempts failed: the row is NOT terminal, and teardown will see it.
		expect(fake.rows.get("intent-1")?.state).toBe("CONFIRMED");
	});

	it("records an ordered, redacted transition vocabulary and a recomputable identity closure", async () => {
		const fake = fakeStore();
		const handle = await ledgerOver(fake).prepare(PREPARE);
		await handle.submitted();
		await handle.ambiguous("response body was lost");
		fake.answer([
			{
				...candidate("job-9", ["key"]),
				providerId: "enc-9",
			},
		]);
		await handle.resolve();
		await handle.terminal({
			cleanupState: "CLEANED",
			readback: {
				local: { id: "job-9", status: "FINISHED" },
				provider: [{ id: "enc-9", status: "FINISHED" }],
			},
		});

		const row = fake.rows.get("intent-1");
		expect(row?.updates.map((update) => update.eventType)).toEqual([
			"SUBMITTED",
			"AMBIGUOUS",
			"ADOPTED",
			"TERMINAL_READBACK",
		]);
		expect(row).toMatchObject({
			providerIds: ["enc-9"],
			possiblyCreatedKeys: [
				"local:VOD_JOB:job-9",
				"provider:BITMOVIN_ENCODING:enc-9",
			],
			cleanedResourceKeys: [
				"local:VOD_JOB:job-9",
				"provider:BITMOVIN_ENCODING:enc-9",
			],
		});
		expect(row?.closureDigest).toMatch(/^[0-9a-f]{64}$/);
		const verdict = await ledgerOver(fake).teardown(
			resolvers(async () => {
				throw new Error("a closed dossier must not be driven again");
			}),
		);
		expect(verdict.sealable).toBe(true);
	});
});

describe("teardown — the run seals only when possibly-created == terminal-readback-and-cleaned", () => {
	it("an empty ledger is sealable", async () => {
		const fake = fakeStore();
		const verdict = await ledgerOver(fake).teardown(
			resolvers(async () => ({ terminal: true })),
		);
		expect(verdict).toEqual({
			sealable: true,
			unresolved: [],
			lines: [],
			dossier: [],
		});
	});

	it("a PREPARED intent that was never sent closes NEVER_CREATED without a resolver", async () => {
		const fake = fakeStore();
		const ledger = ledgerOver(fake);
		await ledger.prepare(PREPARE);
		fake.answer([]);
		let resolved = 0;
		const verdict = await ledger.teardown(
			resolvers(async () => {
				resolved += 1;
				return { terminal: true };
			}),
		);
		expect(resolved).toBe(0);
		expect(verdict.sealable).toBe(true);
		expect(fake.rows.get("intent-1")).toMatchObject({
			state: "TERMINAL",
			cleanupState: "NEVER_CREATED",
		});
		expect(verdict.lines[0]).toMatch(/never sent/);
	});

	it.each([
		["VOD_JOB", "job-fresh"],
		["LIVE_CHANNEL", "channel-fresh"],
	] as const)("uses the fresh claimed %s row when SUBMITTED + response-id capture lands after the initial list", async (kind, localId) => {
		const fake = fakeStore();
		const ledger = createIntentLedger(fake.store, {
			verificationRunId: "run-row-1",
			producerRecoveryGeneration: 0,
			recoveryOwner: "recovery-process",
			sleep: noSleep,
			now: () => 1_760_000_000_000,
		});
		const handle = await ledger.prepare({ ...PREPARE, kind });
		const originalListForRun = fake.store.listForRun;
		let injectedAfterSnapshot = false;
		fake.store.listForRun = async (runId) => {
			const snapshot = await originalListForRun(runId);
			if (!injectedAfterSnapshot) {
				injectedAfterSnapshot = true;
				await handle.submitted();
				await handle.recordCreateResponseId(localId);
				await handle.confirmed(localId);
			}
			return snapshot;
		};
		fake.answer([]);
		const driven: string[] = [];
		const resolveOne = async (row: IntentRow & { localId: string }) => {
			driven.push(row.localId);
			const localKey = verificationLocalResourceKey(kind, row.localId);
			return {
				terminal: true,
				readback: { localId: row.localId, terminal: true },
				possiblyCreatedKeys: [localKey],
				cleanedResourceKeys: [localKey],
			};
		};

		const verdict = await ledger.teardown({
			VOD_JOB: resolveOne,
			LIVE_CHANNEL: resolveOne,
		});

		expect(driven).toEqual([localId]);
		expect(verdict.sealable).toBe(true);
		expect(verdict.dossier[0]).toMatchObject({
			state: "TERMINAL",
			cleanupState: "CLEANED",
			possiblyCreatedKeys: [verificationLocalResourceKey(kind, localId)],
			cleanedResourceKeys: [verificationLocalResourceKey(kind, localId)],
		});
	});

	it("a SUBMITTED intent with no local row is UNRESOLVED and refuses the seal (SIGTERM before the response)", async () => {
		const fake = fakeStore();
		const ledger = ledgerOver(fake);
		const handle = await ledger.prepare(PREPARE);
		await handle.submitted();
		const inFlight = fake.rows.get("intent-1");
		if (!inFlight) throw new Error("fixture intent missing");
		inFlight.recoveryLeaseUntil = new Date(1_759_999_999_999);
		fake.answer([]);
		const verdict = await ledger.teardown(
			resolvers(async () => ({ terminal: true })),
		);
		expect(verdict.sealable).toBe(false);
		expect(verdict.unresolved.map((r) => r.verificationKey)).toEqual([
			PREPARE.verificationKey,
		]);
		expect(fake.rows.get("intent-1")).toMatchObject({
			state: "SUBMITTED",
			cleanupState: "UNRESOLVED",
		});
		expect(verdict.lines[0]).toMatch(/may still land/);
	});

	it.each([
		["VOD_JOB", "job-sha-conflict", "CANCELED"],
		["LIVE_CHANNEL", "channel-sha-conflict", "STOPPED"],
	] as const)("drives an exact-key %s different-SHA conflict through bounded cleanup without adopting it as evidence", async (kind, localId, terminalStatus) => {
		const fake = fakeStore();
		const ledger = ledgerOver(fake);
		const verificationKey = `verify:r1:h264-hls:${kind}`;
		const handle = await ledger.prepare({
			...PREPARE,
			kind,
			verificationKey,
		});
		await handle.submitted();
		await handle.ambiguous("HTTP 409: different-SHA conflict");
		fake.answer([candidate(localId, ["key"], "RUNNING", "b".repeat(64))]);

		const found = await handle.resolve();
		expect(found.adopted).toBe(false);
		expect(handle.localId()).toBeUndefined();

		const driven: Array<{ kind: string; localId: string }> = [];
		const resolveOne = async (row: IntentRow & { localId: string }) => {
			driven.push({ kind: row.kind, localId: row.localId });
			const localKey = verificationLocalResourceKey(kind, row.localId);
			return {
				terminal: true,
				readback: {
					localId: row.localId,
					status: terminalStatus,
					billing: false,
				},
				possiblyCreatedKeys: [localKey],
				cleanedResourceKeys: [localKey],
			};
		};
		const verdict = await ledger.teardown({
			VOD_JOB: resolveOne,
			LIVE_CHANNEL: resolveOne,
		});

		expect(driven).toEqual([{ kind, localId }]);
		expect(verdict.sealable).toBe(true);
		expect(verdict.dossier[0]).toMatchObject({
			verificationKey,
			state: "TERMINAL",
			cleanupState: "CLEANED",
			localId: null,
			readback: {
				localId,
				status: terminalStatus,
				billing: false,
			},
			possiblyCreatedKeys: [verificationLocalResourceKey(kind, localId)],
			cleanedResourceKeys: [verificationLocalResourceKey(kind, localId)],
		});
	});

	it.each([
		["VOD_JOB", "job-weak", ["label"]],
		["LIVE_CHANNEL", "channel-weak", ["name"]],
	] as const)("keeps an unrelated ambiguous %s weak-marker candidate fail-closed and never stops it", async (kind, localId, matchedBy) => {
		const fake = fakeStore();
		const ledger = ledgerOver(fake);
		const handle = await ledger.prepare({
			...PREPARE,
			kind,
			verificationKey: `verify:r1:h264-hls:${kind}`,
		});
		await handle.submitted();
		await handle.ambiguous("response lost");
		fake.answer([candidate(localId, [...matchedBy])]);

		const found = await handle.resolve();
		expect(found.adopted).toBe(false);
		let resolverCalls = 0;
		const verdict = await ledger.teardown(
			resolvers(async () => {
				resolverCalls += 1;
				return { terminal: true };
			}),
		);

		expect(resolverCalls).toBe(0);
		expect(verdict.sealable).toBe(false);
		expect(verdict.dossier[0]).toMatchObject({
			state: "AMBIGUOUS",
			cleanupState: "UNRESOLVED",
			localId: null,
			possiblyCreatedKeys: [],
			cleanedResourceKeys: [],
		});
	});

	it("reclaims an empty first lookup and cleans the exact-key resource when it becomes visible later", async () => {
		const fake = fakeStore();
		const producer = ledgerOver(fake);
		const handle = await producer.prepare(PREPARE);
		await handle.submitted();
		await handle.ambiguous("response lost after the request left");

		fake.answer([]);
		const first = await producer.teardown(
			resolvers(async () => {
				throw new Error("zero candidates must not call the resolver");
			}),
		);
		expect(first.sealable).toBe(false);
		expect(first.dossier[0]).toMatchObject({
			state: "AMBIGUOUS",
			cleanupState: "UNRESOLVED",
			recoveryOwner: null,
			recoveryLeaseUntil: null,
		});

		fake.answer([candidate("job-visible-later", ["key"], "RUNNING")]);
		const driven: string[] = [];
		const second = await producer.teardown(
			resolvers(async (localId) => {
				driven.push(localId);
				return { terminal: true };
			}),
		);
		expect(driven).toEqual(["job-visible-later"]);
		expect(second.sealable).toBe(true);
		expect(second.dossier[0]).toMatchObject({
			state: "TERMINAL",
			cleanupState: "CLEANED",
			localId: "job-visible-later",
		});
	});

	it("a SUBMITTED intent whose row EXISTS is adopted at teardown, driven terminal and CLEANED (response lost, process died)", async () => {
		const fake = fakeStore();
		const ledger = ledgerOver(fake);
		const handle = await ledger.prepare(PREPARE);
		await handle.submitted();
		const inFlight = fake.rows.get("intent-1");
		if (!inFlight) throw new Error("fixture intent missing");
		inFlight.recoveryLeaseUntil = new Date(1_759_999_999_999);
		fake.answer([candidate("job-7", ["key"])]);
		const driven: string[] = [];
		const verdict = await ledger.teardown(
			resolvers(async (localId) => {
				driven.push(localId);
				return { terminal: true };
			}),
		);
		expect(driven).toEqual(["job-7"]);
		expect(verdict.sealable).toBe(true);
		expect(fake.rows.get("intent-1")).toMatchObject({
			state: "TERMINAL",
			cleanupState: "CLEANED",
			localId: "job-7",
		});
	});

	it("a CONFIRMED intent left PENDING re-runs exact-key discovery before cleanup", async () => {
		const fake = fakeStore();
		const ledger = ledgerOver(fake);
		const handle = await ledger.prepare(PREPARE);
		await handle.submitted();
		await handle.confirmed("job-1", "enc-1");
		const localKey = "local:VOD_JOB:job-1";
		const providerKey = "provider:BITMOVIN_ENCODING:enc-1";
		const verdict = await ledger.teardown({
			VOD_JOB: async () => ({
				terminal: true,
				readback: { status: "FINISHED" },
				providerId: "enc-1",
				providerIds: ["enc-1"],
				possiblyCreatedKeys: [localKey, providerKey],
				cleanedResourceKeys: [localKey, providerKey],
			}),
			LIVE_CHANNEL: async () => {
				throw new Error("wrong resolver");
			},
		});
		expect(fake.lookups).toHaveLength(1);
		expect(verdict.sealable).toBe(true);
		expect(fake.rows.get("intent-1")?.cleanupState).toBe("CLEANED");
	});

	it("a resolver that cannot drive the resource terminal leaves it UNRESOLVED — no seal", async () => {
		const fake = fakeStore();
		const ledger = ledgerOver(fake);
		const handle = await ledger.prepare(PREPARE);
		await handle.submitted();
		await handle.confirmed("job-1");
		const verdict = await ledger.teardown(
			resolvers(async () => ({ terminal: false })),
		);
		expect(verdict.sealable).toBe(false);
		expect(fake.rows.get("intent-1")?.cleanupState).toBe("UNRESOLVED");
	});

	it("a resolver error cannot seal even when its terminal flag and resource sets look clean", async () => {
		const fake = fakeStore();
		const ledger = ledgerOver(fake);
		const handle = await ledger.prepare(PREPARE);
		await handle.submitted();
		await handle.confirmed("job-1");
		const localKey = "local:VOD_JOB:job-1";
		const verdict = await ledger.teardown({
			VOD_JOB: async () => ({
				terminal: true,
				readback: { status: "CANCELED", identityComplete: false },
				possiblyCreatedKeys: [localKey],
				cleanedResourceKeys: [localKey],
				error: "identity readback incomplete",
			}),
			LIVE_CHANNEL: async () => {
				throw new Error("wrong resolver");
			},
		});
		expect(verdict.sealable).toBe(false);
		expect(verdict.dossier[0]).toMatchObject({
			cleanupState: "UNRESOLVED",
			error: "identity readback incomplete",
		});
	});

	it("a resolver that THROWS is an UNRESOLVED intent, not a crashed teardown", async () => {
		const fake = fakeStore();
		const ledger = ledgerOver(fake);
		const handle = await ledger.prepare(PREPARE);
		await handle.submitted();
		await handle.confirmed("job-1");
		const verdict = await ledger.teardown(
			resolvers(async () => {
				throw new Error("provider unreachable");
			}),
		);
		expect(verdict.sealable).toBe(false);
		expect(verdict.lines[0]).toMatch(/provider unreachable/);
	});

	it("several exact-key candidates are all driven terminal before the cleanup ledger seals", async () => {
		const fake = fakeStore();
		const ledger = ledgerOver(fake);
		const handle = await ledger.prepare(PREPARE);
		await handle.submitted();
		await handle.ambiguous("response lost");
		fake.answer([candidate("job-1", ["key"]), candidate("job-2", ["key"])]);
		const driven: string[] = [];
		const verdict = await ledger.teardown(
			resolvers(async (localId) => {
				driven.push(localId);
				return { terminal: true };
			}),
		);
		expect(driven.sort()).toEqual(["job-1", "job-2"]);
		expect(verdict.sealable).toBe(true);
	});

	it("reads the seal verdict from the ROWS after the loop — a lost TERMINAL write still refuses", async () => {
		const fake = fakeStore();
		const ledger = ledgerOver(fake);
		const handle = await ledger.prepare(PREPARE);
		await handle.submitted();
		await handle.confirmed("job-1");
		// Every update from here on is rejected: the resolver says terminal,
		// but the TERMINAL write never lands.
		fake.failNext("update", 99);
		const verdict = await ledger.teardown(
			resolvers(async () => ({ terminal: true })),
		);
		expect(verdict.sealable).toBe(false);
		expect(verdict.unresolved).toHaveLength(1);
	});

	it("does not touch an intent leased by another live recovery process", async () => {
		const fake = fakeStore();
		const ledger = ledgerOver(fake);
		const handle = await ledger.prepare(PREPARE);
		await handle.submitted();
		await handle.confirmed("job-owned");
		const row = fake.rows.get("intent-1");
		if (!row) throw new Error("fixture row missing");
		const bearer = "verify-dispatch:TOKEN-CANARY-MUST-NEVER-LEAVE-THE-DATABASE";
		row.recoveryOwner = bearer;
		row.recoveryGeneration = 7;
		row.recoveryLeaseUntil = new Date(1_760_000_600_000);
		row.events = [
			{
				sequence: 7,
				eventType: "RECOVERY_CLAIMED",
				fromState: "CONFIRMED",
				toState: "CONFIRMED",
				cleanupState: "PENDING",
				details: {
					owner: bearer,
					generation: 7,
					leaseUntil: row.recoveryLeaseUntil.toISOString(),
				},
				createdAt: new Date(1_760_000_000_000),
			},
		];
		let resolutions = 0;
		const verdict = await ledger.teardown(
			resolvers(async () => {
				resolutions += 1;
				return { terminal: true };
			}),
		);
		expect(resolutions).toBe(0);
		expect(verdict.sealable).toBe(false);
		expect(verdict.lines.join(" ")).toMatch(/another reconciler/);
		expect(row.recoveryGeneration).toBe(7);
		// The database keeps its exact fencing owner, while the report-facing
		// dossier must not turn either copy into a portable paid-create token.
		expect(row.recoveryOwner).toBe(bearer);
		expect(
			(row.events[0]?.details as { owner?: string } | undefined)?.owner,
		).toBe(bearer);
		expect(verdict.dossier[0]?.recoveryOwner).toBe(REDACTED);
		expect(verdict.unresolved[0]?.recoveryOwner).toBe(REDACTED);
		expect(
			(
				verdict.dossier[0]?.events?.[0]?.details as
					| { owner?: string }
					| undefined
			)?.owner,
		).toBe(REDACTED);
		expect(
			(
				verdict.unresolved[0]?.events?.[0]?.details as
					| { owner?: string }
					| undefined
			)?.owner,
		).toBe(REDACTED);
		expect(JSON.stringify(verdict.dossier)).not.toContain(bearer);
		expect(JSON.stringify(verdict.unresolved)).not.toContain(bearer);
	});

	it("takes over an expired lease with a higher generation and closes idempotently", async () => {
		const fake = fakeStore();
		const ledger = ledgerOver(fake);
		const handle = await ledger.prepare(PREPARE);
		await handle.submitted();
		await handle.confirmed("job-resume", "enc-resume");
		const row = fake.rows.get("intent-1");
		if (!row) throw new Error("fixture row missing");
		row.recoveryOwner = "dead-process";
		row.recoveryGeneration = 3;
		row.recoveryLeaseUntil = new Date(1_759_999_999_999);
		const localKey = "local:VOD_JOB:job-resume";
		const providerKey = "provider:BITMOVIN_ENCODING:enc-resume";
		const verdict = await ledger.teardown({
			VOD_JOB: async () => ({
				terminal: true,
				readback: { status: "FINISHED" },
				providerId: "enc-resume",
				providerIds: ["enc-resume"],
				possiblyCreatedKeys: [localKey, providerKey],
				cleanedResourceKeys: [localKey, providerKey],
			}),
			LIVE_CHANNEL: async () => {
				throw new Error("wrong resolver");
			},
		});
		expect(verdict.sealable).toBe(true);
		expect(row.recoveryGeneration).toBe(4);
		expect(row.recoveryOwner).toBeNull();
		expect(row.recoveryLeaseUntil).toBeNull();
	});

	it("is idempotent: a second teardown re-resolves only what is still open", async () => {
		const fake = fakeStore();
		const ledger = ledgerOver(fake);
		const a = await ledger.prepare({ ...PREPARE, verificationKey: "k-a" });
		await a.submitted();
		await a.confirmed("job-a");
		const b = await ledger.prepare({ ...PREPARE, verificationKey: "k-b" });
		await b.submitted();
		await b.confirmed("job-b");
		let calls = 0;
		const flaky = resolvers(async (localId) => {
			calls += 1;
			return { terminal: localId === "job-a" || calls > 2 };
		});
		const first = await ledger.teardown(flaky);
		expect(first.sealable).toBe(false);
		expect(first.unresolved.map((r) => r.verificationKey)).toEqual(["k-b"]);
		const second = await ledger.teardown(flaky);
		expect(second.sealable).toBe(true);
		// job-a was closed by the first pass and not driven again.
		expect(calls).toBe(3);
	});
});

describe("CREATE response ID capture — durable cleanup ownership without adoption", () => {
	it.each([
		["VOD_JOB", "job-created", "job-wrong", "job-late"],
		["LIVE_CHANNEL", "channel-created", "channel-wrong", "channel-late"],
	] as const)("recovers every %s local id after process death, including a wrong persisted adoption", async (kind, createdId, wrongId, lateId) => {
		const fake = fakeStore();
		const original = createIntentLedger(fake.store, {
			verificationRunId: "run-row-1",
			producerRecoveryGeneration: 0,
			recoveryOwner: "original-process",
			sleep: noSleep,
			now: () => 1_760_000_000_000,
		});
		const handle = await original.prepare({ ...PREPARE, kind });
		await handle.submitted();
		await handle.recordCreateResponseId(createdId);

		const rowAfterCapture = fake.rows.get("intent-1");
		expect(rowAfterCapture).toMatchObject({
			state: "SUBMITTED",
			localId: null,
			possiblyCreatedKeys: [`local:${kind}:${createdId}`],
		});
		const capture = rowAfterCapture?.updates.find(
			(update) => update.eventType === "CREATE_RESPONSE_ID_CAPTURED",
		);
		expect(capture).toBeDefined();
		expect(capture).not.toHaveProperty("localId");

		// At the injection instant only the wrong row is visible, so it is the
		// unique exact-key adoption. The process then dies before either id is
		// cleaned; recovery must not trust this persisted localId alone.
		fake.answer([candidate(wrongId, ["key"])]);
		await expect(handle.resolve()).resolves.toMatchObject({
			adopted: true,
			localId: wrongId,
		});
		const rowAfterWrongAdoption = fake.rows.get("intent-1");
		expect(rowAfterWrongAdoption?.possiblyCreatedKeys).toEqual([
			`local:${kind}:${createdId}`,
			`local:${kind}:${wrongId}`,
		]);
		const eventTypes = rowAfterWrongAdoption?.updates.map(
			(update) => update.eventType,
		);
		expect(eventTypes?.indexOf("CREATE_RESPONSE_ID_CAPTURED")).toBeLessThan(
			eventTypes?.indexOf("ADOPTED") ?? -1,
		);

		// A new process sees the created id, the wrong row.localId, and a late
		// exact-key candidate. All three are owned cleanup possibilities.
		fake.answer([
			candidate(createdId, ["key"]),
			candidate(wrongId, ["key"]),
			candidate(lateId, ["key"]),
		]);
		const driven: string[] = [];
		const resolveOne = async (row: IntentRow & { localId: string }) => {
			driven.push(row.localId);
			const localKey = `local:${kind}:${row.localId}`;
			return {
				terminal: true,
				readback: { localId: row.localId, recovered: true },
				possiblyCreatedKeys: [localKey],
				cleanedResourceKeys: [localKey],
			};
		};
		const restarted = createIntentLedger(fake.store, {
			verificationRunId: "run-row-1",
			recoveryOwner: "restart-process",
			sleep: noSleep,
			now: () => 1_760_000_001_000,
		});
		const verdict = await restarted.teardown({
			VOD_JOB: resolveOne,
			LIVE_CHANNEL: resolveOne,
		});

		expect(driven.sort()).toEqual([createdId, lateId, wrongId].sort());
		expect(verdict.sealable).toBe(true);
		const expectedKeys = [createdId, lateId, wrongId]
			.map((id) => `local:${kind}:${id}`)
			.sort();
		expect(verdict.dossier[0]).toMatchObject({
			cleanupState: "CLEANED",
			possiblyCreatedKeys: expectedKeys,
			cleanedResourceKeys: expectedKeys,
		});
	});

	it("a CREATE response ID capture is HARD and cannot silently proceed to adoption", async () => {
		const fake = fakeStore();
		const handle = await ledgerOver(fake).prepare(PREPARE);
		await handle.submitted();
		fake.failNext("update", 1);
		await expect(handle.recordCreateResponseId("job-created")).rejects.toThrow(
			/intent update rejected/,
		);
		expect(fake.rows.get("intent-1")).toMatchObject({
			state: "SUBMITTED",
			localId: null,
			possiblyCreatedKeys: [],
		});
	});
});

describe("Prisma intent adapter — exact key lookup cannot be crowded out", () => {
	it.each([
		"VOD_JOB",
		"LIVE_CHANNEL",
	] as const)("fetches the unique %s verificationKey separately from ten weak marker rows", async (kind) => {
		const marker = {
			verificationKey: PREPARE.verificationKey,
			label: `verify-key:${PREPARE.verificationKey}`,
			name: PREPARE.resourceName,
		};
		const exactId = kind === "VOD_JOB" ? "job-exact" : "channel-exact";
		const exact = {
			id: exactId,
			status: "RUNNING",
			bitmovinEncodingId: null,
			verificationKey: marker.verificationKey,
			verificationRequestSha256: PREPARE.requestSha256,
			labels: [marker.label],
			name: marker.name,
		};
		const weak = Array.from({ length: 10 }, (_, index) => ({
			...exact,
			id: `${kind === "VOD_JOB" ? "job" : "channel"}-weak-${index}`,
			verificationKey: null,
		}));
		const encodingFindUnique = vi.fn(async () => exact);
		const encodingFindMany = vi.fn(async () => weak);
		const liveFindUnique = vi.fn(async () => exact);
		const liveFindMany = vi.fn(async () => weak);
		const prisma = {
			encodingJob: {
				findUnique: encodingFindUnique,
				findMany: encodingFindMany,
			},
			liveChannel: {
				findUnique: liveFindUnique,
				findMany: liveFindMany,
			},
		} as unknown as AppPrismaClient;

		const candidates = await prismaIntentStore(prisma).findLocal(kind, marker);

		expect(
			kind === "VOD_JOB" ? encodingFindUnique : liveFindUnique,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { verificationKey: marker.verificationKey },
			}),
		);
		expect(candidates).toContainEqual(
			expect.objectContaining({
				localId: exactId,
				matchedBy: expect.arrayContaining(["key"]),
				requestSha256: PREPARE.requestSha256,
			}),
		);
	});
});

describe("Prisma intent adapter — append-only CAS evidence", () => {
	const PRODUCER_FENCE = {
		verificationRunId: "run-db-1",
		recoveryGeneration: 0,
	};

	function adapterFixture(updateCount = 1, parentRows = [{ id: "run-db-1" }]) {
		const intentCreate = vi.fn(async (_input: unknown) => ({
			id: "intent-db-1",
		}));
		const eventCreate = vi.fn(async (_input: unknown) => ({
			id: "event-db-1",
		}));
		const findUniqueOrThrow = vi.fn(
			async (): Promise<{
				eventSeq: number;
				state: string;
				recoveryOwner?: string | null;
				recoveryLeaseUntil?: Date | null;
				recoveryGeneration?: number;
			}> => ({
				eventSeq: 3,
				state: "AMBIGUOUS",
			}),
		);
		const updateMany = vi.fn(async () => ({ count: updateCount }));
		const queryRaw = vi.fn(
			async (_strings: TemplateStringsArray, ..._values: unknown[]) =>
				parentRows,
		);
		const tx = {
			$queryRaw: queryRaw,
			verificationResourceIntent: {
				create: intentCreate,
				findUniqueOrThrow,
				updateMany,
			},
			verificationResourceIntentEvent: { create: eventCreate },
		};
		const prisma = {
			$transaction: async (callback: (transaction: typeof tx) => unknown) =>
				callback(tx),
		} as unknown as AppPrismaClient;
		return {
			store: prismaIntentStore(prisma),
			intentCreate,
			eventCreate,
			findUniqueOrThrow,
			updateMany,
			queryRaw,
		};
	}

	it("atomically appends PREPARED and every CAS-protected transition", async () => {
		const fixture = adapterFixture();
		await fixture.store.create(
			{ verificationRunId: "run-db-1", ...PREPARE },
			PRODUCER_FENCE,
		);
		expect(fixture.queryRaw).toHaveBeenCalled();
		expect(String(fixture.queryRaw.mock.calls[0]?.[0])).toContain("FOR UPDATE");
		expect(fixture.eventCreate).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				data: expect.objectContaining({
					sequence: 0,
					eventType: "PREPARED",
					toState: "PREPARED",
				}),
			}),
		);

		await fixture.store.update(
			"intent-db-1",
			{
				eventType: "TERMINAL_READBACK",
				state: "TERMINAL",
				cleanupState: "CLEANED",
				localId: "job-1",
				providerIds: ["enc-1"],
				possiblyCreatedKeys: ["local:VOD_JOB:job-1"],
				cleanedResourceKeys: ["local:VOD_JOB:job-1"],
				candidates: [candidate("job-1", ["key"])],
				readback: { status: "FINISHED", token: "must-not-enter-event" },
				closureDigest: "d".repeat(64),
			},
			undefined,
			PRODUCER_FENCE,
		);
		expect(fixture.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: "intent-db-1", eventSeq: 3 }),
				data: expect.objectContaining({ eventSeq: { increment: 1 } }),
			}),
		);
		const event = (
			fixture.eventCreate.mock.calls[1] as [
				{
					data: Record<string, unknown> & { details: Record<string, unknown> };
				},
			]
		)[0].data;
		expect(event).toMatchObject({
			sequence: 4,
			eventType: "TERMINAL_READBACK",
			fromState: "AMBIGUOUS",
			toState: "TERMINAL",
			details: {
				localId: "job-1",
				providerIds: ["enc-1"],
				candidateCount: 1,
				closureDigest: "d".repeat(64),
			},
		});
		expect(event.details).not.toHaveProperty("readback");
		expect(event.details).not.toHaveProperty("candidates");
	});

	it("fails the transaction when the event-sequence CAS loses", async () => {
		const fixture = adapterFixture(0);
		await expect(
			fixture.store.update(
				"intent-db-1",
				{
					eventType: "ADOPTED",
					state: "CONFIRMED",
					localId: "job-loser",
				},
				undefined,
				PRODUCER_FENCE,
			),
		).rejects.toThrow(/changed concurrently/);
		expect(fixture.eventCreate).not.toHaveBeenCalled();
	});

	it("fences an ordinary in-process writer while a restart recovery lease is live", async () => {
		const fixture = adapterFixture();
		await fixture.store.update(
			"intent-db-1",
			{
				eventType: "RESPONSE_CONFIRMED",
				state: "CONFIRMED",
				localId: "job-original-process",
			},
			undefined,
			PRODUCER_FENCE,
		);
		expect(fixture.updateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					OR: [
						{ recoveryLeaseUntil: null },
						{ recoveryLeaseUntil: { lte: expect.any(Date) } },
					],
				}),
			}),
		);
	});

	it("refuses PREPARED atomically when the parent RUNNING generation lock is lost", async () => {
		const fixture = adapterFixture(1, []);
		await expect(
			fixture.store.create(
				{ verificationRunId: "run-db-1", ...PREPARE },
				PRODUCER_FENCE,
			),
		).rejects.toThrow(/producer fence changed/);
		expect(fixture.intentCreate).not.toHaveBeenCalled();
		expect(fixture.eventCreate).not.toHaveBeenCalled();
	});

	it("never regresses a TERMINAL intent to SUBMITTED", async () => {
		const fixture = adapterFixture();
		fixture.findUniqueOrThrow.mockResolvedValueOnce({
			eventSeq: 9,
			state: "TERMINAL",
		});
		await expect(
			fixture.store.update(
				"intent-db-1",
				{ eventType: "SUBMITTED", state: "SUBMITTED" },
				undefined,
				PRODUCER_FENCE,
			),
		).rejects.toThrow(/TERMINAL.*regress/i);
		expect(fixture.updateMany).not.toHaveBeenCalled();
	});

	it("claims recovery with generation+event CAS and fences subsequent writes", async () => {
		const fixture = adapterFixture();
		fixture.findUniqueOrThrow.mockResolvedValueOnce({
			eventSeq: 5,
			state: "SUBMITTED",
			recoveryOwner: "dead-owner",
			recoveryLeaseUntil: new Date("2026-08-31T00:00:00Z"),
			recoveryGeneration: 8,
		});
		const claim = await fixture.store.claimForRecovery("intent-db-1", {
			owner: "restart-owner",
			now: new Date("2026-08-31T01:00:00Z"),
			leaseMs: 60_000,
		});
		expect(claim).toEqual({
			owner: "restart-owner",
			generation: 9,
			leaseUntil: new Date("2026-08-31T01:01:00Z"),
		});
		expect(fixture.updateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					eventSeq: 5,
					recoveryGeneration: 8,
				}),
				data: expect.objectContaining({
					recoveryGeneration: { increment: 1 },
					eventSeq: { increment: 1 },
				}),
			}),
		);
		expect(fixture.eventCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					sequence: 6,
					eventType: "RECOVERY_CLAIMED",
				}),
			}),
		);

		fixture.findUniqueOrThrow.mockResolvedValueOnce({
			eventSeq: 6,
			state: "SUBMITTED",
		});
		await fixture.store.update(
			"intent-db-1",
			{ eventType: "ADOPTED", state: "CONFIRMED", localId: "job-1" },
			claim ?? undefined,
		);
		expect(fixture.updateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					recoveryOwner: "restart-owner",
					recoveryGeneration: 9,
					recoveryLeaseUntil: { gt: expect.any(Date) },
				}),
			}),
		);
	});

	it("reads dossiers in a stable createdAt+id total order", async () => {
		let seen: unknown;
		const prisma = {
			verificationResourceIntent: {
				findMany: async (args: { orderBy: unknown }) => {
					seen = args.orderBy;
					return [];
				},
			},
		} as unknown as AppPrismaClient;
		await prismaIntentStore(prisma).listForRun("run-db-1");
		expect(seen).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
	});
});
