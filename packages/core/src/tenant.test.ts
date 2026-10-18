import { describe, expect, it } from "vitest";
import { tenantQueueEnvelope, tenantQueueEnvelopeSchema } from "./tenant";

describe("tenant queue envelope", () => {
	it("retains the existing payload without adding provider tenancy or secrets", () => {
		const payload = { encodingJobId: "e21d0727-e91e-47ab-9037-665a465b6b76" };
		const envelope = tenantQueueEnvelope(
			"79b51031-95df-442e-801d-2c9dbdaffeb9",
			payload,
		);
		expect(envelope.payload).toBe(payload);
		expect(tenantQueueEnvelopeSchema.parse(envelope)).toEqual(envelope);
	});
	it.each([
		{},
		{ organizationId: "79b51031-95df-442e-801d-2c9dbdaffeb9" },
		{ organizationId: "provider-tenant", payload: {} },
		{
			organizationId: "79b51031-95df-442e-801d-2c9dbdaffeb9",
			payload: {},
			admin: true,
		},
	])("refuses missing, malformed or privilege-smuggling context: %j", (value) => {
		expect(tenantQueueEnvelopeSchema.safeParse(value).success).toBe(false);
	});
});
