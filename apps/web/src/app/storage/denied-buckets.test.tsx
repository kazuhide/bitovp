import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized as renderL } from "@/test/render";
import { StorageClient } from "./storage-client";

/**
 * A bucket the credential cannot open is marked — and the mark belongs to the
 * CREDENTIAL, so switching credentials forgets it.
 *
 * . `ListBuckets` is account-level on Akamai/Linode and AWS while an
 * access key can be scoped to particular buckets, so the list shows buckets
 * this key cannot open. Marking them saves the operator from re-clicking; the
 * second test is here because the FIRST version of this feature never cleared
 * the Set, and the label — which says "with this credential" — went on claiming
 * it about a credential that could read the bucket fine.
 */
const state = vi.hoisted(() => ({
	/** bucket → does the CURRENT credential get objects, or a 403? */
	readable: new Set<string>(),
	/** Page 1 lists, page 2 is refused — the load-more case. */
	loadMoreDenied: false,
	/** The 403's code — `SignatureDoesNotMatch` means the KEY, not the bucket. */
	code: "AccessDenied",
	/** Set to fail the BUCKET LIST itself rather than one bucket's objects. */
	listFails: false,
	/** credentialId -> buckets it may read. Overrides `readable` when set. */
	scoped: null as Record<string, Set<string>> | null,
}));

vi.mock("@/lib/api", async (orig) => {
	const actual = await orig<Record<string, unknown>>();
	const ApiError = actual.ApiError as new (
		s: number,
		m: string,
		d?: unknown,
	) => Error;
	return {
		...actual,
		apiFetch: vi.fn(async (url: string) => {
			if (url === "/api/credentials") {
				return [
					{ id: "in", label: "input key", provider: "AKAMAI_OBJECT_STORAGE" },
					{ id: "out", label: "output key", provider: "AKAMAI_OBJECT_STORAGE" },
				];
			}
			if (url.includes("/storage/buckets")) {
				if (state.listFails) {
					throw new ApiError(
						502,
						`Storage request failed: ${state.code} (upstream 403)`,
						{ code: state.code, status: 403 },
					);
				}
				return { buckets: ["alpha", "beta"] };
			}
			if (url.includes("/storage/objects")) {
				const bucket =
					new URL(url, "http://x").searchParams.get("bucket") ?? "";
				// Per-CREDENTIAL when `scoped` is set. Without it the offer test
				// could not prove it picks the RIGHT credential — any credential
				// would have opened the bucket and the assertion would pass on a
				// coincidence.
				const cid = /credentials\/([^/]+)\//.exec(url)?.[1] ?? "";
				const readable = state.scoped
					? (state.scoped[cid] ?? new Set<string>())
					: state.readable;
				if (!readable.has(bucket)) {
					throw new ApiError(
						502,
						`Storage request failed: ${state.code} (upstream 403)`,
						{ code: state.code, status: 403 },
					);
				}
				const cursor =
					new URL(url, "http://x").searchParams.get("cursor") ?? "";
				if (cursor && state.loadMoreDenied) {
					throw new ApiError(
						502,
						"Storage request failed: AccessDenied (upstream 403)",
						{ code: "AccessDenied", status: 403 },
					);
				}
				return {
					objects: [{ key: `${bucket}/a.mp4`, size: 1, lastModified: null }],
					prefixes: [],
					nextCursor: state.loadMoreDenied ? "page2" : undefined,
				};
			}
			if (url.includes("/storage/presets")) return [];
			return [];
		}),
	};
});

vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(),
}));

function render() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	renderL(
		<QueryClientProvider client={client}>
			<StorageClient />
		</QueryClientProvider>,
	);
}

/**
 * The BUCKET list specifically. `getByRole("button", {name: /^beta/})` matched
 * more than one element — a saved preset carries the bucket name too — so a
 * bare role query was asserting about whichever node came first.
 */
function bucketRow(name: string): HTMLElement {
	const list = screen.getByRole("list", { name: /bucket/i });
	return within(list).getByRole("button", { name: new RegExp(`^${name}`) });
}

async function pickCredential(label: string) {
	const select = (await screen.findByLabelText(
		/credential/i,
	)) as HTMLSelectElement;
	// The select renders BEFORE its options — `findByLabelText` resolves on the
	// element existing, so the first version of this helper looked for an
	// option in an empty list and reported "value not found" as though the
	// component were broken.
	await waitFor(() => {
		expect(
			[...select.options].some((o) => o.text.includes(label)),
			`no option for ${label}; have: ${[...select.options].map((o) => o.text).join(" | ")}`,
		).toBe(true);
	});
	// Match on the VISIBLE label: the value is an opaque id, and a test that
	// hard-codes it stops describing what an operator does.
	const option = [...select.options].find((o) => o.text.includes(label));
	await userEvent.selectOptions(select, (option as HTMLOptionElement).value);
}

describe("buckets this credential cannot open (ledger #144)", () => {
	it("marks a bucket after its 403, and only that bucket", async () => {
		state.loadMoreDenied = false;
		state.code = "AccessDenied";
		state.readable = new Set(["alpha"]);
		render();
		await pickCredential("in");
		await waitFor(() => bucketRow("beta"));
		await userEvent.click(bucketRow("beta"));
		await waitFor(() => {
			expect(bucketRow("beta").textContent).toMatch(/no access/i);
		});
		// The one that worked must stay unmarked — a blanket marker would be
		// worse than none, since the operator could no longer tell them apart.
		expect(bucketRow("alpha").textContent).not.toMatch(/no access/i);
	});

	it("forgets the mark when the credential changes", async () => {
		state.loadMoreDenied = false;
		state.code = "AccessDenied";
		state.readable = new Set(["alpha"]);
		render();
		await pickCredential("in");
		await waitFor(() => bucketRow("beta"));
		await userEvent.click(bucketRow("beta"));
		await waitFor(() => {
			expect(bucketRow("beta").textContent).toMatch(/no access/i);
		});

		// The other key CAN read beta. The mark says "no access with this
		// credential", so leaving it up is a false statement about the new one.
		state.readable = new Set(["alpha", "beta"]);
		await pickCredential("out");
		await waitFor(() => {
			expect(bucketRow("beta").textContent).not.toMatch(/no access/i);
		});
	});

	it("un-marks a bucket once it lists — the mark is not permanent", async () => {
		// review-282 finding 3: nothing removed a mark. Grant the missing
		// permission at the provider, re-open the bucket, and the objects render
		// while the row still says "no access" until a reload.
		state.loadMoreDenied = false;
		state.code = "AccessDenied";
		state.readable = new Set(["alpha"]);
		render();
		await pickCredential("in");
		await waitFor(() => bucketRow("beta"));
		await userEvent.click(bucketRow("beta"));
		await waitFor(() => {
			expect(bucketRow("beta").textContent).toMatch(/no access/i);
		});

		state.readable = new Set(["alpha", "beta"]);
		await userEvent.click(bucketRow("alpha"));
		await userEvent.click(bucketRow("beta"));
		await waitFor(() => {
			expect(bucketRow("beta").textContent).not.toMatch(/no access/i);
		});
	});

	it("does NOT mark a bucket whose objects are on screen when LOAD MORE is refused", async () => {
		// review-282 finding 4: `objects.error` on an infinite query is also set
		// when `fetchNextPage` fails, so a refused second page marked a bucket
		// "no access" with its contents listed two panes away.
		state.loadMoreDenied = true;
		state.readable = new Set(["alpha", "beta"]);
		render();
		await pickCredential("in");
		await waitFor(() => bucketRow("beta"));
		await userEvent.click(bucketRow("beta"));
		await screen.findByText(/beta\/a\.mp4/);
		const more = await screen.findByRole("button", { name: /load more/i });
		await userEvent.click(more);
		// Assert the page-2 failure SURFACED, not merely that the button still
		// exists — the button is there before the click too, so the old
		// precondition could go vacuous on a timing change and the negative
		// assertion below would pass over nothing (review-282's suggestion).
		await waitFor(() => {
			// Narrowed to the OBJECT sentence. The alternation used to include
			// "cannot list buckets", which cannot occur on this path (load-more
			// is object scope) — and that stray branch was the only occurrence
			// of the string anywhere under app/storage, so grepping for it
			// answered "yes, the list-level case is tested" when it was not
			// (review-282, round 3). A matcher broader than the fact it proves
			// is not merely loose; here it hid a gap.
			expect(screen.getByRole("alert").textContent).toMatch(
				/refused for this bucket/i,
			);
		});
		// …and the row must still not claim the bucket is closed.
		expect(bucketRow("beta").textContent).not.toMatch(/no access/i);
	});

	it("does NOT mark a bucket when the 403 is about the CREDENTIAL", async () => {
		/**
		 * review-282 finding 2, and the mutation that survived its first fix:
		 * splitting `isAccessDenied` from `isBucketDenied` is pointless if the
		 * MARKER still uses the coarse one.
		 *
		 * The scenario is the likeliest 403 an operator will actually meet. The
		 * credential form is write-only, so a mistyped secret cannot be read
		 * back; S3 answers SignatureDoesNotMatch on EVERY bucket. Marking them
		 * all teaches exactly the wrong conclusion — that the key is scoped to
		 * nothing — while the truth is one typo.
		 */
		state.loadMoreDenied = false;
		state.code = "SignatureDoesNotMatch";
		state.readable = new Set<string>();
		render();
		await pickCredential("in");
		await waitFor(() => bucketRow("beta"));
		await userEvent.click(bucketRow("beta"));
		// The failure has surfaced…
		await waitFor(() => {
			expect(screen.getByRole("alert").textContent).toMatch(
				/credential itself was rejected/i,
			);
		});
		// …and NEITHER bucket is blamed.
		expect(bucketRow("beta").textContent).not.toMatch(/no access/i);
		expect(bucketRow("alpha").textContent).not.toMatch(/no access/i);
	});

	it("tells /storage the LIST was refused, mirroring the picker", async () => {
		/**
		 * review-282's n5: reverting ONLY this branch left the suite green, so
		 * the half of #144's fix that unifies the two screens was unpinned —
		 * and #144 is precisely about these two screens saying different things.
		 *
		 * The reviewer flagged three things as "correct but unpinned" in this
		 * change and all three turned out to have already regressed or to be
		 * wrong in the shipped tree. Three for three is the argument for
		 * writing this now rather than trusting the code.
		 */
		state.loadMoreDenied = false;
		state.code = "AccessDenied";
		state.listFails = true;
		state.readable = new Set<string>();
		try {
			render();
			await pickCredential("in");
			await screen.findByText(/cannot list buckets/i);
			// The object-level sentence must NOT appear: "pick another bucket"
			// is nonsense when the list is what was refused.
			expect(screen.queryByText(/pick another/i)).toBeNull();
			// And the instruction that makes the text field the answer stays —
			// /storage has always appended it.
			await screen.findByText(/enter the bucket name:/i);
		} finally {
			state.listFails = false;
		}
	});

	it("offers a credential that CAN open the bucket, and switches to it", async () => {
		/**
		 * The owner's third report of the same symptom . The app
		 * was correct each time — it explained the refusal — and they still
		 * could not browse, because the explanation left them guessing which of
		 * their keys is scoped to which bucket. Measured on the real account:
		 * each Akamai key opens exactly one of the three buckets shown.
		 *
		 * Operator-initiated: the offer does nothing until clicked, because
		 * finding the answer costs a request per credential.
		 */
		state.loadMoreDenied = false;
		state.code = "AccessDenied";
		state.listFails = false;
		// Real scoping: `out` opens nothing, `in` opens alpha — the shape of the
		// live Akamai account, where each key opens exactly one bucket.
		state.scoped = { out: new Set(), in: new Set(["alpha"]) };
		render();
		await pickCredential("out");
		await waitFor(() => bucketRow("alpha"));
		await userEvent.click(bucketRow("alpha"));
		await screen.findByRole("alert");

		// Nothing probed until asked.
		const search = await screen.findByRole("button", {
			name: /find a credential/i,
		});
		state.readable = new Set(["alpha"]);
		await userEvent.click(search);

		// It names the credential rather than telling the operator to go hunt.
		const offer = await screen.findByRole("button", { name: /input key/ });
		await userEvent.click(offer);
		// And switching actually opens the bucket.
		await waitFor(() => {
			expect(screen.queryByRole("alert")).toBeNull();
		});
		state.scoped = null;
	});
});
