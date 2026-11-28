import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compilePlan,
	downgradeJitManifests,
	encodingPlanSchema,
	initStepLog,
	reseedFailedSteps,
	type StepLogEntry,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedCredential } from "./executor";
import { fakeSdk as baseFakeSdk } from "./fake-sdk";
import { applyJitFallback } from "./jit-fallback";
import { makeWorkerSdk } from "./make-sdk";
import { VerificationProviderIdPersistenceError } from "./ops/encoding";
import {
	createOrchestratorProcessor,
	type OrchestratorDeps,
} from "./processor";
import { ProviderCreateRefusal } from "./provider-create-refusal";
import { createBitmovinSdkOps, type SdkOps } from "./sdk-ops";
import {
	type CreateStamp,
	VerificationProviderIdDefinitelyNotPersistedError,
	VerificationProviderOwnershipLostError,
} from "./stamping-fetch";

const fixturePath = join(
	__dirname,
	"../../../../packages/core/src/plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json",
);
const basePlan = encodingPlanSchema.parse(
	JSON.parse(readFileSync(fixturePath, "utf8")),
);
const ACCOUNT_ID = "00000000-0000-4000-8000-00000000000a";
const JOB_ID = "00000000-0000-4000-8000-0000000000aa";

/**
 * A `updateMany` that honours the WHERE clause the way Postgres would — the
 * lease is a compare-and-swap on
 * `attemptClaimedAt`, and a fake that ignored `where` would make every fence
 * pass and every lease test vacuous. Modelled: `id`, `status` (a literal or
 * `{ in }`), `attemptClaimedAt` (a Date, `null`, or `{ lt }`) and `OR` over
 * those. Anything else in `where` is a modelling gap and throws, so a new
 * clause cannot be silently treated as "matches".
 */
type WhereClause = Record<string, unknown>;
function whereMatches(
	row: Record<string, unknown>,
	where: WhereClause,
): boolean {
	for (const [field, cond] of Object.entries(where)) {
		if (field === "OR") {
			if (!(cond as WhereClause[]).some((c) => whereMatches(row, c))) {
				return false;
			}
			continue;
		}
		const actual = row[field];
		if (cond === null) {
			if (actual !== null && actual !== undefined) return false;
			continue;
		}
		if (cond instanceof Date) {
			if (!(actual instanceof Date) || actual.getTime() !== cond.getTime()) {
				return false;
			}
			continue;
		}
		if (typeof cond === "object") {
			const c = cond as { in?: unknown[]; lt?: Date };
			if (c.in !== undefined) {
				if (!c.in.includes(actual)) return false;
				continue;
			}
			if (c.lt !== undefined) {
				if (!(actual instanceof Date) || !(actual.getTime() < c.lt.getTime())) {
					return false;
				}
				continue;
			}
			throw new Error(
				`fake updateMany: unmodelled clause on ${field}: ${JSON.stringify(cond)}`,
			);
		}
		if (actual !== cond) return false;
	}
	return true;
}
function fakeUpdateMany(
	row: Record<string, unknown>,
	updates: Record<string, unknown>[],
	/** Force the AWAITING_QC→RUNNING claim to lose (the existing harness knob). */
	loseStatusClaim?: () => boolean,
) {
	return vi.fn(
		async ({
			where,
			data,
		}: {
			where: WhereClause;
			data: Record<string, unknown>;
		}) => {
			if (loseStatusClaim?.() && where.status === "AWAITING_QC") {
				return { count: 0 };
			}
			if (!whereMatches(row, where)) {
				return { count: 0 };
			}
			// A COPY, taken at write time — a database records bytes, not a
			// reference. The processor keeps mutating its own step-log array
			// after a write lands, so pushing `data` itself made every earlier
			// accepted write appear to contain whatever the attempt did LATER,
			// and a fence test read a refused DONE as if it had landed.
			updates.push(structuredClone(data));
			Object.assign(row, structuredClone(data));
			return { count: 1 };
		},
	);
}

function fakeSdk(overrides: Partial<SdkOps> = {}): SdkOps {
	return baseFakeSdk({
		createEncoding: vi.fn(() => Promise.resolve("bm-encoding")),
		...overrides,
	});
}

function setup(
	rowOverrides: Record<string, unknown> = {},
	sdkOverrides: Partial<SdkOps> = {},
	onVodFinished?: (args: {
		encodingJobId: string;
		plan: unknown;
	}) => Promise<void>,
	makeSdkSpy?: (args: {
		apiKey: string;
		tenantOrgId: string | null;
		bitmovinAccountId: string;
		stamp?: CreateStamp;
	}) => SdkOps,
	vmafModelAvailable?: (model: string) => boolean,
	/** Poll-tick seam — the lease is renewed here (CRITICAL-1), so a test can
	 * steal it on a tick. */
	sleep?: () => Promise<void>,
	/** Injected clock; the default is frozen, which hides a lease that never moves. */
	now?: () => string,
) {
	const plan = structuredClone(basePlan);
	plan.bitmovin.accountId = ACCOUNT_ID;
	const row: Record<string, unknown> = {
		id: JOB_ID,
		status: "QUEUED",
		cancelRequested: false,
		plan,
		stepLog: initStepLog(compilePlan(plan)),
		bitmovinAccountId: null,
		...rowOverrides,
	};
	const updates: Record<string, unknown>[] = [];
	const updateMany = fakeUpdateMany(row, updates);
	const prisma = {
		encodingJob: {
			findUnique: vi.fn(async () => row),
			update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				updates.push(structuredClone(data));
				Object.assign(row, structuredClone(data));
				return row;
			}),
			updateMany,
		},
	} as unknown as AppPrismaClient;
	const sdk = fakeSdk(sdkOverrides);
	const emitted: Record<string, unknown>[] = [];
	const deps: OrchestratorDeps = {
		prisma,
		revealBitmovinAccount: vi.fn(async () => ({
			apiKey: "key",
			tenantOrgId: null,
		})),
		resolveCredential: vi.fn(async () => ({
			provider: "AWS_S3",
			config: {},
			secret: { accessKeyId: "a", secretAccessKey: "s" },
		})),
		makeSdk: makeSdkSpy ?? (() => sdk),
		sleep: sleep ?? (() => Promise.resolve()),
		emitEvent: async (event) => {
			emitted.push(event as unknown as Record<string, unknown>);
		},
		pollIntervalMs: 1,
		pollTimeoutMs: 1000,
		now: now ?? (() => "2026-06-11T00:00:00.000Z"),
		...(onVodFinished ? { onVodFinished } : {}),
		// null = the explicit "no capability claim" opt-out; the type makes
		// forgetting it impossible (review-234 round 5).
		vmafModelAvailable: vmafModelAvailable ?? null,
	};
	const processor = createOrchestratorProcessor(deps);
	return { processor, deps, row, updates, sdk, emitted, prisma, updateMany };
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => vi.unstubAllEnvs());

describe("orchestrator processor", () => {
	it.each([
		["HLS", "jit"],
		["HLS", "default"],
		["HLS", "upstream-safe"],
		["DASH", "stopped"],
		["DASH", "scope-changed"],
		["SMOOTH", "still-active"],
		["SMOOTH", "foreign"],
		["SMOOTH", "lost-lease"],
		["SMOOTH", "user-cancel"],
		["SMOOTH", "cancel-during-start"],
		["SMOOTH", "cancel-at-error-write"],
		["SMOOTH", "status-503"],
		["SMOOTH", "owner-503"],
		["SMOOTH", "owner-forbidden"],
		["SMOOTH", "stop-forbidden"],
		["SMOOTH", "cancel-account-unavailable"],
		["SMOOTH", "cancel-account-lease-lost"],
		["SMOOTH", "blocked-account-deleted"],
		["SMOOTH", "blocked-account-crossed"],
		["SMOOTH", "blocked-account-scope-refused"],
		["SMOOTH", "blocked-account-malformed-identity"],
		["SMOOTH", "blocked-preparation-changed"],
	] as const)("guards the recorded %s manifest on resume (%s)", async (format, scenario) => {
		const sample = basePlan.manifests[0];
		const primary = basePlan.outputs[0];
		if (!sample || !primary || !("credentialId" in primary))
			throw new Error("Missing role manifest fixture");
		const preparationChanged =
			scenario === "blocked-preparation-changed" ||
			scenario === "cancel-account-unavailable";
		const plan = encodingPlanSchema.parse({
			...basePlan,
			...(preparationChanged
				? {
						inputTimelinePreparation: {
							taskId: "00000000-0000-4000-8000-000000000001",
							requestHash: "a".repeat(64),
						},
						qc: { vmaf: true, model: "vmaf_v1.0.16_3d0h" },
					}
				: {}),
			bitmovin: { ...basePlan.bitmovin, accountId: ACCOUNT_ID },
			outputs: [
				...basePlan.outputs,
				{
					kind: "S3_ROLE_BASED",
					key: "role",
					name: "Role output",
					bucket: "role-manifest-test",
					credentialId: primary.credentialId,
				},
			],
			deliveryMirrors: [{ outputKey: "role" }],
			generation: {
				...basePlan.generation,
				timing: scenario === "jit" ? "JUST_IN_TIME" : "POST_ENCODING",
			},
			manifests:
				format === "HLS"
					? [
							{
								...sample,
								...(scenario === "default"
									? { generationMode: "DEFAULT" }
									: {}),
							},
						]
					: [
							{
								key: sample.key,
								kind: format,
								destination: sample.destination,
							},
						],
		});
		const journal = initStepLog(compilePlan(plan));
		const createKind = `CREATE_MANIFEST_${format}`;
		const startKind =
			scenario === "jit" ? "START_ENCODING" : `START_MANIFEST_${format}`;
		const startIndex = journal.findIndex((entry) => entry.kind === startKind);
		const manifest = journal.find((entry) => entry.kind === createKind);
		if (!manifest || startIndex < 0)
			throw new Error("Missing compiled manifest");
		const account = {
			id: ACCOUNT_ID,
			version: "00000000-0000-4000-8000-0000000000fe",
		};
		for (const [index, step] of journal.entries()) {
			if (index >= startIndex) break;
			step.status = "DONE";
			step.resourceId = `provider-${step.step}`;
			step.request = { ...step.payload };
			step.resourceAccount = account;
		}
		const lostStart =
			scenario === "cancel-during-start" ||
			scenario === "cancel-at-error-write";
		const retryableCancel =
			scenario === "status-503" || scenario === "owner-503";
		const accountReadForCancel =
			scenario === "cancel-account-unavailable" ||
			scenario === "cancel-account-lease-lost";
		const permanentScopeError =
			scenario === "blocked-account-scope-refused"
				? "42501"
				: scenario === "blocked-account-malformed-identity"
					? "22P02"
					: undefined;
		const permanentAccountFailure =
			permanentScopeError !== undefined ||
			scenario === "blocked-account-deleted" ||
			scenario === "blocked-account-crossed";
		const userCancel =
			accountReadForCancel ||
			scenario === "user-cancel" ||
			scenario === "owner-forbidden" ||
			scenario === "stop-forbidden" ||
			retryableCancel;
		const attempted =
			userCancel ||
			permanentAccountFailure ||
			preparationChanged ||
			[
				"stopped",
				"still-active",
				"foreign",
				"lost-lease",
				"scope-changed",
			].includes(scenario);
		const start = journal[startIndex];
		if (!start || !manifest.resourceId)
			throw new Error("Missing attempted manifest");
		if (attempted) {
			start.status = "RUNNING";
			start.startedAt = "2026-06-11T00:00:00.000Z";
		}
		if (permanentAccountFailure || scenario === "blocked-preparation-changed")
			manifest.roleDeliveryBlocked = true;
		// Persisted ACL is correct even though the provider-side old adoption is public.
		expect(manifest.request).toMatchObject({ mirrorOutputAcls: ["PRIVATE"] });
		const h = setup({
			plan,
			stepLog: journal,
			bitmovinAccountId:
				scenario === "blocked-account-crossed"
					? "00000000-0000-4000-8000-0000000000bb"
					: ACCOUNT_ID,
			status: "RUNNING",
			cancelRequested: userCancel,
		});
		if (preparationChanged) {
			h.deps.validateInputPreparation = vi.fn(async () => {
				throw new Error("INPUT_PREPARATION_INVALID");
			});
			h.deps.vmafModelAvailable = vi.fn(() => false);
		}
		if (scenario === "cancel-at-error-write") {
			const persist = h.updateMany.getMockImplementation();
			if (!persist) throw new Error("Missing fixture persistence");
			h.updateMany.mockImplementation(async (args) => {
				if (args.data.status === "ERROR") h.row.cancelRequested = true;
				return persist(args);
			});
		}
		const revealAccount = vi.mocked(h.deps.revealBitmovinAccount);
		revealAccount.mockResolvedValue({
			apiKey: "synthetic-only",
			tenantOrgId: "fixture-org",
			resourceScopeVersion:
				scenario === "scope-changed"
					? "00000000-0000-4000-8000-0000000000ff"
					: account.version,
		});
		const unavailableAccount = Object.assign(
			new Error("Synthetic temporary database connection failure"),
			{ errorCode: "P1002" },
		);
		if (permanentScopeError) {
			revealAccount.mockRejectedValueOnce(
				Object.assign(new Error("Synthetic tenant scope failure"), {
					code: "P2010",
					meta: { code: permanentScopeError },
				}),
			);
		} else if (scenario === "blocked-account-deleted") {
			revealAccount.mockRejectedValueOnce(
				new Error("Bitmovin account no longer exists"),
			);
		} else if (scenario === "cancel-account-lease-lost") {
			revealAccount.mockImplementationOnce(async () => {
				h.row.attemptClaimedAt = new Date("2030-01-01Z");
				throw unavailableAccount;
			});
		} else if (accountReadForCancel || permanentAccountFailure) {
			revealAccount.mockRejectedValueOnce(unavailableAccount);
		}
		const makeSdk = makeWorkerSdk({
			...h.prisma,
			auditLog: { create: vi.fn() },
		} as unknown as AppPrismaClient);
		h.deps.makeSdk = (args) => {
			const real = makeSdk(args);
			return {
				...h.sdk,
				...(lostStart ? { startSmoothManifest: real.startSmoothManifest } : {}),
				getManifestRoleAcl: real.getManifestRoleAcl,
				ownsManifest: real.ownsManifest,
				stopManifest: real.stopManifest,
				getHlsManifestStatus: real.getHlsManifestStatus,
				getDashManifestStatus: real.getDashManifestStatus,
				getSmoothManifestStatus: real.getSmoothManifestStatus,
			};
		};
		const reads: string[] = [];
		let stopped = false;
		let atStop: typeof h.row | undefined;
		const manifestId = manifest.resourceId;
		const path = `/v1/encoding/manifests/${format.toLowerCase()}/${manifestId}`;
		const result = (resource: unknown, status = 200) =>
			Response.json({ data: { result: resource } }, { status });
		const unavailable = (status: number) =>
			Response.json(
				{
					status: "ERROR",
					data: { code: 1004, message: "Synthetic manifest lookup error" },
				},
				{ status },
			);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (raw: string, init: RequestInit) => {
				const { pathname } = new URL(raw);
				const decoded = decodeURIComponent(pathname);
				expect(new Headers(init.headers).get("X-Tenant-Org-Id")).toBe(
					"fixture-org",
				);
				reads.push(`${init.method} ${decoded}`);
				if (decoded === path) {
					return result({
						id: manifestId,
						outputs: [
							{
								outputId: "provider-output:role",
								outputPath: manifest.payload.outputPath,
								acl: [
									{
										permission:
											scenario === "upstream-safe" || lostStart
												? "PRIVATE"
												: "PUBLIC_READ",
									},
								],
							},
						],
					});
				}
				if (decoded.endsWith("/customData")) {
					if (scenario === "owner-503") return unavailable(503);
					if (scenario === "owner-forbidden") return unavailable(403);
					if (scenario === "lost-lease")
						h.row.attemptClaimedAt = new Date("2030-01-01Z");
					return result({
						customData: {
							bitovp: {
								job: scenario === "foreign" ? "other-job" : JOB_ID,
								step: manifest.step,
							},
						},
					});
				}
				if (decoded.endsWith("/status")) {
					if (scenario === "status-503") return unavailable(503);
					return result({
						status:
							scenario === "upstream-safe"
								? "FINISHED"
								: stopped &&
										(scenario === "stopped" ||
											scenario === "blocked-preparation-changed" ||
											scenario === "user-cancel" ||
											accountReadForCancel ||
											lostStart)
									? "CANCELED"
									: "RUNNING",
					});
				}
				if (decoded.endsWith("/stop") && init.method === "POST") {
					if (scenario === "stop-forbidden") return unavailable(403);
					stopped = true;
					atStop = structuredClone(h.row);
					return result({}, 202);
				}
				if (
					decoded === `${path}/start` &&
					init.method === "POST" &&
					lostStart
				) {
					if (scenario === "cancel-during-start") h.row.cancelRequested = true;
					throw new TypeError("Synthetic lost START response after acceptance");
				}
				throw new Error("Unexpected role manifest request");
			}),
		);
		try {
			if (permanentAccountFailure) {
				const crossed = scenario === "blocked-account-crossed";
				await expect(h.processor({ encodingJobId: JOB_ID })).rejects.toThrow(
					crossed
						? "The recorded Bitmovin account is required for manifest stop"
						: permanentScopeError
							? "Synthetic tenant scope failure"
							: "Bitmovin account no longer exists",
				);
				expect(revealAccount).toHaveBeenCalledTimes(crossed ? 0 : 1);
				expect(h.row).toMatchObject({
					status: "ERROR",
					attemptClaimedAt: null,
					stepLog: journal,
				});
				expect(reads).toHaveLength(0);
				return;
			}
			if (accountReadForCancel) {
				const displaced = scenario === "cancel-account-lease-lost";
				await expect(
					h.processor({ encodingJobId: JOB_ID }),
				).resolves.toMatchObject({
					status: displaced ? "LEASE_LOST" : "MANIFEST_STOP_PENDING",
				});
				expect(h.row).toMatchObject({
					status: "RUNNING",
					cancelRequested: true,
					attemptClaimedAt: displaced ? new Date("2030-01-01Z") : null,
					stepLog: journal,
				});
				expect(h.emitted).toHaveLength(0);
				expect(reads).toHaveLength(0);
				if (displaced) return;
			}
			const outcome = await h.processor({ encodingJobId: JOB_ID });
			if (scenario === "scope-changed") expect(reads).toHaveLength(0);
			else if (!userCancel && !preparationChanged)
				expect(reads).toContain(`GET ${path}`);
			if (preparationChanged) {
				expect(h.deps.validateInputPreparation).not.toHaveBeenCalled();
				expect(h.deps.vmafModelAvailable).not.toHaveBeenCalled();
			}
			expect(stopped).toBe(
				scenario === "stopped" ||
					scenario === "blocked-preparation-changed" ||
					scenario === "still-active" ||
					scenario === "user-cancel" ||
					accountReadForCancel ||
					lostStart,
			);
			expect(h.sdk.startEncoding).not.toHaveBeenCalled();
			expect(h.sdk.startHlsManifest).toHaveBeenCalledTimes(
				scenario === "upstream-safe" ? 1 : 0,
			);
			expect(h.sdk.startDashManifest).not.toHaveBeenCalled();
			expect(h.sdk.startSmoothManifest).not.toHaveBeenCalled();
			if (scenario === "still-active" || retryableCancel) {
				expect(outcome.status).toBe("MANIFEST_STOP_PENDING");
				expect(h.row.status).toBe("RUNNING");
				expect(h.row.attemptClaimedAt).toBeNull();
				expect(h.emitted).toHaveLength(0);
				const durableBlock = expect.arrayContaining([
					expect.objectContaining({
						step: manifest.step,
						roleDeliveryBlocked: true,
					}),
				]);
				expect(h.row.stepLog).toEqual(durableBlock);
				if (scenario === "still-active") {
					expect(atStop?.stepLog).toEqual(durableBlock);
					Object.assign(h.row, atStop, {
						status: "RUNNING",
						attemptClaimedAt: new Date(0),
					});
					const saved = structuredClone(h.row.stepLog);
					const beforeRead = reads.length;
					// The tenant-scoped account lookup can surface raw PostgreSQL
					// errors from the RLS setup statements as Prisma P2010.
					for (const failure of [
						{ code: "P2024" },
						...[
							"57014",
							"08006",
							"40001",
							"40P01",
							"55P03",
							"57P03",
							"53000",
							"53100",
							"53200",
							"53300",
							"53400",
							"58030",
						].map((sqlState) => ({ code: "P2010", meta: { code: sqlState } })),
					]) {
						revealAccount.mockRejectedValueOnce(
							Object.assign(
								new Error("Synthetic temporary account read failure"),
								failure,
							),
						);
						await expect(
							createOrchestratorProcessor(h.deps)({ encodingJobId: JOB_ID }),
						).resolves.toMatchObject({ status: "MANIFEST_STOP_PENDING" });
						expect(h.row).toMatchObject({
							status: "RUNNING",
							attemptClaimedAt: null,
							stepLog: saved,
						});
						expect(h.emitted).toHaveLength(0);
						expect(reads).toHaveLength(beforeRead);
					}
				}
				const post = reads.filter(
					(call) => call === `POST ${path}/stop`,
				).length;
				let later503 = scenario === "still-active";
				vi.stubGlobal(
					"fetch",
					vi.fn(async (raw: string, init: RequestInit) => {
						const pathRead = decodeURIComponent(new URL(raw).pathname);
						reads.push(`${init.method} ${pathRead}`);
						if (pathRead === path)
							return result({
								id: manifestId,
								outputs: [
									{
										outputId: "provider-output:role",
										outputPath: manifest.payload.outputPath,
										acl: [{ permission: "PRIVATE" }],
									},
								],
							});
						if (pathRead === `${path}/status`) {
							if (later503) {
								later503 = false;
								return unavailable(503);
							}
							return result({ status: "CANCELED" });
						}
						throw new Error(
							"Terminal readback must not issue another mutation",
						);
					}),
				);
				if (scenario === "still-active") {
					await expect(
						createOrchestratorProcessor(h.deps)({ encodingJobId: JOB_ID }),
					).resolves.toMatchObject({ status: "MANIFEST_STOP_PENDING" });
					expect(h.row.status).toBe("RUNNING");
					expect(h.row.attemptClaimedAt).toBeNull();
					expect(h.emitted).toHaveLength(0);
				}
				await expect(
					createOrchestratorProcessor(h.deps)({ encodingJobId: JOB_ID }),
				).resolves.toMatchObject({ status: userCancel ? "CANCELED" : "ERROR" });
				expect(
					reads.filter((call) => call === `POST ${path}/stop`),
				).toHaveLength(post);
				expect(h.sdk.startSmoothManifest).not.toHaveBeenCalled();
			} else if (scenario === "upstream-safe") {
				expect(outcome.status).toBe("FINISHED");
			} else if (scenario === "lost-lease") {
				expect(outcome.status).toBe("LEASE_LOST");
				expect(h.emitted).toHaveLength(0);
			} else if (
				scenario === "user-cancel" ||
				accountReadForCancel ||
				lostStart
			) {
				expect(outcome.status).toBe("CANCELED");
				if (lostStart)
					expect(
						reads.filter((call) => call === `POST ${path}/start`),
					).toHaveLength(1);
				expect(h.emitted).toContainEqual(
					expect.objectContaining({ kind: "JOB_CANCELED" }),
				);
			} else if (
				scenario === "owner-forbidden" ||
				scenario === "stop-forbidden"
			) {
				expect(outcome.status).toBe("ERROR");
				expect(
					reads.filter((call) => call === `POST ${path}/stop`),
				).toHaveLength(scenario === "stop-forbidden" ? 1 : 0);
				expect(h.emitted).toContainEqual(
					expect.objectContaining({
						kind: "JOB_ERROR",
						error: expect.stringContaining(
							"Could not verify whether Bitmovin stopped",
						),
					}),
				);
			} else {
				expect(outcome.status).toBe("ERROR");
				expect(h.emitted).toContainEqual(
					expect.objectContaining({
						kind: "JOB_ERROR",
						error: expect.stringMatching(/role output ACL/i),
					}),
				);
			}
			if (
				scenario === "stopped" ||
				scenario === "user-cancel" ||
				preparationChanged
			)
				expect(
					reads.filter((read) => read === `GET ${path}/status`),
				).toHaveLength(2);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("records an ordinary account setup failure without a manifest stop to reconcile", async () => {
		const h = setup();
		const outage = Object.assign(new Error("Synthetic exhausted pool"), {
			code: "P2024",
		});
		vi.mocked(h.deps.revealBitmovinAccount).mockRejectedValueOnce(outage);
		await expect(h.processor({ encodingJobId: JOB_ID })).rejects.toBe(outage);
		expect(h.row).toMatchObject({ status: "ERROR", attemptClaimedAt: null });
		expect(h.sdk.createEncoding).not.toHaveBeenCalled();
	});

	it.each([
		"pending",
		"safe-done",
		"unsafe-done",
		"uncertain",
	] as const)("hydrates VOD role output ACLs and refuses an unsafe prior destination (%s)", async (previous) => {
		const plan = structuredClone(basePlan);
		plan.bitmovin.accountId = ACCOUNT_ID;
		const primary = plan.outputs[0];
		if (!primary) throw new Error("Missing primary fixture");
		plan.outputs.push({
			kind: "S3_ROLE_BASED",
			key: "mirror",
			name: "Private mirror",
			credentialId: primary.credentialId,
			bucket: "private-role-mirror",
		});
		plan.deliveryMirrors = [{ outputKey: "mirror" }];
		const history = initStepLog(compilePlan(plan));
		const mirror = history.find(
			(row) => row.kind === "CREATE_OUTPUT_S3_ROLE_BASED",
		);
		const firstMuxing = history.find(
			(row) => row.kind === "CREATE_MUXING_FMP4",
		);
		if (!mirror || !firstMuxing) throw new Error("Missing role mirror steps");
		mirror.status = "DONE";
		mirror.resourceId = "adopted-role-output";
		for (const entry of history) {
			if (previous !== "safe-done" || entry !== firstMuxing)
				delete entry.payload.mirrorOutputAcls;
		}
		if (previous === "safe-done" || previous === "unsafe-done") {
			firstMuxing.status = "DONE";
			firstMuxing.resourceId = "recorded-muxing";
			firstMuxing.request = { ...firstMuxing.payload, refs: firstMuxing.refs };
		} else if (previous === "uncertain") {
			firstMuxing.status = "RUNNING";
			firstMuxing.startedAt = "2026-06-11T00:00:00.000Z";
		}
		const h = setup({ plan, stepLog: history });
		if (previous === "unsafe-done" || previous === "uncertain") {
			await expect(
				h.processor({ encodingJobId: JOB_ID }),
			).resolves.toMatchObject({ status: "ERROR" });
			expect(h.row.error).toMatch(/prior.*role output ACL/i);
			expect(h.emitted).toEqual([
				expect.objectContaining({ kind: "JOB_ERROR", jobId: JOB_ID }),
			]);
			expect(h.sdk.startEncoding).not.toHaveBeenCalled();
			expect(h.sdk.createFmp4Muxing).not.toHaveBeenCalled();
			return;
		}
		await expect(h.processor({ encodingJobId: JOB_ID })).resolves.toMatchObject(
			{ status: "FINISHED" },
		);
		const destination = expect.objectContaining({
			acl: "PUBLIC_READ",
			mirrorOutputIds: ["adopted-role-output"],
			mirrorOutputAcls: ["PRIVATE"],
			roleOutputIds: ["adopted-role-output"],
		});
		expect(h.sdk.createS3RoleBasedOutput).not.toHaveBeenCalled();
		expect(h.sdk.createFmp4Muxing).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ destination }),
		);
		expect(h.sdk.createHlsManifest).toHaveBeenCalledWith(
			expect.objectContaining({ destination }),
		);
		expect(h.row.stepLog).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "CREATE_MANIFEST_HLS",
					payload: expect.objectContaining({ mirrorOutputAcls: ["PRIVATE"] }),
					request: expect.objectContaining({ mirrorOutputAcls: ["PRIVATE"] }),
				}),
			]),
		);
	});

	it("persists the exact caption key from its executed S3 input", async () => {
		const inputPath = "archive/scene.ts?key=wide";
		const plan = structuredClone(basePlan);
		plan.bitmovin.accountId = ACCOUNT_ID;
		const source = plan.inputs[0];
		if (source?.kind !== "S3") throw Error("Missing S3 input fixture");
		plan.captionStreams = [
			{
				key: "captions",
				inputKey: source.key,
				inputPath,
				kind: "CEA608",
				channel: "CC1",
			},
		];
		const h = setup({ plan, stepLog: initStepLog(compilePlan(plan)) });
		await expect(h.processor({ encodingJobId: JOB_ID })).resolves.toMatchObject(
			{ status: "FINISHED" },
		);
		const history = h.row.stepLog as StepLogEntry[];
		const producer = history.find(
			(entry) => entry.step === `input:${source.key}`,
		);
		expect(producer?.resourceId).toBeTruthy();
		expect(
			history.find((entry) => entry.step === "caption:captions")?.request,
		).toMatchObject({ inputPath, refs: { inputId: producer?.resourceId } });
		expect(h.sdk.createCea608InputStream).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ inputPath, inputId: producer?.resourceId }),
		);
	});
	it.each([
		false,
		true,
	])("refuses a prepared input before provider calls when receipt validation is unavailable or rejects (validator=%s)", async (supplied) => {
		const f = setup();
		(f.row.plan as Record<string, unknown>).inputTimelinePreparation = {
			taskId: "00000000-0000-4000-8000-000000000001",
			requestHash: "a".repeat(64),
		};
		if (supplied)
			f.deps.validateInputPreparation = vi.fn(async () => {
				throw new Error("INPUT_PREPARATION_INVALID");
			});
		await expect(f.processor({ encodingJobId: JOB_ID })).rejects.toThrow(
			/PREPARATION/,
		);
		expect(f.row.status).toBe("ERROR");
		expect(f.sdk.createEncoding).not.toHaveBeenCalled();
		expect(f.sdk.startEncoding).not.toHaveBeenCalled();
	});
	it("acknowledges an ERROR row without reporting a held lease", async () => {
		const { processor, updateMany, updates, sdk } = setup({ status: "ERROR" });
		await expect(processor({ encodingJobId: JOB_ID })).resolves.toMatchObject({
			status: "ERROR",
		});
		expect(updateMany).not.toHaveBeenCalled();
		expect(updates).toHaveLength(0);
		expect(sdk.createEncoding).not.toHaveBeenCalled();
	});

	it.each([
		"FINISHED",
		"CANCELED",
		"QC_FAILED",
		"ERROR",
	])("acknowledges a row that becomes %s before the lease claim", async (status) => {
		const { processor, row, updateMany, updates, sdk } = setup();
		updateMany.mockImplementationOnce(async () => {
			row.status = status;
			return { count: 0 };
		});
		await expect(processor({ encodingJobId: JOB_ID })).resolves.toMatchObject({
			status,
		});
		expect(updates).toHaveLength(0);
		expect(sdk.createEncoding).not.toHaveBeenCalled();
	});

	it("acknowledges a row deleted before its lease claim", async () => {
		const { processor, prisma, row, updateMany, updates, sdk } = setup();
		updateMany.mockResolvedValueOnce({ count: 0 });
		vi.mocked(prisma.encodingJob.findUnique)
			.mockResolvedValueOnce(row as never)
			.mockResolvedValueOnce(null);
		await expect(processor({ encodingJobId: JOB_ID })).resolves.toMatchObject({
			status: "MISSING",
		});
		expect(updates).toHaveLength(0);
		expect(sdk.createEncoding).not.toHaveBeenCalled();
	});

	function internalPlan() {
		return encodingPlanSchema.parse({
			...basePlan,
			bitmovin: { ...basePlan.bitmovin, accountId: ACCOUNT_ID },
			internal: { hevcV2: { bcfVersion: "v2.325.0-461-g85df7fd6c6" } },
			renditions: basePlan.renditions.map((r) =>
				r.codec === "H264"
					? {
							key: r.key,
							ingestKey: r.ingestKey,
							codec: "H265",
							height: 720,
							bitrate: 1000000,
						}
					: r,
			),
		});
	}
	it.each([
		"pending",
		"sent",
	] as const)("preserves internal HEVCv2 replay across role ACL expansion (%s)", async (prior) => {
		vi.stubEnv("BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID", ACCOUNT_ID);
		const plan = internalPlan();
		const primary = plan.outputs[0];
		if (!primary || !("credentialId" in primary))
			throw new Error("Missing output");
		plan.outputs.push({
			kind: "S3_ROLE_BASED",
			key: "mirror",
			name: "Role mirror",
			bucket: "fixture-hevc-role",
			credentialId: primary.credentialId,
		});
		plan.deliveryMirrors = [{ outputKey: "mirror" }];
		const log = initStepLog(compilePlan(plan));
		const roleOutput = log.find(
			(entry) => entry.kind === "CREATE_OUTPUT_S3_ROLE_BASED",
		);
		const muxing = log.find((entry) => entry.kind === "CREATE_MUXING_FMP4");
		if (!roleOutput || !muxing) throw new Error("Missing role replay steps");
		for (const entry of log) delete entry.payload.mirrorOutputAcls;
		roleOutput.status = "DONE";
		roleOutput.resourceId = "role-output";
		if (prior === "sent") {
			muxing.status = "RUNNING";
			muxing.startedAt = "2026-06-11T00:00:00.000Z";
		}
		const h = setup({ plan, stepLog: log, bitmovinAccountId: ACCOUNT_ID });
		await expect(h.processor({ encodingJobId: JOB_ID })).resolves.toMatchObject(
			{
				status: prior === "sent" ? "ERROR" : "FINISHED",
			},
		);
		if (prior === "sent") {
			expect(h.row.error).toMatch(/role output ACL/);
			expect(h.sdk.startEncoding).not.toHaveBeenCalled();
		} else {
			expect(h.sdk.createFmp4Muxing).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					destination: expect.objectContaining({
						mirrorOutputAcls: ["PRIVATE"],
					}),
				}),
			);
		}
	});
	it.each([
		"internalHevcV2",
		"bcfVersion",
		"encodingMode",
	])("rejects a forged %s ledger marker without an internal plan before credentials", async (field) => {
		const { processor, row, deps } = setup();
		const log = row.stepLog as StepLogEntry[];
		const entry = log[0];
		if (!entry) throw new Error("missing step");
		entry.payload[field] =
			field === "internalHevcV2"
				? true
				: field === "encodingMode"
					? "SMART_PASS"
					: "v2.325.0-461-g85df7fd6c6";
		await expect(processor({ encodingJobId: JOB_ID })).rejects.toThrow(
			/internal HEVCv2/i,
		);
		expect(deps.revealBitmovinAccount).not.toHaveBeenCalled();
	});
	it("refuses internal queued jobs before revealing credentials when allowlist was revoked", async () => {
		vi.stubEnv("BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID", "");
		const plan = internalPlan();
		const { processor, deps } = setup({
			plan,
			stepLog: initStepLog(compilePlan(plan)),
		});
		await expect(processor({ encodingJobId: JOB_ID })).rejects.toThrow(
			/internal HEVCv2/i,
		);
		expect(deps.revealBitmovinAccount).not.toHaveBeenCalled();
	});
	it.each([
		"account",
		"codec",
		"mode",
		"flag",
	])("rejects mismatched internal %s before any provider work", async (tamper) => {
		vi.stubEnv("BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID", ACCOUNT_ID);
		const plan = internalPlan();
		const log = initStepLog(compilePlan(plan));
		const codec = log.find((e) => e.kind === "CREATE_CODEC_H265");
		if (!codec) throw new Error("missing codec");
		if (tamper === "codec") codec.kind = "CREATE_CODEC_H264";
		if (tamper === "mode") codec.payload.encodingMode = "SINGLE_PASS";
		if (tamper === "flag") delete codec.payload.internalHevcV2;
		const { processor, deps } = setup({
			plan,
			stepLog: log,
			bitmovinAccountId:
				tamper === "account"
					? "00000000-0000-4000-8000-00000000000b"
					: ACCOUNT_ID,
		});
		await expect(processor({ encodingJobId: JOB_ID })).rejects.toThrow(
			/internal HEVCv2/i,
		);
		expect(deps.revealBitmovinAccount).not.toHaveBeenCalled();
	});
	it("threads the allowed immutable profile through the processor SDK factory", async () => {
		vi.stubEnv("BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID", ACCOUNT_ID);
		const plan = internalPlan();
		const make = vi.fn((_args: Parameters<OrchestratorDeps["makeSdk"]>[0]) =>
			fakeSdk(),
		);
		const { processor } = setup(
			{
				plan,
				stepLog: initStepLog(compilePlan(plan)),
				bitmovinAccountId: ACCOUNT_ID,
			},
			{},
			undefined,
			make,
		);
		await processor({ encodingJobId: JOB_ID });
		expect(make).toHaveBeenCalledWith(
			expect.objectContaining({ internalHevcV2: plan.internal?.hevcV2 }),
		);
	});
	it("keeps cancel cleanup working with a revoked profile without forwarding override headers", async () => {
		vi.stubEnv("BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID", "");
		const plan = internalPlan();
		const log = initStepLog(compilePlan(plan));
		const encoding = log.find((e) => e.kind === "CREATE_ENCODING");
		if (!encoding) throw new Error("missing encoding");
		encoding.status = "DONE";
		encoding.resourceId = "owned-encoding";
		const sdk = fakeSdk({
			getEncodingStatus: vi.fn(async () => ({ status: "RUNNING" })),
		});
		const make = vi.fn(
			(_args: Parameters<OrchestratorDeps["makeSdk"]>[0]) => sdk,
		);
		const { processor } = setup(
			{
				plan,
				stepLog: log,
				bitmovinAccountId: ACCOUNT_ID,
				cancelRequested: true,
			},
			{},
			undefined,
			make,
		);
		await processor({ encodingJobId: JOB_ID });
		expect(make.mock.calls[0]?.[0]).not.toHaveProperty("internalHevcV2");
		expect(sdk.stopEncoding).toHaveBeenCalledWith("owned-encoding");
		expect(sdk.createH265Config).not.toHaveBeenCalled();
	});
	it.each([
		"duplicate",
		"missing",
		"reorder",
		"payload",
		"refs",
	])("rejects %s tampering of internal fallback before credentials", async (tamper) => {
		vi.stubEnv("BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID", ACCOUNT_ID);
		const plan = internalPlan();
		const log = initStepLog(compilePlan(plan));
		const downgrade = downgradeJitManifests(
			plan,
			log.map((e) => e.step),
		);
		if (!downgrade.ok) throw new Error(downgrade.reason);
		applyJitFallback(downgrade, log);
		const first = log[0];
		const second = log[1];
		if (!first || !second) throw new Error("missing steps");
		if (tamper === "duplicate") log[1] = structuredClone(first);
		if (tamper === "missing") log.pop();
		if (tamper === "reorder") {
			log[0] = second;
			log[1] = first;
		}
		if (tamper === "payload") first.payload.name = "altered";
		if (tamper === "refs") first.refs.encodingId = "foreign";
		const { processor, deps } = setup({
			plan: downgrade.plan,
			stepLog: log,
			bitmovinAccountId: ACCOUNT_ID,
		});
		await expect(processor({ encodingJobId: JOB_ID })).rejects.toThrow(
			/persisted steps/,
		);
		expect(deps.revealBitmovinAccount).not.toHaveBeenCalled();
	});
	it("resumes an internal persisted JIT fallback with its original resource order", async () => {
		vi.stubEnv("BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID", ACCOUNT_ID);
		const plan = internalPlan();
		const log = initStepLog(compilePlan(plan));
		const downgrade = downgradeJitManifests(
			plan,
			log.map((e) => e.step),
		);
		if (!downgrade.ok) throw new Error(downgrade.reason);
		applyJitFallback(downgrade, log);
		for (const entry of log) {
			if (entry.kind === "START_ENCODING") {
				entry.status = "RUNNING";
				break;
			}
			entry.status = "DONE";
			entry.resourceId = `owned:${entry.step}`;
		}
		const { processor, deps, sdk } = setup({
			status: "RUNNING",
			plan: downgrade.plan,
			stepLog: JSON.parse(JSON.stringify(log)),
			bitmovinAccountId: ACCOUNT_ID,
		});
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("FINISHED");
		expect(deps.revealBitmovinAccount).toHaveBeenCalledOnce();
		expect(sdk.startHlsManifest).toHaveBeenCalled();
		expect(sdk.createH265Config).not.toHaveBeenCalled();
	});
	it("refuses an incomplete verification identity before any provider create", async () => {
		const { processor, sdk } = setup({
			verificationKey: "verify:run-1:scenario-1:VOD_JOB",
			verificationRequestSha256: null,
		});
		await expect(processor({ encodingJobId: JOB_ID })).rejects.toMatchObject({
			code: "VERIFICATION_IDENTITY_INCOMPLETE",
		});
		expect(sdk.createEncoding).not.toHaveBeenCalled();
	});

	it("durably records a verification provider id while CREATE_ENCODING is still RUNNING", async () => {
		const key = "verify:run-1:scenario-1:VOD_JOB";
		const sha = "a".repeat(64);
		let callbackResult: string | undefined;
		const harness = setup(
			{ verificationKey: key, verificationRequestSha256: sha },
			{},
			undefined,
			(args) =>
				fakeSdk({
					createEncoding: vi.fn(async () => {
						callbackResult = await args.stamp?.onEncodingCreated?.(
							"bm-verified",
							"created",
						);
						return "bm-verified";
					}),
				}),
		);
		expect((await harness.processor({ encodingJobId: JOB_ID })).status).toBe(
			"FINISHED",
		);
		expect(callbackResult).toBe("PERSISTED");
		const early = harness.updates.find((update) =>
			(update.stepLog as StepLogEntry[] | undefined)?.some(
				(entry) =>
					entry.kind === "CREATE_ENCODING" &&
					entry.status === "RUNNING" &&
					entry.resourceId === "bm-verified",
			),
		);
		// rev431: the pointer write also clears a stale stop/CREATED confirmation
		expect(early).toMatchObject({
			bitmovinEncodingId: "bm-verified",
			encoderStoppedConfirmedFor: null,
		});
		const earlyIndex = harness.updates.indexOf(
			early as Record<string, unknown>,
		);
		const doneIndex = harness.updates.findIndex((update) =>
			(update.stepLog as StepLogEntry[] | undefined)?.some(
				(entry) => entry.kind === "CREATE_ENCODING" && entry.status === "DONE",
			),
		);
		expect(earlyIndex).toBeGreaterThanOrEqual(0);
		expect(doneIndex).toBeGreaterThan(earlyIndex);
	});

	it("turns the provider-id barrier's ownership loss into LEASE_LOST without a stale ERROR write", async () => {
		let callbackResult: string | undefined;
		let harness: ReturnType<typeof setup>;
		harness = setup(
			{
				verificationKey: "verify:run-1:scenario-1:VOD_JOB",
				verificationRequestSha256: "d".repeat(64),
			},
			{},
			undefined,
			(args) =>
				fakeSdk({
					createEncoding: vi.fn(async () => {
						harness.row.attemptClaimedAt = new Date("2030-01-01T00:00:00.000Z");
						callbackResult = await args.stamp?.onEncodingCreated?.(
							"bm-lost-owner",
							"created",
						);
						if (callbackResult === "OWNERSHIP_LOST") {
							throw new VerificationProviderOwnershipLostError("bm-lost-owner");
						}
						return "bm-lost-owner";
					}),
				}),
		);
		expect((await harness.processor({ encodingJobId: JOB_ID })).status).toBe(
			"LEASE_LOST",
		);
		expect(callbackResult).toBe("OWNERSHIP_LOST");
		expect(harness.updates.some((update) => update.status === "ERROR")).toBe(
			false,
		);
	});

	it("classifies a proven pre-DB P1001 so the facade may compensate the created id", async () => {
		let callbackError: unknown;
		const harness = setup(
			{
				verificationKey: "verify:run-1:scenario-1:VOD_JOB",
				verificationRequestSha256: "f".repeat(64),
			},
			{},
			undefined,
			(args) =>
				fakeSdk({
					createEncoding: vi.fn(async () => {
						try {
							await args.stamp?.onEncodingCreated?.("bm-db-down", "created");
						} catch (err) {
							callbackError = err;
							throw new VerificationProviderIdPersistenceError(
								"bm-db-down",
								"created",
								"DEFINITELY_NOT_PERSISTED",
								{ stop: "FAILED", delete: "SUCCEEDED" },
								err,
							);
						}
						return "bm-db-down";
					}),
				}),
		);
		const { updateMany } = harness;
		const original = updateMany.getMockImplementation();
		if (!original) {
			throw new Error("harness updateMany carries no implementation");
		}
		updateMany.mockImplementation(async (args) => {
			const hasUnpersistedId = (
				args.data.stepLog as StepLogEntry[] | undefined
			)?.some(
				(entry) =>
					entry.kind === "CREATE_ENCODING" &&
					entry.status === "RUNNING" &&
					entry.resourceId === "bm-db-down",
			);
			if (hasUnpersistedId) {
				throw Object.assign(new Error("database unreachable"), {
					code: "P1001",
				});
			}
			return original(args);
		});
		await expect(
			harness.processor({ encodingJobId: JOB_ID }),
		).rejects.toBeInstanceOf(VerificationProviderIdPersistenceError);
		expect(callbackError).toBeInstanceOf(
			VerificationProviderIdDefinitelyNotPersistedError,
		);
		const failed = (harness.row.stepLog as StepLogEntry[]).find(
			(entry) => entry.kind === "CREATE_ENCODING",
		);
		expect(failed).toMatchObject({
			status: "FAILED",
			resourceId: "bm-db-down",
			response: {
				providerId: "bm-db-down",
				source: "created",
				durability: "DEFINITELY_NOT_PERSISTED",
				compensation: { stop: "FAILED", delete: "SUCCEEDED" },
			},
		});
	});

	it("records commit-after-timeout as unknown instead of claiming the provider id was not persisted", async () => {
		let callbackError: unknown;
		const harness = setup(
			{
				verificationKey: "verify:run-1:scenario-timeout:VOD_JOB",
				verificationRequestSha256: "e".repeat(64),
			},
			{},
			undefined,
			(args) =>
				fakeSdk({
					createEncoding: vi.fn(async () => {
						try {
							await args.stamp?.onEncodingCreated?.(
								"bm-db-ambiguous",
								"created",
							);
						} catch (err) {
							callbackError = err;
							throw new VerificationProviderIdPersistenceError(
								"bm-db-ambiguous",
								"created",
								"PERSISTENCE_UNKNOWN",
								{ stop: "SKIPPED_UNKNOWN", delete: "SKIPPED_UNKNOWN" },
								err,
							);
						}
						return "bm-db-ambiguous";
					}),
				}),
		);
		const original = harness.updateMany.getMockImplementation();
		if (!original)
			throw new Error("harness updateMany carries no implementation");
		let timedOut = false;
		harness.updateMany.mockImplementation(async (args) => {
			const hasAmbiguousId = (
				args.data.stepLog as StepLogEntry[] | undefined
			)?.some(
				(entry) =>
					entry.status === "RUNNING" && entry.resourceId === "bm-db-ambiguous",
			);
			if (hasAmbiguousId && !timedOut) {
				timedOut = true;
				throw Object.assign(new Error("database response timed out"), {
					code: "P1002",
				});
			}
			return original(args);
		});
		await expect(
			harness.processor({ encodingJobId: JOB_ID }),
		).rejects.toBeInstanceOf(VerificationProviderIdPersistenceError);
		expect(callbackError).toMatchObject({ code: "P1002" });
		const failed = (harness.row.stepLog as StepLogEntry[]).find(
			(entry) => entry.kind === "CREATE_ENCODING",
		);
		expect(failed?.response).toMatchObject({
			providerId: "bm-db-ambiguous",
			durability: "PERSISTENCE_UNKNOWN",
			compensation: {
				stop: "SKIPPED_UNKNOWN",
				delete: "SKIPPED_UNKNOWN",
			},
		});
		expect(failed?.error).toContain("unknown database commit outcome");
		expect(failed?.error).not.toContain("was not durably persisted");
	});

	it("executes every step, records ids, and finishes the job", async () => {
		const { processor, row, sdk, updates } = setup();
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("FINISHED");
		expect(row.status).toBe("FINISHED");
		// rev431: the ordinary CREATE-step persist (the only worker clear for a
		// non-verification job) voids any stop/CREATED confirmation
		const pointerWrite = updates.find(
			(u) => u.bitmovinEncodingId === "bm-encoding",
		);
		expect(pointerWrite).toMatchObject({ encoderStoppedConfirmedFor: null });
		// finishedAt rides the SAME terminal write, derived inside persist —
		// @updatedAt is bumped by later writers and cannot serve as the finish
		// time (review-259 116-A1); deleting the derivation must fail HERE.
		expect(row.finishedAt).toBeDefined();
		expect(row.bitmovinEncodingId).toBe("bm-encoding");
		expect(sdk.startEncoding).toHaveBeenCalledWith(
			"bm-encoding",
			expect.objectContaining({ manifestGenerator: "V2" }),
		);
		const entries = row.stepLog as { status: string }[];
		expect(entries.every((e) => e.status === "DONE")).toBe(true);
	});

	it("never resurrects a CANCELED verification row when its delayed create enqueue arrives", async () => {
		// POST can commit the local row, then recovery can cancel it before the
		// route's queue.add completes. The later queue job must remain a no-op.
		const { processor, row, sdk, updates } = setup({
			status: "CANCELED",
			verificationKey: "verify:run:scenario:VOD_JOB",
			verificationRequestSha256: "a".repeat(64),
		});
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("CANCELED");
		expect(row.status).toBe("CANCELED");
		expect(sdk.createEncoding).not.toHaveBeenCalled();
		expect(updates).toHaveLength(0);
	});

	it.each([
		true,
		false,
	])("only replays a rejected PSNR create after a proven refusal (%s)", async (definitive) => {
		const video = basePlan.renditions.find(({ codec }) => codec === "H264");
		if (!video) throw new Error("Fixture has no video");
		const plan = encodingPlanSchema.parse({
			...basePlan,
			bitmovin: { ...basePlan.bitmovin, accountId: ACCOUNT_ID },
			supplements: [{ kind: "PSNR", key: "psnr", renditionKey: video.key }],
		});
		let stamp: CreateStamp | undefined;
		const send = vi.fn(async () => {});
		const sdk = fakeSdk({
			createEncodingSupplement: vi.fn(async () => {
				if (stamp?.adoptWindow?.())
					throw new Error("Could not verify interrupted registration");
				await send();
				if (send.mock.calls.length === 1)
					throw definitive
						? new ProviderCreateRefusal(403)
						: new Error("Disconnected");
				return undefined;
			}),
		});
		const { processor, row } = setup(
			{ plan, stepLog: initStepLog(compilePlan(plan)) },
			{},
			undefined,
			(options) => {
				stamp = options.stamp;
				return sdk;
			},
		);
		await expect(processor({ encodingJobId: JOB_ID })).rejects.toThrow();
		const history = row.stepLog as StepLogEntry[];
		const failed = history.find(
			(entry) => entry.kind === "CREATE_ENCODING_SUPPLEMENT",
		);
		expect(failed?.response).toEqual(
			definitive
				? { providerCreateRefused: true, httpStatusCode: 403 }
				: undefined,
		);
		row.stepLog = reseedFailedSteps(history);
		row.status = "QUEUED";
		const retry = processor({ encodingJobId: JOB_ID });
		if (definitive) await retry;
		else await expect(retry).rejects.toThrow(/verify interrupted/);
		expect(send).toHaveBeenCalledTimes(definitive ? 2 : 1);
	});

	it("keeps Azure supplement preflight resumable until a create is sent", async () => {
		const video = basePlan.renditions.find(({ codec }) => codec === "H264");
		if (!video) throw new Error("Missing supplement fixture");
		const plan = encodingPlanSchema.parse({
			...basePlan,
			bitmovin: { ...basePlan.bitmovin, accountId: ACCOUNT_ID },
			outputs: [
				...basePlan.outputs,
				...["azure", "mirror"].map((key) => ({
					key,
					kind: "AZURE",
					credentialId: ACCOUNT_ID,
					container: key,
				})),
			],
			deliveryMirrors: [{ outputKey: "mirror" }],
			supplements: [
				{
					kind: "BIF",
					key: "preview",
					renditionKey: video.key,
					destination: { outputKey: "azure", path: "extras/" },
					filename: "preview.bif",
					distance: 10,
					width: 320,
				},
			],
		});
		const stepLog = initStepLog(compilePlan(plan));
		for (const step of stepLog) {
			if (step.kind === "CREATE_OUTPUT_AZURE") {
				step.status = "DONE";
				step.resourceId = step.step;
			}
		}
		let stamp: CreateStamp | undefined;
		const create = vi.fn(async () => "preview-id");
		const preflight = vi.fn(async (outputId: string) => {
			const saved = (row.stepLog as StepLogEntry[]).find(
				(entry) => entry.kind === "CREATE_ENCODING_SUPPLEMENT",
			);
			expect(saved?.startedAt).toBeUndefined();
			expect(saved?.status).toBe("PENDING");
			expect(create).not.toHaveBeenCalled();
			if (preflight.mock.calls.length === 1)
				throw new Error("Azure output details unavailable");
			return outputId;
		});
		const { processor, row } = setup(
			{ plan, stepLog },
			{},
			undefined,
			(options) => {
				stamp = options.stamp;
				return fakeSdk({
					getAzureOutputStorageKey: preflight,
					createEncodingSupplement: async () => {
						if (stamp?.adoptWindow?.())
							throw new Error("Unexpected reconciliation");
						return create();
					},
				});
			},
		);
		await expect(processor({ encodingJobId: JOB_ID })).rejects.toThrow(
			"Azure output details unavailable",
		);
		const history = row.stepLog as StepLogEntry[];
		expect(
			history.find(({ kind }) => kind === "CREATE_ENCODING_SUPPLEMENT")
				?.startedAt,
		).toBeUndefined();
		row.stepLog = reseedFailedSteps(history);
		row.status = "QUEUED";
		await processor({ encodingJobId: JOB_ID });
		expect(preflight.mock.calls).toEqual([
			["output:azure"],
			["output:mirror"],
			["output:azure"],
			["output:mirror"],
		]);
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("resumes by skipping DONE steps and reusing their resource ids", async () => {
		const { processor, row, sdk } = setup();
		const entries = row.stepLog as {
			step: string;
			status: string;
			resourceId?: string;
		}[];
		const first = entries[0];
		const second = entries[1];
		if (!first || !second) {
			throw new Error("fixture entries missing");
		}
		first.status = "DONE";
		first.resourceId = "bm-existing-input";
		second.status = "DONE";
		second.resourceId = "bm-existing-output";

		await processor({ encodingJobId: JOB_ID });
		expect(sdk.createS3Input).not.toHaveBeenCalled();
		expect(sdk.createS3Output).not.toHaveBeenCalled();
		// The ingest streams must reference the pre-existing input id.
		expect(sdk.createIngestInputStream).toHaveBeenCalledWith(
			"bm-encoding",
			expect.objectContaining({ inputId: "bm-existing-input" }),
		);
	});

	it("retains successful S3 role creates when IAM denies the subsequent start", async () => {
		const plan = structuredClone(basePlan);
		plan.bitmovin.accountId = ACCOUNT_ID;
		plan.inputs = plan.inputs.map((input) =>
			input.kind === "S3" ? { ...input, kind: "S3_ROLE_BASED" } : input,
		);
		plan.outputs = plan.outputs.map((output) =>
			output.kind === "S3" ? { ...output, kind: "S3_ROLE_BASED" } : output,
		);
		const transport = vi.fn(async (url: string) => {
			if (url.endsWith("/encoding/inputs/s3-role-based"))
				return Response.json({
					data: {
						result: { id: "role-input", externalId: "provider-global-id" },
					},
				});
			if (url.endsWith("/encoding/outputs/s3-role-based"))
				return Response.json({ data: { result: { id: "role-output" } } });
			throw new Error("Unexpected provider call");
		});
		vi.stubGlobal("fetch", transport);
		try {
			const roleSdk = createBitmovinSdkOps(
				{ apiKey: "fixture" },
				async () => {},
			);
			const startEncoding = vi.fn(async () => {});
			startEncoding.mockRejectedValueOnce(
				new Error("IAM trust policy rejected the role"),
			);
			const { processor, row, deps } = setup(
				{ plan, stepLog: initStepLog(compilePlan(plan)) },
				{
					startEncoding,
					createS3RoleBasedInput: roleSdk.createS3RoleBasedInput,
					createS3RoleBasedOutput: roleSdk.createS3RoleBasedOutput,
				},
			);
			vi.mocked(deps.resolveCredential).mockResolvedValue({
				provider: "AWS_S3_ROLE_BASED",
				config: {
					roleArn: "arn:aws:iam::123456789012:role/encoding",
					externalId: "legacy-local-id",
					region: "us-east-1",
				},
				secret: {},
			});
			await expect(processor({ encodingJobId: JOB_ID })).rejects.toThrow(
				"IAM trust policy rejected the role",
			);
			const persisted = row.stepLog as StepLogEntry[];
			expect(persisted).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "CREATE_INPUT_S3_ROLE_BASED",
						status: "DONE",
						resourceId: "role-input",
					}),
					expect.objectContaining({
						kind: "CREATE_OUTPUT_S3_ROLE_BASED",
						status: "DONE",
						resourceId: "role-output",
					}),
					expect.objectContaining({ kind: "START_ENCODING", status: "FAILED" }),
				]),
			);
			expect(JSON.stringify(persisted)).not.toMatch(
				/legacy-local-id|provider-global-id|arn:aws:/,
			);
			row.stepLog = reseedFailedSteps(persisted);
			row.status = "QUEUED";
			expect(await processor({ encodingJobId: JOB_ID })).toMatchObject({
				status: "FINISHED",
			});
			expect(transport).toHaveBeenCalledTimes(2);
			expect(startEncoding).toHaveBeenCalledTimes(2);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it.each([
		["inputs", "late-visible"],
		["outputs", "late-visible"],
		["outputs", "exact-refusal"],
		["outputs", "done-write-failed"],
		["outputs", "invalid-role"],
		["outputs", "provider-500"],
	] as const)("recovers %s role storage without duplicating %s creates", async (direction, outcome) => {
		const plan = structuredClone(basePlan);
		plan.bitmovin.accountId = ACCOUNT_ID;
		if (direction === "inputs")
			plan.inputs = plan.inputs.map((input) =>
				input.kind === "S3" ? { ...input, kind: "S3_ROLE_BASED" } : input,
			);
		else
			plan.outputs = plan.outputs.map((output) =>
				output.kind === "S3" ? { ...output, kind: "S3_ROLE_BASED" } : output,
			);
		const kind =
			direction === "inputs"
				? "CREATE_INPUT_S3_ROLE_BASED"
				: "CREATE_OUTPUT_S3_ROLE_BASED";
		const roleArn = "arn:aws:iam::111122223333:role/fixture-encoding";
		const externalId = "fixture-provider-external";
		const steps = initStepLog(compilePlan(plan));
		const target = steps.find((entry) => entry.kind === kind);
		const credentialId = target?.payload.credentialId;
		const originalName = target?.payload.name;
		if (typeof originalName !== "string")
			throw new Error("Missing authored storage name");
		const needsRecovery =
			outcome !== "exact-refusal" && outcome !== "invalid-role";
		const originalRole =
			outcome === "invalid-role"
				? "arn:aws:iam::111122223333:role/rejected-by-provider"
				: roleArn;
		let activeRole = originalRole;
		const h = setup({ plan, stepLog: steps });
		const savedAccount = {
			apiKey: "fixture-key",
			tenantOrgId: "fixture-tenant",
			resourceScopeVersion: "00000000-0000-4000-8000-0000000000fe",
		};
		vi.mocked(h.deps.revealBitmovinAccount).mockResolvedValue(savedAccount);
		vi.mocked(h.deps.resolveCredential).mockImplementation(
			async (id): Promise<ResolvedCredential> =>
				id === credentialId
					? {
							provider: "AWS_S3_ROLE_BASED",
							config: { roleArn: activeRole, region: "us-east-1" },
							secret: {},
						}
					: {
							provider: "AWS_S3",
							config: {},
							secret: { accessKeyId: "a", secretAccessKey: "s" },
						},
		);
		const audit = vi.fn(
			async (_entry: { data: Record<string, unknown> }) => {},
		);
		const makeSdk = makeWorkerSdk({
			...h.prisma,
			auditLog: { create: audit },
		} as unknown as AppPrismaClient);
		h.deps.makeSdk = (args) => {
			const real = makeSdk(args);
			return {
				...h.sdk,
				createS3RoleBasedInput: real.createS3RoleBasedInput,
				createS3RoleBasedOutput: real.createS3RoleBasedOutput,
			};
		};
		const firstId = "00000000-0000-4000-8000-0000000000aa";
		const otherId = "00000000-0000-4000-8000-0000000000ab";
		const prefix = `/v1/encoding/${direction}/s3-role-based`;
		const requests: Record<string, unknown>[] = [];
		const journalAtSend: Array<StepLogEntry["roleStorageCreate"]> = [];
		let providerResource: Record<string, unknown> | undefined;
		let crashSnapshot: Record<string, unknown> | undefined;
		let isVisible = false;
		const visiblePages: URLSearchParams[] = [];
		const wire = vi.fn(async (rawUrl: string, init: RequestInit) => {
			const url = new URL(rawUrl);
			expect(new Headers(init.headers).get("X-Tenant-Org-Id")).toBe(
				"fixture-tenant",
			);
			if (init.method === "POST" && url.pathname === prefix) {
				const body = JSON.parse(String(init.body));
				requests.push(body);
				journalAtSend.push(
					(h.row.stepLog as StepLogEntry[]).find((entry) => entry.kind === kind)
						?.roleStorageCreate,
				);
				if (requests.length === 1 && !needsRecovery)
					return Response.json(
						{
							status: "ERROR",
							data: {
								code: outcome === "invalid-role" ? 1001 : 1002,
								message: `Role rejected ${originalRole}`,
							},
						},
						{ status: outcome === "invalid-role" ? 400 : 403 },
					);
				if (requests.length === 1) {
					providerResource = { ...body, id: firstId, externalId };
					crashSnapshot = structuredClone(h.row);
					if (outcome === "late-visible")
						throw new TypeError("connection lost after committed role storage");
					if (outcome === "provider-500")
						return Response.json(
							{
								status: "ERROR",
								data: { code: 1004, message: "Unexpected provider error" },
							},
							{ status: 500 },
						);
					return Response.json({ data: { result: providerResource } });
				}
				return Response.json({ data: { result: { id: otherId, externalId } } });
			}
			if (init.method === "GET" && url.pathname === prefix) {
				const inventory =
					isVisible && providerResource
						? [
								{
									...providerResource,
									id: otherId,
									description: "another attempt",
								},
								providerResource,
								...(direction === "outputs" && outcome === "late-visible"
									? Array.from({ length: 600 }, (_, index) => ({
											id: `another-resource-${index}`,
											name: originalName,
											description: "another attempt",
										}))
									: []),
							]
						: [];
				const { searchParams } = url;
				const query = searchParams.get("name") ?? "";
				const matches = inventory.filter((item) =>
					String(item.name).includes(query),
				);
				const offset = Number(searchParams.get("offset"));
				const limit = Number(searchParams.get("limit"));
				if (isVisible) visiblePages.push(searchParams);
				return Response.json({
					data: {
						result: {
							items: matches.slice(offset, offset + limit),
							totalCount: matches.length,
						},
					},
				});
			}
			if (init.method === "GET" && url.pathname === `${prefix}/${firstId}`)
				return Response.json({ data: { result: providerResource } });
			throw new Error("Unexpected provider call in role create fixture");
		});
		if (outcome === "done-write-failed") {
			const persist = h.updateMany.getMockImplementation();
			if (!persist) throw new Error("Missing fixture persistence");
			let fail = true;
			h.updateMany.mockImplementation(async (args) => {
				const entries = args.data.stepLog as StepLogEntry[] | undefined;
				if (
					fail &&
					entries?.some(
						(entry) => entry.kind === kind && entry.status === "DONE",
					)
				) {
					fail = false;
					throw new Error("Synthetic lost role DONE write");
				}
				return persist(args);
			});
		}
		vi.stubGlobal("fetch", wire);
		try {
			const first = h.processor({ encodingJobId: JOB_ID });
			if (outcome === "invalid-role")
				await expect(first).rejects.toMatchObject({
					httpStatusCode: 400,
					errorCode: 1001,
				});
			else await expect(first).rejects.toThrow();
			expect(requests).toHaveLength(1);
			expect(journalAtSend).toEqual([
				expect.objectContaining({ id: expect.any(String) }),
			]);
			expect(requests[0]?.name).toBe(journalAtSend[0]?.lookupName);
			expect(requests[0]?.name).toContain(journalAtSend[0]?.id);
			expect(requests[0]?.description).toBe(originalName);
			if (direction === "outputs")
				expect(requests[0]).not.toHaveProperty("customData");
			expect(h.row.status).toBe("ERROR");
			const failed = (h.row.stepLog as StepLogEntry[]).find(
				(entry) => entry.kind === kind,
			);
			if (needsRecovery)
				expect(failed?.roleStorageCreate?.id).toEqual(expect.any(String));
			else expect(failed?.roleStorageCreate).toBeUndefined();
			h.row.stepLog = reseedFailedSteps(h.row.stepLog as StepLogEntry[]);
			h.row.status = "QUEUED";
			isVisible = true;
			activeRole = roleArn;
			if (direction === "inputs" && crashSnapshot) {
				Object.assign(h.row, crashSnapshot, {
					status: "RUNNING",
					attemptClaimedAt: new Date(0),
				});
			}
			if (direction === "outputs" && outcome === "late-visible") {
				const priorCalls = wire.mock.calls.length;
				vi.mocked(h.deps.revealBitmovinAccount).mockResolvedValueOnce({
					...savedAccount,
					resourceScopeVersion: "00000000-0000-4000-8000-0000000000ff",
				});
				await expect(
					createOrchestratorProcessor(h.deps)({ encodingJobId: JOB_ID }),
				).rejects.toThrow("The original Bitmovin account is required");
				expect(wire).toHaveBeenCalledTimes(priorCalls);
				h.row.stepLog = reseedFailedSteps(h.row.stepLog as StepLogEntry[]);
				h.row.status = "QUEUED";
			}
			await expect(
				createOrchestratorProcessor(h.deps)({ encodingJobId: JOB_ID }),
			).resolves.toMatchObject({
				status: "FINISHED",
			});
			expect(requests).toHaveLength(needsRecovery ? 1 : 2);
			if (direction === "outputs" && outcome === "late-visible") {
				expect(visiblePages).toHaveLength(1);
				expect(visiblePages[0]?.get("name")).toBe(requests[0]?.name);
				expect(requests[0]?.name).not.toBe(originalName);
				expect(requests[0]?.description).toContain(originalName);
			}
			if (outcome === "invalid-role") {
				expect(requests.map((body) => body.roleArn)).toEqual([
					originalRole,
					roleArn,
				]);
				expect(visiblePages).toHaveLength(0);
			}
			if (needsRecovery) {
				expect(audit.mock.calls.map(([entry]) => entry.data)).toContainEqual(
					expect.objectContaining({
						method: "GET",
						path: prefix.replace(/^\/v1/, ""),
						bitmovinAccountId: ACCOUNT_ID,
						response: { id: firstId },
					}),
				);
			} else {
				expect(journalAtSend[1]?.id).toEqual(expect.any(String));
				expect(journalAtSend[1]?.id).not.toBe(journalAtSend[0]?.id);
			}
			expect(
				(h.row.stepLog as StepLogEntry[]).find((entry) => entry.kind === kind),
			).toMatchObject({
				status: "DONE",
				resourceId: needsRecovery ? firstId : otherId,
			});
			const stored = JSON.stringify([
				h.row.stepLog,
				h.emitted,
				audit.mock.calls,
			]);
			expect(
				stored.includes(roleArn) ||
					stored.includes(originalRole) ||
					stored.includes(externalId),
			).toBe(false);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("marks the failing step and the job on error, then rethrows", async () => {
		const { processor, row, sdk } = setup();
		(sdk.createEncoding as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("region rejected"),
		);
		await expect(processor({ encodingJobId: JOB_ID })).rejects.toThrow(
			"region rejected",
		);
		expect(row.status).toBe("ERROR");
		expect(row.error).toBe("region rejected");
		const entries = row.stepLog as {
			step: string;
			status: string;
			error?: string;
		}[];
		const failed = entries.find((e) => e.step === "encoding");
		expect(failed?.status).toBe("FAILED");
		expect(failed?.error).toBe("region rejected");
		// Earlier steps stay DONE for resume.
		expect(entries[0]?.status).toBe("DONE");
	});

	it.each([
		["START", "input", null],
		["STATUS_READ", "output", null],
		["STATUS_TASK", "output", null],
		["STATUS_TASK", "output", "HLS"],
		["STATUS_TASK", "output", "DASH"],
		["STATUS_TASK", "output", "SMOOTH"],
		["STATUS_READ", "output", "SMOOTH"],
		["START", null, null],
		["STATUS_TASK", null, "DASH"],
	] as const)("projects a %s failure with %s role-backed storage and manifest %s", async (failure, storage, manifest) => {
		let plan = structuredClone(basePlan);
		plan.bitmovin.accountId = ACCOUNT_ID;
		if (manifest) {
			const sample = plan.manifests[0];
			if (!sample) throw new Error("Missing manifest fixture");
			plan = encodingPlanSchema.parse({
				...plan,
				generation: { ...plan.generation, timing: "POST_ENCODING" },
				manifests:
					manifest === "HLS"
						? [sample]
						: [
								{
									key: sample.key,
									kind: manifest,
									destination: sample.destination,
								},
							],
			});
		}
		if (storage === "input")
			plan.inputs = plan.inputs.map((input) =>
				input.kind === "S3" ? { ...input, kind: "S3_ROLE_BASED" } : input,
			);
		if (storage === "output")
			plan.outputs = plan.outputs.map((output) =>
				output.kind === "S3" ? { ...output, kind: "S3_ROLE_BASED" } : output,
			);
		const stepLog = initStepLog(compilePlan(plan));
		for (const entry of stepLog) {
			if (
				entry.kind === "CREATE_INPUT_S3_ROLE_BASED" ||
				entry.kind === "CREATE_OUTPUT_S3_ROLE_BASED"
			) {
				entry.status = "DONE";
				entry.resourceId = `prior-${storage}-resource`;
			}
		}
		const h = setup({ plan, stepLog });
		const audit = vi.fn(
			async (_entry: { data: Record<string, unknown> }) => {},
		);
		const makeSdk = makeWorkerSdk({
			...h.prisma,
			auditLog: { create: audit },
		} as unknown as AppPrismaClient);
		h.deps.makeSdk = (args) => {
			const real = makeSdk(args);
			return {
				...h.sdk,
				startEncoding: real.startEncoding,
				getEncodingStatus: real.getEncodingStatus,
				startHlsManifest: real.startHlsManifest,
				getHlsManifestStatus: real.getHlsManifestStatus,
				startDashManifest: real.startDashManifest,
				getDashManifestStatus: real.getDashManifestStatus,
				startSmoothManifest: real.startSmoothManifest,
				getSmoothManifestStatus: real.getSmoothManifestStatus,
			};
		};

		const role = "arn:aws:iam::111122223333:role/fixture-encoding";
		const external = "global-credential-fixture-value";
		const providerText = storage
			? `AssumeRole denied for ${role}; received ${external}`
			: "Provider refused this account's encoding setup";
		const diagnostic = {
			code: 2104,
			message: providerText,
			developerMessage: storage ? external : "Internal debugging message",
		};
		const rejected = () =>
			Response.json(
				{
					requestId: "fixture-request",
					status: "ERROR",
					data: diagnostic,
				},
				{ status: 403 },
			);
		const wire = vi.fn(async (url: string, init: RequestInit) => {
			if (url.endsWith("/bm-encoding/start") && init.method === "POST")
				return failure === "START"
					? rejected()
					: Response.json({ data: { result: { status: "CREATED" } } });
			if (url.endsWith("/bm-encoding/status") && init.method === "GET") {
				if (manifest)
					return Response.json({ data: { result: { status: "FINISHED" } } });
				if (failure === "STATUS_READ") return rejected();
				return Response.json({
					data: {
						result:
							failure === "STATUS_TASK"
								? {
										status: "ERROR",
										error: { ...diagnostic, text: providerText },
										messages: [{ type: "ERROR", text: providerText }],
									}
								: { status: "CREATED" },
					},
				});
			}
			if (
				manifest &&
				url.includes(`/v1/encoding/manifests/${manifest.toLowerCase()}/`)
			) {
				if (init.method === "POST" && url.endsWith("/start"))
					return Response.json({ data: { result: { status: "CREATED" } } });
				if (init.method === "GET" && url.endsWith("/status")) {
					if (failure === "STATUS_READ") return rejected();
					return Response.json({
						data: {
							result: {
								status: "ERROR",
								error: { ...diagnostic, text: providerText },
								messages: [{ type: "ERROR", text: providerText }],
							},
						},
					});
				}
			}
			throw new Error("Unexpected provider call in role diagnostics fixture");
		});
		vi.stubGlobal("fetch", wire);
		try {
			const outcome = await h
				.processor({ encodingJobId: JOB_ID })
				.catch((error: unknown) => error);
			expect(outcome).toBeInstanceOf(Error);
			const message = (outcome as Error).message;
			if (storage || failure === "START") expect(message).toContain("2104");
			expect(h.row).toMatchObject({ status: "ERROR", error: message });
			expect(h.row.stepLog).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: manifest
							? `AWAIT_MANIFEST_${manifest}`
							: failure === "START"
								? "START_ENCODING"
								: "AWAIT_ENCODING",
						status: "FAILED",
						error: message,
					}),
				]),
			);
			expect(h.emitted).toContainEqual(
				expect.objectContaining({ kind: "JOB_ERROR", error: message }),
			);
			expect(wire).toHaveBeenCalledTimes(manifest ? 4 : 2);
			const startAudit = audit.mock.calls[0]?.[0].data;
			expect(startAudit).toMatchObject({
				method: "POST",
				path: "/encoding/encodings/bm-encoding/start",
				statusCode: failure === "START" ? 403 : 200,
			});
			if (failure === "START")
				expect(startAudit?.response).toMatchObject({ errorCode: 2104 });
			if (storage) {
				const outward = JSON.stringify([
					message,
					h.updates,
					h.emitted,
					audit.mock.calls,
				]);
				expect(
					outward.includes(role) ||
						outward.includes(external) ||
						outward.includes(providerText),
				).toBe(false);
			} else {
				expect(message).toContain(providerText);
				if (failure === "START")
					expect(startAudit?.error).toContain(providerText);
			}
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("ignores already-finished jobs", async () => {
		const { processor, sdk } = setup({ status: "FINISHED" });
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("FINISHED");
		expect(sdk.createS3Input).not.toHaveBeenCalled();
	});

	it("bumps the denormalized doneSteps to the DONE count on every persist", async () => {
		const { processor, row, updates } = setup();
		await processor({ encodingJobId: JOB_ID });
		const total = (row.stepLog as StepLogEntry[]).length;
		// The persist after the LAST step records every step DONE.
		const withDone = updates.filter((u) => typeof u.doneSteps === "number") as {
			doneSteps: number;
		}[];
		expect(withDone.at(-1)?.doneSteps).toBe(total);
		// doneSteps never exceeds the total and is monotonic (each post-step
		// persist either holds or advances the count).
		const counts = withDone.map((u) => u.doneSteps);
		expect(Math.max(...counts)).toBe(total);
		for (let i = 1; i < counts.length; i++) {
			expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1] as number);
		}
	});

	it("records the partial doneSteps count alongside the ERROR persist (loop not broken by the bump)", async () => {
		const { processor, updates, sdk } = setup();
		// Fail at the encoding create: the inputs/outputs before it are DONE,
		// so the failing persist still carries their partial doneSteps count.
		(sdk.createEncoding as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("region rejected"),
		);
		await expect(processor({ encodingJobId: JOB_ID })).rejects.toThrow(
			"region rejected",
		);
		const errorUpdate = updates.find((u) => u.status === "ERROR") as
			| { doneSteps: number }
			| undefined;
		// The ERROR persist carries the partial DONE count (> 0, the steps that
		// ran), proving the doneSteps bump shares the existing write and never
		// short-circuits the step loop's failure handling.
		expect(errorUpdate?.doneSteps).toBeGreaterThan(0);
	});

	it("persists useful task warnings while withholding private storage locations from finished step snapshots", async () => {
		const { processor, row } = setup(
			{},
			{
				getEncodingStatus: async () => ({
					status: "FINISHED",
					messages: [
						"Local warning",
						"Diagnostics at https://fixture.invalid/encoder?sig=FIXTURE_WARNING_VALUE",
					],
				}),
			},
		);
		await processor({ encodingJobId: JOB_ID });
		const entries = row.stepLog as StepLogEntry[];
		const snapshots = JSON.stringify(entries.map((e) => e.response));
		expect(snapshots).toContain("Local warning");
		expect(snapshots).toContain("[withheld]");
		expect(snapshots).not.toContain("FIXTURE_WARNING_VALUE");
	});
	it("invokes the onVodFinished hook once after FINISHED with the parsed plan", async () => {
		const onVodFinished = vi.fn(async () => {});
		const { processor, row } = setup({}, {}, onVodFinished);
		await processor({ encodingJobId: JOB_ID });
		expect(onVodFinished).toHaveBeenCalledTimes(1);
		expect(onVodFinished).toHaveBeenCalledWith({
			encodingJobId: JOB_ID,
			plan: row.plan,
		});
	});

	it("does not invoke onVodFinished when the job errors", async () => {
		const onVodFinished = vi.fn(async () => {});
		const { processor } = setup(
			{},
			{ createS3Input: vi.fn(() => Promise.reject(new Error("boom"))) },
			onVodFinished,
		);
		await expect(processor({ encodingJobId: JOB_ID })).rejects.toThrow("boom");
		expect(onVodFinished).not.toHaveBeenCalled();
	});

	it("swallows an onVodFinished failure (a green encoding stays FINISHED)", async () => {
		const onVodFinished = vi.fn(async () => {
			throw new Error("trigger blew up");
		});
		const { processor, row } = setup({}, {}, onVodFinished);
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("FINISHED");
		expect(row.status).toBe("FINISHED");
	});

	describe("cooperative cancel (ledger #10)", () => {
		// A single-encoding job mid-flight: the encoding is created (its id is
		// resolvable for a stop), started, and the await is the next PENDING
		// step. Used by the mid-run and mid-await cases.
		function midRunLog(): StepLogEntry[] {
			return [
				{
					step: "encoding",
					kind: "CREATE_ENCODING",
					payload: {},
					refs: {},
					status: "DONE",
					resourceId: "bm-enc",
				},
				{
					step: "start",
					kind: "START_ENCODING",
					payload: {},
					refs: { encodingId: "encoding" },
					status: "DONE",
				},
				{
					step: "await",
					kind: "AWAIT_ENCODING",
					payload: {},
					refs: { encodingId: "encoding" },
					status: "PENDING",
				},
			];
		}

		it.each([
			"cancel",
			"lease",
		] as const)("stops START retry sends when %s wins during the first delay", async (race) => {
			vi.useFakeTimers();
			try {
				const log = midRunLog();
				const startEntry = log.find((entry) => entry.kind === "START_ENCODING");
				if (!startEntry) throw new Error("Missing START fixture");
				startEntry.status = "PENDING";
				let sent = false;
				let stopping = false;
				const h = setup({
					status: "RUNNING",
					stepLog: log,
					bitmovinEncodingId: "bm-enc",
				});
				h.sdk.getEncodingStatus = vi.fn(async () => ({
					status: stopping ? "FINISHED" : sent ? "QUEUED" : "CREATED",
				}));
				h.sdk.stopEncoding = vi.fn(async () => {
					stopping = true;
				});
				h.deps.sleep = (ms) =>
					new Promise((resolve) => setTimeout(resolve, ms));
				const wire = vi.fn(async () => {
					sent = true;
					return new Response(
						JSON.stringify({
							status: "ERROR",
							data: { code: 1004, message: "Synthetic settle window" },
						}),
						{ status: 500 },
					);
				});
				vi.stubGlobal("fetch", wire);
				h.deps.makeSdk = (args) => ({
					...h.sdk,
					startEncoding: createBitmovinSdkOps(args, async () => {})
						.startEncoding,
				});
				let outcome: unknown;
				void h.processor({ encodingJobId: JOB_ID }).then(
					(result) => {
						outcome = result;
					},
					(error) => {
						outcome = error;
					},
				);
				await vi.advanceTimersByTimeAsync(0);
				expect(wire).toHaveBeenCalledOnce();
				const winner = new Date("2030-01-01T00:00:00Z");
				if (race === "cancel") h.row.cancelRequested = true;
				else h.row.attemptClaimedAt = winner;
				const acceptedBeforeRace = h.updates.length;
				await vi.advanceTimersByTimeAsync(1_000);
				expect(outcome).toMatchObject({
					status: race === "cancel" ? "CANCELED" : "LEASE_LOST",
				});
				expect(wire).toHaveBeenCalledOnce();
				expect(h.emitted.some((event) => event.kind === "JOB_ERROR")).toBe(
					false,
				);
				expect(
					h.updates
						.slice(acceptedBeforeRace)
						.some(
							(update) =>
								update.status === "ERROR" || update.status === "FINISHED",
						),
				).toBe(false);
				if (race === "cancel") {
					expect(h.sdk.stopEncoding).toHaveBeenCalledExactlyOnceWith("bm-enc");
					expect(h.row).toMatchObject({
						status: "CANCELED",
						error: null,
						bitmovinEncodingId: "bm-enc",
						encoderStoppedConfirmedFor: "bm-enc",
					});
					expect(
						(h.row.stepLog as StepLogEntry[]).find(
							(entry) => entry.kind === "START_ENCODING",
						),
					).toMatchObject({
						status: "RUNNING",
						startedAt: expect.any(String),
						error: undefined,
					});
				} else {
					expect(h.sdk.stopEncoding).not.toHaveBeenCalled();
					expect(h.row.attemptClaimedAt).toEqual(winner);
					expect(h.updates).toHaveLength(acceptedBeforeRace);
				}
			} finally {
				vi.clearAllTimers();
				vi.useRealTimers();
				vi.unstubAllGlobals();
			}
		});

		it.each([
			"QUEUED",
			"CREATED",
		])("retains the exact encoding after an in-flight START accepts during cancellation with provider state %s", async (providerStatus) => {
			vi.useFakeTimers();
			try {
				const log = midRunLog();
				const entry = log.find((item) => item.kind === "START_ENCODING");
				if (!entry) throw new Error("Missing START fixture");
				entry.status = "PENDING";
				let sent = false;
				let stopping = false;
				let accept: ((value: Response) => void) | undefined;
				const h = setup({
					status: "RUNNING",
					stepLog: log,
					bitmovinEncodingId: "bm-enc",
				});
				h.sdk.getEncodingStatus = vi.fn(async () => ({
					status: stopping ? "FINISHED" : sent ? providerStatus : "CREATED",
				}));
				h.sdk.stopEncoding = vi.fn(async () => {
					stopping = true;
				});
				const wire = vi.fn(() => {
					sent = true;
					return new Promise<Response>((resolve) => {
						accept = resolve;
					});
				});
				vi.stubGlobal("fetch", wire);
				h.deps.makeSdk = (args) => ({
					...h.sdk,
					startEncoding: createBitmovinSdkOps(args, async () => {})
						.startEncoding,
				});
				let outcome: unknown;
				void h.processor({ encodingJobId: JOB_ID }).then(
					(result) => {
						outcome = result;
					},
					(error) => {
						outcome = error;
					},
				);
				await vi.advanceTimersByTimeAsync(0);
				expect(accept).toBeDefined();
				h.row.cancelRequested = true;
				expect(outcome).toBeUndefined();
				accept?.(
					new Response(JSON.stringify({ data: { result: { id: "bm-enc" } } }), {
						status: 202,
					}),
				);
				await vi.advanceTimersByTimeAsync(0);
				expect(outcome).toMatchObject({ status: "CANCELED" });
				expect(wire).toHaveBeenCalledOnce();
				if (providerStatus === "QUEUED") {
					expect(h.sdk.stopEncoding).toHaveBeenCalledExactlyOnceWith("bm-enc");
					expect(h.row.encoderStoppedConfirmedFor).toBe("bm-enc");
				} else {
					expect(h.sdk.stopEncoding).not.toHaveBeenCalled();
					expect(h.row.encoderStoppedConfirmedFor).toBeNull();
				}
				expect(
					(h.row.stepLog as StepLogEntry[]).find(
						(item) => item.kind === "START_ENCODING",
					),
				).toMatchObject({ status: "RUNNING", startedAt: expect.any(String) });
				expect(
					h.emitted.some(
						(event) =>
							event.kind === "JOB_ERROR" || event.kind === "JOB_FINISHED",
					),
				).toBe(false);
			} finally {
				vi.clearAllTimers();
				vi.useRealTimers();
				vi.unstubAllGlobals();
			}
		});

		it.each([
			false,
			true,
		])("preserves prior START history %s when canceled before this pass sends", async (priorAttempt) => {
			const log = midRunLog();
			const entry = log.find((item) => item.kind === "START_ENCODING");
			if (!entry) throw new Error("Missing START fixture");
			entry.status = priorAttempt ? "RUNNING" : "PENDING";
			entry.startedAt = priorAttempt ? "2020-01-01T00:00:00Z" : undefined;
			const h = setup({
				status: "RUNNING",
				stepLog: log,
				bitmovinEncodingId: "bm-enc",
			});
			let stopping = false;
			h.sdk.getEncodingStatus = vi.fn(async () => ({
				status: stopping ? "FINISHED" : "CREATED",
			}));
			h.sdk.stopEncoding = vi.fn(async () => {
				stopping = true;
			});
			const wire = vi.fn();
			vi.stubGlobal("fetch", wire);
			h.deps.makeSdk = (args) => ({
				...h.sdk,
				startEncoding: createBitmovinSdkOps(
					{
						...args,
						startControl: {
							sleep: h.deps.sleep,
							check: async (attempted) => {
								h.row.cancelRequested = true;
								await args.startControl?.check(attempted);
							},
						},
					},
					async () => {},
				).startEncoding,
			});
			try {
				expect(await h.processor({ encodingJobId: JOB_ID })).toMatchObject({
					status: "CANCELED",
				});
				expect(wire).not.toHaveBeenCalled();
				const stored = (h.row.stepLog as StepLogEntry[]).find(
					(item) => item.kind === "START_ENCODING",
				);
				expect(stored?.status).toBe(priorAttempt ? "RUNNING" : "PENDING");
				if (priorAttempt) expect(stored?.startedAt).toBeDefined();
				else expect(stored?.startedAt).toBeUndefined();
			} finally {
				vi.unstubAllGlobals();
			}
		});

		// (a) cancel set before a QUEUED job is processed -> CANCELED, no steps
		// run, stopEncoding NOT called (nothing was ever started).
		it("cancels a QUEUED job before any step runs and stops nothing", async () => {
			const { processor, row, sdk } = setup({ cancelRequested: true });
			const result = await processor({ encodingJobId: JOB_ID });
			expect(result.status).toBe("CANCELED");
			expect(row.status).toBe("CANCELED");
			expect(row.error).toBeNull();
			// No encoding was created, so nothing is created or stopped, and the
			// job never flipped to RUNNING.
			expect(sdk.createS3Input).not.toHaveBeenCalled();
			expect(sdk.createEncoding).not.toHaveBeenCalled();
			expect(sdk.stopEncoding).not.toHaveBeenCalled();
			const ranRunning = (row.stepLog as StepLogEntry[]).some(
				(e) => e.status === "RUNNING" || e.status === "DONE",
			);
			expect(ranRunning).toBe(false);
		});

		it.each([
			false,
			true,
		])("honors accepted cancel with a retired HDR declaration, concurrent=%s", async (late) => {
			const plan = {
				...basePlan,
				bitmovin: { ...basePlan.bitmovin, accountId: ACCOUNT_ID },
				hdr10PlusStreams: [
					{
						key: "hdr",
						inputKey: "in",
						videoInputPath: "picture.mxf",
						metadataInputPath: "picture.mxf",
					},
				],
			};
			const { processor, row, sdk, updateMany, emitted } = setup(
				{
					plan,
					status: "RUNNING",
					cancelRequested: !late,
					stepLog: midRunLog(),
					bitmovinEncodingId: "bm-enc",
				},
				{ getEncodingStatus: vi.fn(async () => ({ status: "RUNNING" })) },
			);
			if (late) {
				const apply = updateMany.getMockImplementation();
				if (!apply) throw new Error("missing update seam");
				updateMany.mockImplementation(async (args) => {
					if (args.data.status === "ERROR") row.cancelRequested = true;
					return apply(args);
				});
			}
			expect(await processor({ encodingJobId: JOB_ID })).toMatchObject({
				status: "CANCELED",
			});
			expect(row.status).toBe("CANCELED");
			expect(emitted.map((e) => e.kind)).toEqual(["JOB_CANCELED"]);
			expect(sdk.stopEncoding).toHaveBeenCalledWith("bm-enc");
			expect(sdk.createEncoding).not.toHaveBeenCalled();
		});
		// (b) cancel before a mid-run step, with a running encoding -> CANCELED +
		// stopEncoding called for that encoding.
		it("cancels before the next step and stops the running encoding", async () => {
			const { processor, row, sdk } = setup(
				{
					status: "RUNNING",
					cancelRequested: true,
					stepLog: midRunLog(),
					// the CREATE step's persist mirrors the pointer onto the row (processor.ts)
					bitmovinEncodingId: "bm-enc",
				},
				{
					getEncodingStatus: vi.fn(() =>
						Promise.resolve({ status: "RUNNING" }),
					),
				},
			);
			const result = await processor({ encodingJobId: JOB_ID });
			expect(result.status).toBe("CANCELED");
			expect(row.status).toBe("CANCELED");
			expect(row.error).toBeNull();
			expect(sdk.stopEncoding).toHaveBeenCalledTimes(1);
			expect(sdk.stopEncoding).toHaveBeenCalledWith("bm-enc");
			expect(sdk.createEncoding).not.toHaveBeenCalled();
			expect(sdk.startEncoding).not.toHaveBeenCalled();
			// The PENDING await never started — it stays PENDING (not FAILED).
			const awaitStep = (row.stepLog as StepLogEntry[]).find(
				(e) => e.step === "await",
			);
			expect(awaitStep?.status).toBe("PENDING");
		});

		// (c) cancel detected DURING the AWAIT_ENCODING poll -> interrupted ->
		// CANCELED (not ERROR). The flag flips to true only once polling starts,
		// proving the in-await shouldCancel probe (not the before-step check)
		// caught it.
		it("interrupts an in-progress await and cancels (not errors)", async () => {
			const log = midRunLog();
			const { processor, row, sdk } = setup(
				{ status: "RUNNING", cancelRequested: false, stepLog: log },
				{
					getEncodingStatus: vi.fn(() => {
						// Still encoding; meanwhile the user hits cancel. The next
						// shouldCancel in awaitTask sees it and throws CancelRequested.
						row.cancelRequested = true;
						return Promise.resolve({ status: "RUNNING" });
					}),
				},
			);
			const result = await processor({ encodingJobId: JOB_ID });
			expect(result.status).toBe("CANCELED");
			expect(row.status).toBe("CANCELED");
			// NOT an error — the ERROR status must never have been written.
			expect(row.error).toBeNull();
			// The await was rolled back to PENDING (interrupted, not FAILED).
			const awaitStep = (row.stepLog as StepLogEntry[]).find(
				(e) => e.step === "await",
			);
			expect(awaitStep?.status).toBe("PENDING");
			expect(awaitStep?.error).toBeUndefined();
			// The running encoding was stopped by the finalize.
			expect(sdk.stopEncoding).toHaveBeenCalledWith("bm-enc");
		});

		// (d) stopEncoding failure -> still CANCELED (best-effort) + logged.
		it("row #313: a stop the provider applied by the readback stamps the encoding id it confirmed", async () => {
			const statuses = ["RUNNING", "CANCELED"];
			const { processor, row, sdk } = setup(
				{
					status: "RUNNING",
					cancelRequested: true,
					stepLog: midRunLog(),
					// the CREATE step's persist mirrors the pointer onto the row (processor.ts)
					bitmovinEncodingId: "bm-enc",
				},
				{
					getEncodingStatus: vi.fn(() =>
						Promise.resolve({ status: statuses.shift() ?? "CANCELED" }),
					),
					stopEncoding: vi.fn(() => Promise.resolve()),
				},
			);
			const result = await processor({ encodingJobId: JOB_ID });
			expect(result.status).toBe("CANCELED");
			expect(sdk.stopEncoding).toHaveBeenCalledWith("bm-enc");
			expect(sdk.getEncodingStatus).toHaveBeenCalledTimes(2);
			// rev425 C1: the stamp IS the encoding id, so a retry that re-points
			// the row stops matching it by construction.
			expect(row.encoderStoppedConfirmedFor).toBe("bm-enc");
		});

		it("row #313: a readback of QUEUED after the stop is not terminal — no stamp", async () => {
			const statuses = ["RUNNING", "QUEUED"];
			const { processor, row, sdk } = setup(
				{
					status: "RUNNING",
					cancelRequested: true,
					stepLog: midRunLog(),
					// the CREATE step's persist mirrors the pointer onto the row (processor.ts)
					bitmovinEncodingId: "bm-enc",
				},
				{
					getEncodingStatus: vi.fn(() =>
						Promise.resolve({ status: statuses.shift() ?? "QUEUED" }),
					),
					stopEncoding: vi.fn(() => Promise.resolve()),
				},
			);
			await processor({ encodingJobId: JOB_ID });
			expect(row.status).toBe("CANCELED");
			expect(sdk.stopEncoding).toHaveBeenCalledWith("bm-enc");
			expect(row.encoderStoppedConfirmedFor ?? null).toBeNull();
		});

		it("row #313: a CREATED encoding is neither stopped nor confirmed — a retry can still start it (rev425 R2)", async () => {
			const { processor, row, sdk } = setup(
				{
					status: "RUNNING",
					cancelRequested: true,
					stepLog: midRunLog(),
					// the CREATE step's persist mirrors the pointer onto the row (processor.ts)
					bitmovinEncodingId: "bm-enc",
				},
				{
					getEncodingStatus: vi.fn(() =>
						Promise.resolve({ status: "CREATED" }),
					),
					stopEncoding: vi.fn(() => Promise.resolve()),
				},
			);
			await processor({ encodingJobId: JOB_ID });
			expect(row.status).toBe("CANCELED");
			expect(sdk.stopEncoding).not.toHaveBeenCalled();
			expect(row.encoderStoppedConfirmedFor ?? null).toBeNull();
		});

		it("row #313: a stop the provider has not applied by the readback leaves the job unconfirmed", async () => {
			const { processor, row } = setup(
				{
					status: "RUNNING",
					cancelRequested: true,
					stepLog: midRunLog(),
					// the CREATE step's persist mirrors the pointer onto the row (processor.ts)
					bitmovinEncodingId: "bm-enc",
				},
				{
					getEncodingStatus: vi.fn(() =>
						Promise.resolve({ status: "RUNNING" }),
					),
					stopEncoding: vi.fn(() => Promise.resolve()),
				},
			);
			await processor({ encodingJobId: JOB_ID });
			expect(row.status).toBe("CANCELED");
			expect(row.encoderStoppedConfirmedFor ?? null).toBeNull();
		});

		it("row #313: an encoding already terminal before the cancel counts as confirmed", async () => {
			const { processor, row, sdk } = setup(
				{
					status: "RUNNING",
					cancelRequested: true,
					stepLog: midRunLog(),
					// the CREATE step's persist mirrors the pointer onto the row (processor.ts)
					bitmovinEncodingId: "bm-enc",
				},
				{
					getEncodingStatus: vi.fn(() =>
						Promise.resolve({ status: "FINISHED" }),
					),
					stopEncoding: vi.fn(() => Promise.resolve()),
				},
			);
			await processor({ encodingJobId: JOB_ID });
			expect(sdk.stopEncoding).not.toHaveBeenCalled();
			expect(row.encoderStoppedConfirmedFor).toBe("bm-enc");
		});

		it("still cancels when stopEncoding fails (best-effort)", async () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const { processor, row, sdk } = setup(
				{
					status: "RUNNING",
					cancelRequested: true,
					stepLog: midRunLog(),
					// the CREATE step's persist mirrors the pointer onto the row (processor.ts)
					bitmovinEncodingId: "bm-enc",
				},
				{
					getEncodingStatus: vi.fn(() =>
						Promise.resolve({ status: "RUNNING" }),
					),
					stopEncoding: vi.fn(() => Promise.reject(new Error("stop refused"))),
				},
			);
			const result = await processor({ encodingJobId: JOB_ID });
			expect(result.status).toBe("CANCELED");
			expect(row.status).toBe("CANCELED");
			expect(row.error).toBeNull();
			// : a refused stop is an UNPROVEN stop — no confirmation stamp
			expect(row.encoderStoppedConfirmedFor ?? null).toBeNull();
			expect(sdk.stopEncoding).toHaveBeenCalledWith("bm-enc");
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("failed to stop encoding bm-enc"),
				expect.anything(),
			);
			errorSpy.mockRestore();
		});

		// (e) crash-resume: a job persisted cancelRequested=true resumes and
		// honors it -> CANCELED (idempotent; the flag is re-read from the DB).
		it("honors a persisted cancel flag on resume (idempotent)", async () => {
			// Encoding created (a prior attempt), await pending — exactly a resume.
			// cancelRequested survived the crash.
			const log = midRunLog();
			const { processor, row, sdk } = setup(
				{ status: "RUNNING", cancelRequested: true, stepLog: log },
				{
					getEncodingStatus: vi.fn(() =>
						Promise.resolve({ status: "RUNNING" }),
					),
				},
			);
			const result = await processor({ encodingJobId: JOB_ID });
			expect(result.status).toBe("CANCELED");
			expect(row.status).toBe("CANCELED");
			// Did NOT recreate the already-DONE encoding (resume contract intact).
			expect(sdk.createEncoding).not.toHaveBeenCalled();
			expect(sdk.stopEncoding).toHaveBeenCalledWith("bm-enc");
		});

		// (f) a job that FINISHED before the check is NOT reverted to CANCELED.
		it("does not revert an already-FINISHED job", async () => {
			const { processor, row, sdk } = setup({
				status: "FINISHED",
				cancelRequested: true,
			});
			const result = await processor({ encodingJobId: JOB_ID });
			expect(result.status).toBe("FINISHED");
			expect(row.status).toBe("FINISHED");
			// Early-return before any work: no stop, no recreate.
			expect(sdk.stopEncoding).not.toHaveBeenCalled();
			expect(sdk.createS3Input).not.toHaveBeenCalled();
		});

		// (g) the normal (no-cancel) path is unchanged — a full run still
		// FINISHES with every step DONE and stopEncoding never called.
		it("leaves the normal no-cancel path unchanged", async () => {
			const { processor, row, sdk } = setup();
			const result = await processor({ encodingJobId: JOB_ID });
			expect(result.status).toBe("FINISHED");
			expect(row.status).toBe("FINISHED");
			expect(sdk.stopEncoding).not.toHaveBeenCalled();
			const entries = row.stepLog as StepLogEntry[];
			expect(entries.every((e) => e.status === "DONE")).toBe(true);
		});
	});

	describe("stop-siblings on AWAIT_ENCODING failure", () => {
		// Multi-encoding ladder shape (Dolby DV/SDR): both encodings started,
		// the first await fails while the sibling is still RUNNING.
		function ladderLog(): StepLogEntry[] {
			return [
				{
					step: "encoding:dv",
					kind: "CREATE_ENCODING",
					payload: {},
					refs: {},
					status: "DONE",
					resourceId: "bm-enc-dv",
				},
				{
					step: "encoding:sdr",
					kind: "CREATE_ENCODING",
					payload: {},
					refs: {},
					status: "DONE",
					resourceId: "bm-enc-sdr",
				},
				{
					step: "start:dv",
					kind: "START_ENCODING",
					payload: {},
					refs: { encodingId: "encoding:dv" },
					status: "DONE",
				},
				{
					step: "start:sdr",
					kind: "START_ENCODING",
					payload: {},
					refs: { encodingId: "encoding:sdr" },
					status: "DONE",
				},
				{
					step: "await:dv",
					kind: "AWAIT_ENCODING",
					payload: {},
					refs: { encodingId: "encoding:dv" },
					status: "PENDING",
				},
				{
					step: "await:sdr",
					kind: "AWAIT_ENCODING",
					payload: {},
					refs: { encodingId: "encoding:sdr" },
					status: "PENDING",
				},
			];
		}

		function statusSdk(statusByEncoding: Record<string, string>) {
			return {
				getEncodingStatus: vi.fn((encodingId: string) =>
					Promise.resolve({
						status: statusByEncoding[encodingId] ?? "FINISHED",
					}),
				),
			};
		}

		it("stops still-running siblings and records the stops on the failed step", async () => {
			const { processor, row, sdk } = setup(
				{ stepLog: ladderLog() },
				statusSdk({ "bm-enc-dv": "ERROR", "bm-enc-sdr": "RUNNING" }),
			);
			await expect(processor({ encodingJobId: JOB_ID })).rejects.toThrow(
				/await:dv ended ERROR/,
			);
			expect(sdk.stopEncoding).toHaveBeenCalledTimes(1);
			expect(sdk.stopEncoding).toHaveBeenCalledWith("bm-enc-sdr");
			const entries = row.stepLog as StepLogEntry[];
			const failed = entries.find((e) => e.step === "await:dv");
			expect(failed?.status).toBe("FAILED");
			expect(failed?.response).toMatchObject({
				stoppedSiblings: [
					{
						step: "encoding:sdr",
						encodingId: "bm-enc-sdr",
						status: "RUNNING",
					},
				],
			});
			expect(row.status).toBe("ERROR");
		});

		it("leaves already-terminal siblings alone", async () => {
			const { processor, sdk } = setup(
				{ stepLog: ladderLog() },
				statusSdk({ "bm-enc-dv": "ERROR", "bm-enc-sdr": "FINISHED" }),
			);
			await expect(processor({ encodingJobId: JOB_ID })).rejects.toThrow(
				/await:dv ended ERROR/,
			);
			expect(sdk.stopEncoding).not.toHaveBeenCalled();
		});

		it("logs stop failures without masking the original await error", async () => {
			const { processor, row, sdk } = setup(
				{ stepLog: ladderLog() },
				{
					...statusSdk({ "bm-enc-dv": "ERROR", "bm-enc-sdr": "RUNNING" }),
					stopEncoding: vi.fn(() => Promise.reject(new Error("stop refused"))),
				},
			);
			// The await failure must surface — not the stop failure.
			await expect(processor({ encodingJobId: JOB_ID })).rejects.toThrow(
				/await:dv ended ERROR/,
			);
			expect(sdk.stopEncoding).toHaveBeenCalledWith("bm-enc-sdr");
			const entries = row.stepLog as StepLogEntry[];
			const failed = entries.find((e) => e.step === "await:dv");
			expect(failed?.response).toMatchObject({
				stoppedSiblings: [
					{
						step: "encoding:sdr",
						encodingId: "bm-enc-sdr",
						error: "stop refused",
					},
				],
			});
		});
	});
});

it("persists and emits only the public provider failure diagnostic", async () => {
	const { processor, row, updates, emitted } = setup(
		{},
		{
			createEncoding: vi.fn(async () => {
				throw new Error(
					"Provider input https://fixture.invalid/input?\nkey=PRIVATE_STEP_SAMPLE",
				);
			}),
		},
	);
	await expect(processor({ encodingJobId: JOB_ID })).rejects.toThrow(
		"[withheld]",
	);
	expect(row).toMatchObject({ status: "ERROR", error: "[withheld]" });
	expect(row.stepLog).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ status: "FAILED", error: "[withheld]" }),
		]),
	);
	expect(emitted).toContainEqual(
		expect.objectContaining({ kind: "JOB_ERROR", error: "[withheld]" }),
	);
	expect(JSON.stringify(updates)).not.toContain("PRIVATE_STEP_SAMPLE");
});

it("executes and records the same literal Dolby Vision key on the selected S3 input", async () => {
	const plan = structuredClone(basePlan);
	plan.bitmovin.accountId = ACCOUNT_ID;
	const key = "reels/take.mxf?auth=review";
	plan.dolbyStreams = [
		{ kind: "VISION", key: "vision", inputKey: "main", videoInputPath: key },
	];
	const { processor, sdk, row } = setup({
		plan,
		stepLog: initStepLog(compilePlan(plan)),
	});
	await processor({ encodingJobId: JOB_ID });
	const entries = row.stepLog as StepLogEntry[];
	const producer = entries.find((entry) => entry.step === "input:main");
	const consumer = entries.find((entry) => entry.step === "dolby:vision");
	expect(sdk.createDolbyVisionInputStream).toHaveBeenCalledWith(
		"bm-encoding",
		expect.objectContaining({
			inputId: producer?.resourceId,
			videoInputPath: key,
		}),
	);
	expect(consumer).toMatchObject({
		status: "DONE",
		request: {
			videoInputPath: key,
			refs: { inputId: producer?.resourceId, encodingId: "bm-encoding" },
		},
	});
	expect(consumer?.response).toEqual({ id: consumer?.resourceId });
});

it("rejects a queued unsupported HDR10+ trim before provider access", async () => {
	const p = structuredClone(basePlan);
	p.bitmovin = {
		...p.bitmovin,
		accountId: ACCOUNT_ID,
		encoderVersion: "2.294.0",
	};
	const [input] = p.inputs;
	if (!input) throw new Error("Missing fixture input");
	p.hdr10PlusStreams = [
		{
			key: "hdr",
			inputKey: input.key,
			videoInputPath: "source.mxf",
			metadataInputPath: "meta.json",
			selectionMode: "AUTO",
		},
	];
	p.trimmingStreams = [
		{ key: "trim", kind: "TIME_BASED", sourceKey: "hdr", duration: 3 },
	];
	const { processor, row, deps, sdk } = setup({ plan: p });
	await expect(processor({ encodingJobId: JOB_ID })).rejects.toThrow(/HDR10/);
	expect(row.status).toBe("ERROR");
	expect(deps.revealBitmovinAccount).not.toHaveBeenCalled();
	expect(sdk.createEncoding).not.toHaveBeenCalled();
});

describe("VMAF model capability — refuse BEFORE any Bitmovin resource (review-234 I1)", () => {
	const qcPlan = (model: string) => ({
		plan: (() => {
			const p = structuredClone(basePlan) as Record<string, unknown>;
			p.bitmovin = { ...(p.bitmovin as object), accountId: ACCOUNT_ID };
			p.qc = { vmaf: true, model };
			return p;
		})(),
	});

	it("does not require a VMAF model for standalone banding QC", async () => {
		const input = qcPlan("vmaf_v1.0.16_3d0h");
		input.plan.qc = { vmaf: false, banding: true, model: "vmaf_v1.0.16_3d0h" };
		const { processor, row } = setup(
			input,
			{},
			undefined,
			undefined,
			() => false,
		);
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("FINISHED");
		expect(row.status).toBe("FINISHED");
	});

	it("fails the job WITHOUT creating anything when the worker cannot load the model", async () => {
		const { processor, row, sdk } = setup(
			qcPlan("vmaf_v1.0.16_3d0h"),
			{},
			undefined,
			undefined,
			// A worker with no bundled models: built-ins only.
			(model) => model === "vmaf_v0.6.1",
		);
		await expect(processor({ encodingJobId: JOB_ID })).rejects.toThrow(
			/not a libvmaf built-in/i,
		);
		expect(row.status).toBe("ERROR");
		// The point of the whole guard: nothing was created, so nothing was
		// paid for. The previous behaviour failed at SCORING time — after the
		// encode had finished and every QC mirror had been downloaded.
		expect(sdk.createS3Input).not.toHaveBeenCalled();
		expect(sdk.createEncoding).not.toHaveBeenCalled();
		expect(sdk.startEncoding).not.toHaveBeenCalled();
	});

	it("runs normally when the worker HAS the model", async () => {
		const { processor, row } = setup(
			qcPlan("vmaf_v1.0.16_3d0h"),
			{},
			undefined,
			undefined,
			(model) => model === "vmaf_v1.0.16_3d0h",
		);
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("FINISHED");
		expect(row.status).toBe("FINISHED");
	});

	it("never refuses when the capability is UNKNOWN — an unknown must not manufacture a refusal", async () => {
		// No `vmafModelAvailable` at all: the same rule the validator follows.
		const { processor } = setup(qcPlan("vmaf_v1.0.16_3d0h"));
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("FINISHED");
	});

	it("never refuses a plan without qc, whatever the capability says", async () => {
		const { processor } = setup({}, {}, undefined, undefined, () => false);
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("FINISHED");
	});
});

describe("the #38 create stamp — threaded, not just declared", () => {
	it("hands makeSdk a stamp whose step tracks the executing step", async () => {
		// The first WIRING of this feature passed every test while index.ts's
		// destructure silently dropped the stamp — the feature was dead in
		// production with a green suite. This pins the processor half: makeSdk
		// RECEIVES the stamp, its jobId is the job's, and currentStep reads the
		// step that is executing at SDK-call time and nothing outside one.
		const seen: Array<string | undefined> = [];
		let stampRef:
			| { jobId: string; currentStep: () => string | undefined }
			| undefined;
		const { processor } = setup({}, {}, undefined, (args) => {
			stampRef = args.stamp;
			// A Proxy over the fake, method-name agnostic: every SDK call records
			// what the stamp would read at that moment — the same read the real
			// stamping fetch performs.
			return new Proxy(fakeSdk({}), {
				get(target, prop, receiver) {
					const value = Reflect.get(target, prop, receiver);
					if (typeof value !== "function") {
						return value;
					}
					return (...callArgs: unknown[]) => {
						seen.push(stampRef?.currentStep());
						return (value as (...a: unknown[]) => unknown).apply(
							target,
							callArgs,
						);
					};
				},
			});
		});
		await processor({ encodingJobId: JOB_ID });
		expect(stampRef?.jobId).toBe(JOB_ID);
		// Every SDK call happened INSIDE some step — never with a cleared slot.
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every((step) => typeof step === "string")).toBe(true);
		// Outside any step (now), the slot is cleared.
		expect(stampRef?.currentStep()).toBeUndefined();
	});

	it("adoptWindow() is true EXACTLY while a crash-leftover step re-executes", async () => {
		// sdk-ops runs adopt-before-create only in
		// this window. Too wide (true on fresh steps) and every happy-path
		// create pays a list + N customData GETs; too narrow (never true) and
		// adoption is dead code with a green suite — the same silent-drop shape
		// the stamp itself shipped with. Seed a step log whose FIRST entry was
		// left RUNNING by a "previous attempt"; record the window at every SDK
		// call.
		const plan = structuredClone(basePlan);
		plan.bitmovin.accountId = ACCOUNT_ID;
		const entries = initStepLog(compilePlan(plan));
		const crashStep = entries[0]?.step as string;
		(entries[0] as { status: string }).status = "RUNNING";
		const seen: Array<{ step: string | undefined; window: boolean }> = [];
		let stampRef:
			| {
					jobId: string;
					currentStep: () => string | undefined;
					adoptWindow?: () => boolean;
			  }
			| undefined;
		const { processor } = setup({ stepLog: entries }, {}, undefined, (args) => {
			stampRef = args.stamp;
			return new Proxy(fakeSdk({}), {
				get(target, prop, receiver) {
					const value = Reflect.get(target, prop, receiver);
					if (typeof value !== "function") {
						return value;
					}
					return (...callArgs: unknown[]) => {
						seen.push({
							step: stampRef?.currentStep(),
							window: stampRef?.adoptWindow?.() ?? false,
						});
						return (value as (...a: unknown[]) => unknown).apply(
							target,
							callArgs,
						);
					};
				},
			});
		});
		await processor({ encodingJobId: JOB_ID });
		const inCrashStep = seen.filter((c) => c.step === crashStep);
		const elsewhere = seen.filter((c) => c.step !== crashStep);
		expect(inCrashStep.length).toBeGreaterThan(0);
		expect(elsewhere.length).toBeGreaterThan(0);
		expect(inCrashStep.every((c) => c.window)).toBe(true);
		expect(elsewhere.every((c) => !c.window)).toBe(true);
		// Cleared outside any step, like the step slot itself.
		expect(stampRef?.adoptWindow?.()).toBe(false);
	});

	it("re-opens provider adoption for a verification CREATE that /retry reseeded to PENDING", async () => {
		const plan = structuredClone(basePlan);
		plan.bitmovin.accountId = ACCOUNT_ID;
		const entries = initStepLog(compilePlan(plan));
		const create = entries.find((entry) => entry.kind === "CREATE_ENCODING");
		if (!create) throw new Error("fixture CREATE_ENCODING missing");
		// /retry keeps these timestamps while changing FAILED/RUNNING to PENDING.
		// Treating this as a fresh create can duplicate a provider encoding whose
		// first response was lost.
		create.status = "PENDING";
		create.startedAt = "2026-06-10T23:59:00.000Z";
		create.finishedAt = "2026-06-10T23:59:01.000Z";
		let observedWindow: boolean | undefined;
		let stampRef: CreateStamp | undefined;
		const { processor } = setup(
			{
				stepLog: entries,
				verificationKey: "verify:run-1:retry:VOD_JOB",
				verificationRequestSha256: "a".repeat(64),
			},
			{},
			undefined,
			(args) => {
				stampRef = args.stamp;
				return fakeSdk({
					createEncoding: vi.fn(async () => {
						observedWindow = stampRef?.adoptWindow?.();
						return "bm-recovered";
					}),
				});
			},
		);
		await processor({ encodingJobId: JOB_ID });
		expect(observedWindow).toBe(true);
	});
});

/**
 * QC gate boundary : a BLOCK_MANIFESTS
 * plan compiles its manifest group phase:"post-qc", and the loop parks the
 * job AWAITING_QC at the first such step until the vmaf-runner's verdict —
 * delivered by a continuation enqueue of this same job — decides FINISHED
 * (run the group) or QC_FAILED (leave it PENDING for PR4's override).
 */
describe("orchestrator processor — QC gate boundary", () => {
	type VmafRow = {
		status: string;
		gateVerdict: unknown;
		error: string | null;
	} | null;

	function gateSetup(opts: {
		qcVmafEnabled?: boolean;
		qcVmafUnreadable?: boolean;
		rowStatus?: string;
		vmafRow?: VmafRow;
		/** Marks every NON-deferred step DONE (a parked job's log shape). */
		preGateDone?: boolean;
		claimLoses?: boolean;
		onVodFinished?: (args: {
			encodingJobId: string;
			plan: unknown;
		}) => Promise<void>;
	}) {
		const plan = structuredClone(basePlan);
		plan.bitmovin.accountId = ACCOUNT_ID;
		plan.generation.timing = "POST_ENCODING";
		plan.qc = {
			vmaf: true,
			model: "vmaf_v0.6.1",
			gate: {
				rules: [{ metric: "VMAF_MEAN", scope: "OVERALL", gte: 80 }],
				onFail: "BLOCK_MANIFESTS",
			},
		};
		const parsed = encodingPlanSchema.parse(plan);
		const stepLog = initStepLog(compilePlan(parsed));
		if (opts.preGateDone) {
			for (const entry of stepLog) {
				if (entry.phase !== "post-qc") {
					entry.status = "DONE";
					entry.resourceId = `bm-${entry.step}`;
				}
			}
		}
		const row: Record<string, unknown> = {
			id: JOB_ID,
			name: "gated-job",
			labels: ["qc"],
			status: opts.rowStatus ?? "QUEUED",
			plan: parsed,
			stepLog,
			bitmovinAccountId: null,
			cancelRequested: false,
		};
		const updates: Record<string, unknown>[] = [];
		const emitted: Record<string, unknown>[] = [];
		const prisma = {
			encodingJob: {
				findUnique: vi.fn(async () => row),
				update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
					updates.push(data);
					Object.assign(row, structuredClone(data));
					return row;
				}),
				updateMany: fakeUpdateMany(
					row,
					updates,
					() => opts.claimLoses === true,
				),
			},
			//  (review-265 131-A1): the boundary asks the flag when
			// there is no AUTO row. Harness default ON keeps every existing
			// wait-case testing what it was written for; the off-case pin
			// below flips it.
			appSetting: {
				findUnique: async () => {
					if (opts.qcVmafUnreadable) {
						throw new Error("settings row unreadable");
					}
					return { value: { qcVmaf: opts.qcVmafEnabled ?? true } };
				},
			},
			vmafJob: {
				/**
				 * HONOURS `select`. The QC gate reads `gateVerdict` out of a
				 * SELECTed row, and this mock used to return `opts.vmafRow`
				 * whatever was asked for — so dropping `gateVerdict` from the
				 * production select left all 36 gate tests green while, in
				 * production, `vmaf.gateVerdict` became undefined and EVERY
				 * gated delivery was refused with "QC verdict missing on a
				 * finished measurement" (review-213 proved both ends: the
				 * projecting mock keeps the baseline at 36 passed and turns
				 * that mutation into 2 failures).
				 *
				 * Honest about what this buys: `tsc` ALSO rejects that mutation
				 * here, because nothing casts the row — so this is
				 * defence-in-depth, not a live hole closed. The site where the
				 * compiler really was out of the loop is `vmaf/processor.ts`,
				 * where an `as`-cast re-asserted the whole select; that cast is
				 * deleted in the same change. Stating this because an earlier
				 * version of this same finding, on the feeder's mock, claimed a
				 * production no-op that tsc actually rejected.
				 */
				findFirst: vi.fn(
					async ({ select }: { select?: Record<string, boolean> } = {}) => {
						const row = opts.vmafRow ?? null;
						if (!row || !select) {
							return row;
						}
						return Object.fromEntries(
							Object.entries(row as Record<string, unknown>).filter(
								([key]) => select[key],
							),
						);
					},
				),
			},
		} as unknown as AppPrismaClient;
		const sdk = fakeSdk();
		const processor = createOrchestratorProcessor({
			prisma,
			revealBitmovinAccount: vi.fn(async () => ({
				apiKey: "key",
				tenantOrgId: null,
			})),
			resolveCredential: vi.fn(async () => ({
				provider: "AWS_S3",
				config: {},
				secret: { accessKeyId: "a", secretAccessKey: "s" },
			})),
			makeSdk: () => sdk,
			sleep: () => Promise.resolve(),
			pollIntervalMs: 1,
			pollTimeoutMs: 1000,
			now: () => "2026-06-11T00:00:00.000Z",
			emitEvent: async (event) => {
				emitted.push(event as unknown as Record<string, unknown>);
			},
			...(opts.onVodFinished ? { onVodFinished: opts.onVodFinished } : {}),
			vmafModelAvailable: null,
		});
		return { processor, row, updates, emitted, sdk, stepLog };
	}

	it("compiles the manifest group deferred and parks the job AWAITING_QC", async () => {
		// The trigger reads the SHARED row at call time: a fast measurement's
		// continuation can only find the park if it was persisted FIRST, so
		// firing the trigger before the persist is the bug this pin kills.
		const statusAtTriggerTime: unknown[] = [];
		let rowRef: Record<string, unknown> | undefined;
		const trigger = vi.fn(async () => {
			statusAtTriggerTime.push(rowRef?.status);
		});
		const setupResult = gateSetup({ onVodFinished: trigger });
		const { processor, row, sdk, stepLog, emitted } = setupResult;
		rowRef = row;
		// The compiled log carries a deferred group: the ENTIRE manifest family
		// (tree creates like CREATE_HLS_STREAM_INFO included) and nothing else
		// (kill: dropping the compiler stamp empties this set).
		const manifestFamily = /MANIFEST|HLS|DASH|SMOOTH/;
		const deferred = stepLog.filter((e) => e.phase === "post-qc");
		expect(deferred.length).toBeGreaterThan(0);
		expect(deferred.every((e) => manifestFamily.test(e.kind))).toBe(true);
		expect(
			stepLog
				.filter((e) => e.phase !== "post-qc")
				.every((e) => !manifestFamily.test(e.kind)),
		).toBe(true);

		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("AWAITING_QC");
		expect(row.status).toBe("AWAITING_QC");
		// The encoding ran; the manifests did NOT.
		expect(sdk.startEncoding).toHaveBeenCalled();
		expect(sdk.createHlsManifest).not.toHaveBeenCalled();
		expect(sdk.startHlsManifest).not.toHaveBeenCalled();
		const entries = row.stepLog as { phase?: string; status: string }[];
		expect(
			entries
				.filter((e) => e.phase === "post-qc")
				.every((e) => e.status === "PENDING"),
		).toBe(true);
		// The trigger fired AFTER the park (its VmafJob is what wakes us), and
		// JOB_FINISHED did not — the job is not finished.
		expect(trigger).toHaveBeenCalledWith(
			expect.objectContaining({ encodingJobId: JOB_ID }),
		);
		expect(statusAtTriggerTime).toEqual(["AWAITING_QC"]);
		expect(emitted.map((e) => e.kind)).not.toContain("JOB_FINISHED");
	});

	it("a trigger failure after the park cannot ERROR a row another attempt has since finished (review-322 C1)", async () => {
		// The park RELEASES the lease (token null). While attempt A's trigger call
		// is in flight, attempt C claims the open row, runs the deferred group,
		// FINISHES and releases — writing the same null. A's trigger promise then
		// rejects (the response never reached A; the vendor committed). A's ERROR
		// write used to fence on null alone, match, and land A's stale step log —
		// five post-qc steps back to PENDING — over C's finished row.
		const { processor, row, updates, emitted } = gateSetup({
			onVodFinished: async () => {
				// Attempt C, compressed: claim, complete, release.
				row.status = "RUNNING";
				row.attemptClaimedAt = new Date("2026-06-11T00:00:30.000Z");
				for (const e of row.stepLog as { status: string }[]) {
					e.status = "DONE";
				}
				row.status = "FINISHED";
				row.attemptClaimedAt = null;
				throw new Error("trigger response lost");
			},
		});
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("LEASE_LOST");
		expect(row.status).toBe("FINISHED");
		expect(
			(row.stepLog as { status: string }[]).every((e) => e.status === "DONE"),
			"C's finished log must survive A's stale write",
		).toBe(true);
		expect(updates.filter((u) => u.status === "ERROR")).toEqual([]);
		expect(emitted.map((e) => e.kind)).not.toContain("JOB_ERROR");
	});

	it("a trigger failure on a row that is STILL parked errors it, and releases (the common case)", async () => {
		const { processor, row, updates, emitted } = gateSetup({
			onVodFinished: async () => {
				throw new Error("trigger refused");
			},
		});
		await expect(processor({ encodingJobId: JOB_ID })).rejects.toThrow(
			"trigger refused",
		);
		expect(row.status).toBe("ERROR");
		expect(row.attemptClaimedAt).toBeNull();
		expect(updates.filter((u) => u.status === "ERROR")).toHaveLength(1);
		expect(emitted.map((e) => e.kind)).toContain("JOB_ERROR");
	});

	it("with QC/VMAF OFF and no measurement coming, the boundary FAILS the job instead of parking it forever (ledger #131 / review-265 131-A1)", async () => {
		// The stranding path: BLOCK_MANIFESTS parks at AWAITING_QC, the
		// trigger creates nothing while the flag is off, and the override
		// button only exists for QC_FAILED. Waiting here is a job the
		// operator can never release. The setting becomes an OUTCOME.
		const { processor, row } = gateSetup({
			rowStatus: "AWAITING_QC",
			preGateDone: true,
			vmafRow: null,
			qcVmafEnabled: false,
		});
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("QC_FAILED");
		expect(row.status).toBe("QC_FAILED");
		// The reason names the setting AND the way out — the operator reads
		// this string in the panel that now shows them a button.
		expect(String(row.error)).toMatch(/turned off/i);
		expect(String(row.error)).toMatch(/Deliver anyway/i);
	});

	it("an UNREADABLE setting waits, it does not fail — a wrong FAIL costs a forced delivery, a wrong WAIT resolves itself (review-265 131-B1)", async () => {
		const { processor, row } = gateSetup({
			rowStatus: "AWAITING_QC",
			preGateDone: true,
			vmafRow: null,
			qcVmafUnreadable: true,
		});
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("AWAITING_QC");
		expect(row.status).toBe("AWAITING_QC");
		// And crucially NOT carrying a message that claims a setting this
		// deployment may not have.
		expect(String(row.error ?? "")).not.toMatch(/turned off/i);
	});

	it("with QC/VMAF ON and no measurement yet, the same job still WAITS — the off-case is not passing for some other reason", async () => {
		const { processor, row } = gateSetup({
			rowStatus: "AWAITING_QC",
			preGateDone: true,
			vmafRow: null,
			qcVmafEnabled: true,
		});
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("AWAITING_QC");
		expect(row.status).toBe("AWAITING_QC");
	});

	it("continuation with a PASSING verdict runs the deferred group to FINISHED", async () => {
		const { processor, row, sdk, emitted } = gateSetup({
			rowStatus: "AWAITING_QC",
			preGateDone: true,
			vmafRow: {
				status: "FINISHED",
				gateVerdict: { pass: true, ruleResults: [] },
				error: null,
			},
		});
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("FINISHED");
		expect(row.status).toBe("FINISHED");
		// The continuation ends through the same persist funnel → same stamp.
		expect(row.finishedAt).toBeDefined();
		expect(sdk.createHlsManifest).toHaveBeenCalled();
		expect(sdk.startHlsManifest).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ manifestGenerator: "V2" }),
		);
		expect(emitted.map((e) => e.kind)).toContain("JOB_FINISHED");
	});

	it("continuation with a FAILING verdict marks QC_FAILED, leaves the group PENDING, emits", async () => {
		const { processor, row, sdk, emitted } = gateSetup({
			rowStatus: "AWAITING_QC",
			preGateDone: true,
			vmafRow: {
				status: "FINISHED",
				gateVerdict: {
					pass: false,
					ruleResults: [
						{ rule: {}, pass: false, actuals: [] },
						{ rule: {}, pass: true, actuals: [] },
					],
				},
				error: null,
			},
		});
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("QC_FAILED");
		expect(row.status).toBe("QC_FAILED");
		expect(row.error).toBe("QC gate failed: 1 of 2 rule(s) below threshold");
		// Never ERROR — and the manifests were not created.
		expect(sdk.createHlsManifest).not.toHaveBeenCalled();
		const entries = row.stepLog as { phase?: string; status: string }[];
		expect(
			entries
				.filter((e) => e.phase === "post-qc")
				.every((e) => e.status === "PENDING"),
		).toBe(true);
		const qcEvent = emitted.find((e) => e.kind === "JOB_QC_FAILED");
		expect(qcEvent).toMatchObject({
			jobId: JOB_ID,
			name: "gated-job",
			reason: "QC gate failed: 1 of 2 rule(s) below threshold",
		});
	});

	it("continuation after a vmaf ERROR maps to QC_FAILED with a measurement reason", async () => {
		const { processor, row } = gateSetup({
			rowStatus: "AWAITING_QC",
			preGateDone: true,
			vmafRow: {
				status: "ERROR",
				gateVerdict: null,
				error: "ffmpeg exploded",
			},
		});
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("QC_FAILED");
		expect(row.error).toBe("QC measurement failed: ffmpeg exploded");
	});

	it("a FINISHED measurement with NO verdict on a gate plan fails closed", async () => {
		const { processor, row } = gateSetup({
			rowStatus: "AWAITING_QC",
			preGateDone: true,
			vmafRow: { status: "FINISHED", gateVerdict: null, error: null },
		});
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("QC_FAILED");
		expect(row.error).toBe("QC verdict missing on a finished measurement");
	});

	it("no verdict yet (vmaf still RUNNING) re-parks without touching the group", async () => {
		const trigger = vi.fn(async () => {});
		const { processor, row, sdk } = gateSetup({
			rowStatus: "AWAITING_QC",
			preGateDone: true,
			vmafRow: { status: "RUNNING", gateVerdict: null, error: null },
			onVodFinished: trigger,
		});
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("AWAITING_QC");
		expect(row.status).toBe("AWAITING_QC");
		expect(sdk.createHlsManifest).not.toHaveBeenCalled();
		// The park re-fires the trigger. Load-bearing since review-201 C1:
		// the trigger re-ENQUEUES an existing PENDING VmafJob (a crash in its
		// create→enqueue gap left a row with nothing queued), so this re-fire
		// is the parked job's only exit from that state — trigger.test.ts
		// pins the re-enqueue itself.
		expect(trigger).toHaveBeenCalled();
	});

	it("two deliveries, one winner — the loser is refused at the LEASE and writes nothing", async () => {
		// CRITICAL-1 moved the dedupe one layer up: a redelivery of a parked
		// job whose winner holds a live lease never reaches the AWAITING_QC
		// CAS at all. Zero writes, zero SDK calls, the row untouched.
		const { processor, row, sdk, updates } = gateSetup({
			rowStatus: "AWAITING_QC",
			preGateDone: true,
			vmafRow: {
				status: "FINISHED",
				gateVerdict: { pass: true, ruleResults: [] },
				error: null,
			},
		});
		row.attemptClaimedAt = new Date("2026-06-10T23:59:30.000Z"); // 30s old
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("LEASE_HELD");
		expect(row.status).toBe("AWAITING_QC");
		expect(sdk.createHlsManifest).not.toHaveBeenCalled();
		expect(updates).toHaveLength(0);
	});

	it("a lost AWAITING_QC claim inside the window RELEASES the lease it just took", async () => {
		// The residual the lease cannot close: the row leaves AWAITING_QC
		// between the winner's re-read and its status CAS. The first cut of
		// CRITICAL-1 returned CLAIMED while still HOLDING the lease, locking
		// whoever moved the row — or a retry — out for a full window.
		const { processor, row, sdk, updates } = gateSetup({
			rowStatus: "AWAITING_QC",
			preGateDone: true,
			claimLoses: true,
			vmafRow: {
				status: "FINISHED",
				gateVerdict: { pass: true, ruleResults: [] },
				error: null,
			},
		});
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("CLAIMED");
		expect(row.status).toBe("AWAITING_QC");
		expect(sdk.createHlsManifest).not.toHaveBeenCalled();
		// Exactly two writes: the lease claim and its release. Nothing else.
		expect(updates).toHaveLength(2);
		expect(row.attemptClaimedAt).toBeNull();
	});

	it("parking at AWAITING_QC RELEASES the lease so the continuation can claim (CRITICAL-1)", async () => {
		// The park is a leaving write. A held lease here would make the QC
		// continuation — a NEW queue job arriving minutes later, well inside
		// the window — lose its claim and return quietly, wedging the job at
		// AWAITING_QC with nothing left to wake it.
		const { processor, row } = gateSetup({ rowStatus: "QUEUED" });
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("AWAITING_QC");
		expect(row.status).toBe("AWAITING_QC");
		expect(row.attemptClaimedAt).toBeNull();
	});

	it("QC_FAILED is terminal for the processor — a redelivery changes nothing", async () => {
		const { processor, row, sdk } = gateSetup({ rowStatus: "QC_FAILED" });
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("QC_FAILED");
		expect(row.status).toBe("QC_FAILED");
		expect(sdk.createEncoding).not.toHaveBeenCalled();
	});

	it("a trigger failure at the park is ERROR (retryable), never a silent forever-park", async () => {
		const { processor, row, emitted } = gateSetup({
			onVodFinished: vi.fn(async () => {
				throw new Error("redis is gone");
			}),
		});
		await expect(processor({ encodingJobId: JOB_ID })).rejects.toThrow(
			"redis is gone",
		);
		expect(row.status).toBe("ERROR");
		expect(row.error).toBe("QC trigger failed: redis is gone");
		// The transition emits like every other ERROR (emit-sites arithmetic).
		expect(emitted.find((e) => e.kind === "JOB_ERROR")).toMatchObject({
			error: "QC trigger failed: redis is gone",
		});
	});

	it("qcOverriddenAt runs the deferred group DESPITE a failing verdict (ledger #86 PR4)", async () => {
		// The override route flips QC_FAILED→QUEUED and stamps the flag; the
		// boundary must then deliver without re-judging — the verdict stays
		// FAIL in the report, delivery was forced past it. Kill: drop the
		// short-circuit and this re-parks as QC_FAILED.
		const { processor, row, sdk, emitted } = gateSetup({
			rowStatus: "QUEUED",
			preGateDone: true,
			vmafRow: {
				status: "FINISHED",
				gateVerdict: { pass: false, ruleResults: [] },
				error: null,
			},
		});
		row.qcOverriddenAt = new Date("2026-08-14T00:00:00.000Z");
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("FINISHED");
		expect(row.status).toBe("FINISHED");
		expect(sdk.createHlsManifest).toHaveBeenCalled();
		// Forced delivery is a FINISH, not a QC failure — no JOB_QC_FAILED.
		expect(emitted.map((e) => e.kind)).toContain("JOB_FINISHED");
		expect(emitted.map((e) => e.kind)).not.toContain("JOB_QC_FAILED");
	});

	it("a flagged row NEVER re-parks — even with a PENDING measurement (review-203 F4 invariant)", async () => {
		// The flag means "never judge this job again", and that safety rests
		// on AWAITING_QC having exactly one writer (the boundary the flag
		// short-circuits). This pins the semantic so a future second writer
		// fails a test instead of silently inheriting force-delivery.
		const { processor, row, sdk, updates } = gateSetup({
			rowStatus: "QUEUED",
			preGateDone: true,
			// A measurement that would normally PARK the job (no verdict yet).
			vmafRow: { status: "PENDING", gateVerdict: null, error: null },
		});
		row.qcOverriddenAt = new Date("2026-08-14T02:00:00.000Z");
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("FINISHED");
		expect(sdk.createHlsManifest).toHaveBeenCalled();
		expect(updates.some((u) => u.status === "AWAITING_QC")).toBe(false);
	});

	/**
	 * the JIT→POST_ENCODING fallback, end to end through the
	 * processor. The fake start REFUSES exactly the request shape Bitmovin
	 * refused for hours on 2026-08-14 (a body carrying vodHlsManifestIds) and
	 * accepts the plain one — so a green run here means the recovery produced
	 * a DIFFERENT REQUEST and then generated the manifests afterwards, which
	 * is the whole claim.
	 */
	const start1004 = () =>
		Object.assign(
			new Error(
				"POST /encoding/encodings/x/start failed (500): An undefined error occurred (code 1004)",
			),
			{ httpStatusCode: 500, errorCode: 1004 },
		);

	it("downgrades to POST_ENCODING when a JIT start dies of 1004, then finishes with the manifests generated after the encode", async () => {
		const seen: unknown[] = [];
		const { processor, row, sdk } = setup(
			{},
			{
				startEncoding: vi.fn(
					async (_id: string, request: Record<string, unknown>) => {
						seen.push(request);
						if (
							Array.isArray(request.vodHlsManifestIds) &&
							request.vodHlsManifestIds.length > 0
						) {
							throw start1004();
						}
						return undefined;
					},
				),
			},
		);

		const result = await processor({ encodingJobId: JOB_ID });

		expect(result.status).toBe("FINISHED");
		// The JIT request was tried FIRST and refused; the plain one followed.
		expect(seen).toHaveLength(2);
		// Asserted on the WIRE shape, not the object: the executor sets absent
		// fields to `undefined`, which JSON.stringify drops — so "the key is
		// present with an undefined value" is exactly what Bitmovin never sees,
		// and asserting key-absence on the object would fail a correct request.
		expect(JSON.stringify(seen[0])).toContain("vodHlsManifestIds");
		expect(JSON.stringify(seen[1])).not.toContain("vodHlsManifestIds");
		// The plan persisted for resume is the downgraded one.
		expect(
			(row.plan as { generation: { timing: string } }).generation.timing,
		).toBe("POST_ENCODING");
		// The manifest was generated AFTER the encode — the appended steps ran
		// in this same attempt (the live-iterator reliance in jit-fallback).
		expect(sdk.startHlsManifest).toHaveBeenCalled();
		const entries = row.stepLog as {
			step: string;
			kind: string;
			status: string;
			response?: unknown;
		}[];
		expect(entries.map((e) => e.step)).toContain("manifest-start:hls");
		expect(entries.every((e) => e.status === "DONE")).toBe(true);
		// And the step log says WHY the plan changed.
		const startEntry = entries.find((e) => e.kind === "START_ENCODING");
		expect(
			(startEntry?.response as { jitDowngrade?: { appendedSteps: string[] } })
				?.jitDowngrade?.appendedSteps,
		).toContain("manifest-start:hls");
	});

	it("retains the original START attempt when canceled during JIT fallback persistence before the second SDK invocation", async () => {
		const h = setup();
		let stopping = false;
		h.sdk.getEncodingStatus = vi.fn(async () => ({
			status: stopping ? "FINISHED" : "QUEUED",
		}));
		h.sdk.stopEncoding = vi.fn(async () => {
			stopping = true;
		});
		const sends: Record<string, unknown>[] = [];
		const wire = vi.fn(async (_url: string, init?: RequestInit) => {
			if (init?.method === "POST") {
				sends.push(JSON.parse(String(init.body)) as Record<string, unknown>);
				return new Response(
					JSON.stringify({
						status: "ERROR",
						data: { code: 1004, message: "Synthetic settle window" },
					}),
					{ status: 500 },
				);
			}
			return new Response(
				JSON.stringify({ data: { result: { status: "CREATED" } } }),
			);
		});
		vi.stubGlobal("fetch", wire);
		h.deps.makeSdk = (args) => ({
			...h.sdk,
			startEncoding: createBitmovinSdkOps(args, async () => {}).startEncoding,
		});
		let enterFallback!: () => void;
		const fallbackReached = new Promise<void>((resolve) => {
			enterFallback = resolve;
		});
		let releaseFallback!: () => void;
		const fallbackRelease = new Promise<void>((resolve) => {
			releaseFallback = resolve;
		});
		const update = h.updateMany.getMockImplementation();
		let originalMarker: unknown;
		h.updateMany.mockImplementation(async (args) => {
			const result = await update?.(args);
			if (args.data.plan) {
				originalMarker = (h.row.stepLog as StepLogEntry[]).find(
					(entry) => entry.kind === "START_ENCODING",
				)?.startedAt;
				enterFallback();
				await fallbackRelease;
			}
			return result ?? { count: 0 };
		});
		try {
			const pending = h.processor({ encodingJobId: JOB_ID });
			await fallbackReached;
			expect(sends).toHaveLength(10);
			expect(
				sends.every(
					(body) =>
						Array.isArray(body.vodHlsManifests) &&
						body.vodHlsManifests.length > 0,
				),
			).toBe(true);
			expect(originalMarker).toBeDefined();
			h.row.cancelRequested = true;
			releaseFallback();
			expect(await pending).toMatchObject({ status: "CANCELED" });
			expect(sends).toHaveLength(10);
			const entry = (h.row.stepLog as StepLogEntry[]).find(
				(item) => item.kind === "START_ENCODING",
			);
			expect(entry).toMatchObject({
				status: "RUNNING",
				startedAt: originalMarker,
			});
			const encodingId = (h.row.stepLog as StepLogEntry[]).find(
				(item) => item.kind === "CREATE_ENCODING",
			)?.resourceId;
			expect(encodingId).toBe("bm-encoding");
			expect(h.sdk.stopEncoding).toHaveBeenCalledExactlyOnceWith(encodingId);
			expect(h.row.encoderStoppedConfirmedFor).toBe(encodingId);
			expect(
				h.emitted.some(
					(event) =>
						event.kind === "JOB_ERROR" || event.kind === "JOB_FINISHED",
				),
			).toBe(false);
		} finally {
			releaseFallback();
			vi.unstubAllGlobals();
		}
	});

	it("never downgrades twice: a POST_ENCODING plan whose start 1004s fails the job", async () => {
		const plan = structuredClone(basePlan);
		plan.bitmovin.accountId = ACCOUNT_ID;
		plan.generation.timing = "POST_ENCODING";
		const parsed = encodingPlanSchema.parse(plan);
		const { processor, row } = setup(
			{ plan: parsed, stepLog: initStepLog(compilePlan(parsed)) },
			{
				startEncoding: vi.fn(() => {
					throw start1004();
				}),
			},
		);

		await expect(processor({ encodingJobId: JOB_ID })).rejects.toThrow(/1004/);
		expect(row.status).toBe("ERROR");
	});

	it("does not downgrade on a non-1004 start failure — the job fails as before", async () => {
		const { processor, row, sdk } = setup(
			{},
			{
				startEncoding: vi.fn(() => {
					throw Object.assign(new Error("start refused (400)"), {
						httpStatusCode: 400,
						errorCode: 1000,
					});
				}),
			},
		);

		await expect(processor({ encodingJobId: JOB_ID })).rejects.toThrow(/400/);
		expect(row.status).toBe("ERROR");
		expect(
			(row.plan as { generation: { timing: string } }).generation.timing,
		).toBe("JUST_IN_TIME");
		expect(sdk.startHlsManifest).not.toHaveBeenCalled();
	});

	it("a MARK_ONLY gate compiles NO deferred group and finishes unchanged", async () => {
		const plan = structuredClone(basePlan);
		plan.bitmovin.accountId = ACCOUNT_ID;
		plan.generation.timing = "POST_ENCODING";
		plan.qc = {
			vmaf: true,
			model: "vmaf_v0.6.1",
			gate: {
				rules: [{ metric: "VMAF_MEAN", scope: "OVERALL", gte: 80 }],
				onFail: "MARK_ONLY",
			},
		};
		const parsed = encodingPlanSchema.parse(plan);
		const stepLog = initStepLog(compilePlan(parsed));
		expect(stepLog.every((e) => e.phase === undefined)).toBe(true);
	});
});

describe("attempt lease", () => {
	const NOW = new Date("2026-06-11T00:00:00.000Z");

	it("claims on entry and RELEASES on FINISHED, so a retry can claim at once", async () => {
		const { processor, row, updates } = setup();
		expect(row.attemptClaimedAt).toBeUndefined();
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("FINISHED");
		// The first write is the claim, and it carries the injected clock.
		expect(updates[0]).toEqual({ attemptClaimedAt: NOW });
		// The terminal write released it — a stale-but-fresh token here would
		// make /retry's next attempt lose its claim for a full window.
		expect(row.attemptClaimedAt).toBeNull();
	});

	it("refuses to start while another attempt holds a FRESH lease", async () => {
		const { processor, row, sdk, updates } = setup();
		row.attemptClaimedAt = new Date(NOW.getTime() - 60_000);
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("LEASE_HELD");
		expect(updates).toHaveLength(0);
		expect(sdk.createEncoding).not.toHaveBeenCalled();
		expect(row.status).toBe("QUEUED");
	});

	it("takes over a STALE lease — a dead worker must not wedge the job", async () => {
		const { processor, row, sdk } = setup();
		row.attemptClaimedAt = new Date(NOW.getTime() - 11 * 60_000);
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("FINISHED");
		expect(sdk.createEncoding).toHaveBeenCalledTimes(1);
		expect(row.attemptClaimedAt).toBeNull();
	});

	it("losing the lease on a poll tick stops the attempt QUIETLY — no ERROR, no JOB_ERROR, no stop", async () => {
		/*
		 * The double-tree scenario, from the loser's side. Worker A is mid
		 * AWAIT_ENCODING; its lease is taken (B claimed after A went stale);
		 * A's next renewal fails. A must stop WITHOUT touching the row: marking
		 * ERROR, emitting JOB_ERROR or stopping the encoding would all land on
		 * the job B is now running correctly. And the result must RESOLVE, not
		 * reject — BullMQ's failed handler would otherwise ERROR B's row.
		 */
		let polls = 0;
		const { processor, row, sdk, emitted } = setup(
			{},
			{
				getEncodingStatus: vi.fn(() =>
					Promise.resolve({ status: polls++ === 0 ? "RUNNING" : "FINISHED" }),
				),
			},
			undefined,
			undefined,
			undefined,
			async () => {
				// The steal, on the tick: another worker's claim now sits on the row.
				row.attemptClaimedAt = new Date(NOW.getTime() + 5_000);
			},
		);
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("LEASE_LOST");
		expect(row.status).toBe("RUNNING");
		expect(row.error ?? null).toBeNull();
		expect(emitted.map((e) => e.kind)).not.toContain("JOB_ERROR");
		expect(sdk.stopEncoding).not.toHaveBeenCalled();
		// The stolen token is exactly what is on the row — A wrote nothing over it.
		expect(row.attemptClaimedAt).toEqual(new Date(NOW.getTime() + 5_000));
		const entries = row.stepLog as { kind: string; status: string }[];
		expect(entries.find((e) => e.kind === "AWAIT_ENCODING")?.status).not.toBe(
			"FAILED",
		);
	});

	it("an ALIVE attempt renews on every poll tick, so a long encode outlives the window", async () => {
		/*
		 * The renewal's own property, distinct from the fence. Removing the
		 * tick renewal left every other lease test green — the fence catches a
		 * loser one provider call later — but that is the LOSER's side. The
		 * WINNER's side is this: an encode that legitimately polls for hours
		 * must keep its lease fresh, or a redelivery arriving after the window
		 * finds a stale token, takes the job, and the double tree is back with
		 * the lease in place. Osaka's median live provision is 589s against a
		 * 600s window; VOD encodes run longer than either.
		 *
		 * Clock advances six minutes per tick, three ticks — eighteen minutes,
		 * past the window — and the token on the row must move with it.
		 */
		let t = new Date("2026-06-11T00:00:00.000Z").getTime();
		let polls = 0;
		const { processor, updates } = setup(
			{},
			{
				getEncodingStatus: vi.fn(() =>
					Promise.resolve({ status: polls++ < 3 ? "RUNNING" : "FINISHED" }),
				),
			},
			undefined,
			undefined,
			undefined,
			async () => {
				t += 6 * 60_000;
			},
			() => new Date(t).toISOString(),
		);
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("FINISHED");
		// Token-only writes: the CLAIM at t0, then one pure renewal per tick.
		// Asserted as the full sequence so the claim time is pinned too.
		const tokenWrites = updates.filter(
			(u) => Object.keys(u).length === 1 && "attemptClaimedAt" in u,
		);
		const stamps = tokenWrites.map((u) =>
			(u.attemptClaimedAt as Date).toISOString(),
		);
		expect(stamps).toEqual([
			"2026-06-11T00:00:00.000Z",
			"2026-06-11T00:06:00.000Z",
			"2026-06-11T00:12:00.000Z",
			"2026-06-11T00:18:00.000Z",
		]);
	});

	it("the FENCE: a persist whose token no longer matches is refused, even with no tick between", async () => {
		/*
		 * Distinct from the tick test above: here the lease is taken DURING the
		 * provider call, so no renewal runs before the step's DONE write. The
		 * write itself must be the check — an unconditional update here is the
		 * exact "last DB writer wins" the audit describes, and it would record
		 * this attempt's step as DONE over the owner's log.
		 */
		const { processor, row, sdk, updates } = setup(
			{},
			{
				createEncoding: vi.fn(async () => {
					row.attemptClaimedAt = new Date(NOW.getTime() + 5_000);
					return "bm-encoding-from-the-loser";
				}),
			},
		);
		const result = await processor({ encodingJobId: JOB_ID });
		expect(result.status).toBe("LEASE_LOST");
		// The create happened at the provider (that is the residual — a stamped
		// resource the winner adopts, ) but its DONE never LANDED.
		expect(sdk.createEncoding).toHaveBeenCalledTimes(1);
		/*
		 * Asserted on what was WRITTEN, not on the in-memory step log: the
		 * processor marks the entry DONE in memory before persisting, and the
		 * harness row aliases that array, so reading `row.stepLog` here shows
		 * the attempt's own view rather than the database's. `updates` records
		 * only writes the fake accepted (count 1), which is exactly the fence.
		 */
		const landedDone = updates.some((u) =>
			(u.stepLog as { kind: string; status: string }[] | undefined)?.some(
				(e) => e.kind === "CREATE_ENCODING" && e.status === "DONE",
			),
		);
		expect(landedDone).toBe(false);
		expect(updates.some((u) => "bitmovinEncodingId" in u)).toBe(false);
		// And the thief's token is untouched — the loser wrote nothing over it.
		expect(row.attemptClaimedAt).toEqual(new Date(NOW.getTime() + 5_000));
	});
});

it("journals, stops and acknowledges a deferred VOD CREATE after reset erases its row", async () => {
	let resolveCreate!: (id: string) => void;
	const create = vi.fn(
		() =>
			new Promise<string>((resolve) => {
				resolveCreate = resolve;
			}),
	);
	const t = setup({}, { createEncoding: create });
	const journal = vi.fn(async () => true);
	const ack = vi.fn(async () => {});
	t.deps.journalResetEncoding = journal;
	t.deps.acknowledgeResetEntity = ack;
	const pending = t.processor({ encodingJobId: JOB_ID });
	await vi.waitFor(() => expect(create).toHaveBeenCalled());
	vi.mocked(t.prisma.encodingJob.findUnique).mockResolvedValue(null);
	t.updateMany.mockResolvedValue({ count: 0 });
	resolveCreate("late-vod");
	await expect(pending).resolves.toMatchObject({ status: "LEASE_LOST" });
	expect(journal).toHaveBeenCalledWith(
		`encodingJob:${JOB_ID}`,
		"late-vod",
		ACCOUNT_ID,
	);
	expect(t.sdk.stopEncoding).toHaveBeenCalledWith("late-vod");
	expect(ack).toHaveBeenCalledWith(`encodingJob:${JOB_ID}`, expect.any(String));
	expect(t.sdk.startEncoding).not.toHaveBeenCalled();
});

it("acknowledges reset even when its claimed VOD row disappears before SDK setup", async () => {
	const t = setup();
	const ack = vi.fn(async () => {});
	t.deps.acknowledgeResetEntity = ack;
	vi.mocked(t.prisma.encodingJob.findUnique)
		.mockResolvedValueOnce(t.row as never)
		.mockResolvedValue(null);
	await expect(t.processor({ encodingJobId: JOB_ID })).resolves.toMatchObject({
		status: "MISSING",
	});
	expect(ack).toHaveBeenCalledWith(
		`encodingJob:${JOB_ID}`,
		"2026-06-11T00:00:00.000Z",
	);
	expect(t.sdk.createEncoding).not.toHaveBeenCalled();
});
