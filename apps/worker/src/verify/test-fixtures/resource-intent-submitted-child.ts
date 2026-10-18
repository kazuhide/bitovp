import {
	closeSync,
	fsyncSync,
	openSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import {
	createIntentLedger,
	type IntentRow,
	type IntentStore,
} from "../resource-intent";

const ledgerPathArg = process.argv[2];
if (!ledgerPathArg) {
	throw new Error("ledger path argument is required");
}
const ledgerPath = ledgerPathArg;

let row: IntentRow | undefined;

/**
 * File-backed stand-in for the durable database boundary. Each transition is
 * fsync'd before it resolves, so the parent may SIGKILL immediately after the
 * production ledger reports SUBMITTED and still recover the exact row.
 */
function persist(): void {
	if (!row) throw new Error("intent row does not exist");
	const next = `${ledgerPath}.next`;
	const fd = openSync(next, "w", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(row)}\n`, "utf8");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(next, ledgerPath);
}

const store: IntentStore = {
	create: async (data) => {
		row = {
			id: "intent-before-kill",
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
		};
		persist();
		return { id: "intent-before-kill" };
	},
	update: async (_id, data) => {
		if (!row) throw new Error("intent row does not exist");
		const { dispatchLease, releaseLease, ...persisted } = data;
		Object.assign(row, persisted);
		if (dispatchLease) {
			row.recoveryGeneration += 1;
			row.recoveryOwner = dispatchLease.owner;
			row.recoveryLeaseUntil = new Date(
				dispatchLease.now.getTime() + dispatchLease.leaseMs,
			);
		}
		if (data.providerIds) row.providerIds = [...data.providerIds];
		if (data.candidates) row.candidates = [...data.candidates];
		if (data.possiblyCreatedKeys) {
			row.possiblyCreatedKeys = [...data.possiblyCreatedKeys];
		}
		if (data.cleanedResourceKeys) {
			row.cleanedResourceKeys = [...data.cleanedResourceKeys];
		}
		if (data.state === "TERMINAL" || releaseLease) {
			row.recoveryOwner = null;
			row.recoveryLeaseUntil = null;
		}
		persist();
		return dispatchLease && row.recoveryLeaseUntil
			? {
					claim: {
						owner: dispatchLease.owner,
						generation: row.recoveryGeneration,
						leaseUntil: row.recoveryLeaseUntil,
					},
				}
			: row;
	},
	claimForRecovery: async () => {
		throw new Error("child must not start recovery");
	},
	listForRun: async () => (row ? [row] : []),
	findLocal: async () => [],
};

const ledger = createIntentLedger(store, {
	verificationRunId: "run-before-kill",
	producerRecoveryGeneration: 0,
});
const intent = await ledger.prepare({
	scenario: "kill-window",
	kind: "VOD_JOB",
	verificationKey: "verify:restart:kill-window:VOD_JOB",
	requestSha256: "a".repeat(64),
	resourceName: "kill-window [verify restart]",
});
await intent.submitted();
process.stdout.write("SUBMITTED_DURABLE\n");
setInterval(() => {}, 1_000);
