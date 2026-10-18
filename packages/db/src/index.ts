// Model/enum types only — the runtime PrismaClient class is deliberately not
// re-exported. Construct clients via createPrismaClient/getPrisma (which
// enforce a global omit on ciphertext columns) and reach secrets only
// through the stores.
export type * from "../generated/client";
export type { AuditEntry } from "./audit";
export { writeAuditLog } from "./audit";
export type {
	BitmovinAccountStore,
	BitmovinAccountSummary,
	CreateBitmovinAccountInput,
	UpdateBitmovinAccountInput,
} from "./bitmovin-accounts";
export { createBitmovinAccountStore } from "./bitmovin-accounts";
export type { AppPrismaClient, AppTransactionClient } from "./client";
export { createPrismaClient, DB_NULL, getPrisma } from "./client";
export type {
	CreateCredentialInput,
	CredentialStore,
	CredentialSummary,
	UpdateCredentialInput,
} from "./credentials";
export { createCredentialStore } from "./credentials";
export { recordUnrestrictedEgress } from "./egress-audit";
export type {
	AuthenticationToken,
	IdentityPrismaClient,
	IdentityTransactionClient,
} from "./identity-client";
export {
	getIdentityPrisma,
	resolveApiTokenForAuthentication,
	resolveWebhookOrganization,
	touchApiTokenForAuthentication,
} from "./identity-client";
export { readIngressSnapshot, writeIngressSnapshot } from "./ingress-setting";
export { LibrarySourceError, requestLibrarySource } from "./library-source";
export type {
	LiveEffectAction,
	LiveEffectBeginInput,
	LiveEffectBeginResult,
	LiveEffectClaimHandle,
	LiveEffectTargetClaimResult,
	ResolveLiveEffectsAfterConfirmedStopInput,
	ResolveLiveEffectsAfterConfirmedStopResult,
} from "./live-effect-claim";
export {
	assertLiveEffectCurrent,
	beginLiveEffect,
	bindLiveEffectTarget,
	LIVE_EFFECT_OPEN_STATES,
	loadLiveEffectTargetClaim,
	markLiveEffectAcked,
	markLiveEffectAmbiguous,
	markLiveEffectFailed,
	resolveLiveEffectsAfterConfirmedStop,
} from "./live-effect-claim";
export {
	claimLiveToVodAttempt,
	LiveToVodFenceError,
	persistLiveToVodAttempt,
	readLiveToVodAttempt,
} from "./live-to-vod-state";
export type {
	ResetCleanupAccount,
	ResetCleanupEncoding,
	ResetCleanupPayload,
	ResetCleanupWebhook,
} from "./reset-cleanup";
export {
	acknowledgeResetCleanupEntity,
	appendResetCleanupEncoding,
	createResetCleanupTask,
	findResetCleanupTaskForEntity,
	mutateResetCleanupTask,
	readResetCleanupTask,
	recordResetCleanupWebhookResult,
	revealResetCleanupAccount,
} from "./reset-cleanup";
export {
	appendLiveChannelStepLogEntry,
	appendLiveEffectStepLogEntry,
	mergeEncodingJobSnapshot,
} from "./step-log";
export type { TenantClientOptions } from "./tenant-client";
export {
	createTenantPrismaClient,
	DEFAULT_ORGANIZATION_ID,
	getTenantPrisma,
	TENANT_ORGANIZATION,
	tenantOrganizationId,
} from "./tenant-client";
// Test doubles that honour `select`. Exported so worker/web suites share ONE
// projection contract instead of re-deriving it per file — six of twelve
// worker Prisma mocks were silently permissive before this existed.
export {
	projecting,
	projectingMany,
	projectSelected,
} from "./test-helpers";
export * from "./vmaf-profiles";
export type { VmafTriggerKind } from "./vmaf-trigger-key";
export {
	autoTriggerKey,
	labManualTriggerKey,
	labManualTriggerPrefix,
	vmafTriggerKind,
} from "./vmaf-trigger-key";
export { findProcessableWebhookEvents } from "./webhook-events";
export type {
	ResolveWebhookMasterSecretDeps,
	WebhookMasterSecret,
} from "./webhook-secret";
export {
	encodeWebhookMasterSecretRow,
	resolveWebhookMasterSecret,
	WEBHOOK_MASTER_SECRET_KEY,
} from "./webhook-secret";
