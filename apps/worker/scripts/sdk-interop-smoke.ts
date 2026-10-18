/**
 * Pins the tsx/Node-native ESM↔CJS interop path that unit tests cannot
 * reach (vitest applies bundler interop): constructing the Bitmovin SDK
 * through sdk-ops, the webhook registrar provider and the usage provider
 * must work under the same runtime the worker uses.
 * No network: construction is offline. Run via `pnpm --filter
 * @bitovp/worker smoke` (wired into CI).
 */
import {
	AclEntry,
	AiSceneAnalysis,
	CencDrm,
	Condition,
	ConditionOperator,
	DolbyVisionMetadata,
	H265VideoConfiguration,
	IvSize,
	MaxCtuSize,
	Mp4Muxing,
	NexGuardFileMarker,
	ProfileH265,
	RedundantRtmpInput,
	ResetLiveManifestTimeShift,
	S3Input,
	Scte35Cue,
	SmoothStreamingManifest,
	SrtInput,
	SrtMode,
	StartLiveEncodingRequest,
	StreamInfo,
	StreamKeyConfigurationType,
	Thumbnail,
	ZixiInput,
} from "@bitmovin/api-sdk";
import { createAnalysisProvider } from "../src/library/analysis-sweep";
import { createBitmovinSdkOps } from "../src/orchestrator/sdk-ops";
import { createUsageStatisticsProvider } from "../src/usage/statistics-sweep";
import { createRegistrarProvider } from "../src/webhooks/provider";

// Default export resolves and BitmovinApi constructs (throws inside if not).
createBitmovinSdkOps(
	{ apiKey: "smoke-dummy", tenantOrgId: null, bitmovinAccountId: "smoke" },
	async () => {},
);

// rev432: the webhook registrar and the usage sweep construct the SDK through
// their own factories; each once used a bare default import and failed on
// every attempt under tsx while every unit test stayed green. Construct
// through both here — offline, no call is made.
const smokeAccount = async () => ({
	apiKey: "smoke-dummy",
	tenantOrgId: null as string | null,
});
await createRegistrarProvider({
	// prisma is reached only by the audit writer on a provider CALL; the smoke
	// constructs and never calls
	prisma: {} as Parameters<typeof createRegistrarProvider>[0]["prisma"],
	revealBitmovinAccount: smokeAccount,
})("smoke");
await createUsageStatisticsProvider({ revealBitmovinAccount: smokeAccount })(
	"smoke",
);
await createAnalysisProvider({ revealBitmovinAccount: smokeAccount })("smoke");

// Named classes must stay constructible across SDK bumps (^range) — they
// are all `new`ed by sdk-ops (representative cut across resource families).
const namedClasses = {
	AclEntry,
	AiSceneAnalysis,
	CencDrm,
	Condition,
	DolbyVisionMetadata,
	H265VideoConfiguration,
	Mp4Muxing,
	NexGuardFileMarker,
	RedundantRtmpInput,
	ResetLiveManifestTimeShift,
	S3Input,
	Scte35Cue,
	SmoothStreamingManifest,
	SrtInput,
	StartLiveEncodingRequest,
	StreamInfo,
	Thumbnail,
	ZixiInput,
};
for (const [name, ctor] of Object.entries(namedClasses)) {
	if (typeof ctor !== "function") {
		throw new Error(
			`sdk interop smoke failed: named export ${name} is not a constructor (got ${typeof ctor})`,
		);
	}
	new (ctor as new (obj?: object) => object)({});
}

// Enum wire values must survive interop (HLS_V4="4" class of bug).
if (
	ConditionOperator.EQUAL !== "==" ||
	MaxCtuSize.S64 !== "64" ||
	IvSize.IV_16_BYTES !== "16_BYTES" ||
	ProfileH265.MAIN !== "main" ||
	SrtMode.LISTENER !== "LISTENER" ||
	StreamKeyConfigurationType.GENERATE !== "GENERATE"
) {
	throw new Error("sdk interop smoke failed: enum wire values lost in interop");
}

console.log(
	"sdk interop smoke: ok (sdk-ops, registrar provider, usage provider, analysis provider)",
);
