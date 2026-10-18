import { z } from "zod";

/** The application organization is distinct from Bitmovin's provider tenant. */
export const tenantQueueEnvelopeSchema = z.strictObject({
	organizationId: z.uuid(),
	payload: z.unknown(),
});
export type TenantQueueEnvelope<T = unknown> = {
	organizationId: string;
	payload: T;
};

export const tenantSystemSweepSchema = z.strictObject({
	systemSweep: z.enum(["heartbeat", "slate"]),
});

export function tenantQueueEnvelope<T>(
	organizationId: string,
	payload: T,
): TenantQueueEnvelope<T> {
	tenantQueueEnvelopeSchema.parse({ organizationId, payload });
	return { organizationId, payload };
}
