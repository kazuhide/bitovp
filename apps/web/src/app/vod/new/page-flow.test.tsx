import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/i18n/metadata", () => ({ localizedTitle: () => () => ({}) }));

const { cookies, remembered } = vi.hoisted(() => {
	const remembered: { value?: string } = {};
	return {
		remembered,
		cookies: vi.fn(async () => ({
			get: (name: string) =>
				name === "bitovp-vod-flow" && remembered.value !== undefined
					? { name, value: remembered.value }
					: undefined,
		})),
	};
});
vi.mock("next/headers", () => ({ cookies }));

import NewVodJobPage from "./page";

async function open(searchParams: Record<string, string | string[]>) {
	const page = await NewVodJobPage({
		searchParams: Promise.resolve(searchParams),
	});
	return { flow: page.props.flow, key: page.key };
}

beforeEach(() => {
	remembered.value = undefined;
	cookies.mockClear();
});

describe("new VOD job page — which flow opens", () => {
	it("opens the streaming wizard when nothing was chosen", async () => {
		expect(await open({})).toEqual({ flow: "streaming", key: "wizard" });
	});

	it("opens the flow the URL names, over the one remembered", async () => {
		remembered.value = "streaming";
		expect(await open({ flow: "file" })).toEqual({ flow: "file", key: "file" });
		remembered.value = "file";
		expect(await open({ flow: "streaming" })).toEqual({
			flow: "streaming",
			key: "wizard",
		});
	});

	it("opens the remembered flow when the URL names none it knows", async () => {
		remembered.value = "file";
		expect(await open({})).toEqual({ flow: "file", key: "file" });
		expect(await open({ flow: "mezzanine" })).toEqual({
			flow: "file",
			key: "file",
		});
		expect(await open({ flow: ["streaming", "file"] })).toEqual({
			flow: "file",
			key: "file",
		});
	});

	it.each([
		"preset",
		"userPreset",
		"deliveryPreset",
		"editPreset",
	])("leaves the flow to the plan a %s brings", async (param) => {
		remembered.value = "file";
		expect(await open({ [param]: "retained", flow: "file" })).toEqual({
			flow: undefined,
			key: "wizard",
		});
		expect(cookies).not.toHaveBeenCalled();
	});

	it("copies a job without asking for a flow", async () => {
		remembered.value = "file";
		const page = await NewVodJobPage({
			searchParams: Promise.resolve({ from: "source-job", flow: "file" }),
		});
		expect(page.props).toEqual({
			source: "source-job",
			conflictingSource: false,
		});
		expect(cookies).not.toHaveBeenCalled();
	});
});
