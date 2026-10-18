import type { StepLogEntry } from "@bitovp/core";
import type { SdkOps } from "../orchestrator/sdk-ops";

export type ResetEncodingJournal = (
	entityKey: string,
	encodingId: string,
	accountId: string,
) => Promise<boolean>;

export type ResetOwnerState = {
	entityKey: string;
	ownerToken: string | null;
	entries: StepLogEntry[];
	sdk?: SdkOps;
	accountId?: string;
};

export async function finishResetOwner(
	deps: {
		journalResetEncoding?: ResetEncodingJournal;
		acknowledgeResetEntity?: (
			entityKey: string,
			ownerToken: string | null,
		) => Promise<void>;
	},
	state: ResetOwnerState,
	isDeleted: () => Promise<boolean>,
) {
	if (!state.ownerToken || !deps.acknowledgeResetEntity || !(await isDeleted()))
		return;
	if (state.sdk && state.accountId)
		await journalLostEncodings(
			deps.journalResetEncoding,
			state.entityKey,
			state.accountId,
			state.entries,
			state.sdk,
		);
	await deps.acknowledgeResetEntity(state.entityKey, state.ownerToken);
}

/** Lease loss alone never authorizes STOP. A durable reset tombstone does. */
export async function journalLostEncodings(
	journal: ResetEncodingJournal | undefined,
	entityKey: string,
	accountId: string,
	entries: StepLogEntry[],
	sdk: SdkOps,
): Promise<void> {
	if (!journal) return;
	const ids = new Set(
		entries
			.filter((entry) => entry.kind === "CREATE_ENCODING")
			.map((entry) => entry.resourceId)
			.filter((id): id is string => Boolean(id)),
	);
	for (const id of ids) {
		if (!(await journal(entityKey, id, accountId))) continue;
		// The receipt owns retries/readback even when this best-effort STOP fails.
		try {
			if (
				entityKey.startsWith("liveChannel") ||
				entityKey.startsWith("liveEffectClaim:")
			)
				await sdk.stopLiveEncoding(id);
			else await sdk.stopEncoding(id);
		} catch {
			/* durable cleanup retries */
		}
	}
}
