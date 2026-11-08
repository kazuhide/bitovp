import { randomUUID } from "node:crypto";
import { mediaTaskCreateSchema, mediaTaskIntentHash } from "@bitovp/core";
import { beforeEach, expect, it, vi } from "vitest";
import type { ServerContext } from "./context";
import { createMediaTask } from "./library-media-tasks";

const holder = vi.hoisted(() => ({ context: {} as ServerContext }));
vi.mock("./context", () => ({ getServerContext: async () => holder.context }));
const organizationId = randomUUID(),
	mediaVersionId = randomUUID(),
	sourceId = randomUUID(),
	analysisRevisionId = randomUUID();
type Row = Record<string, unknown>;
let created: Row[];
const prior = vi.fn(),
	media = vi.fn();
beforeEach(() => {
	created = [];
	prior.mockReset().mockResolvedValue(null);
	media.mockReset().mockResolvedValue({
		id: mediaVersionId,
		organizationId,
		sourceId,
		state: "PENDING",
	});
	const delegates = {
		$executeRaw: vi.fn(async () => 1),
		libraryMediaTask: {
			findUnique: prior,
			create: vi.fn(async ({ data }: { data: Row }) => {
				created.push(data);
				return { id: randomUUID(), state: "PENDING", ...data };
			}),
		},
		libraryMediaVersion: { findUnique: media },
		sceneAnalysisRevision: {
			findUnique: vi.fn(async () => ({
				id: analysisRevisionId,
				organizationId,
				sourceId,
				rawHash: "b".repeat(64),
				document: {},
			})),
		},
		contentRevision: { findFirst: vi.fn(async () => ({ id: randomUUID() })) },
	};
	holder.context = {
		tenant: { organizationId },
		prisma: {
			...delegates,
			$transaction: async <T>(fn: (tx: typeof delegates) => Promise<T>) =>
				fn(delegates),
		},
	} as unknown as ServerContext;
});
const request = (
	kind: "TRACK" | "GENERATE" | "TRANSCRIBE",
	tracking = false,
) => ({
	kind,
	mediaVersionId,
	requestKey: randomUUID(),
	...(kind === "TRANSCRIBE" ? {} : { analysisRevisionId }),
	parameters:
		kind === "GENERATE"
			? { contentId: randomUUID(), targetDurationFrames: 31, tracking }
			: {},
});
it.each([
	"TRACK",
	"GENERATE",
] as const)("pins the corrected frame clock server-side for a new %s", async (kind) => {
	await createMediaTask(request(kind, true), "editor");
	expect(created[0]?.parameters).toMatchObject({
		identity: {
			trackingAlgorithmVersion: "template-ncc-v2",
			trackingFrameClockVersion: "cfr30-source-frames-v1",
		},
	});
});
it.each([
	"TRANSCRIBE",
	"GENERATE",
] as const)("leaves unrelated %s work without a tracking clock", async (kind) => {
	await createMediaTask(request(kind), "editor");
	const envelope = created[0]?.parameters as {
		identity: Record<string, unknown>;
	};
	expect(envelope.identity).not.toHaveProperty("trackingFrameClockVersion");
});
it("replays the exact same-key completed legacy receipt without relabeling its identity", async () => {
	const value = request("TRACK"),
		id = randomUUID();
	const old = {
		id,
		state: "SUCCEEDED",
		phase: "COMPLETE",
		requestHash: mediaTaskIntentHash(mediaTaskCreateSchema.parse(value)),
		parameters: { identity: { trackingAlgorithmVersion: "template-ncc-v2" } },
	};
	prior.mockResolvedValue(old);
	expect(await createMediaTask(value, "editor")).toEqual({
		taskId: id,
		state: "SUCCEEDED",
		cached: false,
	});
	expect(media).not.toHaveBeenCalled();
	expect(created).toEqual([]);
	expect(old.parameters.identity).not.toHaveProperty(
		"trackingFrameClockVersion",
	);
});
it("does not allow a client to choose the frame-clock identity", async () => {
	await expect(
		createMediaTask(
			{
				...request("TRACK"),
				trackingFrameClockVersion: "cfr30-source-frames-v1",
			},
			"editor",
		),
	).rejects.toThrow();
	expect(created).toEqual([]);
});
