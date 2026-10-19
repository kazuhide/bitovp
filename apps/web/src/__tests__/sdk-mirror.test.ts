import {
	AkamaiCloudRegion,
	AwsCloudRegion,
	AzureCloudRegion,
	CaptionCharacterEncoding,
	CloudRegion,
	GoogleCloudRegion,
	OciCloudRegion,
} from "@bitmovin/api-sdk";
import { BITMOVIN_CLOUD_REGIONS } from "@bitovp/core";
import { SRT_CHARACTER_ENCODING_VALUES } from "@bitovp/core/wizard";
import { describe, expect, it } from "vitest";
import {
	AKAMAI_REGIONS,
	AWS_REGIONS,
	AZURE_REGIONS,
	GCE_REGIONS,
	OCI_REGIONS,
	staticIpCreateSchema,
} from "@/lib/infrastructure/schemas";

const regionMirrors = [
	{ name: "CloudRegion", actual: BITMOVIN_CLOUD_REGIONS, sdk: CloudRegion },
	{ name: "AwsCloudRegion", actual: AWS_REGIONS, sdk: AwsCloudRegion },
	{ name: "GoogleCloudRegion", actual: GCE_REGIONS, sdk: GoogleCloudRegion },
	{ name: "AzureCloudRegion", actual: AZURE_REGIONS, sdk: AzureCloudRegion },
	{ name: "AkamaiCloudRegion", actual: AKAMAI_REGIONS, sdk: AkamaiCloudRegion },
	{ name: "OciCloudRegion", actual: OCI_REGIONS, sdk: OciCloudRegion },
];

describe("client-safe SDK mirrors", () => {
	it.each(regionMirrors)("$name contains every SDK wire value", ({
		actual,
		sdk,
	}) => {
		expect([...actual].sort()).toEqual(Object.values(sdk).sort());
	});

	it("accepts the Akamai Melbourne region for infrastructure requests", () => {
		expect(
			staticIpCreateSchema.parse({ region: CloudRegion.AKAMAI_AU_MEL }),
		).toEqual({ region: "AKAMAI_AU_MEL" });
	});

	it("preserves every SDK caption character-encoding name and wire value", () => {
		expect(SRT_CHARACTER_ENCODING_VALUES).toEqual(CaptionCharacterEncoding);
	});
});
