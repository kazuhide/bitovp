import { describe, expect, it } from "vitest";
import { GET } from "./route";

/** Code-shipped delivery specs : id-addressed, 404 on misses. */
describe("GET /api/delivery-presets/[id]", () => {
	const request = (id: string) =>
		GET(new Request(`http://test/api/delivery-presets/${id}`), {
			params: Promise.resolve({ id }),
		});

	it("serves a shipped spec with plan + constraints + suggested gate", async () => {
		const res = await request("mezz-h264-1080p-50m");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			spec: {
				name: string;
				plan: { renditions: unknown[] };
				constraints: unknown[];
				suggestedGate: { onFail: string };
			};
		};
		expect(body.spec.name).toContain("H.264");
		expect(body.spec.plan.renditions).toHaveLength(2);
		expect(body.spec.constraints.length).toBeGreaterThan(0);
		expect(body.spec.suggestedGate.onFail).toBe("MARK_ONLY");
	});

	it("404s an unknown id", async () => {
		expect((await request("nope")).status).toBe(404);
	});
});
