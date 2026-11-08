import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { editingObjectSchema } from "../content-library/editing-storage";
import { canonicalEditingJson } from "./automatic-binding";
import { editingNormalizationSourceSchema } from "./normalization-evidence";

const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const pinnedInputCaptureSchema = z.strictObject({
	schemaVersion: z.literal(1),
	profile: z.literal("PINNED_HTTP_INPUT_V1"),
	organizationId: z.uuid(),
	jobId: z.uuid(),
	encodingId: z.uuid(),
	expiresAt: integer,
	storage: editingObjectSchema.refine(
		(storage) =>
			!!storage.size &&
			(!!storage.expect?.generation ||
				(!!storage.expect?.versionId && storage.expect.versionId !== "null")),
		"Provider input requires an immutable object version",
	),
	sha256: sha,
	sourceFacts: editingNormalizationSourceSchema,
	ingestKey: z.string().min(1).max(128),
	planHash: sha,
});
export type PinnedInputCapture = z.infer<typeof pinnedInputCaptureSchema>;

/** A successful provider GET captured by the importer, never metadata supplied by a client. */
export const authoritativeAnalysisCaptureSchema = z.strictObject({
	schemaVersion: z.literal(1),
	profile: z.literal("BITMOVIN_ANALYSIS_HTTP_V1"),
	organizationId: z.uuid(),
	sourceId: z.uuid(),
	jobId: z.uuid(),
	encodingId: z.uuid(),
	accountId: z.uuid(),
	analysisRevisionId: z.uuid(),
	locale: z
		.string()
		.regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
		.max(35),
	inputReceiptId: z.uuid(),
	providerInputId: z.uuid(),
	ingestStreamId: z.uuid(),
	providerResponseSha256: sha,
	ingestionRawHash: sha,
	storedRawHash: sha,
	storedDocumentHash: sha,
	planHash: sha,
	inputTransformHash: sha,
});
export type AuthoritativeAnalysisCapture = z.infer<
	typeof authoritativeAnalysisCaptureSchema
>;

const uuid = z.uuid();
const MAX_LIFETIME_SECONDS = 7 * 86400;
const clock = () => Math.floor(Date.now() / 1000);
function signature(
	secret: string,
	organizationId: string,
	receiptId: string,
	expiresAt: number,
): string {
	return createHmac("sha256", secret)
		.update(
			canonicalEditingJson({
				purpose: "ENCODING_INPUT_CAPTURE",
				schemaVersion: 1,
				organizationId,
				receiptId,
				expiresAt,
			}),
		)
		.digest("hex");
}

/** Returned credentials go only to the provider HTTPSInput, never into logs/receipts. */
export function createInputCaptureCredentials(input: {
	secret: string;
	organizationId: string;
	receiptId: string;
	expiresAt: number;
	now?: number;
}): { username: string; password: string } {
	const organizationId = uuid.parse(input.organizationId).toLowerCase();
	const receiptId = uuid.parse(input.receiptId).toLowerCase();
	const now = input.now ?? clock();
	if (
		input.secret.length < 32 ||
		!Number.isSafeInteger(input.expiresAt) ||
		input.expiresAt <= now ||
		input.expiresAt > now + MAX_LIFETIME_SECONDS
	)
		throw new Error("INPUT_CAPTURE_CONFIGURATION_INVALID");
	return {
		username: `v1.${organizationId}.${input.expiresAt}`,
		password: signature(
			input.secret,
			organizationId,
			receiptId,
			input.expiresAt,
		),
	};
}

/** Authenticate before loading any unscoped receipt; caller then verifies row tuple/hash. */
export function verifyInputCaptureAuthorization(input: {
	secret: string;
	receiptId: string;
	authorization: string | null | undefined;
	now?: number;
}): { organizationId: string; expiresAt: number } | null {
	if (
		input.secret.length < 32 ||
		!input.authorization ||
		input.authorization.length > 1024 ||
		!uuid.safeParse(input.receiptId).success
	)
		return null;
	const encoded = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(
		input.authorization,
	)?.[1];
	if (!encoded) return null;
	const decoded = Buffer.from(encoded, "base64").toString("utf8");
	const parts = /^v1\.([a-f0-9-]{36})\.(\d{1,16}):([a-f0-9]{64})$/.exec(
		decoded,
	);
	if (
		!parts?.[1] ||
		!parts[2] ||
		!parts[3] ||
		!uuid.safeParse(parts[1]).success
	)
		return null;
	const expiresAt = Number(parts[2]);
	const now = input.now ?? clock();
	if (
		!Number.isSafeInteger(expiresAt) ||
		expiresAt <= now ||
		expiresAt > now + MAX_LIFETIME_SECONDS
	)
		return null;
	const expected = signature(
		input.secret,
		parts[1],
		input.receiptId.toLowerCase(),
		expiresAt,
	);
	if (
		!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(parts[3], "hex"))
	)
		return null;
	return { organizationId: parts[1], expiresAt };
}
