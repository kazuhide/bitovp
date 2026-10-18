import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LOCALES, messagesFor, translate } from "@/lib/i18n";
import { renderLocalized } from "@/test/render";
import { BuildInfoPanel } from "./build-info-panel";

describe("Settings Web build information", () => {
	for (const locale of LOCALES) {
		it(`${locale}: shows the full commit and identifies this Web only`, () => {
			const messages = messagesFor(locale);
			renderLocalized(
				<BuildInfoPanel version="0.1.0" commit={"a".repeat(40)} />,
				locale,
			);
			expect(
				screen.getByRole("heading", {
					name: translate(messages, "settingsBuild.title"),
				}),
			).toBeInTheDocument();
			expect(
				screen.getByText(translate(messages, "settingsBuild.scope")),
			).toBeInTheDocument();
			expect(screen.getByText("a".repeat(40))).toBeInTheDocument();
			expect(screen.getByText("0.1.0")).toBeInTheDocument();
			expect(
				screen.queryByText(/deployment profile|デプロイプロファイル/i),
			).toBeNull();
			expect(screen.queryByText(/UNRESTRICTED|AKAMAI_ONLY/)).toBeNull();
			expect(
				screen.getByRole("button", {
					name: translate(messages, "uiX.moreInformationFor", {
						label: translate(messages, "settingsBuild.title"),
					}),
				}),
			).toBeInTheDocument();
		});

		it(`${locale}: renders an explicit unknown commit without a guessed date`, () => {
			renderLocalized(<BuildInfoPanel version="0.1.0" commit={null} />, locale);
			expect(
				screen.getByText(
					translate(messagesFor(locale), "settingsBuild.unknown"),
				),
			).toBeInTheDocument();
			expect(document.querySelector("time")).toBeNull();
		});
	}
});
