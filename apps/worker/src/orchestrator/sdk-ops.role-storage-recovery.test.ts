import { afterEach, expect, it, vi } from "vitest";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

const receipt = { id: "32541f4a-19a2-4a27-8cf7-4af7d2978147" };
const resource = {
	id: "matching-role",
	name: "legacy authored name",
	description: `BitOVP role storage create ${receipt.id}`,
	bucketName: "fixture-bucket",
	roleArn: "arn:aws:iam::111122223333:role/fixture",
};
const other = (id: string) => ({
	id,
	name: resource.name,
	description: "another receipt",
});
const page = [
	resource,
	...Array.from({ length: 99 }, (_, index) => other(`other-${index}`)),
];

const response = (result: object) => Response.json({ data: { result } });

function recovery(direction: "inputs" | "outputs", pages: object[]) {
	const path = `/v1/encoding/${direction}/s3-role-based`;
	const requested: string[] = [];
	const wire = vi.fn(async (target: string, init: RequestInit) => {
		const url = new URL(target);
		expect(init.method).toBe("GET");
		requested.push(
			url.pathname === path
				? (url.searchParams.get("offset") ?? "")
				: url.pathname,
		);
		if (url.pathname === path) {
			expect(url.searchParams.get("name")).toBe(resource.name);
			expect(url.searchParams.get("limit")).toBe("100");
			return response(
				pages[Number(url.searchParams.get("offset")) / 100] ?? {},
			);
		}
		const id = url.pathname.split("/").at(-1);
		return response({ ...resource, id });
	});
	vi.stubGlobal("fetch", wire);
	const reserve = vi.fn(async () => receipt);
	const sdk = createBitmovinSdkOps(
		{
			apiKey: "fixture-only",
			stamp: {
				jobId: "fixture-job",
				currentStep: () => "role-storage",
				roleStorageCreateJournal: () => ({
					current: () => receipt,
					reserve,
					release: vi.fn(),
				}),
			},
		},
		async () => {},
	);
	return {
		requested,
		reserve,
		result: () =>
			(direction === "inputs"
				? sdk.createS3RoleBasedInput
				: sdk.createS3RoleBasedOutput)({
				name: resource.name,
				bucketName: resource.bucketName,
				roleArn: resource.roleArn,
				region: "us-east-1",
			}),
	};
}

it.each([
	"inputs",
	"outputs",
] as const)("recovers a legacy %s receipt from a full page without totalCount", async (direction) => {
	const run = recovery(direction, [
		{ items: page, offset: 0 },
		{ items: [other("last")], offset: 100 },
	]);
	await expect(run.result()).resolves.toBe(resource.id);
	expect(run.requested).toEqual([
		"0",
		`/v1/encoding/${direction}/s3-role-based/${resource.id}`,
		"100",
	]);
	expect(run.reserve).not.toHaveBeenCalled();
});

it("can prove the end of an inventory with a coherent explicit total", async () => {
	const run = recovery("outputs", [
		{ items: page },
		{ items: [], offset: 100, totalCount: 100 },
	]);
	await expect(run.result()).resolves.toBe(resource.id);
	expect(run.reserve).not.toHaveBeenCalled();
});

it.each([
	["repeated IDs", { items: page, offset: 100 }],
	["wrong offset", { items: [other("last")], offset: 0 }],
	["unidentified item", { items: [{ name: resource.name }] }],
	[
		"second matching fingerprint",
		{ items: [{ ...resource, id: "second-role" }] },
	],
	["missing items", {}],
	["empty result without total", { items: [] }],
	["inconsistent total", { items: [other("last")], totalCount: 102 }],
] as const)("keeps an uncertain role receipt unresolved with %s", async (_name, next) => {
	const run = recovery("outputs", [{ items: page }, next]);
	await expect(run.result()).rejects.toThrow(/S3 role-based storage create/i);
	expect(run.requested).toContain("100");
	expect(run.reserve).not.toHaveBeenCalled();
});
