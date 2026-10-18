import { GoogleCloudRegion } from "@bitmovin/api-sdk";
import type { CredentialSummaryWire } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { GCE_REGIONS } from "@/lib/infrastructure/schemas";
// `renderWithQuery`, not `renderLocalized`: the credential picker now
// carries an "add a credential" link that invalidates the shared
// `["credentials"]` query on the operator's return (owner request
// 2026-08-19), and the app always renders inside a QueryClientProvider.
import { renderWithQuery as render } from "@/test/render";
import { GcsRegionControl, StorageLocation } from "./storage-location";

const credentials = [
	{ id: "s3-1", label: "My S3", provider: "AWS_S3" },
	{ id: "az-1", label: "My Azure", provider: "AZURE_BLOB" },
] as unknown as CredentialSummaryWire[];

function props(overrides: Partial<Parameters<typeof StorageLocation>[0]> = {}) {
	return {
		idBase: "t",
		credentials,
		selectable: (p: string) => p === "AWS_S3",
		browsable: true,
		credentialId: "",
		bucket: "",
		bucketLabel: "Bucket",
		path: "",
		pathLabel: "Object path",
		onCredentialChange: vi.fn(),
		onChange: vi.fn(),
		onBrowse: vi.fn(),
		...overrides,
	};
}

// Controlled harness: mirrors how the wizard owns credential/bucket/path state,
// so edits re-render with the new value (needed to catch the "field vanishes
// mid-typing" regression, which only shows up after a controlled re-render).
function Harness(
	overrides: Partial<Parameters<typeof StorageLocation>[0]> = {},
) {
	const [credentialId, setCredentialId] = useState(
		(overrides.credentialId as string) ?? "",
	);
	const [bucket, setBucket] = useState((overrides.bucket as string) ?? "");
	const [path, setPath] = useState((overrides.path as string) ?? "");
	return (
		<StorageLocation
			{...props({
				...overrides,
				credentialId,
				bucket,
				path,
				onCredentialChange: setCredentialId,
				onChange: (p) => {
					if (p.bucket !== undefined) setBucket(p.bucket);
					if (p.path !== undefined) setPath(p.path);
				},
			})}
		/>
	);
}

describe("StorageLocation", () => {
	it("shows a browsed S3 location as a summary, with a manual toggle", () => {
		render(
			<StorageLocation
				{...props({
					credentialId: "s3-1",
					bucket: "my-bucket",
					path: "in/x.mp4",
				})}
			/>,
		);
		// Summary, not raw fields. The "Change" button is summary-only, so it
		// positively distinguishes the summary view from manual mode.
		expect(screen.getByText(/my-bucket/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Change" })).toBeInTheDocument();
		expect(screen.queryByLabelText("Bucket")).not.toBeInTheDocument();
		// "Enter manually" reveals the editable fields.
		fireEvent.click(screen.getByText("Enter manually"));
		expect(screen.getByLabelText("Bucket")).toBeInTheDocument();
	});

	it("shows manual fields + a Browse button for an empty browsable location", () => {
		const onBrowse = vi.fn();
		render(<StorageLocation {...props({ onBrowse })} />);
		expect(screen.getByLabelText("Bucket")).toBeInTheDocument();
		fireEvent.click(screen.getByText(/Browse storage/));
		expect(onBrowse).toHaveBeenCalledTimes(1);
	});

	it("is manual-only (no Browse) for non-browsable kinds", () => {
		render(
			<StorageLocation
				{...props({ browsable: false, bucket: "c", bucketLabel: "Container" })}
			/>,
		);
		expect(screen.getByLabelText("Container")).toBeInTheDocument();
		expect(screen.queryByText(/Browse storage/)).not.toBeInTheDocument();
	});

	it("reports credential selection to the parent (which opens the picker)", () => {
		const onCredentialChange = vi.fn();
		render(<StorageLocation {...props({ onCredentialChange })} />);
		fireEvent.change(screen.getByLabelText("Credential"), {
			target: { value: "s3-1" },
		});
		expect(onCredentialChange).toHaveBeenCalledWith("s3-1");
	});

	// --- Regression: a prefilled location with no credential is NOT a summary ---
	// A preset prefills bucket/path but clears the sample credential; the summary
	// must not assert a resolved location the user has no credential for.
	it("does not show a summary when a browsable location has no credential", () => {
		render(
			<StorageLocation
				{...props({
					credentialId: "",
					bucket: "sample-bucket",
					path: "in/x.mp4",
				})}
			/>,
		);
		expect(screen.getByLabelText("Bucket")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Change" }),
		).not.toBeInTheDocument();
	});

	// --- Regression: typing must not flip to the summary and hide the field ---
	it("keeps the fields open while typing into a credential-backed location", () => {
		render(<Harness credentialId="s3-1" />);
		const pathField = screen.getByLabelText("Object path");
		fireEvent.change(pathField, { target: { value: "videos/source.mp4" } });
		// Still editing — the field the user typed into is still on screen.
		const after = screen.getByLabelText("Object path") as HTMLInputElement;
		expect(after.value).toBe("videos/source.mp4");
		expect(
			screen.queryByRole("button", { name: "Change" }),
		).not.toBeInTheDocument();
	});

	it("emits { bucket } and { path } patches when editing manual fields", () => {
		const onChange = vi.fn();
		render(<StorageLocation {...props({ credentialId: "s3-1", onChange })} />);
		fireEvent.change(screen.getByLabelText("Bucket"), {
			target: { value: "b" },
		});
		fireEvent.change(screen.getByLabelText("Object path"), {
			target: { value: "p" },
		});
		expect(onChange).toHaveBeenNthCalledWith(1, { bucket: "b" });
		expect(onChange).toHaveBeenNthCalledWith(2, { path: "p" });
	});

	it("hides the credential select when showCredential is false (HTTPS)", () => {
		render(
			<StorageLocation
				{...props({ showCredential: false, browsable: false, bucket: "host" })}
			/>,
		);
		expect(screen.queryByLabelText("Credential")).not.toBeInTheDocument();
	});

	it("hides the bucket field when showBucket is false (SFTP)", () => {
		render(
			<StorageLocation
				{...props({
					browsable: false,
					showBucket: false,
					path: "out/",
					pathLabel: "Base output path",
				})}
			/>,
		);
		expect(screen.queryByLabelText("Bucket")).not.toBeInTheDocument();
		expect(screen.getByLabelText("Base output path")).toBeInTheDocument();
	});

	it("toggles back to the summary via 'Show summary'", () => {
		render(
			<StorageLocation
				{...props({ credentialId: "s3-1", bucket: "b", path: "p" })}
			/>,
		);
		fireEvent.click(screen.getByText("Enter manually"));
		expect(screen.getByLabelText("Bucket")).toBeInTheDocument();
		fireEvent.click(screen.getByText("Show summary"));
		expect(screen.getByRole("button", { name: "Change" })).toBeInTheDocument();
		expect(screen.queryByLabelText("Bucket")).not.toBeInTheDocument();
	});

	it("offers no 'Show summary' link when the location is empty", () => {
		render(<StorageLocation {...props({ credentialId: "s3-1" })} />);
		expect(screen.queryByText("Show summary")).not.toBeInTheDocument();
	});
});

describe("StorageLocation — browseOwnsCredential (Sources layout)", () => {
	it("shows only Browse (no upfront credential select) when empty", () => {
		const onBrowse = vi.fn();
		render(
			<StorageLocation {...props({ browseOwnsCredential: true, onBrowse })} />,
		);
		// The picker owns credential selection — it is not asked upfront.
		expect(screen.queryByLabelText("Credential")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Bucket")).not.toBeInTheDocument();
		fireEvent.click(screen.getByText(/Browse storage/));
		expect(onBrowse).toHaveBeenCalledTimes(1);
	});

	it("reveals an inline credential + fields via 'Enter manually'", () => {
		render(<StorageLocation {...props({ browseOwnsCredential: true })} />);
		fireEvent.click(screen.getByText("Enter manually"));
		expect(screen.getByLabelText("Credential")).toBeInTheDocument();
		expect(screen.getByLabelText("Bucket")).toBeInTheDocument();
	});

	it("shows the manual fields for a credential-less prefilled (placeholder) location", () => {
		// A preset prefills the path but clears the credential — the path must
		// stay visible (not collapse to a Browse-only button).
		render(
			<StorageLocation
				{...props({ browseOwnsCredential: true, path: "<INSERT PATH>" })}
			/>,
		);
		expect(screen.getByLabelText("Credential")).toBeInTheDocument();
		expect(
			(screen.getByLabelText("Object path") as HTMLInputElement).value,
		).toBe("<INSERT PATH>");
	});

	it("summarizes a browsed location with its credential label", () => {
		render(
			<StorageLocation
				{...props({
					browseOwnsCredential: true,
					credentialId: "s3-1",
					bucket: "my-bucket",
					path: "in/x.mp4",
				})}
			/>,
		);
		expect(screen.getByText(/My S3/)).toBeInTheDocument();
		expect(screen.getByText(/my-bucket/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Change" })).toBeInTheDocument();
	});

	it("Change in the browse-owns summary re-opens the picker", () => {
		const onBrowse = vi.fn();
		render(
			<StorageLocation
				{...props({
					browseOwnsCredential: true,
					credentialId: "s3-1",
					bucket: "my-bucket",
					path: "in/x.mp4",
					onBrowse,
				})}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Change" }));
		expect(onBrowse).toHaveBeenCalledTimes(1);
	});
});

// The credential select clears `manual` in the classic layout (so the location
// the picker then resolves shows as a summary) but keeps the fields open in the
// inline fallback. Mutation-tested: inverting setManual(inlineCredential) must
// fail one of these two.
describe("StorageLocation — layout-aware setManual on credential select", () => {
	it("classic: selecting a credential collapses a prefilled location to the summary", () => {
		render(<Harness credentialId="s3-1" bucket="b" path="p" />);
		fireEvent.click(screen.getByText("Enter manually"));
		expect(screen.getByLabelText("Bucket")).toBeInTheDocument();
		// Re-selecting the credential resets manual → summary.
		fireEvent.change(screen.getByLabelText("Credential"), {
			target: { value: "s3-1" },
		});
		expect(screen.getByRole("button", { name: "Change" })).toBeInTheDocument();
		expect(screen.queryByLabelText("Bucket")).not.toBeInTheDocument();
	});

	it("inline: selecting a credential keeps the fields open (no flip to summary)", () => {
		// path set, credential empty → manual fields shown (placeholder layout).
		render(<Harness browseOwnsCredential path="some/obj.mp4" />);
		fireEvent.change(screen.getByLabelText("Credential"), {
			target: { value: "s3-1" },
		});
		// Even though credential + location now resolve, manual stays set, so the
		// user keeps editing instead of the field vanishing into a summary.
		expect(screen.getByLabelText("Object path")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Change" }),
		).not.toBeInTheDocument();
	});
});

describe("GCS region enum control", () => {
	it("offers SDK regions, preserves imported values, and clears to undefined", () => {
		expect([...GCE_REGIONS]).toEqual(Object.keys(GoogleCloudRegion));
		const onChange = vi.fn();
		render(
			<GcsRegionControl
				idBase="gcs"
				kind="GCS"
				value="FUTURE_REGION"
				onChange={onChange}
			/>,
		);
		const select = screen.getByLabelText("GCS region") as HTMLSelectElement;
		expect(select.tagName).toBe("SELECT");
		expect(select.value).toBe("FUTURE_REGION");
		fireEvent.change(select, { target: { value: "ASIA_EAST_1" } });
		expect(onChange).toHaveBeenLastCalledWith("ASIA_EAST_1");
		fireEvent.change(select, { target: { value: "" } });
		expect(onChange).toHaveBeenLastCalledWith(undefined);
	});
});
