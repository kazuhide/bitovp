import { beforeEach, describe, expect, it, vi } from "vitest";

const { getWebBuildInfo } = vi.hoisted(() => ({ getWebBuildInfo: vi.fn() }));
vi.mock("@/lib/server/build-info", () => ({ getWebBuildInfo }));
vi.mock("@/lib/i18n/metadata", () => ({
	localizedTitle: () => () => ({ title: "Settings" }),
}));
vi.mock("./settings-areas", () => ({ SettingsAreas: () => null }));
vi.mock("./build-info-panel", () => ({ BuildInfoPanel: () => null }));

import { BuildInfoPanel } from "./build-info-panel";
import SettingsPage, { dynamic } from "./page";
import { SettingsAreas } from "./settings-areas";

beforeEach(() => getWebBuildInfo.mockReset());

describe("Settings page build-info boundary", () => {
	it("is request-time dynamic and places the panel after SettingsAreas with only allowed props", () => {
		getWebBuildInfo.mockReturnValue({
			version: "0.1.0",
			commit: "a".repeat(40),
			secret: "never-expose",
		});
		expect(dynamic).toBe("force-dynamic");
		const children = SettingsPage().props.children;
		expect(children).toHaveLength(2);
		expect(children[0].type).toBe(SettingsAreas);
		expect(children[1].type).toBe(BuildInfoPanel);
		expect(children[1].props).toEqual({
			version: "0.1.0",
			commit: "a".repeat(40),
		});
	});

	it("resolves a fresh public snapshot for each page request", () => {
		getWebBuildInfo
			.mockReturnValueOnce({
				version: "0.1.0",
				commit: null,
			})
			.mockReturnValueOnce({
				version: "0.1.0",
				commit: "b".repeat(40),
			});
		expect(SettingsPage().props.children[1].props.commit).toBeNull();
		expect(SettingsPage().props.children[1].props.commit).toBe("b".repeat(40));
	});
});
