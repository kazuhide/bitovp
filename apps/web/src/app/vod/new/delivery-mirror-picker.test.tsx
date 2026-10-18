import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

/* Delivery mirrors support storage browsing and explicit destination selection like other output locations. */

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import { VodWizard } from "./wizard";

const CREDENTIALS = [
	{
		id: "cred-a",
		label: "verify-aws",
		provider: "AWS_S3",
		createdAt: "2026-08-01T00:00:00.000Z",
		updatedAt: "2026-08-01T00:00:00.000Z",
	},
	{
		id: "cred-b",
		label: "verify-akamai-output",
		provider: "AKAMAI_OBJECT_STORAGE",
		createdAt: "2026-08-01T00:00:00.000Z",
		updatedAt: "2026-08-01T00:00:00.000Z",
	},
];

beforeEach(() => {
	vi.clearAllMocks();
	apiFetch.mockImplementation(async (url: string) => {
		if (url === "/api/credentials") return CREDENTIALS;
		if (url.includes("/storage/buckets")) {
			return { buckets: ["mirror-bucket", "other-bucket"] };
		}
		if (url.includes("/storage/objects")) {
			return { objects: [], prefixes: [], nextCursor: undefined };
		}
		return [];
	});
});

/** Walk to step 4 (Output), where the mirrors live. */
async function openOutputStep(): Promise<void> {
	renderWithQuery(<VodWizard />);
	const step = (await screen.findAllByRole("button", { name: /output/i }))[0];
	if (!step) throw new Error("no Output step button");
	await userEvent.click(step);
	await screen.findByRole("button", { name: /add delivery mirror/i });
}

async function addMirrors(n: number): Promise<void> {
	for (let i = 0; i < n; i += 1) {
		await userEvent.click(
			screen.getByRole("button", { name: /add delivery mirror/i }),
		);
	}
}

describe("delivery mirror — bucket picker (owner, 2026-08-20)", () => {
	it("offers Browse on a mirror row, which it never used to", async () => {
		await openOutputStep();
		await addMirrors(1);
		// Pick a credential so the row is browsable at all — the same gate the
		// primary output uses (a non-S3 kind has no browse API).
		const provider = await screen.findByRole("combobox", {
			name: /delivery mirror 1 provider/i,
		});
		await userEvent.selectOptions(provider, "cred-a");
		// Selecting an S3 credential auto-opens the picker, exactly as the
		// primary output does; close it to assert the button independently.
		const dialog = await screen.findByRole("dialog");
		await userEvent.click(
			within(dialog).getByRole("button", { name: /close|cancel/i }),
		);
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		expect(
			screen.getAllByRole("button", { name: /browse storage/i }).length,
		).toBeGreaterThanOrEqual(2); // the primary output's, plus the mirror's
	});

	it("writes the picked bucket to the mirror the picker was opened FOR", async () => {
		/**
		 * The trap this exists for, and it caught me: an index captured once, or
		 * a hardcoded 0, sends every row's Browse to the FIRST mirror. It reads
		 * as working while there is one row.
		 *
		 * The first version of this test asserted only that mirror 1's provider
		 * stayed empty — which is a fact about `applyMirrorCredentialSelection`,
		 * not about the picker's target. Hardcoding `setPicker({ mirror: 0 })`
		 * left it GREEN, in a test whose own comment described the defect. So it
		 * now drives a real selection through the dialog and reads the bucket
		 * back off the row.
		 */
		await openOutputStep();
		await addMirrors(2);

		const second = await screen.findByRole("combobox", {
			name: /delivery mirror 2 provider/i,
		});
		await userEvent.selectOptions(second, "cred-a");

		// Selecting an S3 credential opens the picker on that row.
		const dialog = await screen.findByRole("dialog");
		await userEvent.selectOptions(
			within(dialog).getByRole("combobox", { name: /bucket/i }),
			"mirror-bucket",
		);
		// "Use current prefix" — NOT "…as output". Two catalogue entries spell
		// this key and the shorter one is what renders; asserting the sentence I
		// expected would have failed on a working dialog.
		await userEvent.click(
			await within(dialog).findByRole("button", {
				name: /^use current prefix$/i,
			}),
		);
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);

		// Mirror 2 got it...
		expect(
			(
				screen.getByRole("combobox", {
					name: /delivery mirror 2 provider/i,
				}) as HTMLSelectElement
			).value,
		).toBe("cred-a");
		expect(screen.getByText(/mirror-bucket/)).toBeInTheDocument();

		// ...and mirror 1 is untouched: still no credential, still no bucket.
		expect(
			(
				screen.getByRole("combobox", {
					name: /delivery mirror 1 provider/i,
				}) as HTMLSelectElement
			).value,
		).toBe("");
		expect(screen.getAllByText(/mirror-bucket/)).toHaveLength(1);
	});

	it("re-opens the picker from the row's own Change button", async () => {
		/**
		 * Kill-verified addition. Making `onBrowse` a no-op left the other tests
		 * GREEN, because every one of them reached the dialog through the
		 * credential select's auto-open — never by pressing a control. The
		 * owner's report was precisely that there was no control to press, so a
		 * suite that cannot tell the difference is not testing the fix.
		 */
		await openOutputStep();
		await addMirrors(1);
		await userEvent.selectOptions(
			await screen.findByRole("combobox", {
				name: /delivery mirror 1 provider/i,
			}),
			"cred-a",
		);
		const first = await screen.findByRole("dialog");
		await userEvent.selectOptions(
			within(first).getByRole("combobox", { name: /bucket/i }),
			"mirror-bucket",
		);
		await userEvent.click(
			await within(first).findByRole("button", {
				name: /^use current prefix$/i,
			}),
		);
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);

		// The row is now a summary with its own Change button — press it.
		const summary = screen.getByText(/mirror-bucket/).closest("div");
		expect(summary).toBeTruthy();
		if (!summary) return;
		await userEvent.click(
			within(summary as HTMLElement).getByRole("button", { name: /change/i }),
		);
		const reopened = await screen.findByRole("dialog");
		expect(reopened).toBeInTheDocument();
		// And it comes back seeded with the bucket this row already holds.
		expect(
			(
				within(reopened).getByRole("combobox", {
					name: /bucket/i,
				}) as HTMLSelectElement
			).value,
		).toBe("mirror-bucket");
	});

	it("explains that a mirror has no prefix of its own", async () => {
		/* A mirror is an output reference; compilation emits a separate EncodingOutput for each mirror. */
		await openOutputStep();
		await addMirrors(1);
		const provider = await screen.findByRole("combobox", {
			name: /delivery mirror 1 provider/i,
		});
		await userEvent.selectOptions(provider, "cred-a");
		const dialog = await screen.findByRole("dialog");
		await userEvent.click(
			within(dialog).getByRole("button", { name: /close|cancel/i }),
		);
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		// Enter manual mode so the bucket field (and its help mark) render.
		const manual = screen.queryAllByRole("button", { name: /enter manually/i });
		if (manual[0]) await userEvent.click(manual[0]);

		const help = screen
			.getAllByRole("button", { name: /more information/i })
			.find((b) => /bucket/i.test(b.getAttribute("aria-label") ?? ""));
		expect(help, "the bucket field has no help mark").toBeTruthy();
		if (!help) return;
		await userEvent.click(help);
		expect(await screen.findByRole("note")).toHaveTextContent(
			/same paths as the primary output/i,
		);
	});
});
