import { beforeEach, describe, expect, it, vi } from "vitest";
import { enableClipEditingForTests } from "@/test/clip-editing-env";
import { POST } from "./route";

enableClipEditingForTests();

const create = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server/library-automatic-portrait", () => ({
	createAutomaticPortrait: create,
}));
vi.mock("@/lib/server/library-editing-routes", async () => {
	const { editingRoute } = await import("@/lib/server/library-editing-common");
	return {
		editingMutation: (
			_req: Request,
			action: (actor: string) => Promise<unknown>,
			status: number,
		) => editingRoute(() => action("fixture"), status),
	};
});
const id = "11111111-1111-4111-8111-111111111111";
describe("automatic portrait HTTP intake", () => {
	beforeEach(() => {
		create.mockReset();
	});
	it("returns the stable result identity for the queued export", async () => {
		create.mockResolvedValue({ id, projectId: id });
		const input = {
			contentId: id,
			mediaVersionId: id,
			analysisRevisionId: id,
			targetDurationFrames: 900,
			requestKey: id,
		};
		const response = await POST(
			new Request("http://localhost/api/library/portrait-generations", {
				method: "POST",
				body: JSON.stringify(input),
			}),
		);
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ id, projectId: id });
		expect(create).toHaveBeenCalledExactlyOnceWith(input, "fixture");
	});
	it("rejects oversized JSON before creating any generation", async () => {
		const response = await POST(
			new Request("http://localhost/api/library/portrait-generations", {
				method: "POST",
				body: "x".repeat(512 * 1024 + 1),
			}),
		);
		expect(response.status).toBe(413);
		expect(create).not.toHaveBeenCalled();
	});
});
