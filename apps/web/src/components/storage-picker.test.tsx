import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

/** Override the buckets rejection per test; null = the #112 capability refusal. */
const bucketsFailure = vi.hoisted(() => ({ value: null as Error | null }));
/** : make the buckets listing succeed with ZERO entries. */
const bucketsEmpty = vi.hoisted(() => ({ value: false }));

/**
 * The picker drives selects from live queries; stub the API so the seeded
 * credential/bucket have matching options to stick to.
 *
 * KEEP THE REAL `ApiError`. It used to be stubbed as
 * `class ApiError extends Error {}` — no `details` — so no test in this file
 * could exercise a CLASSIFIED failure at all, and the 403 paths were
 * untestable here by construction. review-282 found a wrong 403 sentence in
 * this very component while every test in this file passed.
 */
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: vi.fn((url: string) => {
		if (url === "/api/credentials") {
			return Promise.resolve([
				{ id: "s3-1", label: "My S3", provider: "AWS_S3" },
			]);
		}
		if (url.includes("/storage/buckets")) {
			return Promise.resolve({
				buckets: bucketsEmpty.value ? [] : ["my-bucket"],
			});
		}
		if (url.includes("/storage/objects")) {
			return Promise.resolve({
				prefixes: [],
				objects: [{ key: "masters/movie.mp4", size: 524288000 }],
			});
		}
		if (url.startsWith("/api/storage-inspections?")) {
			return Promise.resolve({ latest: null });
		}
		if (url === "/api/storage-inspections") {
			return Promise.resolve({
				id: "11111111-2222-4333-8444-555555555555",
				status: "PENDING",
				bucket: "my-bucket",
				objectKey: "masters/movie.mp4",
				probe: null,
				bytesRead: null,
				error: null,
				createdAt: "2026-08-12T00:00:00.000Z",
				updatedAt: "2026-08-12T00:00:00.000Z",
			});
		}
		if (url === "/api/storage-presets") {
			return Promise.resolve([]);
		}
		return Promise.resolve({});
	}),
}));

import { StoragePicker } from "./storage-picker";

function renderPicker(
	extra: Partial<Parameters<typeof StoragePicker>[0]> = {},
) {
	return renderWithQuery(
		<StoragePicker
			open
			mode="object"
			providers={["AWS_S3"]}
			onClose={vi.fn()}
			onSelect={vi.fn()}
			{...extra}
		/>,
	);
}

describe("StoragePicker — seed on open", () => {
	it("opens pre-scoped to the given credential and bucket (never re-asks)", async () => {
		renderPicker({ initialCredentialId: "s3-1", initialBucket: "my-bucket" });
		// Credentials load → the seeded credential option exists and is selected.
		await screen.findByRole("option", { name: /My S3/ });
		expect(
			(screen.getByLabelText("Credential") as HTMLSelectElement).value,
		).toBe("s3-1");
		// Buckets for that credential load → the seeded bucket is selected too.
		await screen.findByRole("option", { name: "my-bucket" });
		expect((screen.getByLabelText("Bucket") as HTMLSelectElement).value).toBe(
			"my-bucket",
		);
	});

	it("starts blank when no seed is given", async () => {
		renderPicker();
		await screen.findByRole("option", { name: /My S3/ });
		expect(
			(screen.getByLabelText("Credential") as HTMLSelectElement).value,
		).toBe("");
	});
});

describe("StoragePicker — Inspect (ledger #25, review of PR #175 I1/I2)", () => {
	it("POSTs the clicked object's identity + LISTING size through the dialog", async () => {
		const user = userEvent.setup();
		renderPicker({ initialCredentialId: "s3-1", initialBucket: "my-bucket" });
		await screen.findByText("movie.mp4");
		await user.click(screen.getByRole("button", { name: /inspect/i }));
		const { apiFetch } = await import("@/lib/api");
		const posts = () =>
			(apiFetch as ReturnType<typeof vi.fn>).mock.calls.filter(
				([url, init]) =>
					url === "/api/storage-inspections" &&
					(init as RequestInit | undefined)?.method === "POST",
			);
		await waitFor(() => expect(posts()).toHaveLength(1));
		// Kills review-175's M9 (prop deleted: no dialog, no POST) and M10
		// (stale bucket: the body would carry STALE-BUCKET).
		expect(JSON.parse((posts()[0]?.[1] as RequestInit).body as string)).toEqual(
			{
				credentialId: "s3-1",
				bucket: "my-bucket",
				objectKey: "masters/movie.mp4",
				objectSize: 524288000,
			},
		);
	});

	it("close/reopen does NOT resurrect the previous Inspect dialog (I1)", async () => {
		const user = userEvent.setup();
		const view = renderPicker({
			initialCredentialId: "s3-1",
			initialBucket: "my-bucket",
		});
		await screen.findByText("movie.mp4");
		await user.click(screen.getByRole("button", { name: /inspect/i }));
		// The Inspect dialog is open over the picker.
		await screen.findByText(/ffprobe over/);
		// Close the PICKER (open=false), then reopen it.
		view.rerender(
			<StoragePicker
				open={false}
				mode="object"
				providers={["AWS_S3"]}
				onClose={vi.fn()}
				onSelect={vi.fn()}
				initialCredentialId="s3-1"
				initialBucket="my-bucket"
			/>,
		);
		view.rerender(
			<StoragePicker
				open
				mode="object"
				providers={["AWS_S3"]}
				onClose={vi.fn()}
				onSelect={vi.fn()}
				initialCredentialId="s3-1"
				initialBucket="my-bucket"
			/>,
		);
		await screen.findByText("movie.mp4");
		// The stale modal must NOT be back.
		expect(screen.queryByText(/ffprobe over/)).toBeNull();
	});
});

/**
 * : a bucket-enumeration capability refusal (400 + reason from the
 * factory's UnsupportedBrowseError) must PROMOTE the manual bucket field —
 * the labeled Bucket control becomes the text input (the dead select
 * unmounts), and the refusal reason renders as the field hint so the operator
 * reads what to do instead of a greyed dropdown.
 */
describe("StoragePicker — an EMPTY bucket listing is not a dead end (ledger #143)", () => {
	/**
	 * `{buckets: []}` is a success, and it used to render an enabled select
	 * whose only entry was "Select bucket…" — no hint, no promoted manual
	 * input. A dead end that LOOKS healthy, which review-277 confirmed and
	 * rated worse than the error branch beside it: the error at least says
	 * something. The hole predates #112 for AWS/OCI/GenericS3; #112 widened
	 * the population by making Akamai and GCS-HMAC reach this point at all.
	 */
	it("promotes the manual input and says the listing was empty", async () => {
		bucketsEmpty.value = true;
		try {
			renderWithQuery(
				<StoragePicker
					open
					mode="object"
					providers={["AWS_S3"]}
					onClose={() => {}}
					onSelect={() => {}}
				/>,
			);
			// The empty state only exists once a credential makes the listing
			// run — the first version of this test skipped the select and
			// asserted against a picker that had never fetched anything.
			await screen.findByRole("option", { name: /My S3/ });
			await userEvent.selectOptions(
				screen.getByLabelText(/credential/i),
				"s3-1",
			);
			// The labelled bucket control is the INPUT now — the select would be
			// a combobox; an input is a textbox. Same promotion the error branch
			// performs, because "nothing to pick" has the same remedy.
			const control = await screen.findByLabelText(/bucket/i, {
				selector: "input",
			});
			expect(control).toBeInTheDocument();
			expect(
				screen.queryByRole("combobox", { name: /bucket/i }),
			).not.toBeInTheDocument();
			// And the hint says EMPTY, not failed — different fact, different
			// sentence (only one of them is about permissions).
			expect(screen.getByText(/returned no buckets/i)).toBeInTheDocument();
		} finally {
			bucketsEmpty.value = false;
		}
	});
});

describe("StoragePicker — capability refusal promotes manual entry (ledger #112)", () => {
	/**
	 * The fixture was Akamai's refusal until 2026-08-19, when that refusal was
	 * withdrawn: it had been the `x-id` defect misread as a vendor limit, and
	 * Akamai enumerates buckets fine. The BEHAVIOUR under test is unchanged and
	 * still needed — a store can genuinely be unable to list (a service-account
	 * key with no project_id, which is the fixture now) and the operator must
	 * get a typeable field with the reason beside it, not a dead dropdown.
	 */
	it("renders the reason and makes the input the labeled bucket control", async () => {
		const { ApiError, apiFetch } = await import("@/lib/api");
		(apiFetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
			if (url === "/api/credentials") {
				return Promise.resolve([
					{
						id: "gcs-1",
						label: "GCS (service account)",
						provider: "GCS_SERVICE_ACCOUNT",
					},
				]);
			}
			if (url.includes("/storage/buckets")) {
				// Built the way the API actually answers: `(status, message,
				// details)`. The old cast to `new (m: string) => Error` was only
				// possible because `ApiError` was stubbed as a bare Error — and
				// it put the message in the STATUS slot, which is why no 403
				// path was reachable from this file.
				return Promise.reject(
					bucketsFailure.value ??
						new ApiError(
							400,
							"Service-account key has no project_id — enter the bucket name manually",
						),
				);
			}
			if (url.includes("/storage/objects")) {
				return Promise.resolve({ prefixes: [], objects: [] });
			}
			if (url.startsWith("/api/storage-inspections?")) {
				return Promise.resolve({ latest: null });
			}
			if (url === "/api/storage-presets") {
				return Promise.resolve([]);
			}
			return Promise.resolve({});
		});
		renderWithQuery(
			<StoragePicker
				open
				mode="object"
				providers={["GCS_SERVICE_ACCOUNT"]}
				initialCredentialId="gcs-1"
				onClose={vi.fn()}
				onSelect={vi.fn()}
			/>,
		);
		// The refusal reason is on screen (field hint), verbatim from the error.
		await screen.findByText(/enter the bucket name manually/);
		// 's title: the REASON alone left the operator with a code
		// and a text field they had no reason to connect. `/storage` has always
		// appended this; the picker did not until 2026-08-20.
		await screen.findByText(/enter the bucket name:/i);
		// The labeled Bucket control is now the TEXT INPUT, not a select.
		const control = screen.getByLabelText("Bucket");
		expect(control.tagName).toBe("INPUT");
		// Typing a bucket and opening it still works — the refusal never
		// blocks bucket-scoped browsing.
		await userEvent.type(control, "some-bucket");
		await userEvent.click(screen.getByRole("button", { name: "Open" }));
		await waitFor(() => {
			const calls = (apiFetch as ReturnType<typeof vi.fn>).mock.calls.filter(
				([u]) =>
					typeof u === "string" &&
					u.includes("/storage/objects") &&
					u.includes("bucket=some-bucket"),
			);
			expect(calls.length).toBeGreaterThan(0);
		});
	});

	it("says the LIST was refused on a 403, not 'pick another bucket'", async () => {
		/**
		 * review-282, rendered: the hint read "Pick another, or use a credential
		 * with access to this one" over a refused LIST — the object-level
		 * sentence, reused on the one path a comment nine lines above the call
		 * site said it could not be. `bucketListDenied` held the true sentence
		 * and nothing rendered it.
		 *
		 * Untestable from this file until the `ApiError` stub was replaced with
		 * the real class: without `details` there was no such thing as a
		 * classified 403 here.
		 */
		const { ApiError } = await import("@/lib/api");
		bucketsFailure.value = new ApiError(502, "x (upstream 403)", {
			code: "AccessDenied",
			status: 403,
		});
		try {
			renderWithQuery(
				<StoragePicker
					open
					mode="object"
					providers={["AWS_S3"]}
					initialCredentialId="s3-1"
					onClose={vi.fn()}
					onSelect={vi.fn()}
				/>,
			);
			await screen.findByText(/cannot list buckets/i);
			// The object-level clauses must be absent — they are what shipped.
			expect(screen.queryByText(/pick another/i)).toBeNull();
			expect(screen.queryByText(/appear here/i)).toBeNull();
			// And the instruction that makes the text field the answer stays.
			await screen.findByText(/enter the bucket name:/i);
		} finally {
			bucketsFailure.value = null;
		}
	});
});
