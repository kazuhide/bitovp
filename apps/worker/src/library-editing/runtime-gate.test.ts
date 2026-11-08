import { describe, expect, it, vi } from "vitest";
import { createSweepLoop } from "../lifecycle";
import { createConfiguredLibraryEditing } from "./runtime-gate";

const configured = {
	BITOVP_LOCAL_SEMANTIC_ENABLED: "1",
	BITOVP_LOCAL_SEMANTIC_GATEWAY_URL: "https://192.168.68.62:11437",
	BITOVP_LOCAL_SEMANTIC_GATEWAY_TOKEN: "a".repeat(48),
	BITOVP_LOCAL_SEMANTIC_CA_FILE: "/run/local-semantic/ca.pem",
	BITOVP_LOCAL_SEMANTIC_PROFILE: "nvidia",
	BITOVP_LOCAL_SEMANTIC_CONFIG_ID: "11111111-1111-4111-8111-111111111111",
};

describe("local-LLM required worker startup", () => {
	it.each([
		["unset", {}],
		["disabled", { ...configured, BITOVP_LOCAL_SEMANTIC_ENABLED: "0" }],
		["partial", { BITOVP_LOCAL_SEMANTIC_ENABLED: "1" }],
		[
			"invalid url",
			{
				...configured,
				BITOVP_LOCAL_SEMANTIC_GATEWAY_URL: "http://localhost:11434",
			},
		],
		[
			"invalid token",
			{ ...configured, BITOVP_LOCAL_SEMANTIC_GATEWAY_TOKEN: "invalid" },
		],
		[
			"invalid profile",
			{ ...configured, BITOVP_LOCAL_SEMANTIC_PROFILE: "cloud" },
		],
		[
			"invalid identity",
			{ ...configured, BITOVP_LOCAL_SEMANTIC_CONFIG_ID: "invalid" },
		],
	])("does not construct or register either clip sweep for %s configuration", (_, env) => {
		const constructClipSweeps = vi.fn(() => ({
			mediaTasks: vi.fn(),
			editing: vi.fn(),
		}));
		expect(
			createConfiguredLibraryEditing(env, constructClipSweeps),
		).toBeUndefined();
		expect(constructClipSweeps).not.toHaveBeenCalled();
	});

	it.each([
		"nvidia",
		"amd",
	])("preserves the configured runtime and fixed %s profile", (profile) => {
		const runtime = { mediaTasks: vi.fn(), editing: vi.fn() };
		const create = vi.fn(() => runtime);
		expect(
			createConfiguredLibraryEditing(
				{ ...configured, BITOVP_LOCAL_SEMANTIC_PROFILE: profile },
				create,
			),
		).toBe(runtime);
		expect(create).toHaveBeenCalledExactlyOnceWith({
			url: configured.BITOVP_LOCAL_SEMANTIC_GATEWAY_URL,
			token: configured.BITOVP_LOCAL_SEMANTIC_GATEWAY_TOKEN,
			caFile: configured.BITOVP_LOCAL_SEMANTIC_CA_FILE,
			profile,
			configId: configured.BITOVP_LOCAL_SEMANTIC_CONFIG_ID,
		});
	});

	it("keeps unavailable client initialization local to editing without forwarding sensitive errors", () => {
		const create = vi.fn(() => {
			throw new Error("private token or CA path");
		});
		expect(createConfiguredLibraryEditing(configured, create)).toBeUndefined();
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("lets normal capture and encoding loops run while no clip runtime is registered", async () => {
		const seen: string[] = [];
		const create = vi.fn(() =>
			createSweepLoop(async () => {
				seen.push("clip");
			}),
		);
		const editing = createConfiguredLibraryEditing({}, create);
		const capture = createSweepLoop(async () => {
			seen.push("capture");
		});
		const encoding = createSweepLoop(async () => {
			seen.push("encoding");
		});
		capture.run();
		encoding.run();
		editing?.run();
		await Promise.all([capture.drain(), encoding.drain()]);
		expect(seen).toEqual(["capture", "encoding"]);
		expect(create).not.toHaveBeenCalled();
	});
});
