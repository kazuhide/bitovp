import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery as wrap } from "@/test/render";

// vi.hoisted: the mock factory is lifted above the imports, so the class it
// returns has to be created there too (a top-level class is not initialized yet).
const { apiFetch, ApiError } = vi.hoisted(() => {
	class HoistedApiError extends Error {
		constructor(
			readonly status: number,
			message: string,
			readonly details?: unknown,
		) {
			super(message);
		}
	}
	return { apiFetch: vi.fn(), ApiError: HoistedApiError };
});
vi.mock("@/lib/api", () => ({
	apiFetch: (...args: unknown[]) => apiFetch(...args),
	ApiError,
}));

const searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
	useSearchParams: () => searchParams,
}));

import { LoginForm } from "./login-form";

const assign = vi.fn();
Object.defineProperty(window, "location", {
	configurable: true,
	value: { assign, href: "http://localhost:3100/login" },
});

function configured(mode = "password") {
	apiFetch.mockImplementation((input: string) =>
		input === "/api/auth/session"
			? Promise.resolve({
					mode,
					configured: true,
					authenticated: false,
					loginKind: "password-form",
				})
			: Promise.resolve({ ok: true }),
	);
}

afterEach(() => {
	vi.clearAllMocks();
	searchParams.delete("next");
});

describe("LoginForm", () => {
	for (const locale of ["ja", "en"] as const) {
		it(`uses personal sign-in copy and unchanged credentials in users mode (${locale})`, async () => {
			configured("users");
			wrap(<LoginForm />, locale);
			const email = await screen.findByLabelText(
				locale === "ja" ? "メールアドレス" : "Email",
			);
			expect(
				screen.getByText(
					locale === "ja"
						? "メールアドレスとご自身のパスワードでサインインしてください。"
						: "Sign in with your email address and password.",
				),
			).toBeInTheDocument();
			expect(screen.queryByText(/チーム|shared team|Team password/)).toBeNull();
			await userEvent.type(email, "operator@example.test");
			await userEvent.type(
				screen.getByLabelText(locale === "ja" ? "パスワード" : "Password"),
				"personal-password",
			);
			await userEvent.click(
				screen.getByRole("button", {
					name: locale === "ja" ? "サインイン" : "Sign in",
				}),
			);
			await waitFor(() => {
				expect(apiFetch).toHaveBeenCalledWith("/api/auth/login", {
					method: "POST",
					body: JSON.stringify({
						email: "operator@example.test",
						password: "personal-password",
					}),
				});
			});
		});

		it(`retains shared-password copy without an email field (${locale})`, async () => {
			configured("password");
			wrap(<LoginForm />, locale);
			expect(
				await screen.findByLabelText(
					locale === "ja" ? "チームパスワード" : "Team password",
				),
			).toBeInTheDocument();
			expect(
				screen.getByText(
					locale === "ja"
						? "この Bitmovin OVP インストールのチーム共有パスワードを入力してください。"
						: "Enter the shared team password for this Bitmovin OVP install.",
				),
			).toBeInTheDocument();
			expect(screen.queryByLabelText(/メールアドレス|Email/)).toBeNull();
		});
	}

	it("posts the password and lands on the requested page", async () => {
		searchParams.set("next", "/vod/jobs?status=RUNNING");
		configured();
		wrap(<LoginForm />);
		await userEvent.type(
			await screen.findByLabelText("Team password"),
			"a-strong-team-password",
		);
		await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
		await waitFor(() => {
			expect(apiFetch).toHaveBeenCalledWith("/api/auth/login", {
				method: "POST",
				body: JSON.stringify({ password: "a-strong-team-password" }),
			});
		});
		await waitFor(() => {
			expect(assign).toHaveBeenCalledWith("/vod/jobs?status=RUNNING");
		});
	});

	const unsafeNext = [
		"//evil.example",
		"https://evil.example/vod",
		"/\\evil.example",
		"/login",
	];

	for (const next of unsafeNext) {
		it(`ignores an unsafe next= (${next}) and lands on /`, async () => {
			searchParams.set("next", next);
			configured();
			wrap(<LoginForm />);
			await userEvent.type(
				await screen.findByLabelText("Team password"),
				"a-strong-team-password",
			);
			await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
			await waitFor(() => {
				expect(assign).toHaveBeenCalledWith("/");
			});
		});
	}

	it("shows a localized coded rejection without navigating or exposing server prose", async () => {
		apiFetch.mockImplementation((input: string) =>
			input === "/api/auth/session"
				? Promise.resolve({
						mode: "password",
						configured: true,
						authenticated: false,
						loginKind: "password-form",
					})
				: Promise.reject(
						new ApiError(401, "Invalid password", {
							code: "AUTH_INVALID_CREDENTIALS",
						}),
					),
		);
		wrap(<LoginForm />, "ja");
		await userEvent.type(
			await screen.findByLabelText("チームパスワード"),
			"nope",
		);
		await userEvent.click(screen.getByRole("button", { name: "サインイン" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"メールアドレスまたはパスワードが正しくありません。",
		);
		expect(screen.getByRole("alert")).not.toHaveTextContent("Invalid password");
		expect(assign).not.toHaveBeenCalled();
	});

	it("shows locale-owned setup guidance instead of the raw auth reason", async () => {
		apiFetch.mockResolvedValue({
			mode: "password",
			configured: false,
			authenticated: false,
			loginKind: "password-form",
			reasonCode: "AUTH_NOT_CONFIGURED",
		});
		wrap(<LoginForm />, "ja");
		expect(
			await screen.findByText("認証が設定されていません"),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"認証の設定が完了していません。管理者にログイン方法と認証設定の確認を依頼してください。",
			),
		).toBeInTheDocument();
		expect(screen.queryByText(/AUTH_MODE|AUTH_PASSWORD_HASH/)).toBeNull();
		expect(screen.queryByLabelText("チームパスワード")).not.toBeInTheDocument();
	});

	it("says so when AUTH_MODE=none leaves the install open", async () => {
		apiFetch.mockResolvedValue({
			mode: "none",
			configured: true,
			authenticated: true,
			loginKind: "disabled",
		});
		wrap(<LoginForm />);
		expect(
			await screen.findByText(/Authentication is disabled/),
		).toBeInTheDocument();
		expect(screen.queryByText(/AUTH_MODE|\/api\/\*/)).toBeNull();
		expect(screen.queryByLabelText("Team password")).not.toBeInTheDocument();
	});
});
