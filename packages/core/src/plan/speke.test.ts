import { describe, expect, it } from "vitest";
import {
	CREDENTIAL_PROVIDER_SHAPES,
	createCredentialSchema,
} from "../credentials/schemas";
import { compileExpectedArtefacts } from "../verify/expected";
import { buildPlan, DEFAULT_WIZARD_STATE } from "../wizard/build-plan";
import { tryImportPresetIntoWizard } from "../wizard/plan-to-wizard";
import { compilePlan } from "./compiler";
import { encodingPlanSchema } from "./schema";
import { planToEncodingTemplateYaml } from "./template";
import { validatePlan } from "./validate";

const credentialId = "23456789-0123-4567-89ab-0123456789ab";
const systemId = "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed";
function plan() {
	return encodingPlanSchema.parse(
		buildPlan({
			...DEFAULT_WIZARD_STATE,
			name: "SPEKE test",
			inputFiles: [
				{
					key: "main",
					inputKey: "main",
					kind: "S3",
					credentialId,
					bucket: "input",
					path: "test.mp4",
				},
			],
			output: {
				...DEFAULT_WIZARD_STATE.output,
				credentialId,
				bucket: "output",
				basePath: "test/",
			},
			audios: [],
			manifests: {
				hls: true,
				dash: true,
				hlsOptions: { drmKind: "SPEKE" },
				dashOptions: { drmKind: "SPEKE" },
			},
			drm: [
				{
					kind: "SPEKE",
					muxingKey: "v360",
					credentialId,
					contentId: "movie",
					kid: "00112233445566778899aabbccddeeff",
					systemIds: [systemId],
				},
			],
		}),
	);
}
describe("SPEKE plan and encrypted credentials", () => {
	it("compiles a vault reference and DRM-protected manifests, and reopens in the wizard", () => {
		const p = plan(),
			ops = compilePlan(p),
			step = ops.find((op) => op.kind === "CREATE_DRM_SPEKE");
		expect(validatePlan(p).filter((issue) => issue.level === "error")).toEqual(
			[],
		);
		expect(step?.payload).toMatchObject({
			credentialId,
			contentId: "movie",
			systemIds: [systemId],
		});
		expect(
			ops.filter((op) => op.kind === "CREATE_HLS_STREAM_INFO")[0]?.refs.drmId,
		).toBe("drm:v360-speke");
		expect(
			ops.filter((op) => op.kind === "CREATE_DASH_CONTENT_PROTECTION")[0]?.refs
				.drmId,
		).toBe("drm:v360-speke");
		const imported = tryImportPresetIntoWizard(
			p as unknown as Record<string, unknown>,
		);
		expect(imported.ok).toBe(true);
		if (imported.ok)
			expect(encodingPlanSchema.parse(buildPlan(imported.state))).toEqual(p);
		expect(JSON.stringify(p)).not.toContain("provider");
		expect(() => planToEncodingTemplateYaml(p)).toThrow(/vault reference/);
	});
	it("rejects an incompatible muxing, wrong credential, and missing FairPlay IV", () => {
		const p = plan();
		p.muxings[0] = {
			key: "v360",
			kind: "TS",
			streamKey: "v360",
			segmentLength: 6,
			segmentNaming: "segment_%number%.ts",
			destination: p.drm[0]?.destination,
		};
		expect(
			validatePlan(p).some((i) => i.message.includes("cannot encrypt the TS")),
		).toBe(true);
		const wrong = validatePlan(plan(), {
			credentialProviders: new Map([[credentialId, "DRM_CENC"]]),
		});
		expect(wrong.some((i) => i.code === "DRM_CREDENTIAL")).toBe(true);
		const fp = plan();
		const drm = fp.drm[0];
		if (!drm) throw new Error("Missing SPEKE DRM fixture");
		if (drm.kind === "SPEKE")
			drm.systemIds = ["94ce86fb-07ff-4f43-adb8-93d2fa968ca2"];
		expect(validatePlan(fp).some((i) => i.code === "DRM_IV")).toBe(true);
	});
	it("does not invent IV size or encryption scheme for provider-selected keys", () => {
		const expected = compileExpectedArtefacts(plan()).drm[0];
		expect(expected).toMatchObject({
			kind: "SPEKE",
			kid: "00112233445566778899aabbccddeeff",
			systemIds: [systemId.replace(/-/g, "")],
		});
		expect(expected?.ivSizeBytes).toBeUndefined();
		expect(expected?.schemeType).toBeUndefined();
	});
	it("stores endpoint/auth only in secret and validates Basic and role auth", () => {
		const value = {
			label: "keys",
			provider: "DRM_SPEKE",
			config: {},
			secret: {
				url: "https://keys.example.com/token/path",
				username: "u",
				password: "s",
			},
		};
		expect(createCredentialSchema.parse(value)).toEqual(value);
		expect(
			createCredentialSchema.safeParse({
				...value,
				config: { url: value.secret.url },
			}).success,
		).toBe(false);
		const parse = CREDENTIAL_PROVIDER_SHAPES.DRM_SPEKE.secret;
		expect(
			parse.safeParse({ url: "https://keys.example.com", username: "u" })
				.success,
		).toBe(false);
		expect(parse.safeParse({ url: "http://keys.example.com" }).success).toBe(
			false,
		);
		expect(
			parse.safeParse({ url: "https://u:p@keys.example.com" }).success,
		).toBe(false);
		expect(
			parse.safeParse({
				url: "https://keys.example.com",
				roleArn: "arn:aws:iam::123456789012:role/speke",
			}).success,
		).toBe(false);
		expect(
			parse.safeParse({
				url: "https://keys.example.com",
				roleArn: "arn:aws:iam::123456789012:role/speke",
				gatewayRegion: "eu-west-1",
				externalIdMode: "GLOBAL",
			}).success,
		).toBe(true);
	});
});
