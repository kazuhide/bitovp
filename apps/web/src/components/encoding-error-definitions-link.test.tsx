import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { EncodingErrorDefinitionsLink } from "./encoding-error-definitions-link";

describe("EncodingErrorDefinitionsLink", () => {
	it("links the saved account without guessing an error code", () => {
		renderLocalized(
			<EncodingErrorDefinitionsLink bitmovinAccountId="account-1" />,
		);
		expect(
			screen.getByRole("link", { name: "Look up error codes" }),
		).toHaveAttribute(
			"href",
			"/settings/error-definitions?bitmovinAccountId=account-1",
		);
	});
	it("does not link another account for a job without a saved account", () => {
		renderLocalized(<EncodingErrorDefinitionsLink bitmovinAccountId={null} />);
		expect(screen.queryByRole("link")).not.toBeInTheDocument();
	});
});
