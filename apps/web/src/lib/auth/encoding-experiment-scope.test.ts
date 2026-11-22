import { expect, it } from "vitest";
import { experimentScopeRefusal } from "./encoding-experiment-scope";

const experiments = "/api/encoding-experiments/v1";
const scoped = {
	actor: "token:experiment-token",
	tokenScope: "encoding-experiments",
	tokenRoleKnown: true,
};

it("confines an experiment bearer to the versioned prefix and its own revocation", () => {
	expect(
		experimentScopeRefusal(scoped, `${experiments}/campaigns`, "GET", "users"),
	).toBeNull();
	expect(
		experimentScopeRefusal(scoped, "/api/credentials", "GET", "users"),
	).toBe("TOKEN_SCOPE_DENIED");
	expect(
		experimentScopeRefusal(scoped, `${experiments}0/campaigns`, "GET", "users"),
	).toBe("TOKEN_SCOPE_DENIED");
	expect(
		experimentScopeRefusal(
			scoped,
			"/api/api-tokens/experiment-token",
			"DELETE",
			"users",
		),
	).toBeNull();
	expect(
		experimentScopeRefusal(
			scoped,
			"/api/api-tokens/another-token",
			"DELETE",
			"users",
		),
	).toBe("TOKEN_SCOPE_DENIED");
	expect(
		experimentScopeRefusal(
			scoped,
			"/api/api-tokens/experiment-token",
			"GET",
			"users",
		),
	).toBe("TOKEN_SCOPE_DENIED");
});

it("requires experiment scope and a known role from machine callers", () => {
	const ordinary = { actor: "token:ordinary" };
	expect(
		experimentScopeRefusal(ordinary, "/api/credentials", "GET", "users"),
	).toBeNull();
	expect(
		experimentScopeRefusal(
			ordinary,
			`${experiments}/campaigns`,
			"GET",
			"users",
		),
	).toBe("TOKEN_SCOPE_DENIED");
	expect(
		experimentScopeRefusal(
			{ ...scoped, tokenRoleKnown: false },
			`${experiments}/campaigns`,
			"GET",
			"password",
		),
	).toBe("TOKEN_SCOPE_DENIED");
});

it("keeps experiment reads closed under AUTH_MODE=none", () => {
	for (const context of [{ actor: "none" }, scoped]) {
		expect(
			experimentScopeRefusal(context, `${experiments}/sources`, "GET", "none"),
		).toBe("EXPERIMENT_AUTH_REQUIRED");
	}
	expect(
		experimentScopeRefusal(
			{ actor: "session" },
			`${experiments}/sources`,
			"GET",
			"password",
		),
	).toBeNull();
});
