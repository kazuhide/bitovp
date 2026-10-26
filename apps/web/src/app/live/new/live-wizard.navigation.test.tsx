import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { type Locale, messagesFor } from "@/lib/i18n";
import { renderWithQuery } from "@/test/render";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (original) => ({
	...(await original<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
	useSearchParams: () => new URLSearchParams(),
}));

import { LiveWizard } from "./live-wizard";

beforeEach(() => {
	apiFetch.mockReset();
	apiFetch.mockResolvedValue([]);
});

const STEPS: Record<Locale, string[]> = {
	en: [
		"Basics",
		"Sources",
		"Ladder",
		"Output",
		"Packaging",
		"Encoding",
		"Manifests",
		"Schedule",
		"Review",
	],
	ja: [
		"基本",
		"ソース",
		"ラダー",
		"出力",
		"パッケージング",
		"エンコーディング",
		"マニフェスト",
		"スケジュール",
		"確認",
	],
};

function input(id: string): HTMLInputElement {
	const element = document.getElementById(id);
	if (!(element instanceof HTMLInputElement)) {
		throw new Error(`Missing input ${id}`);
	}
	return element;
}

it.each([
	"en",
	"ja",
] as const)("keeps packaging and manifest values while navigating the shared steps (%s)", async (locale) => {
	renderWithQuery(<LiveWizard />, locale);
	const nav = screen.getByRole("navigation", {
		name: locale === "ja" ? "ウィザードのステップ" : "Wizard steps",
	});
	const buttons = within(nav).getAllByRole("button");
	expect(buttons.map((button) => button.textContent)).toEqual(
		STEPS[locale].map((step, index) => `${index + 1}. ${step}`),
	);
	const showStep = async (index: number) => {
		const button = buttons[index];
		if (!button) throw new Error(`Missing step ${index}`);
		await userEvent.click(button);
	};

	const shared = messagesFor(locale).wizard;
	expect(input("lw-name")).toBeVisible();
	expect(input("lw-name")).toHaveValue("");
	await showStep(2);
	expect(
		screen.getByRole("heading", { name: shared.videoRenditions }),
	).toBeVisible();
	expect(
		screen.getByRole("heading", { name: shared.audioRenditions }),
	).toBeVisible();
	for (const [id, label] of [
		["lw-v-0-height", shared.heightP],
		["lw-v-0-bitrate", shared.bitrateBps],
		["lw-a-0-bitrate", shared.bitrateBps],
		["lw-a-0-rate", shared.sampleRateHz],
	] as const) {
		expect(input(id).labels?.[0]).toHaveTextContent(label);
	}
	expect(
		document.querySelector('#lw-v-0-codec option[value="VP9"]'),
	).toBeNull();
	expect(
		document.querySelector('#lw-v-0-codec option[value="AV1"]'),
	).toBeNull();

	await showStep(4);
	const segmentLength = input("lw-seglen");
	expect(
		screen.getByLabelText(
			locale === "ja" ? "セグメント長 (秒)" : "Segment length (s)",
		),
	).toBe(segmentLength);
	fireEvent.change(segmentLength, { target: { value: "6" } });
	expect(document.getElementById("lw-hls-mname")).toBeNull();
	expect(document.getElementById("lw-archive-enabled")).toBeVisible();

	await showStep(6);
	fireEvent.change(input("lw-hls-mname"), {
		target: { value: "custom.m3u8" },
	});
	fireEvent.change(input("lw-hls-timeshift"), { target: { value: "120" } });
	expect(document.getElementById("lw-seglen")).toBeNull();

	await showStep(3);
	fireEvent.change(input("lw-out-base"), { target: { value: "delivery" } });
	expect(document.getElementById("lw-archive-enabled")).toBeNull();

	await showStep(5);
	expect(
		screen.getByRole("heading", {
			name:
				locale === "ja" ? "自動再起動・自動停止" : "Automatic restart and stop",
		}),
	).toBeVisible();
	expect(document.getElementById("lw-ar-segmentsWrittenTimeout")).toBeVisible();

	await showStep(4);
	expect(input("lw-seglen")).toHaveValue(6);
	await showStep(6);
	expect(input("lw-hls-mname")).toHaveValue("custom.m3u8");
	expect(input("lw-hls-timeshift")).toHaveValue(120);
	await showStep(3);
	expect(input("lw-out-base")).toHaveValue("delivery");
	await showStep(8);
	expect(buttons[8]).toHaveAttribute("aria-current", "step");
	expect(apiFetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
		false,
	);
});
