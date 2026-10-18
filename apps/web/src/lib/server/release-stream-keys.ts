/**
 * Release the TEMPORARY stream keys of encodings the reset just wiped
 * .
 *
 * Measured during the MSL runs: `streamKeyConfiguration: GENERATE` mints one
 * TEMPORARY StreamKey per provision, and it stays ASSIGNED after the channel
 * stops — two accumulated in a single night. Releasing on STOP is deliberately
 * NOT the design: `restartLiveEncoding` reuses the encoding, and a STOPPED
 * channel row is a restartable one, so its key must survive. The reset is the
 * moment restart becomes impossible — the rows are gone — which makes it the
 * one safe release point.
 *
 * DELETE, not unassign (the row left this open; deciding): these keys are
 * auto-minted per encoding and meaningless once the encoding's local record is
 * gone, and an UNASSIGNED temporary key is still clutter. RESERVED keys — the
 * ones an operator created on purpose — are never touched: the list is
 * filtered to TEMPORARY at the API, and matched against exactly the encoding
 * ids the reset recorded inside its transaction. Another install sharing the
 * account keeps its keys, because its encodings are not in our recorded set.
 *
 * BEST-EFFORT BY CONTRACT. The reset's own promise is a local wipe that works
 * offline; this runs AFTER the commit and must never turn a completed reset
 * into an error. Every failure is counted and reported, none is thrown.
 */
export type StreamKeyClient = {
	list: (query: {
		type: "TEMPORARY";
		offset: number;
		limit: number;
	}) => Promise<{
		items?: { id?: string; assignedEncodingId?: string }[];
		totalCount?: number;
	}>;
	delete: (streamKeyId: string) => Promise<unknown>;
};

export type ReleaseReport = {
	released: number;
	failed: number;
	/** Pointers with no account recorded — nothing can be released for them. */
	skippedNoAccount: number;
	/** Accounts whose client could not be built or whose listing failed. */
	accountErrors: number;
};

export async function releaseTemporaryStreamKeys(
	pointers: readonly {
		bitmovinEncodingId: string;
		bitmovinAccountId: string | null;
	}[],
	clientFor: (accountId: string) => Promise<StreamKeyClient | null>,
	log: (line: string) => void = () => {},
): Promise<ReleaseReport> {
	const report: ReleaseReport = {
		released: 0,
		failed: 0,
		skippedNoAccount: 0,
		accountErrors: 0,
	};
	const byAccount = new Map<string, Set<string>>();
	for (const p of pointers) {
		if (!p.bitmovinAccountId) {
			report.skippedNoAccount += 1;
			continue;
		}
		const set = byAccount.get(p.bitmovinAccountId) ?? new Set<string>();
		set.add(p.bitmovinEncodingId);
		byAccount.set(p.bitmovinAccountId, set);
	}

	for (const [accountId, encodingIds] of byAccount) {
		try {
			const client = await clientFor(accountId);
			if (!client) {
				report.accountErrors += 1;
				log(`[reset] stream-key release: account ${accountId} not found`);
				continue;
			}
			// C6: page through, never assume one page.
			const LIMIT = 100;
			let offset = 0;
			for (;;) {
				const page = await client.list({
					type: "TEMPORARY",
					offset,
					limit: LIMIT,
				});
				const items = page.items ?? [];
				for (const key of items) {
					if (
						!key.id ||
						!key.assignedEncodingId ||
						!encodingIds.has(key.assignedEncodingId)
					) {
						continue;
					}
					try {
						await client.delete(key.id);
						report.released += 1;
					} catch (err) {
						report.failed += 1;
						log(
							`[reset] stream-key release: delete ${key.id} failed: ${
								err instanceof Error ? err.message : String(err)
							}`,
						);
					}
				}
				offset += items.length;
				if (items.length < LIMIT || offset >= (page.totalCount ?? offset)) {
					break;
				}
			}
		} catch (err) {
			// A listing failure loses this ACCOUNT's cleanup, not the reset and
			// not the other accounts' cleanup.
			report.accountErrors += 1;
			log(
				`[reset] stream-key release: account ${accountId} listing failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}
	return report;
}
