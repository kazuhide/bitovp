import { screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";

const redirect = vi.hoisted(() =>
	vi.fn((_: string) => {
		throw new Error("NEXT_REDIRECT");
	}),
);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/i18n/metadata", () => ({ localizedTitle: vi.fn() }));
vi.mock("../templates/templates-client", () => ({
	TemplatesClient: () => <h2>Saved templates</h2>,
}));
vi.mock("./my-presets", () => ({
	MyPresets: () => <h2>Saved presets</h2>,
}));
vi.mock("./delivery-gallery", () => ({
	DeliveryGallery: () => <h2>Delivery presets</h2>,
}));
vi.mock("./preset-gallery", () => ({
	PresetGallery: () => <h2>Sample presets</h2>,
}));

import TemplatesPage from "../templates/page";
import PresetsPage from "./page";

beforeEach(() => {
	redirect.mockClear();
});

it.each([
	["en", "Templates & presets", "Saved", "Delivery presets", "Samples"],
	["ja", "テンプレート・プリセット", "保存済み", "配信プリセット", "サンプル"],
] as const)("defaults to saved workflows with localized three-view navigation (%s)", async (locale, heading, saved, delivery, samples) => {
	renderLocalized(
		await PresetsPage({ searchParams: Promise.resolve({}) }),
		locale,
	);
	expect(
		await screen.findByRole("heading", { level: 1, name: heading }),
	).toBeInTheDocument();
	expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
	expect(screen.getByRole("link", { name: saved })).toHaveAttribute(
		"href",
		"/presets",
	);
	expect(screen.getByRole("link", { name: saved })).toHaveAttribute(
		"aria-current",
		"page",
	);
	expect(screen.getByRole("link", { name: delivery })).toHaveAttribute(
		"href",
		"/presets?tab=delivery",
	);
	expect(screen.getByRole("link", { name: samples })).toHaveAttribute(
		"href",
		"/presets?tab=samples",
	);
	expect(
		screen.getByRole("heading", { name: "Saved templates" }),
	).toBeInTheDocument();
	expect(
		screen.queryByRole("heading", { name: "Saved presets" }),
	).not.toBeInTheDocument();
});

it.each([
	"saved",
	"templates",
])("restores the saved view through %s URLs", async (tab) => {
	renderLocalized(
		await PresetsPage({ searchParams: Promise.resolve({ tab }) }),
	);
	expect(
		await screen.findByRole("heading", {
			level: 1,
			name: "Templates & presets",
		}),
	).toBeInTheDocument();
	expect(screen.getByRole("link", { name: "Saved" })).toHaveAttribute(
		"aria-current",
		"page",
	);
	expect(
		screen.getByRole("link", { name: "Delivery presets" }),
	).not.toHaveAttribute("aria-current");
	expect(
		screen.getByRole("heading", { name: "Saved templates" }),
	).toBeInTheDocument();
	expect(
		screen.queryByRole("heading", { name: "Saved presets" }),
	).not.toBeInTheDocument();
	expect(
		screen.queryByRole("heading", { name: "Delivery presets" }),
	).not.toBeInTheDocument();
	expect(
		screen.queryByRole("heading", { name: "Sample presets" }),
	).not.toBeInTheDocument();
});

it.each([
	"delivery",
	"presets",
])("keeps delivery and samples apart through %s URLs", async (tab) => {
	renderLocalized(
		await PresetsPage({ searchParams: Promise.resolve({ tab }) }),
	);
	expect(
		await screen.findByRole("heading", { name: "Saved presets" }),
	).toBeInTheDocument();
	expect(
		screen.getByRole("heading", { name: "Delivery presets" }),
	).toBeInTheDocument();
	expect(
		screen.queryByRole("heading", { name: "Saved templates" }),
	).not.toBeInTheDocument();
	expect(
		screen.queryByRole("heading", { name: "Sample presets" }),
	).not.toBeInTheDocument();
});

it("shows only samples for the sample URL", async () => {
	renderLocalized(
		await PresetsPage({ searchParams: Promise.resolve({ tab: "samples" }) }),
	);
	expect(
		await screen.findByRole("heading", { name: "Sample presets" }),
	).toBeInTheDocument();
	expect(
		screen.queryByRole("heading", { name: "Saved presets" }),
	).not.toBeInTheDocument();
	expect(
		screen.queryByRole("heading", { name: "Saved templates" }),
	).not.toBeInTheDocument();
});

it("redirects legacy template URLs to the selected canonical tab", () => {
	expect(() => TemplatesPage()).toThrow("NEXT_REDIRECT");
	expect(redirect).toHaveBeenCalledExactlyOnceWith("/presets?tab=templates");
});
