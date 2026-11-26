import "server-only";
import type { AppTransactionClient } from "@bitovp/db";
import type { parseMoqObservationStore } from "./moq-observations";

/** Caller holds the proven run's row lock and has checked the session owner. */
export async function writeMoqObservationStore(
	tx: Pick<AppTransactionClient, "$executeRaw">,
	scope: { runId: string; organizationId: string | undefined },
	store: ReturnType<typeof parseMoqObservationStore>,
): Promise<void> {
	if (!scope.organizationId) throw new Error("MoQ store tenant unavailable");
	// Prisma's Json model-input path can round metric floats. Preserve the
	// exact serialized prefix as TEXT::jsonb so later append-only checks stay exact.
	const json = JSON.stringify(store);
	const updatedAt = new Date();
	const updated = await tx.$executeRaw`
		UPDATE "LiveChannelRun"
		SET "moqObservations" = ${json}::jsonb,
			"updatedAt" = ${updatedAt}
		WHERE id = ${scope.runId}::uuid
			AND "organizationId" = ${scope.organizationId}::uuid
	`;
	if (updated !== 1) throw new Error("MoQ store scoped write unavailable");
}
