import { afterEach, expect, it, vi } from "vitest";
import { createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => vi.unstubAllGlobals());

const receiptId = "32541f4a-19a2-4a27-8cf7-4af7d2978147";
const receipt = { id: receiptId, lookupName: `bitovp-role-${receiptId}` };
const resource = {
	id: "matching-role",
	name: receipt.lookupName,
	description: "authored role name",
	bucketName: "fixture-bucket",
	roleArn: "arn:aws:iam::111122223333:role/fixture",
	externalId: "provider-global-external-id",
	externalIdMode: "GLOBAL",
};
const other = (id: string) => ({
	id,
	name: `${receipt.lookupName} unrelated`,
});

function recovery(
	direction: "inputs" | "outputs",
	page: object,
	detail: object = resource,
) {
	const path = `/v1/encoding/${direction}/s3-role-based`;
	const calls: string[] = [];
	const wire = vi.fn(async (target: string, init: RequestInit) => {
		const url = new URL(target);
		expect(init.method).toBe("GET");
		calls.push(url.pathname);
		if (url.pathname === path) {
			expect(url.searchParams.get("name")).toBe(receipt.lookupName);
			expect(url.searchParams.get("offset")).toBe("0");
			expect(url.searchParams.get("limit")).toBe("100");
			return Response.json({ data: { result: page } });
		}
		const id = url.pathname.split("/").at(-1);
		return Response.json({ data: { result: { id, ...detail } } });
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
		path,
		calls,
		reserve,
		result: () =>
			(direction === "inputs"
				? sdk.createS3RoleBasedInput
				: sdk.createS3RoleBasedOutput)({
				name: resource.description,
				bucketName: resource.bucketName,
				roleArn: resource.roleArn,
				region: "us-east-1",
			}),
	};
}

it.each([
	"inputs",
	"outputs",
] as const)("recovers a reserved %s name with optional list metadata and a verified detail", async (direction) => {
	const run = recovery(direction, {
		items: [other("unrelated-role"), { id: resource.id }],
	});
	await expect(run.result()).resolves.toBe(resource.id);
	expect(run.calls).toEqual([run.path, `${run.path}/${resource.id}`]);
	expect(run.reserve).not.toHaveBeenCalled();
});

const fullPage = [
	{ id: resource.id },
	...Array.from({ length: 99 }, (_, index) => other(`other-${index}`)),
];

it("accepts a full exact-name result only when the reported total proves completeness", async () => {
	const run = recovery("outputs", { items: fullPage, totalCount: 100 });
	await expect(run.result()).resolves.toBe(resource.id);
	expect(run.calls).toEqual([run.path, `${run.path}/${resource.id}`]);
	expect(run.reserve).not.toHaveBeenCalled();
});

it.each([
	["full page without a total", { items: fullPage }],
	["another page exists", { items: [{ id: resource.id }], next: "/next" }],
	["missing items", {}],
	["empty result without a total", { items: [] }],
	["inconsistent total", { items: [{ id: resource.id }], totalCount: 2 }],
] as const)("keeps storage unresolved after one lookup given %s", async (_name, page) => {
	const run = recovery("outputs", page);
	await expect(run.result()).rejects.toThrow(/awaiting provider confirmation/);
	expect(run.calls).toEqual([run.path]);
	expect(run.reserve).not.toHaveBeenCalled();
});

it.each([
	["different ID", { id: "different" }],
	["different name", { name: "not the reserved name" }],
	["different description", { description: "another attempt" }],
	["different bucket", { bucketName: "unrelated-bucket" }],
	["different role ARN", { roleArn: "arn:aws:iam::111122223333:role/other" }],
	["missing a provider External ID", { externalId: undefined }],
	["blank provider External ID", { externalId: " " }],
	["an explicit non-GLOBAL External ID mode", { externalIdMode: "CUSTOM" }],
] as const)("never adopts detail with %s", async (_name, different) => {
	const run = recovery(
		"outputs",
		{ items: [{ id: resource.id }] },
		{
			...resource,
			...different,
		},
	);
	await expect(run.result()).rejects.toThrow(/S3 role-based storage create/);
	expect(run.calls).toEqual([run.path, `${run.path}/${resource.id}`]);
	expect(run.reserve).not.toHaveBeenCalled();
});

it("rejects more than one exact role resource for the reserved name", async () => {
	const { id: _id, ...fingerprint } = resource;
	const run = recovery(
		"outputs",
		{
			items: [{ id: resource.id }, { id: "second-role" }],
		},
		fingerprint,
	);
	await expect(run.result()).rejects.toThrow(/could not be verified/);
	expect(run.reserve).not.toHaveBeenCalled();
});
