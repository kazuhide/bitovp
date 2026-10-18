import { FEATURE_FLAGS_KEY, parseFeatureFlags } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";

/**
 *  — the worker's read of the app-wide flags.
 *
 * Read AT USE, never cached at startup: the operator can flip a flag mid-run
 * and the next FINISHED encode, the next sweep tick and the next QC boundary
 * must obey the current setting.
 *
 * Returns **null when the setting could not be read** rather than folding that
 * into `false` (review-265 131-B1). The safe direction is not the same for
 * every caller: for the trigger and the watch sweep, "cannot read" should
 * create nothing; for the QC boundary it must NOT become "QC is off", because
 * that fails the job with a message claiming a setting the deployment may not
 * have — and a wrong FAIL costs an operator a forced delivery, while a wrong
 * WAIT resolves itself the moment the read succeeds.
 */
export async function qcVmafEnabled(
	prisma: AppPrismaClient,
): Promise<boolean | null> {
	try {
		const row = await prisma.appSetting.findUnique({
			where: { key: FEATURE_FLAGS_KEY },
			select: { value: true },
		});
		return parseFeatureFlags(row?.value).qcVmaf;
	} catch {
		return null;
	}
}
