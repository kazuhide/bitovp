import { z } from "zod";

const integer = z
	.string()
	.regex(/^\d+$/)
	.transform(Number)
	.pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
export const liveDiagnosticsQuerySchema = z
	.strictObject({
		kind: z
			.enum(["summary", "events", "streams", "srt", "hd-start", "task"])
			.default("summary"),
		offset: integer.default(0),
		limit: integer.pipe(z.number().min(1).max(100)).default(25),
		srtInputId: z.uuid().optional(),
	})
	.refine((q) => q.srtInputId === undefined || q.kind === "srt", {
		message: "srtInputId is only supported for SRT diagnostics",
		path: ["srtInputId"],
	});

const number = z.number().finite().optional().catch(undefined);
const uuid = z.uuid().optional().catch(undefined);
const date = z.preprocess(
	(v) =>
		v instanceof Date && Number.isFinite(v.getTime()) ? v.toISOString() : v,
	z.iso.datetime().optional().catch(undefined),
);
const numeric = <T extends string>(keys: readonly T[]) =>
	z.object(
		Object.fromEntries(keys.map((key) => [key, number])) as Record<
			T,
			typeof number
		>,
	);

const resolvedEncoderVersion = z
	.string()
	.max(64)
	.regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/);
/** Request tags and concrete provider selections remain separate evidence. */
export const diagnosticsEncodingVersionsSchema = z.object({
	encoderVersion: z
		.union([z.enum(["STABLE", "BETA", "LATEST"]), resolvedEncoderVersion])
		.optional()
		.catch(undefined),
	selectedEncoderVersion: resolvedEncoderVersion.optional().catch(undefined),
});
export const diagnosticsSummarySchema = z.object({
	...diagnosticsEncodingVersionsSchema.shape,
	status: z
		.enum([
			"CONNECTED",
			"DISCONNECTED",
			"WAITING_FOR_FIRST_CONNECT",
			"ERROR",
			"NOT_AVAILABLE",
			"FINISHED",
		])
		.optional()
		.catch(undefined),
});

// Installed SDK Task/Message/Status/MessageType models define these fields.
// Message has no public code field. Text is inspected only for fixed mentions,
// never returned or audited; a mention does not establish negotiated ALPN.
const taskProtocolMentions = [
	{
		value: "moqt-16",
		pattern: /(?:^|[^A-Za-z0-9_.-])moqt-16(?=$|[^A-Za-z0-9_.-])/,
	},
	{
		value: "moqt-18",
		pattern: /(?:^|[^A-Za-z0-9_.-])moqt-18(?=$|[^A-Za-z0-9_.-])/,
	},
	{
		value: "moqt-23",
		pattern: /(?:^|[^A-Za-z0-9_.-])moqt-23(?=$|[^A-Za-z0-9_.-])/,
	},
	{
		value: "no_application_protocol",
		pattern:
			/(?:^|[^A-Za-z0-9_.-])no_application_protocol(?=$|[^A-Za-z0-9_.-])/,
	},
] as const;
const taskMessageSchema = z
	.object({
		type: z
			.enum(["ERROR", "WARNING", "INFO", "DEBUG", "TRACE"])
			.optional()
			.catch(undefined),
		date,
		text: z.string().optional().catch(undefined),
	})
	.transform(({ text, ...metadata }) => ({
		...metadata,
		protocolMentions: taskProtocolMentions
			.filter(({ pattern }) => typeof text === "string" && pattern.test(text))
			.map(({ value }) => ({ source: "task-message" as const, value })),
	}));
export const diagnosticsTaskSchema = z
	.object({
		status: z.enum([
			"CREATED",
			"QUEUED",
			"RUNNING",
			"FINISHED",
			"ERROR",
			"CANCELED",
			"TRANSFER_ERROR",
		]),
		progress: number,
		messages: z.array(z.unknown()).optional(),
	})
	.transform(({ messages, ...task }) => ({
		...task,
		// The SDK maps omitted messages to []; neither empty shape proves zero.
		totalMessageCount: messages?.length ? messages.length : null,
		messagesTruncated: (messages?.length ?? 0) > 100,
		messages: (messages ?? [])
			.slice(0, 100)
			.map((message) => taskMessageSchema.parse(message)),
	}));

const manifest = numeric([
	"timeshift",
	"liveEdgeOffset",
	"suggestedPresentationDelay",
	"minimumUpdatePeriod",
]).extend({
	manifestId: uuid,
	insertProgramDateTime: z.boolean().optional().catch(undefined),
});
/** Explicit whitelist: no stream key, credentials, ESAM endpoints or arbitrary strings. */
export const diagnosticsHdStartSchema = z.object({
	manifestGenerator: z.enum(["V2", "LEGACY"]).optional().catch(undefined),
	liveEncodingMode: z
		.enum(["STANDARD", "SINGLE_PASS", "TWO_PASS", "THREE_PASS", "SMART_PASS"])
		.optional()
		.catch(undefined),
	hlsManifests: z.array(manifest).max(100).optional(),
	dashManifests: z.array(manifest).max(100).optional(),
	autoShutdownConfiguration: numeric([
		"bytesReadTimeoutSeconds",
		"streamTimeoutMinutes",
		"waitingForFirstConnectTimeoutMinutes",
	]).optional(),
	autoRestartConfiguration: numeric([
		"segmentsWrittenTimeout",
		"bytesWrittenTimeout",
		"framesWrittenTimeout",
		"hlsManifestsUpdateTimeout",
		"dashManifestsUpdateTimeout",
	])
		.extend({ restartOnEncoderError: z.boolean().optional().catch(undefined) })
		.optional(),
});
// Free-form messages can contain input URLs, keys and credentials. Keep the
// provider's event enum and clock values; never forward or store its message.
export const diagnosticsEventSchema = z.object({
	time: date,
	details: numeric([
		"year",
		"month",
		"day",
		"hours",
		"minutes",
		"seconds",
		"microSeconds",
	])
		.extend({
			eventType: z
				.enum([
					"FIRST_CONNECT",
					"DISCONNECT",
					"RECONNECT",
					"RESYNCING",
					"IDLE",
					"ERROR",
					"WARNING",
					"PICTURE_TIMING",
					"INFO",
				])
				.optional()
				.catch(undefined),
			source: z.enum(["SYSTEM_CLOCK", "EMBEDDED"]).optional().catch(undefined),
		})
		.optional(),
});
export const diagnosticsStreamSchema = z.object({
	time: date,
	streamInfos: z
		.array(
			numeric([
				"width",
				"height",
				"rate",
				"samplesReadPerSecondMin",
				"samplesReadPerSecondMax",
				"samplesReadPerSecondAvg",
				"samplesBackupPerSecondMin",
				"samplesBackupPerSecondMax",
				"samplesBackupPerSecondAvg",
				"bytesReadPerSecondMin",
				"bytesReadPerSecondMax",
				"bytesReadPerSecondAvg",
				"bytesBackupPerSecondMin",
				"bytesBackupPerSecondMax",
				"bytesBackupPerSecondAvg",
			]).extend({
				id: uuid,
				mediaType: z.enum(["VIDEO", "AUDIO"]).optional().catch(undefined),
				codec: z.enum(["H264", "H265", "AAC"]).optional().catch(undefined),
			}),
		)
		.optional(),
});
export const diagnosticsSrtSchema = z.object({
	id: uuid,
	createdAt: date,
	encodingId: uuid,
	srtInputId: uuid,
	srtInputSelected: z.boolean().optional().catch(undefined),
	link: numeric(["bandwidth", "maxBandwidth", "rtt"]).optional(),
	window: numeric(["congestion", "flight", "flow"]).optional(),
	recv: numeric([
		"bytes",
		"bytesDropped",
		"bytesLost",
		"mbitRate",
		"packets",
		"packetsBelated",
		"packetsDropped",
		"packetsLost",
		"packetsRetransmitted",
	]).optional(),
	send: numeric([
		"bytes",
		"bytesDropped",
		"mbitRate",
		"packets",
		"packetsDropped",
		"packetsLost",
		"packetsRetransmitted",
	]).optional(),
});
export const finalHeartbeatSchema = z.object({
	url: z.url().refine(
		(value) => {
			const url = new URL(value);
			return url.protocol === "https:" && !url.username && !url.password;
		},
		{ message: "Expected an HTTPS download URL without credentials" },
	),
});
