import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import {
	createIntentLedger,
	type IntentRow,
	type IntentStore,
	type IntentUpdate,
	verificationLocalResourceKey,
	verificationProviderEncodingKey,
} from "./resource-intent";

const SHA = "a".repeat(64);

/**
 * Starts a fixture as the very process the test kills. `--import tsx` loads
 * TypeScript inside that process. tsx's own command line runs the script in a
 * second process, which a SIGKILL sent to the first never reaches: the fixture
 * would outlive the test, and the process that died would not be the one that
 * had made the row durable.
 */
function spawnFixture(name: string, args: string[]) {
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			fileURLToPath(new URL(`./test-fixtures/${name}`, import.meta.url)),
			...args,
		],
		{
			// `tsx` resolves from the worker package wherever the suite is started.
			cwd: fileURLToPath(new URL("../..", import.meta.url)),
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	// A fixture never ends by itself. vitest runs this however the test ends,
	// also after a timeout during the wait for the marker, where a `finally`
	// in the test would not run.
	onTestFinished(() => {
		if (child.exitCode === null && child.signalCode === null)
			child.kill("SIGKILL");
	});
	return child;
}

/** A directory for one test, removed when the test has ended. */
async function temporaryDirectory(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

/**
 * Waits for the fixture's marker line and returns the process id on it: the
 * process that made the state durable. A process of that id which is not the
 * one started here is ended first.
 */
async function durableProcessId(
	child: ReturnType<typeof spawnFixture>,
	marker: string,
): Promise<number> {
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	const line = new RegExp(`${marker} (\\d+)\\n`);
	let stdout = "";
	for await (const chunk of child.stdout) {
		stdout += String(chunk);
		const match = line.exec(stdout);
		if (!match) continue;
		const pid = Number(match[1]);
		if (pid !== child.pid) {
			// The fixture runs in another process than the one started here, and
			// the test is about to fail on that. Nothing else would end it.
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// It has ended already, or it is no process that this test may
				// end.
			}
		}
		return pid;
	}
	throw new Error(`The fixture ended before ${marker}: ${stderr}`);
}

/**
 * A real OS-process fault at the dangerous boundary: SUBMITTED is durable,
 * then the process dies before any response id is retained. Recovery starts in
 * a different process lifetime and is allowed to use only the durable key/SHA.
 */
describe("EV-01 process-death recovery", () => {
	it("SIGKILL after SUBMITTED is recovered by key+SHA, leased, and idempotently sealed", async () => {
		const dir = await temporaryDirectory("bitovp-intent-kill-");
		const ledgerPath = join(dir, "intent.json");
		const child = spawnFixture("resource-intent-submitted-child.ts", [
			ledgerPath,
		]);
		expect(await durableProcessId(child, "SUBMITTED_DURABLE")).toBe(child.pid);
		const exited = once(child, "exit");
		expect(child.kill("SIGKILL")).toBe(true);
		const [code, signal] = (await exited) as [
			number | null,
			NodeJS.Signals | null,
		];
		expect(code).toBeNull();
		expect(signal).toBe("SIGKILL");

		const row = JSON.parse(await readFile(ledgerPath, "utf8")) as IntentRow;
		row.recoveryLeaseUntil = row.recoveryLeaseUntil
			? new Date(row.recoveryLeaseUntil)
			: null;
		expect(row).toMatchObject({
			id: "intent-before-kill",
			state: "SUBMITTED",
			cleanupState: "PENDING",
			verificationKey: "verify:restart:kill-window:VOD_JOB",
			requestSha256: SHA,
		});
		expect(row.recoveryOwner).toMatch(/^verify-dispatch:/);
		const recoveryAt = (row.recoveryLeaseUntil?.getTime() ?? 0) + 1;
		const updates: IntentUpdate[] = [];
		const store: IntentStore = {
			create: async () => {
				throw new Error("recovery must never create");
			},
			claimForRecovery: async (_id, input) => {
				if (
					row.recoveryOwner !== input.owner &&
					row.recoveryLeaseUntil !== null &&
					row.recoveryLeaseUntil > input.now
				) {
					return null;
				}
				row.recoveryOwner = input.owner;
				row.recoveryGeneration += 1;
				row.recoveryLeaseUntil = new Date(input.now.getTime() + input.leaseMs);
				return {
					owner: input.owner,
					generation: row.recoveryGeneration,
					leaseUntil: row.recoveryLeaseUntil,
				};
			},
			update: async (_id, data, claim) => {
				if (
					!claim ||
					claim.owner !== row.recoveryOwner ||
					claim.generation !== row.recoveryGeneration
				) {
					throw new Error("missing/stale recovery fence");
				}
				updates.push(data);
				Object.assign(row, data);
				if (data.providerIds) row.providerIds = [...data.providerIds];
				if (data.candidates) row.candidates = [...data.candidates];
				if (data.possiblyCreatedKeys)
					row.possiblyCreatedKeys = [...data.possiblyCreatedKeys];
				if (data.cleanedResourceKeys)
					row.cleanedResourceKeys = [...data.cleanedResourceKeys];
				if (data.state === "TERMINAL" || data.releaseLease) {
					row.recoveryOwner = null;
					row.recoveryLeaseUntil = null;
				}
				return row;
			},
			listForRun: async () => [{ ...row }],
			findLocal: async () => [
				{
					localId: "job-recovered",
					matchedBy: ["key"],
					status: "CANCELED",
					providerId: "enc-recovered",
					requestSha256: SHA,
				},
			],
		};
		const recovery = createIntentLedger(store, {
			verificationRunId: "run-after-kill",
			recoveryOwner: "restart-process",
			now: () => recoveryAt,
			sleep: async () => {},
		});
		let resolverCalls = 0;
		const resolvers = {
			VOD_JOB: async () => {
				resolverCalls += 1;
				return {
					terminal: true,
					readback: {
						local: { id: "job-recovered", status: "CANCELED" },
						provider: [{ id: "enc-recovered", status: "CANCELED" }],
					},
					providerIds: ["enc-recovered"],
					possiblyCreatedKeys: [
						verificationLocalResourceKey("VOD_JOB", "job-recovered"),
						verificationProviderEncodingKey("enc-recovered"),
					],
					cleanedResourceKeys: [
						verificationLocalResourceKey("VOD_JOB", "job-recovered"),
						verificationProviderEncodingKey("enc-recovered"),
					],
				};
			},
			LIVE_CHANNEL: async () => {
				throw new Error("wrong resolver");
			},
		};
		const first = await recovery.teardown(resolvers);
		expect(first.sealable).toBe(true);
		expect(resolverCalls).toBe(1);
		expect(updates.map((update) => update.eventType)).toEqual([
			"RECONCILIATION_SET_CAPTURED",
			"TERMINAL_READBACK",
		]);
		const second = await recovery.teardown(resolvers);
		expect(second.sealable).toBe(true);
		expect(resolverCalls).toBe(1);
	});

	it.each([
		["VOD_JOB", "job-created", "job-wrong", "job-late"],
		["LIVE_CHANNEL", "channel-created", "channel-wrong", "channel-late"],
	] as const)("SIGKILL after durable %s response-id capture + wrong adoption recovers and cleans the complete union", async (kind, createdId, wrongId, lateId) => {
		const dir = await temporaryDirectory("bitovp-intent-mismatch-kill-");
		const ledgerPath = join(dir, "intent.json");
		const child = spawnFixture("resource-intent-mismatch-child.ts", [
			ledgerPath,
			kind,
		]);
		expect(
			await durableProcessId(child, "CAPTURE_AND_WRONG_ADOPTION_DURABLE"),
		).toBe(child.pid);
		const exited = once(child, "exit");
		expect(child.kill("SIGKILL")).toBe(true);
		const [code, signal] = (await exited) as [
			number | null,
			NodeJS.Signals | null,
		];
		expect(code).toBeNull();
		expect(signal).toBe("SIGKILL");

		const row = JSON.parse(await readFile(ledgerPath, "utf8")) as IntentRow;
		expect(row).toMatchObject({
			kind,
			state: "CONFIRMED",
			localId: wrongId,
			possiblyCreatedKeys: [
				verificationLocalResourceKey(kind, createdId),
				verificationLocalResourceKey(kind, wrongId),
			],
		});
		const eventTypes = row.events?.map((event) => event.eventType) ?? [];
		expect(eventTypes.indexOf("CREATE_RESPONSE_ID_CAPTURED")).toBeLessThan(
			eventTypes.indexOf("ADOPTED"),
		);

		const store: IntentStore = {
			create: async () => {
				throw new Error("recovery must never create");
			},
			claimForRecovery: async (_id, input) => {
				row.recoveryOwner = input.owner;
				row.recoveryGeneration += 1;
				row.recoveryLeaseUntil = new Date(input.now.getTime() + input.leaseMs);
				return {
					owner: input.owner,
					generation: row.recoveryGeneration,
					leaseUntil: row.recoveryLeaseUntil,
				};
			},
			update: async (_id, data, claim) => {
				if (
					!claim ||
					claim.owner !== row.recoveryOwner ||
					claim.generation !== row.recoveryGeneration
				) {
					throw new Error("missing/stale recovery fence");
				}
				Object.assign(row, data);
				if (data.providerIds) row.providerIds = [...data.providerIds];
				if (data.candidates) row.candidates = [...data.candidates];
				if (data.possiblyCreatedKeys) {
					row.possiblyCreatedKeys = [...data.possiblyCreatedKeys];
				}
				if (data.cleanedResourceKeys) {
					row.cleanedResourceKeys = [...data.cleanedResourceKeys];
				}
				if (data.state === "TERMINAL") {
					row.recoveryOwner = null;
					row.recoveryLeaseUntil = null;
				}
				return row;
			},
			listForRun: async () => [{ ...row }],
			findLocal: async () =>
				[createdId, wrongId, lateId].map((localId) => ({
					localId,
					matchedBy: ["key"] as const,
					status: "CANCELED",
					providerId: null,
					requestSha256: SHA,
				})),
		};
		const recovery = createIntentLedger(store, {
			verificationRunId: "run-after-mismatch-kill",
			recoveryOwner: "restart-process",
			now: () => 1_760_000_000_000,
			sleep: async () => {},
		});
		const driven: string[] = [];
		const resolveOne = async (resolved: IntentRow & { localId: string }) => {
			driven.push(resolved.localId);
			const localKey = verificationLocalResourceKey(kind, resolved.localId);
			return {
				terminal: true,
				readback: { localId: resolved.localId, status: "CANCELED" },
				possiblyCreatedKeys: [localKey],
				cleanedResourceKeys: [localKey],
			};
		};

		const verdict = await recovery.teardown({
			VOD_JOB: resolveOne,
			LIVE_CHANNEL: resolveOne,
		});
		const expectedKeys = [createdId, wrongId, lateId]
			.map((localId) => verificationLocalResourceKey(kind, localId))
			.sort();
		expect(driven.sort()).toEqual([createdId, wrongId, lateId].sort());
		expect(verdict.sealable).toBe(true);
		expect(verdict.dossier[0]).toMatchObject({
			cleanupState: "CLEANED",
			possiblyCreatedKeys: expectedKeys,
			cleanedResourceKeys: expectedKeys,
		});
	});
});
