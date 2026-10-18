import type { createWakeBus } from "../notify/wake-bus";
import { requireOrganizationId } from "./scope";

/** The Redis callback has no job ALS; capture its tenant when the sleep is registered. */
export function tenantWakeSleep(bus: ReturnType<typeof createWakeBus>) {
	return (ms: number, interestedIds: () => string[]) => {
		const organizationId = requireOrganizationId();
		return bus.sleep(ms, (identity) =>
			interestedIds().some((id) => identity === `${organizationId}:${id}`),
		);
	};
}
