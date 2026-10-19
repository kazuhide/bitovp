import { loadEnv } from "@bitovp/core";
import { Prisma, PrismaClient } from "../generated/client";
import {
	setStatementTimeout,
	transactionSettings,
} from "./transaction-settings";

/**
 * The generated Prisma client's handles, pinned to ONE module instance per
 * process — the first copy of this file to evaluate wins and every later copy
 * borrows from it.
 *
 * This is not hot-reload hygiene; it closes a measured silent-wrong-query hole.
 * `next build` (Turbopack) compiles `@bitovp/db` — and with it the generated
 * client's `runtime/library.js` — separately into EACH server layer, so one
 * node process holds three independent copies of the sentinel classes
 * (measured on this tree: `objectEnumValues` is defined in three
 * `.next/server` chunks — the react-server layer, the ssr layer, and
 * `[root-of-the-server]`). The runtime compares a sentinel by IDENTITY:
 *
 *     if (e instanceof ObjectEnumValue) {
 *       if (e !== objectEnumValues.instances[e._getName]) throw …
 *
 * A `DbNull` from a different copy is not `instanceof` the constructing copy's
 * base class at all, so it never reaches that throw — it falls through to the
 * generic-object branch and serializes as a plain `{}`, turning
 * `where: { liveToVod: { equals: DB_NULL } }` into a comparison against an
 * empty JSON object that no SQL-NULL row satisfies. On the 2026-08-29 billed
 * re-audit that made the live-to-VOD `updateMany` match ZERO rows on a column
 * that really was SQL NULL, with no error anywhere. The same shape sits on the
 * QC evidence export's `gateVerdict: { not: DB_NULL }`.
 *
 * Externalizing the package out of the bundle is the structural cure and it is
 * NOT available here: `serverExternalPackages` only takes effect for a package
 * whose resolved path is inside `node_modules`, so listing `@bitovp/db` — or a
 * dedicated workspace package holding the generated client, both measured — is
 * a SILENT no-op: three chunks either way, no shim under `.next/node_modules`,
 * no warning. The one layout Turbopack does accept is Prisma's DEFAULT output —
 * `@prisma/client`, which is already on Next's built-in externals list — and
 * that writes the generated client into the shared pnpm store, where
 * `scripts/review-worktree.sh` links `.pnpm` as a WHOLE-DIRECTORY symlink into
 * MAIN and then runs `prisma generate`: every review worktree would overwrite
 * the owner's client with its own branch's schema. (It does survive
 * `pnpm install --frozen-lockfile` — measured, after a first reading of this
 * same experiment claimed the opposite.) So the identity is pinned here
 * instead, where it also holds in dev and in the worker.
 */
type PrismaModule = {
	readonly PrismaClient: typeof PrismaClient;
	readonly Prisma: typeof Prisma;
};

const globalForPrisma = globalThis as unknown as {
	prisma?: AppPrismaClient;
	prismaModule?: PrismaModule;
};

const prismaModule: PrismaModule = globalForPrisma.prismaModule ?? {
	PrismaClient,
	Prisma,
};
globalForPrisma.prismaModule = prismaModule;

/**
 * JSON-column null sentinels. Prisma cannot express `where: { jsonCol: null }`
 * with a plain null (that means "ignore the filter"), so a query matching a
 * SQL-NULL Json column needs `Prisma.DbNull`. Exported as bare values —
 * NOT the `Prisma` namespace and NOT the client class — so the deliberate
 * boundary above (clients only via createPrismaClient/getPrisma, ciphertext
 * omitted) stays intact.
 *
 * Read off `prismaModule`, never off the local import: the local one is this
 * copy's sentinel, and the client that receives it may belong to another.
 */
export const DB_NULL = prismaModule.Prisma.DbNull;

/**
 * Ciphertext columns, kept out of every raw delegate read.
 *
 * Constructor-level: `findMany`/`include`/… never carry these, even outside the
 * store layer, so a route that returns a Prisma row straight to the browser
 * cannot leak one by omission. `bitmovin-accounts.list` does exactly that —
 * `findMany` with no `select`, returned by `GET /api/bitmovin-accounts` — and
 * it is safe ONLY because of this. The stores' reveal methods still work: an
 * explicit `select` on the column overrides the global omit.
 *
 * EXPORTED so it can be pinned, and it needed to be. Deleting this block used
 * to break nothing: the db suite's 43 tests use `fakeTable(["encryptedApiKey"])`
 * — a fake that strips the column ITSELF — so they were testing an imitation of
 * this mechanism rather than the mechanism (measured 2026-08-21 by removing it
 * and running the whole suite green). `client.test.ts` now derives the expected
 * entries from schema.prisma, so a NEW encrypted column added without a line
 * here fails immediately, which is the case that actually threatens us.
 */
export const CIPHERTEXT_OMIT = {
	credential: { encryptedSecret: true },
	vmafComputeCredential: { encryptedSecret: true },
	bitmovinAccount: { encryptedApiKey: true },
	resetCleanupTask: { encryptedPayload: true },
} as const;

/**
 * The ONLY construction site for a PrismaClient in this repo, and it builds
 * from the shared handle — so the client and the `DB_NULL` any caller hands it
 * always come from the same copy of the generated runtime.
 */
function constructPrismaClient(databaseUrl?: string) {
	return new prismaModule.PrismaClient({
		...(databaseUrl ? { datasourceUrl: databaseUrl } : {}),
		omit: CIPHERTEXT_OMIT,
	});
}

type RawPrismaClient = ReturnType<typeof constructPrismaClient>;
type UniqueMethods =
	| "findUnique"
	| "findUniqueOrThrow"
	| "update"
	| "delete"
	| "upsert";
type LogicalArgs<A extends { where: unknown }, W> = Omit<A, "where"> & {
	where: A["where"] | W;
};
type SettingUnique = Prisma.AppSettingWhereInput & { key: string };
type ProfileUnique = Prisma.VmafExecutionProfileWhereInput & { id: string };
type SettingDelegate = Omit<RawPrismaClient["appSetting"], UniqueMethods> & {
	findUnique<
		T extends LogicalArgs<Prisma.AppSettingFindUniqueArgs, SettingUnique>,
	>(args: T): Prisma.PrismaPromise<Prisma.AppSettingGetPayload<T> | null>;
	findUniqueOrThrow<
		T extends LogicalArgs<
			Prisma.AppSettingFindUniqueOrThrowArgs,
			SettingUnique
		>,
	>(args: T): Prisma.PrismaPromise<Prisma.AppSettingGetPayload<T>>;
	update<T extends LogicalArgs<Prisma.AppSettingUpdateArgs, SettingUnique>>(
		args: T,
	): Prisma.PrismaPromise<Prisma.AppSettingGetPayload<T>>;
	delete<T extends LogicalArgs<Prisma.AppSettingDeleteArgs, SettingUnique>>(
		args: T,
	): Prisma.PrismaPromise<Prisma.AppSettingGetPayload<T>>;
	upsert<T extends LogicalArgs<Prisma.AppSettingUpsertArgs, SettingUnique>>(
		args: T,
	): Prisma.PrismaPromise<Prisma.AppSettingGetPayload<T>>;
};
type ProfileDelegate = Omit<
	RawPrismaClient["vmafExecutionProfile"],
	UniqueMethods
> & {
	findUnique<
		T extends LogicalArgs<
			Prisma.VmafExecutionProfileFindUniqueArgs,
			ProfileUnique
		>,
	>(
		args: T,
	): Prisma.PrismaPromise<Prisma.VmafExecutionProfileGetPayload<T> | null>;
	findUniqueOrThrow<
		T extends LogicalArgs<
			Prisma.VmafExecutionProfileFindUniqueOrThrowArgs,
			ProfileUnique
		>,
	>(args: T): Prisma.PrismaPromise<Prisma.VmafExecutionProfileGetPayload<T>>;
	update<
		T extends LogicalArgs<Prisma.VmafExecutionProfileUpdateArgs, ProfileUnique>,
	>(args: T): Prisma.PrismaPromise<Prisma.VmafExecutionProfileGetPayload<T>>;
	delete<
		T extends LogicalArgs<Prisma.VmafExecutionProfileDeleteArgs, ProfileUnique>,
	>(args: T): Prisma.PrismaPromise<Prisma.VmafExecutionProfileGetPayload<T>>;
	upsert<
		T extends LogicalArgs<Prisma.VmafExecutionProfileUpsertArgs, ProfileUnique>,
	>(args: T): Prisma.PrismaPromise<Prisma.VmafExecutionProfileGetPayload<T>>;
};
type TransactionOptions = {
	maxWait?: number;
	timeout?: number;
	isolationLevel?: Prisma.TransactionIsolationLevel;
	/** Transaction-local PostgreSQL statement limit; integer milliseconds, 1..5000. */
	statementTimeoutMs?: number;
};
export type AppPrismaClient = Omit<
	RawPrismaClient,
	"appSetting" | "vmafExecutionProfile" | "$transaction"
> & {
	appSetting: SettingDelegate;
	vmafExecutionProfile: ProfileDelegate;
	$transaction<P extends Prisma.PrismaPromise<unknown>[]>(
		commands: [...P],
		options?: Pick<TransactionOptions, "isolationLevel" | "statementTimeoutMs">,
	): Promise<{ [K in keyof P]: Awaited<P[K]> }>;
	$transaction<T>(
		callback: (tx: AppTransactionClient) => Promise<T>,
		options?: TransactionOptions,
	): Promise<T>;
};
export type AppTransactionClient = Omit<
	AppPrismaClient,
	"$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export function createPrismaClient(databaseUrl?: string): AppPrismaClient {
	const client = constructPrismaClient(databaseUrl);
	const transaction = client.$transaction as (
		input: unknown,
		options?: unknown,
	) => Promise<unknown>;
	client.$transaction = function (
		this: RawPrismaClient,
		...args: [input: unknown, options?: unknown]
	) {
		const [input, options] = args;
		const { nativeOptions, statementTimeoutMs } = transactionSettings(options);
		if (statementTimeoutMs === undefined)
			return nativeOptions === options
				? transaction.apply(this, args)
				: transaction.call(this, input, nativeOptions);
		if (typeof input === "function")
			return transaction.call(
				this,
				async (tx: AppTransactionClient) => {
					await setStatementTimeout(tx, statementTimeoutMs);
					return input(tx);
				},
				nativeOptions,
			);
		if (Array.isArray(input))
			return transaction
				.call(
					this,
					[setStatementTimeout(this, statementTimeoutMs), ...input],
					nativeOptions,
				)
				.then((results) => (results as unknown[]).slice(1));
		return transaction.call(this, input, nativeOptions);
	} as typeof client.$transaction;
	return client as unknown as AppPrismaClient;
}

/**
 * Process-wide singleton. Next.js dev hot-reload re-evaluates modules; the
 * globalThis stash prevents connection-pool exhaustion.
 */
export function getPrisma(): AppPrismaClient {
	if (!globalForPrisma.prisma) {
		globalForPrisma.prisma = createPrismaClient(loadEnv().DATABASE_URL);
	}
	return globalForPrisma.prisma;
}
