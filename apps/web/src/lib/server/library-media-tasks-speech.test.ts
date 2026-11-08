import { randomUUID } from "node:crypto";
import {
	mediaTaskCreateSchema,
	mediaTaskIntentHash,
	normalizeSceneAnalysis,
} from "@bitovp/core";
import { afterEach, expect, it, vi } from "vitest";
import type { ServerContext } from "./context";
import { createMediaTask } from "./library-media-tasks";

const holder = vi.hoisted(() => ({
	context: null as unknown as ServerContext,
}));
vi.mock("./context", () => ({ getServerContext: async () => holder.context }));
afterEach(() => vi.unstubAllEnvs());
type Row = Record<string, unknown>;
function fixture(captions: "AUTO" | "OFF" = "AUTO") {
	const organizationId = randomUUID(),
		mediaId = randomUUID(),
		sourceId = randomUUID(),
		analysisId = randomUUID(),
		contentId = randomUUID();
	const rows: Row[] = [];
	const input = {
		kind: "GENERATE",
		mediaVersionId: mediaId,
		analysisRevisionId: analysisId,
		requestKey: randomUUID(),
		parameters: { contentId, targetDurationFrames: 90, captions },
	};
	const media = vi.fn(async () => ({
		id: mediaId,
		organizationId,
		sourceId,
		state: "PENDING",
		sha256: null,
		timeMap: null,
	}));
	const matches = (row: Row, where: Row): boolean =>
		Object.entries(where).every(([key, value]) =>
			key === "organizationId_requestKey"
				? matches(row, value as Row)
				: row[key] === value,
		);
	const tx = {
		libraryMediaTask: {
			findUnique: async ({ where }: { where: Row }) =>
				rows.find((row) => matches(row, where)) ?? null,
			findFirst: async () => null,
			create: async ({ data }: { data: Row }) => {
				const row = {
					id: randomUUID(),
					state: "PENDING",
					phase: "QUEUED",
					...data,
				};
				rows.push(row);
				return row;
			},
		},
		libraryMediaVersion: { findUnique: media },
		sceneAnalysisRevision: {
			findUnique: async () => ({
				id: analysisId,
				organizationId,
				sourceId,
				rawHash: "c".repeat(64),
				document: normalizeSceneAnalysis({
					metadata: { version: "authored-unit" },
					duration: 3,
					scenes: [],
				}),
			}),
		},
		contentRevision: { findFirst: async () => ({ contentId, sourceId }) },
		$executeRaw: async () => 1,
	};
	holder.context = {
		tenant: { organizationId },
		prisma: {
			...tx,
			$transaction: async <T>(fn: (value: typeof tx) => Promise<T>) => fn(tx),
		},
	} as unknown as ServerContext;
	return { input, rows, media };
}

it("stamps only new AUTO intents even while immutable media preparation is pending", async () => {
	const f = fixture();
	await createMediaTask(f.input, null);
	expect(f.rows[0]).toHaveProperty("phase", "WAITING_FOR_MEDIA");
	expect(f.rows[0]).toHaveProperty(
		"parameters.identity.speechSelectionPolicyVersion",
		"asr-boundary-v1",
	);
	expect(f.rows[0]).toHaveProperty("parameters.identity.mediaSha256", null);
});
it("does not change the legacy OFF identity", async () => {
	const f = fixture("OFF");
	await createMediaTask(f.input, null);
	expect(f.rows[0]).not.toHaveProperty(
		"parameters.identity.speechSelectionPolicyVersion",
	);
});
it.each([
	"PENDING",
	"SUCCEEDED",
])("replays a pre-version %s intent without rebuilding identity", async (state) => {
	const f = fixture(),
		parsed = mediaTaskCreateSchema.parse(f.input);
	const previous = {
		id: randomUUID(),
		state,
		phase: state === "SUCCEEDED" ? "COMPLETE" : "QUEUED",
		organizationId: (holder.context.tenant as { organizationId: string })
			.organizationId,
		requestKey: parsed.requestKey,
		requestHash: mediaTaskIntentHash(parsed),
		parameters: { preserved: true },
		result: state === "SUCCEEDED" ? { preserved: true } : null,
	};
	f.rows.push(previous);
	const snapshot = structuredClone(previous);
	expect(await createMediaTask(f.input, null)).toMatchObject({
		taskId: previous.id,
		state,
	});
	expect(previous).toEqual(snapshot);
	expect(f.media).not.toHaveBeenCalled();
	await expect(
		createMediaTask(
			{
				...f.input,
				parameters: { ...f.input.parameters, targetDurationFrames: 120 },
			},
			null,
		),
	).rejects.toMatchObject({ code: "REQUEST_KEY_REUSED" });
	expect(previous).toEqual(snapshot);
});
