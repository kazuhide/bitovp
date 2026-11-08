import { canonicalEditingJson, type SecretCipher } from "@bitovp/core";
import type { AppTransactionClient, Prisma } from "@bitovp/db";
import {
	DIALOGUE_SOURCE_ID,
	dialogueDemo,
	dialogueSourceSnapshot,
} from "./dialogue-fixture";

export const DIALOGUE_ACCOUNT_ID = "72b40340-2426-439e-8029-3e5dc764ee06";
export const DIALOGUE_JOB_ID = "72b40340-2426-439e-8029-3e5dc764ee07";
export const DIALOGUE_ENCODING_ID = "72b40340-2426-439e-8029-3e5dc764ee08";
const ACCOUNT_LABEL = "Sintel local fixture account — no provider access";
const PLACEHOLDER_KEY = "editing-preview-sintel-fixture-no-provider-key";
const jobData = {
	id: DIALOGUE_JOB_ID,
	name: "Sintel original dialogue — local fixture only, not a provider encoding",
	labels: ["editing-preview", "FIXTURE_AUTHORED", "NO_PROVIDER_EXECUTION"],
	status: "FINISHED" as const,
	bitmovinAccountId: DIALOGUE_ACCOUNT_ID,
	bitmovinEncodingId: DIALOGUE_ENCODING_ID,
	libraryCaptureSuppressed: true,
	plan: {
		fixture: dialogueDemo.id,
		fixtureOnly: true,
		providerExecution: false,
		metadataProvenance: "MANUALLY_ANNOTATED_DEMO",
	},
	stepLog: [],
	snapshots: { fixtureOnly: true, providerExecution: false },
};
function changed(): never {
	throw new Error("PREVIEW_DIALOGUE_ORIGIN_CHANGED");
}
const same = (a: unknown, b: unknown) =>
	canonicalEditingJson(a) === canonicalEditingJson(b);

/** Called only by the strict isolated preview seed, never a provider producer. */
export async function ensureDialoguePreviewSource(
	tx: AppTransactionClient,
	{ organizationId, cipher }: { organizationId: string; cipher: SecretCipher },
) {
	// Account/job/source admission and all caller writes share this transaction.
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dialogue-preview-origin:${organizationId}`}, 0))`;
	const priorAccount = await tx.bitmovinAccount.findUnique({
		where: { id: DIALOGUE_ACCOUNT_ID },
		select: {
			id: true,
			organizationId: true,
			label: true,
			defaults: true,
			tenantOrgId: true,
			encryptedApiKey: true,
		},
	});
	if (priorAccount) {
		if (
			priorAccount.organizationId !== organizationId ||
			priorAccount.label !== ACCOUNT_LABEL ||
			priorAccount.tenantOrgId !== null ||
			!same(priorAccount.defaults, {})
		)
			changed();
		let key: string;
		try {
			key = await cipher.decrypt(
				priorAccount.encryptedApiKey,
				`bitmovin-account:${DIALOGUE_ACCOUNT_ID}`,
			);
		} catch {
			return changed();
		}
		if (key !== PLACEHOLDER_KEY) changed();
	} else
		await tx.bitmovinAccount.create({
			data: {
				id: DIALOGUE_ACCOUNT_ID,
				label: ACCOUNT_LABEL,
				tenantOrgId: null,
				defaults: {},
				encryptedApiKey: await cipher.encrypt(
					PLACEHOLDER_KEY,
					`bitmovin-account:${DIALOGUE_ACCOUNT_ID}`,
				),
			},
		});
	const priorJob = await tx.encodingJob.findUnique({
		where: { id: DIALOGUE_JOB_ID },
	});
	if (priorJob) {
		if (
			priorJob.organizationId !== organizationId ||
			priorJob.name !== jobData.name ||
			priorJob.status !== "FINISHED" ||
			priorJob.bitmovinAccountId !== DIALOGUE_ACCOUNT_ID ||
			priorJob.bitmovinEncodingId !== DIALOGUE_ENCODING_ID ||
			priorJob.libraryCaptureSuppressed !== true ||
			!same(priorJob.labels, jobData.labels) ||
			!same(priorJob.plan, jobData.plan) ||
			!same(priorJob.stepLog, []) ||
			!same(priorJob.snapshots, jobData.snapshots)
		)
			changed();
	} else await tx.encodingJob.create({ data: jobData });
	const snapshot = JSON.parse(
		JSON.stringify(dialogueSourceSnapshot()),
	) as Prisma.InputJsonValue;
	const priorSource = await tx.librarySource.findUnique({
		where: { id: DIALOGUE_SOURCE_ID },
	});
	if (priorSource) {
		if (
			priorSource.organizationId !== organizationId ||
			priorSource.sourceKind !== "VOD_JOB" ||
			priorSource.jobId !== DIALOGUE_JOB_ID ||
			priorSource.originalJobId !== DIALOGUE_JOB_ID ||
			priorSource.encodingId !== DIALOGUE_ENCODING_ID ||
			priorSource.accountId !== DIALOGUE_ACCOUNT_ID ||
			priorSource.renderArtifactId !== null ||
			priorSource.sourceKey !== dialogueDemo.registrationKey ||
			priorSource.state !== "READY" ||
			!same(priorSource.locales, ["en"]) ||
			!same(priorSource.snapshot, snapshot)
		)
			changed();
		return { source: priorSource, created: false };
	}
	const source = await tx.librarySource.create({
		data: {
			id: DIALOGUE_SOURCE_ID,
			sourceKind: "VOD_JOB",
			jobId: DIALOGUE_JOB_ID,
			originalJobId: DIALOGUE_JOB_ID,
			encodingId: DIALOGUE_ENCODING_ID,
			accountId: DIALOGUE_ACCOUNT_ID,
			renderArtifactId: null,
			sourceKey: dialogueDemo.registrationKey,
			state: "READY",
			locales: ["en"],
			snapshot,
		},
	});
	return { source, created: true };
}
