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
const kindArg = process.argv[3];
if (!ledgerPathArg) throw new Error("ledger path argument is required");
if (kindArg !== "VOD_JOB" && kindArg !== "LIVE_CHANNEL") {
	throw new Error("kind must be VOD_JOB or LIVE_CHANNEL");
}

const ledgerPath = ledgerPathArg;
const kind = kindArg;
const sha = "a".repeat(64);
const createdId = kind === "VOD_JOB" ? "job-created" : "channel-created";
const wrongId = kind === "VOD_JOB" ? "job-wrong" : "channel-wrong";
let row: IntentRow | undefined;
let sequence = 0;

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
			id: "intent-before-mismatch-kill",
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
			events: [],
		};
		persist();
		return { id: row.id };
	},
	update: async (_id, data) => {
		if (!row) throw new Error("intent row does not exist");
		const fromState = row.state;
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
		sequence += 1;
		row.events?.push({
			sequence,
			eventType: data.eventType ?? "UPDATED",
			fromState,
			toState: data.state ?? fromState,
			cleanupState: data.cleanupState ?? row.cleanupState,
			details: {
				...(data.localId ? { localId: data.localId } : {}),
				...(data.possiblyCreatedKeys
					? { possiblyCreatedKeys: [...data.possiblyCreatedKeys] }
					: {}),
			},
			createdAt: new Date(),
		});
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
	findLocal: async () => [
		{
			localId: wrongId,
			matchedBy: ["key"],
			status: "RUNNING",
			providerId: null,
			requestSha256: sha,
		},
	],
};

const ledger = createIntentLedger(store, {
	verificationRunId: "run-before-mismatch-kill",
	producerRecoveryGeneration: 0,
});
const intent = await ledger.prepare({
	scenario: "mismatch-kill-window",
	kind,
	verificationKey: `verify:restart:mismatch-kill-window:${kind}`,
	requestSha256: sha,
	resourceName: `mismatch-kill-window ${kind}`,
});
await intent.submitted();
await intent.recordCreateResponseId(createdId);
const adoption = await intent.resolve();
if (!adoption.adopted || adoption.localId !== wrongId) {
	throw new Error("fixture did not persist the wrong exact-key adoption");
}
process.stdout.write("CAPTURE_AND_WRONG_ADOPTION_DURABLE\n");
setInterval(() => {}, 1_000);
