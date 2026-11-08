import { randomUUID } from "node:crypto";
import { hashEditingEvidence } from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generationDependencyFixture } from "./generation-dependency-fixture";
import { createLibraryMediaTaskSweep } from "./media-task-sweep";

const execute = vi.hoisted(() => vi.fn());
vi.mock("./media-task-execution", async (original) => ({
	...(await original<object>()),
	executeMediaTask: execute,
}));
afterEach(() => execute.mockReset());

describe("queued generation does not adopt a mutable project cache", () => {
	it("executes a fresh generation even when an older success advertises cacheable:true", async () => {
		const f = generationDependencyFixture();
		const instant = new Date(),
			oldProjectId = randomUUID(),
			newProjectId = randomUUID();
		Object.assign(f.task, {
			state: "PENDING",
			phase: "QUEUED",
			availableAt: instant,
			createdAt: instant,
			attempts: 0,
			startedAt: null,
			finishedAt: null,
			leaseToken: null,
			leaseUntil: null,
		});
		const original = {
			projectId: oldProjectId,
			projectIds: [oldProjectId],
			cacheable: true,
		};
		const old = {
			...f.task,
			id: randomUUID(),
			requestKey: randomUUID(),
			state: "SUCCEEDED",
			phase: "COMPLETE",
			result: original,
			createdAt: new Date(instant.getTime() - 1000),
			finishedAt: instant,
		};
		f.rows.push(old);
		const editedProject = {
			id: oldProjectId,
			documentHash: hashEditingEvidence({ title: "Operator edit" }),
		};
		const retained = structuredClone(editedProject);
		execute.mockResolvedValue({
			projectId: newProjectId,
			projectIds: [newProjectId],
			cacheable: false,
		});
		await createLibraryMediaTaskSweep({
			prisma: f.prisma,
			browserFor: vi.fn(),
			now: () => instant,
		})();
		expect(f.task).toMatchObject({
			state: "SUCCEEDED",
			phase: "COMPLETE",
			result: { projectId: newProjectId },
		});
		expect(f.task.result).not.toEqual(original);
		expect(old.result).toEqual(original);
		expect(editedProject).toEqual(retained);
	});
});
