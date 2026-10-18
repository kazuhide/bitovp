import { tenantQueueEnvelope, tenantQueueEnvelopeSchema } from "@bitovp/core";
import { DEFAULT_ORGANIZATION_ID } from "@bitovp/db";
import type { Job, Queue } from "bullmq";
import { requireOrganizationId } from "./scope";

function ownedJob(job: Job, organizationId: string): Job | undefined {
	const parsed = tenantQueueEnvelopeSchema.safeParse(job.data);
	const legacy =
		process.env.TENANT_MIGRATE_LEGACY_QUEUES === "1" &&
		organizationId === DEFAULT_ORGANIZATION_ID &&
		typeof job.data === "object" &&
		job.data !== null &&
		!("organizationId" in job.data) &&
		!("payload" in job.data) &&
		!("systemSweep" in job.data);
	if (
		!(parsed.success ? parsed.data.organizationId === organizationId : legacy)
	)
		return undefined;
	return new Proxy(job, {
		get(target, key) {
			if (key === "data")
				return parsed.success ? parsed.data.payload : job.data;
			const value = Reflect.get(target, key, target);
			return typeof value === "function"
				? (...args: unknown[]) => {
						if (requireOrganizationId() !== organizationId)
							throw new Error("Tenant queue job unavailable");
						return Reflect.apply(value, target, args);
					}
				: value;
		},
	});
}

/** Provider-neutral queue wrapper: preserve names, job IDs and repeatable scheduling. */
export function tenantQueue<T extends Queue>(queue: T): T {
	return new Proxy(queue, {
		get(target, key, receiver) {
			if (key === "getJob")
				return async (id: string) => {
					const organizationId = requireOrganizationId();
					const job = await target.getJob(id);
					return job ? ownedJob(job, organizationId) : undefined;
				};
			if (key === "add") {
				return (name: string, payload: unknown, options?: object) => {
					const organizationId = requireOrganizationId();
					// An envelope is never accepted as an escape hatch to another org.
					if (tenantQueueEnvelopeSchema.safeParse(payload).success)
						throw new Error("Queue payload is already wrapped");
					return target.add(
						name,
						tenantQueueEnvelope(organizationId, payload),
						options,
					);
				};
			}
			if (key === "addBulk") {
				return (jobs: { name: string; data: unknown; opts?: object }[]) => {
					const organizationId = requireOrganizationId();
					return target.addBulk(
						jobs.map((job) => {
							if (tenantQueueEnvelopeSchema.safeParse(job.data).success)
								throw new Error("Queue payload is already wrapped");
							return {
								...job,
								data: tenantQueueEnvelope(organizationId, job.data),
							};
						}),
					);
				};
			}
			const value = Reflect.get(target, key, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
