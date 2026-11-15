import type {
	VodInputTimelinePrepareRequest,
	VodInputTimelineSourceFacts,
} from "@bitovp/core/vod-input-timeline";
import {
	type ObjectIdentity,
	type ObjectStorageBrowser,
	verifyTimelineObjectDigest,
} from "@bitovp/storage";
import { beforeEach, expect, it, vi } from "vitest";
import { probeVodInputSources } from "./media";
import { prepareVodInputTimeline } from "./prepare-timeline";
import { renderVodInputPreview } from "./render";

vi.mock("./render", () => ({ renderVodInputPreview: vi.fn() }));
vi.mock("./media", () => ({ probeVodInputSources: vi.fn() }));
vi.mock("@bitovp/storage", async (original) => ({
	...(await original<typeof import("@bitovp/storage")>()),
	verifyTimelineObjectDigest: vi.fn(),
}));

const id = "10000000-0000-4000-8000-000000000001";
const outputCredential = "10000000-0000-4000-8000-000000000002";
const sourceCredential = "10000000-0000-4000-8000-000000000003";
const secondCredential = "10000000-0000-4000-8000-000000000004";
const identity = { size: 1024, etag: '"source"' };
const fact = (key: string): VodInputTimelineSourceFacts => ({
	key,
	durationMs: 1000,
	identity,
	video: { streamIndex: 0, width: 1920, height: 1080 },
	audio: { streamIndex: 1, sampleRate: 48000, channels: 2 },
});
const request: VodInputTimelinePrepareRequest = {
	kind: "TIMELINE_PREPARE",
	probeId: id,
	document: {
		schemaVersion: 2,
		id,
		durationMs: 1000,
		audioEnabled: true,
		videoClips: [{ id, sourceKey: "a", startMs: 0, inMs: 0, outMs: 1000 }],
		audioClips: [{ id, sourceKey: "b", startMs: 0, inMs: 0, outMs: 1000 }],
	},
	output: { credentialId: outputCredential, bucket: "output", prefix: "owned" },
};
const sources = [
	{ key: "a", credentialId: sourceCredential, bucket: "media", objectKey: "a" },
	{ key: "b", credentialId: secondCredential, bucket: "media", objectKey: "b" },
];
const browser = () => ({
	listBuckets: vi.fn(async () => []),
	listObjects: vi.fn(async () => ({ objects: [], prefixes: [] })),
	headObject: vi.fn(async (): Promise<ObjectIdentity> => identity),
	getObject: vi.fn(),
	putObject: vi.fn(async () => {}),
	dispose: vi.fn(),
});
beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(renderVodInputPreview).mockResolvedValue({
		path: "/owned/prepared.mp4",
		durationMs: 1000,
		size: identity.size,
		bytesRead: identity.size,
		sha256: "a".repeat(64),
	});
	vi.mocked(verifyTimelineObjectDigest).mockResolvedValue(undefined);
	vi.mocked(probeVodInputSources).mockResolvedValue([
		fact(`prepared_${id.replaceAll("-", "")}`),
	]);
});

it.each([
	["source factory", "CANCELED"],
	["source factory", "LEASE_LOST"],
	["source HEAD", "CANCELED"],
	["source HEAD", "LEASE_LOST"],
	["output factory", "CANCELED"],
	["output HEAD", "CANCELED"],
	["final output HEAD", "LEASE_LOST"],
])("stops during %s on %s and disposes owned or late browsers", async (stage, code) => {
	const controller = new AbortController();
	const output = browser(),
		first = browser(),
		second = browser();
	let release: (() => void) | undefined;
	let reached = false;
	const delayed = <T>(value: T) =>
		new Promise<T>((resolve) => {
			reached = true;
			release = () => resolve(value);
		});
	const browserFor = vi.fn(
		async (credentialId: string): Promise<ObjectStorageBrowser> => {
			if (credentialId === outputCredential)
				return stage === "output factory" ? delayed(output) : output;
			if (credentialId === sourceCredential)
				return stage === "source factory" ? delayed(first) : first;
			return second;
		},
	);
	if (stage === "source HEAD")
		first.headObject.mockImplementation(() => delayed(identity));
	if (stage === "output HEAD" || stage === "final output HEAD") {
		let calls = 0;
		output.headObject.mockImplementation(
			async (): Promise<ObjectIdentity> =>
				++calls === (stage === "output HEAD" ? 1 : 2)
					? delayed(identity)
					: identity,
		);
	}
	let rejection: unknown;
	const operation = prepareVodInputTimeline({
		request,
		sources,
		facts: sources.map(({ key }) => fact(key)),
		organizationId: id,
		taskId: id,
		attemptId: id,
		directory: "/owned",
		browserFor,
		signal: controller.signal,
	}).catch((error) => {
		rejection = error;
	});
	try {
		await vi.waitFor(() => expect(reached).toBe(true));
		const reason = new Error(code);
		controller.abort(reason);
		// Resolve the SDK promise only after the caller has stopped and released ownership.
		await vi.waitFor(() => expect(rejection).toBe(reason));
		if (stage !== "output factory")
			expect(output.dispose).toHaveBeenCalledOnce();
		if (stage === "source HEAD") expect(first.dispose).toHaveBeenCalledOnce();
		if (stage.startsWith("source")) {
			expect(browserFor).not.toHaveBeenCalledWith(secondCredential);
			expect(output.putObject).not.toHaveBeenCalled();
		}
		if (stage === "output factory")
			expect(renderVodInputPreview).not.toHaveBeenCalled();
	} finally {
		release?.();
		await operation;
	}
	if (stage === "source factory") {
		await vi.waitFor(() => expect(first.dispose).toHaveBeenCalledOnce());
		expect(first.headObject).not.toHaveBeenCalled();
	}
	if (stage === "output factory")
		await vi.waitFor(() => expect(output.dispose).toHaveBeenCalledOnce());
});
