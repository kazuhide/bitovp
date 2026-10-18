import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
 * A real OS-process fault at the dangerous boundary: SUBMITTED is durable,
 * then the process dies before any response id is retained. Recovery starts in
 * a different process lifetime and is allowed to use only the durable key/SHA.
 */
describe("EV-01 process-death recovery", () => {
	it("SIGKILL after SUBMITTED is recovered by key+SHA, leased, and idempotently sealed", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bitovp-intent-kill-"));
		const ledgerPath = join(dir, "intent.json");
		const tsxCli = fileURLToPath(
			new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url),
		);
		const fixture = fileURLToPath(
			new URL(
				"./test-fixtures/resource-intent-submitted-child.ts",
				import.meta.url,
			),
		);
		const child = spawn(process.execPath, [tsxCli, fixture, ledgerPath], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		try {
			let stdout = "";
			for await (const chunk of child.stdout) {
				stdout += String(chunk);
				if (stdout.includes("SUBMITTED_DURABLE")) break;
			}
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
					row.recoveryLeaseUntil = new Date(
						input.now.getTime() + input.leaseMs,
					);
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
		} finally {
			if (child.exitCode === null && child.signalCode === null)
				child.kill("SIGKILL");
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.each([
		["VOD_JOB", "job-created", "job-wrong", "job-late"],
		["LIVE_CHANNEL", "channel-created", "channel-wrong", "channel-late"],
	] as const)("SIGKILL after durable %s response-id capture + wrong adoption recovers and cleans the complete union", async (kind, createdId, wrongId, lateId) => {
		const dir = await mkdtemp(join(tmpdir(), "bitovp-intent-mismatch-kill-"));
		const ledgerPath = join(dir, "intent.json");
		const tsxCli = fileURLToPath(
			new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url),
		);
		const fixture = fileURLToPath(
			new URL(
				"./test-fixtures/resource-intent-mismatch-child.ts",
				import.meta.url,
			),
		);
		const child = spawn(process.execPath, [tsxCli, fixture, ledgerPath, kind], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		try {
			let stdout = "";
			for await (const chunk of child.stdout) {
				stdout += String(chunk);
				if (stdout.includes("CAPTURE_AND_WRONG_ADOPTION_DURABLE")) break;
			}
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
					row.recoveryLeaseUntil = new Date(
						input.now.getTime() + input.leaseMs,
					);
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
		} finally {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
			}
			await rm(dir, { recursive: true, force: true });
		}
	});
});
