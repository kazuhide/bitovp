import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: vi.fn(), open: vi.fn() }));
vi.mock("node:fs/promises", async () => {
	const actual =
		await vi.importActual<typeof import("node:fs/promises")>(
			"node:fs/promises",
		);
	const mocked = { ...actual, open: fake.open };
	return { ...mocked, default: mocked };
});
vi.mock("@/lib/auth/tenancy", async () => {
	const actual =
		await vi.importActual<typeof import("@/lib/auth/tenancy")>(
			"@/lib/auth/tenancy",
		);
	return { ...actual, requireOrganizationAdmin: fake.admin };
});

import { parsePerTitlePreset } from "@/app/vod/new/per-title-simulator-preset";
import { AuthContextError } from "@/lib/auth/tenancy";
import { GET } from "./route";

const actualFs =
	await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const ENV = "BITOVP_PER_TITLE_SIMULATOR_PRESETS_FILE";
const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG = "00000000-0000-4000-8000-000000000002";
const goal = {
	strategy: "automatic",
	codec: "H264",
	minBitrate: 100_000,
	maxBitrate: 2_000_000,
	countPolicy: { kind: "unrestricted" },
	rows: [],
};
const preset = {
	id: "sample-h264",
	label: "Sample H.264",
	contents: JSON.stringify({ version: 1, goal }),
};
let directory: string;

beforeEach(async () => {
	vi.clearAllMocks();
	vi.stubEnv(ENV, undefined);
	fake.admin.mockResolvedValue({ organizationId: ORG, role: "ADMIN" });
	fake.open.mockImplementation(actualFs.open);
	directory = await mkdtemp(join(tmpdir(), "bitovp-simulator-presets-"));
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(directory, { recursive: true, force: true });
});

async function configure(
	value: unknown = { organizationId: ORG, presets: [preset] },
) {
	const file = join(directory, "presets.json");
	await writeFile(file, JSON.stringify(value));
	vi.stubEnv(ENV, file);
	return file;
}
function request(query = "") {
	return new Request(
		`http://localhost/api/per-title-simulator-presets${query}`,
		{
			headers: { "x-bitovp-organization": OTHER_ORG },
		},
	);
}
function privateResponse(response: Response) {
	expect(response.headers.get("cache-control")).toBe("private, no-store");
}
async function unavailable(response: Response) {
	expect(response.status).toBe(503);
	privateResponse(response);
	expect(await response.json()).toEqual({
		error: "Per-Title presets are unavailable",
	});
}

describe("named Per-Title presets", () => {
	it.each([
		401, 403,
	] as const)("rejects %s before any configured file access", async (status) => {
		await configure();
		fake.admin.mockRejectedValue(
			new AuthContextError(status, "UNEXPOSED_AUTH_REASON"),
		);
		const req = request();
		const response = await GET(req);
		expect(response.status).toBe(status);
		privateResponse(response);
		expect(fake.admin).toHaveBeenCalledWith(req.headers);
		expect(fake.open).not.toHaveBeenCalled();
		expect(await response.text()).not.toContain("UNEXPOSED_AUTH_REASON");
	});

	it("uses the existing public auth mapping for unexpected authentication failures", async () => {
		fake.admin.mockRejectedValue(new Error("UNEXPOSED_AUTH_REASON"));
		const response = await GET(request());
		expect(response.status).toBe(503);
		privateResponse(response);
		expect(await response.json()).toEqual({
			error: "Authentication is unavailable",
			details: { code: "AUTH_PROVIDER_UNAVAILABLE" },
		});
		expect(fake.open).not.toHaveBeenCalled();
	});

	it("returns an empty list by default without opening a file", async () => {
		const response = await GET(request());
		expect(response.status).toBe(200);
		privateResponse(response);
		expect(await response.json()).toEqual({ presets: [] });
		expect(fake.admin).toHaveBeenCalledTimes(1);
		expect(fake.open).not.toHaveBeenCalled();
	});

	it("scopes to the freshly resolved organization and ignores caller paths", async () => {
		const file = await configure();
		const response = await GET(
			request("?path=ignored.json&organizationId=ignored"),
		);
		expect(response.status).toBe(200);
		privateResponse(response);
		expect(fake.open.mock.calls[0]?.[0]).toBe(file);
		expect((await response.json()).presets).toHaveLength(1);
		fake.admin.mockResolvedValue({ organizationId: OTHER_ORG, role: "ADMIN" });
		const other = await GET(request());
		privateResponse(other);
		expect(await other.json()).toEqual({ presets: [] });
	});

	it("does not parse another organization's preset contents", async () => {
		await configure({
			organizationId: OTHER_ORG,
			presets: [{ ...preset, contents: "not-json" }],
		});
		const response = await GET(request());
		expect(response.status).toBe(200);
		privateResponse(response);
		expect(await response.json()).toEqual({ presets: [] });
	});

	it("returns only canonical allowlisted data while retaining reference metadata", async () => {
		const reference = {
			codec: "H265",
			global: {
				minBitrate: 100_000,
				maxBitrate: 6_000_000,
				targetQualityCrf: 20,
				fixedResolutionAndBitrateConfiguration: {
					forcedRenditionAboveHighestFixedRepresentation: 1,
				},
			},
			streams: [
				{
					id: "required",
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
					height: 360,
					perTitleSettings: { minBitrate: 100_000, maxBitrate: 500_000 },
				},
				{
					id: "automatic",
					mode: "PER_TITLE_TEMPLATE",
					height: 1080,
					bitrate: null,
					perTitleSettings: {
						minBitrate: 800_000,
						maxBitrate: 4_000_000,
						bitrateSelectionMode: "COMPLEXITY_RANGE",
						lowComplexityBoundaryForMaxBitrate: 2_000_000,
						highComplexityBoundaryForMaxBitrate: 3_000_000,
					},
				},
			],
		};
		await configure({
			organizationId: ORG,
			presets: [
				preset,
				{
					id: "sample-reference",
					label: "Sample reference",
					contents: JSON.stringify({ version: 1, reference }),
				},
			],
		});
		const response = await GET(request());
		expect(response.status).toBe(200);
		privateResponse(response);
		const body = await response.json();
		expect(Object.keys(body)).toEqual(["presets"]);
		expect(body.presets.map((item: { id: string }) => item.id)).toEqual([
			"sample-h264",
			"sample-reference",
		]);
		expect(Object.keys(body.presets[0]).sort()).toEqual([
			"contents",
			"id",
			"label",
		]);
		expect(body.presets[0].contents).toContain('\n  "version": 1,');
		expect(
			parsePerTitlePreset(body.presets[0].contents, ["H264"]).goal,
		).toEqual(goal);
		const parsed = parsePerTitlePreset(body.presets[1].contents, ["H265"]);
		expect(parsed.reference).toEqual(reference);
		expect(parsed.goal.automaticTemplates?.[0]).toMatchObject(
			reference.streams[1]?.perTitleSettings ?? {},
		);
		expect(body).not.toHaveProperty("organizationId");
	});

	it.each([
		{ organizationId: ORG, presets: [preset], extra: "UNEXPOSED_VALUE" },
		{ organizationId: ORG, presets: [{ ...preset, extra: "UNEXPOSED_VALUE" }] },
		{ organizationId: ORG, presets: [preset, preset] },
		{
			organizationId: ORG,
			presets: Array.from({ length: 9 }, (_, i) => ({
				...preset,
				id: `preset-${i}`,
			})),
		},
		{ organizationId: ORG, presets: [{ ...preset, id: "../unsafe" }] },
		{ organizationId: ORG, presets: [{ ...preset, label: "Bad\nlabel" }] },
		{ organizationId: ORG, presets: [{ ...preset, label: " " }] },
		{ organizationId: ORG, presets: [{ ...preset, label: "x".repeat(81) }] },
		{
			organizationId: ORG,
			presets: [{ ...preset, contents: " ".repeat(128 * 1024 + 1) }],
		},
		{
			organizationId: ORG,
			presets: [
				{
					...preset,
					contents: JSON.stringify({
						version: 1,
						goal: { ...goal, apiKey: "UNEXPOSED_VALUE" },
					}),
				},
			],
		},
		{
			organizationId: ORG,
			presets: [
				{
					...preset,
					contents: JSON.stringify({
						version: 1,
						goal: { ...goal, codec: "H265V2" },
					}),
				},
			],
		},
	])("rejects invalid config without returning a partial list or source details %#", async (value) => {
		await configure(value);
		await unavailable(await GET(request()));
	});

	it("rejects malformed JSON and invalid UTF-8 with a generic response", async () => {
		const file = await configure();
		for (const bytes of [
			Buffer.from("{UNEXPOSED_VALUE"),
			Buffer.from([0xff]),
		]) {
			await writeFile(file, bytes);
			await unavailable(await GET(request()));
		}
	});

	it("rejects oversized and nonregular files", async () => {
		const file = await configure();
		await writeFile(file, Buffer.alloc(1024 * 1024 + 1, 32));
		await unavailable(await GET(request()));
		const folder = join(directory, "folder");
		await mkdir(folder);
		vi.stubEnv(ENV, folder);
		await unavailable(await GET(request()));
		const link = join(directory, "link.json");
		await symlink(file, link);
		vi.stubEnv(ENV, link);
		await unavailable(await GET(request()));
	});

	it("rejects relative configured paths before opening them", async () => {
		vi.stubEnv(ENV, "relative-presets.json");
		await unavailable(await GET(request()));
		expect(fake.open).not.toHaveBeenCalled();
	});

	it("does not expose filesystem errors, paths, labels or stored contents", async () => {
		const file = await configure();
		fake.open.mockRejectedValue(
			new Error(`${file} ${preset.label} ${preset.contents}`),
		);
		await unavailable(await GET(request()));
	});
});
