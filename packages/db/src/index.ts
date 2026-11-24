// Model/enum types only — the runtime PrismaClient class is deliberately not
// re-exported. Construct clients via createPrismaClient/getPrisma (which
// enforce a global omit on ciphertext columns) and reach secrets only
// through the stores.
export type * from "../generated/client";
export type {
	AisaLiveImportOutcome,
	VerifiedFinalAisaImport,
} from "./aisa-live";
export { AisaLiveImportConflict, persistFinalAisaImport } from "./aisa-live";
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
export { createPrismaClient, DB_NULL, dbSql, getPrisma } from "./client";
export type {
	CreateCredentialInput,
	CredentialStore,
	CredentialSummary,
	UpdateCredentialInput,
} from "./credentials";
export { createCredentialStore } from "./credentials";
export { recordUnrestrictedEgress } from "./egress-audit";
export type { ExperimentContext } from "./encoding-experiments";
export {
	addExperimentCampaign,
	claimExperimentTrial,
	completeExperimentTrial,
	controlExperimentCampaign,
	EncodingExperimentError,
	enqueueExperimentBatch,
	experimentCampaignDetail,
	experimentCampaignPage,
	experimentResultPage,
	experimentSelectionRows,
	experimentTrialPage,
	releaseExperimentTrial,
	renewExperimentTrial,
} from "./encoding-experiments";
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
// The hierarchical flow evidence reader is fenced: its exports are in
// ./library-flow (see hierarchical-flow-fence.json at the repository root).
export type { CapturedOriginalInput } from "./library-input-capture";
export {
	listCapturedOriginalInputs,
	resolveCapturedOriginalInput,
} from "./library-input-capture";
export type { LibraryMediaTaskEvidence } from "./library-media-task-evidence";
export {
	getLibraryMediaTaskEvidenceReadOnly,
	LibraryMediaTaskEvidenceError,
	verifyLibraryMediaTaskEvidence,
} from "./library-media-task-evidence";
export {
	getPreparedNormalizationReceipt,
	LibraryNormalizationClockError,
} from "./library-normalization-clock";
export { LibrarySourceError, requestLibrarySource } from "./library-source";
export type {
	LiveEffectAction,
	LiveEffectBeginInput,
	LiveEffectBeginResult,
	LiveEffectClaimHandle,
	LiveEffectTargetClaimResult,
	ResolveLiveEffectsAfterConfirmedStopInput,
	ResolveLiveEffectsAfterConfirmedStopResult,
	RtmpRetirementReceipt,
} from "./live-effect-claim";
export {
	archivedStopRecoveryTarget,
	archivedStopRevision,
	assertLiveEffectCurrent,
	beginLiveEffect,
	bindArchivedStopTarget,
	bindArchivedStopTargetInTransaction,
	bindLiveEffectTarget,
	canObserveLiveStop,
	claimLiveStopSend,
	collectLiveStopTargets,
	LIVE_EFFECT_OPEN_STATES,
	liveChannelAccountId,
	liveEffectSendUncertainty,
	liveStopFeederWhere,
	liveStopKnownTargets,
	liveStopLogEncodings,
	liveStopRunOwnsEncoding,
	loadLiveEffectTargetClaim,
	markLiveEffectAcked,
	markLiveEffectAmbiguous,
	markLiveEffectFailed,
	mergeRtmpRetirementEvidence,
	outstandingLiveStopTargets,
	pendingSecondaryStopTargets,
	readAiringEffectHistory,
	recordLiveStopFailure,
	reserveAisaStop,
	resolveLiveEffectsAfterConfirmedStop,
	STRANDED_RUN_ERROR,
	savedStopReadbacks,
	stopNotificationHistoryEligible,
	unconfirmedRtmpEncoders,
	unreservedStopTargets,
	wasLiveStopAcknowledged,
} from "./live-effect-claim";
export { readLockedLiveStartState } from "./live-reair-guard";
export {
	CURRENT_SCHEDULE_OUTCOME_EVIDENCE_VERSION,
	recordConfirmedStopDelivery,
} from "./live-stop-delivery";
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
export { readResetRtmpArchives } from "./reset-live-inventory";
export {
	appendLiveChannelStepLogEntry,
	appendLiveEffectStepLogEntry,
	mergeEncodingJobSnapshot,
	replaceLiveRunStepLogSnapshot,
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
