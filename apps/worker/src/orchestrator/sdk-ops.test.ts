import BitmovinApi, {
	AacChannelLayout,
	AdMarkersSource,
	AvailabilityStartTimeMode,
	ConditionOperator,
	DolbyAtmosMeteringMode,
	DolbyDigitalChannelLayout,
	DolbyDigitalPlusChannelLayout,
	GoogleCloudRegion,
	HlsVersion,
	IvSize,
	LevelH264,
	LevelH265,
	MaxCtuSize,
	ProfileH265,
	S3SignatureVersion,
	SrtMode,
	StreamKeyConfigurationType,
	TuInterDepth,
	TuIntraDepth,
} from "@bitmovin/api-sdk";
import { CODEC_CONFIG_API_PATH } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { sdkEnumValue } from "./sdk-ops";

/**
 * Pins the enum NAME → wire VALUE mapping. Several SDK enums have
 * name ≠ value; bare casts would put the name on the wire and 400 every
 * real encoding (caught in PR8 review — never reintroduce casts).
 */
describe("sdkEnumValue", () => {
	it("maps HLS versions to their numeric wire values", () => {
		expect(sdkEnumValue(HlsVersion, "HLS_V4", "HlsVersion")).toBe("4");
		expect(sdkEnumValue(HlsVersion, "HLS_V8", "HlsVersion")).toBe("8");
	});

	it("maps AAC channel layouts (CL_STEREO → STEREO)", () => {
		expect(
			sdkEnumValue(AacChannelLayout, "CL_STEREO", "AacChannelLayout"),
		).toBe("STEREO");
	});

	it("maps condition operators to symbols (GREATER_THAN → >)", () => {
		expect(
			sdkEnumValue(ConditionOperator, "GREATER_THAN", "ConditionOperator"),
		).toBe(">");
		expect(sdkEnumValue(ConditionOperator, "EQUAL", "ConditionOperator")).toBe(
			"==",
		);
	});

	it("maps H265 CTU/TU depth enums to bare numbers", () => {
		expect(sdkEnumValue(MaxCtuSize, "S64", "MaxCtuSize")).toBe("64");
		expect(sdkEnumValue(TuIntraDepth, "D4", "TuIntraDepth")).toBe("4");
		expect(sdkEnumValue(TuInterDepth, "D4", "TuInterDepth")).toBe("4");
	});

	it("maps H26x profiles/levels to their lowercase/numeric wire values", () => {
		expect(sdkEnumValue(ProfileH265, "MAIN", "ProfileH265")).toBe("main");
		expect(sdkEnumValue(ProfileH265, "MAIN10", "ProfileH265")).toBe("main10");
		expect(sdkEnumValue(LevelH264, "L4", "LevelH264")).toBe("4");
		expect(sdkEnumValue(LevelH265, "L5_1", "LevelH265")).toBe("5.1");
	});

	it("maps CENC ivSize names to byte-count wire values", () => {
		expect(sdkEnumValue(IvSize, "IV_8_BYTES", "IvSize")).toBe("8_BYTES");
		expect(sdkEnumValue(IvSize, "IV_16_BYTES", "IvSize")).toBe("16_BYTES");
	});

	it("maps Dolby Atmos metering modes to dotted ITU names", () => {
		expect(
			sdkEnumValue(
				DolbyAtmosMeteringMode,
				"ITU_R_BS_1770_4",
				"DolbyAtmosMeteringMode",
			),
		).toBe("ITU-R BS.1770-4");
	});

	it("maps Dolby Digital (Plus) channel layouts (CL_5_1 → 5.1)", () => {
		expect(
			sdkEnumValue(
				DolbyDigitalChannelLayout,
				"CL_STEREO",
				"DolbyDigitalChannelLayout",
			),
		).toBe("STEREO");
		expect(
			sdkEnumValue(
				DolbyDigitalPlusChannelLayout,
				"CL_5_1",
				"DolbyDigitalPlusChannelLayout",
			),
		).toBe("5.1");
	});

	it("maps the live input/start enums (name = wire value today — pinned)", () => {
		expect(sdkEnumValue(SrtMode, "LISTENER", "SrtMode")).toBe("LISTENER");
		expect(sdkEnumValue(SrtMode, "CALLER", "SrtMode")).toBe("CALLER");
		expect(sdkEnumValue(AdMarkersSource, "MANIFEST", "AdMarkersSource")).toBe(
			"MANIFEST",
		);
		expect(
			sdkEnumValue(
				AvailabilityStartTimeMode,
				"ON_FIRST_SEGMENT",
				"AvailabilityStartTimeMode",
			),
		).toBe("ON_FIRST_SEGMENT");
		expect(
			sdkEnumValue(
				StreamKeyConfigurationType,
				"ASSIGN",
				"StreamKeyConfigurationType",
			),
		).toBe("ASSIGN");
	});

	it("maps the GenericS3 signature-version NAME to its S3_V* wire value", () => {
		// The executor translates the credential's wire value ("S3_V4") to the
		// enum NAME ("V4") before calling sdk-ops; sdk-ops then maps NAME → value.
		expect(sdkEnumValue(S3SignatureVersion, "V4", "S3SignatureVersion")).toBe(
			"S3_V4",
		);
		expect(sdkEnumValue(S3SignatureVersion, "V2", "S3SignatureVersion")).toBe(
			"S3_V2",
		);
	});

	it("maps GoogleCloudRegion names (name = wire value today — pinned)", () => {
		expect(
			sdkEnumValue(GoogleCloudRegion, "EUROPE_WEST_1", "GoogleCloudRegion"),
		).toBe("EUROPE_WEST_1");
		expect(
			sdkEnumValue(GoogleCloudRegion, "US_EAST_1", "GoogleCloudRegion"),
		).toBe("US_EAST_1");
	});

	it("throws on unknown names instead of passing them through", () => {
		expect(() => sdkEnumValue(HlsVersion, "HLS_V99", "HlsVersion")).toThrow(
			/Unknown HlsVersion "HLS_V99"/,
		);
	});
});

/**
 * Every entry of the shared codec-config path table must resolve on a REAL
 * BitmovinApi client to an object with a `get` method.
 *
 * This is the one class of error in the per-title capture that no stub can
 * catch: a table typo (`dolbyDigitalPlus` vs `ddPlus`, `subtitles` vs
 * `subtitle`) makes the adapter fall through to "type known, params empty", so
 * the capture succeeds, the snapshot looks plausible, and the parameters are
 * silently missing — a failure that would otherwise surface only against real
 * credentials, on the one codec nobody tested with. Constructing the client
 * builds the resource tree locally and performs no network I/O.
 */
describe("CODEC_CONFIG_API_PATH resolves against the real SDK", () => {
	it("has at least the nine codecs the plan schema can emit", () => {
		// Guards the loop below from passing over an empty table.
		expect(Object.keys(CODEC_CONFIG_API_PATH).length).toBeGreaterThanOrEqual(9);
	});

	it("points every codec at an endpoint that exists and has get()", () => {
		const api = new BitmovinApi({ apiKey: "not-a-real-key" });
		const configurations = api.encoding.configurations as unknown as Record<
			string,
			Record<string, { get?: unknown }>
		>;
		const broken: string[] = [];
		for (const [codecType, [group, codec]] of Object.entries(
			CODEC_CONFIG_API_PATH,
		)) {
			const endpoint = configurations[group]?.[codec];
			if (typeof endpoint?.get !== "function") {
				broken.push(`${codecType} -> configurations.${group}.${codec}`);
			}
		}
		expect(broken).toEqual([]);
	});
});

describe("BitmovinCallError structured capture (E2E 2026-08-14, I-01)", () => {
	// The start-1004 investigation stalled on exactly these three absences:
	// no requestId to hand support, no developerMessage to read, no error
	// code as a field. Kill: drop any capture and its assertion goes red.
	const source = {
		httpStatusCode: 500,
		shortMessage: "Internal error",
		errorCode: 1004,
		requestId: "req-abc-123",
		developerMessage: "Encoding could not be scheduled on the target region",
	};

	it("carries requestId IN the message and the rest as fields", async () => {
		const { BitmovinCallError } = await import("./sdk-ops");
		const err = new BitmovinCallError(
			"POST",
			"/encoding/encodings/x/start",
			source,
		);
		expect(err.message).toContain("[request req-abc-123]");
		expect(err.message).toContain("(500)");
		expect(err.message).toContain("code 1004");
		expect(err.requestId).toBe("req-abc-123");
		expect(err.errorCode).toBe(1004);
		expect(err.httpStatusCode).toBe(500);
		// developerMessage is a FIELD ONLY — diagnostic prose is not vetted
		// for request-body echoes, so it must never ride the message that
		// step logs / audit rows / UI error strings persist.
		expect(err.developerMessage).toBe(source.developerMessage);
		expect(err.message).not.toContain("scheduled on the target region");
	});

	it("clamps a NON-opaque requestId out of the message AND the field (review-206 N1)", async () => {
		const { BitmovinCallError } = await import("./sdk-ops");
		for (const evil of [
			{ ...source, requestId: { deep: "object" } },
			{ ...source, requestId: "x".repeat(2000) },
			{ ...source, requestId: "line\nbreak body: {secret}" },
			{ ...source, requestId: "spaces and prose here" },
		]) {
			const err = new BitmovinCallError("POST", "/x", evil);
			expect(err.message).not.toContain("[request");
			expect(err.requestId).toBeUndefined();
		}
	});

	it("degrades cleanly when the source carries none of it", async () => {
		const { BitmovinCallError } = await import("./sdk-ops");
		const err = new BitmovinCallError("GET", "/status", new Error("boom"));
		expect(err.requestId).toBeUndefined();
		expect(err.message).not.toContain("[request");
	});
});
