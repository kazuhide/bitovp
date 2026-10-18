import { expect, it } from "vitest";
import { createWakeBus } from "../notify/wake-bus";
import { currentOrganizationId, runInOrganization } from "./scope";
import { tenantWakeSleep } from "./wake";

const A = "ef984a2c-1d65-4f48-8eae-0f4be5c80432",
	B = "aa14e5f0-e526-4af1-886c-a9a1f2f9e1ed";
it("same provider ID in another tenant cannot wake a sleeper, even with no callback ALS", async () => {
	const bus = createWakeBus();
	const sleep = tenantWakeSleep(bus);
	const ids: string[] = [];
	const pending = runInOrganization(A, () => sleep(5000, () => ids));
	expect(currentOrganizationId()).toBeUndefined();
	ids.push("provider-id");
	bus.signal(`${B}:provider-id`);
	expect(bus.size()).toBe(1);
	bus.signal(`${A}:provider-id`);
	await pending;
	expect(bus.size()).toBe(0);
});
