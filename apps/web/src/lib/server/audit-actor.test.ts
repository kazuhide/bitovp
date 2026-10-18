import { describe, expect, it, vi } from "vitest";

/**
 * : attribution must be a MECHANISM, not a comment.
 *
 * Measured 2026-08-15: the QC-override route wrote its audit row with an
 * empty `actor` while its own comment said "actor rides the shared audit
 * pipeline". It did not — `writeAuditLog` forwarded the entry untouched and
 * nothing read ACTOR_HEADER, which the proxy sets on every authenticated
 * request after stripping any client copy.
 *
 * The first fix threaded the request into the six routes that call
 * `writeAuditLog` directly and guarded them with a source scan over
 * `app/api/**\/route.ts`. Security-review-212 then measured what that scan
 * could not see: 34 FURTHER route files write audit rows through
 * `auditedBitmovinCall` and `delete*JobLocally`, and all of them still
 * persisted `actor = NULL` — every mutating Bitmovin call and every job
 * delete among them — while the ledger row had just been closed as "every
 * route that audits passes it". The scan reported them clean because it
 * matched the identifier `req` inside route files, and those files never
 * name `writeAuditLog` at all.
 *
 * So the guard is gone and the TYPE is the guard: `req` is required on
 * `writeAuditLog`, on `auditedBitmovinCall`'s options and on both
 * `delete*JobLocally` options. `tsc` enumerates the population across file
 * boundaries — it found all 33 remaining route files by itself — and it
 * cannot be defeated by a rename, a reformat, or by moving the call into a
 * helper, all three of which defeated the scan. What remains here is the
 * behaviour the type cannot express: which value wins.
 */

describe("audit actor attribution (ledger #81)", () => {
	async function withMockedDb<T>(
		fn: (
			writeAuditLog: typeof import("./audit").writeAuditLog,
			write: ReturnType<typeof vi.fn>,
		) => Promise<T>,
	): Promise<T> {
		const write = vi.fn(async (_prisma: unknown, _entry: unknown) => {});
		vi.doMock("@bitovp/db", () => ({ writeAuditLog: write }));
		vi.resetModules();
		try {
			const { writeAuditLog } = await import("./audit");
			return await fn(writeAuditLog, write);
		} finally {
			vi.doUnmock("@bitovp/db");
			vi.resetModules();
		}
	}

	const ctx = { prisma: {} } as never;
	const reqWithActor = new Request("https://x/api/thing", {
		headers: { "x-bitovp-actor": "token:abc" },
	});

	it("attaches the proxy-verified actor from the request header", async () => {
		await withMockedDb(async (writeAuditLog, write) => {
			await writeAuditLog(
				ctx,
				{ method: "POST", path: "/api/thing" },
				reqWithActor,
			);
			expect(write).toHaveBeenCalledTimes(1);
			expect(write.mock.calls[0]?.[1]).toMatchObject({ actor: "token:abc" });
		});
	});

	it("lets an explicit entry.actor win, for routes that resolve a finer identity", async () => {
		await withMockedDb(async (writeAuditLog, write) => {
			await writeAuditLog(
				ctx,
				{ method: "POST", path: "/api/thing", actor: "session:owner" },
				reqWithActor,
			);
			expect(write).toHaveBeenCalledTimes(1);
			expect(write.mock.calls[0]?.[1]).toMatchObject({
				actor: "session:owner",
			});
		});
	});

	it("names the actor as NULL when the header is absent — rather than inventing one", async () => {
		await withMockedDb(async (writeAuditLog, write) => {
			// A request that reached a handler without the proxy's header is a
			// path that should not exist; the row must say nothing rather than
			// claim an identity. The wrapper says so EXPLICITLY as `null` and
			// the db writer omits the column for null — the requirement lives
			// at the db boundary so a new consumer of the exported writer
			// cannot default to NULL and compile clean (security-review-212).
			// `toHaveBeenCalledTimes` first, because `mock.calls[0]?.[1]` on a
			// call that never happened is `undefined`, and `undefined`
			// satisfies a negative assertion vacuously.
			await writeAuditLog(
				ctx,
				{ method: "POST", path: "/api/thing" },
				new Request("https://x/api/thing"),
			);
			expect(write).toHaveBeenCalledTimes(1);
			expect(write.mock.calls[0]?.[1]).toMatchObject({ actor: null });
		});
	});
});
