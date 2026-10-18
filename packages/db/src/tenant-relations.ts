/** Schema-derived relation graph, pinned by the tenant schema census test. */
export const TENANT_MODEL_RELATIONS: Readonly<
	Record<string, Readonly<Record<string, string>>>
> = {
	appSetting: {
		organization: "organization",
	},
	credential: {
		organization: "organization",
		locationPresets: "storageLocationPreset",
		inspections: "storageInspection",
		notificationChannels: "notificationChannel",
		watchRules: "watchRule",
	},
	resetCleanupTask: {
		organization: "organization",
	},
	bitmovinAccount: {
		organization: "organization",
		encodingJobs: "encodingJob",
		liveChannels: "liveChannel",
		auditLogs: "auditLog",
		verificationRuns: "verificationRun",
		usageDailyStatistics: "usageDailyStatistic",
		usageSweepCursors: "usageSweepCursor",
	},
	storageLocationPreset: {
		organization: "organization",
		credential: "credential",
	},
	encodingJob: {
		organization: "organization",
		bitmovinAccount: "bitmovinAccount",
		preset: "preset",
		manifests: "manifestJob",
		vmafJobs: "vmafJob",
		librarySources: "librarySource",
		watchedObjects: "watchedObject",
		webhookRegistrations: "webhookRegistration",
	},
	librarySource: {
		organization: "organization",
		job: "encodingJob",
		analyses: "sceneAnalysisRevision",
		revisions: "contentRevision",
	},
	sceneAnalysisRevision: {
		organization: "organization",
		source: "librarySource",
	},
	content: {
		organization: "organization",
		revisions: "contentRevision",
	},
	contentRevision: {
		organization: "organization",
		content: "content",
		source: "librarySource",
	},
	manifestJob: {
		organization: "organization",
		encodingJob: "encodingJob",
	},
	liveChannel: {
		organization: "organization",
		bitmovinAccount: "bitmovinAccount",
		preset: "preset",
		feederSessions: "feederSession",
		liveHeartbeats: "liveHeartbeat",
		runs: "liveChannelRun",
		schedules: "liveSchedule",
		slateNormalizations: "slateNormalization",
		effectClaims: "liveEffectClaim",
		alertRules: "alertRule",
		alertEvents: "alertEvent",
	},
	liveChannelRun: {
		organization: "organization",
		liveChannel: "liveChannel",
		liveHeartbeats: "liveHeartbeat",
		feederSessions: "feederSession",
		webhookRegistrations: "webhookRegistration",
	},
	alertRule: {
		organization: "organization",
		liveChannel: "liveChannel",
		events: "alertEvent",
	},
	alertEvent: {
		organization: "organization",
		rule: "alertRule",
		liveChannel: "liveChannel",
	},
	liveHeartbeat: {
		organization: "organization",
		liveChannel: "liveChannel",
		liveChannelRun: "liveChannelRun",
	},
	feederSession: {
		organization: "organization",
		liveChannel: "liveChannel",
		liveChannelRun: "liveChannelRun",
	},
	feederPushAttempt: {
		organization: "organization",
	},
	vmafJob: {
		organization: "organization",
		encodingJob: "encodingJob",
		results: "vmafResult",
	},
	vmafResult: {
		organization: "organization",
		vmafJob: "vmafJob",
	},
	storageInspection: {
		organization: "organization",
		credential: "credential",
	},
	preset: {
		organization: "organization",
		watchRules: "watchRule",
		encodingJobs: "encodingJob",
		liveChannels: "liveChannel",
	},
	webhookEvent: {
		organization: "organization",
	},
	webhookRegistration: {
		organization: "organization",
		encodingJob: "encodingJob",
		liveChannelRun: "liveChannelRun",
	},
	auditLog: {
		organization: "organization",
		bitmovinAccount: "bitmovinAccount",
	},
	notificationChannel: {
		organization: "organization",
		credential: "credential",
		rules: "notificationRule",
	},
	notificationRule: {
		organization: "organization",
		channel: "notificationChannel",
	},
	apiToken: {
		user: "user",
		organization: "organization",
	},
	startupSample: {
		organization: "organization",
	},
	liveSchedule: {
		organization: "organization",
		liveChannel: "liveChannel",
	},
	slateNormalization: {
		organization: "organization",
		liveChannel: "liveChannel",
	},
	liveEffectClaim: {
		organization: "organization",
		liveChannel: "liveChannel",
	},
	watchRule: {
		organization: "organization",
		credential: "credential",
		preset: "preset",
		objects: "watchedObject",
	},
	watchedObject: {
		organization: "organization",
		watchRule: "watchRule",
		encodingJob: "encodingJob",
	},
	verificationRun: {
		organization: "organization",
		bitmovinAccount: "bitmovinAccount",
		resumedFrom: "verificationRun",
		resumedRuns: "verificationRun",
		intents: "verificationResourceIntent",
		liveEvidence: "verificationLiveEvidence",
	},
	verificationResourceIntent: {
		organization: "organization",
		verificationRun: "verificationRun",
		events: "verificationResourceIntentEvent",
	},
	verificationResourceIntentEvent: {
		organization: "organization",
		verificationResourceIntent: "verificationResourceIntent",
	},
	verificationLiveEvidence: {
		organization: "organization",
		verificationRun: "verificationRun",
	},
	usageDailyStatistic: {
		organization: "organization",
		bitmovinAccount: "bitmovinAccount",
	},
	usageSweepCursor: {
		organization: "organization",
		bitmovinAccount: "bitmovinAccount",
	},
	vmafComputeTask: {
		organization: "organization",
	},
	vmafComputeCredential: {
		organization: "organization",
	},
	vmafExecutionProfile: {
		organization: "organization",
	},
	accessEvent: {
		organization: "organization",
		user: "user",
	},
};
