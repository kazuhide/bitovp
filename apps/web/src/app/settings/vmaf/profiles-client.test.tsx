import { vmafCloudProfileSchema } from "@bitovp/core";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { cloudProfile } from "@/test/vmaf-cloud-profile";

const apiFetch = vi.fn();
let admin = true;
vi.mock("@/lib/api", () => ({
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("@/lib/auth/use-role-access", () => ({ useRoleAccess: () => admin }));

import { ProfileForm } from "./profile-form";
import { VmafProfilesClient } from "./profiles-client";

beforeEach(() => {
	admin = true;
	apiFetch.mockReset();
	apiFetch.mockImplementation(
		async (url: string, options?: { method?: string }) =>
			options?.method
				? {}
				: {
						items: url.endsWith("vmaf-profiles")
							? [
									{
										id: cloudProfile.id,
										label: cloudProfile.label,
										config: cloudProfile,
										version: 3,
										enabled: true,
									},
								]
							: [
									{
										id: "00000000-0000-4000-8000-0000000000a1",
										label: "AWS vault",
										provider: "AWS",
										disabledAt: null,
									},
								],
					},
	);
});

it("edits a saved profile with its version and separate credential references without starting a job", async () => {
	renderWithQuery(<VmafProfilesClient />);
	const user = userEvent.setup();
	await user.click(await screen.findByRole("button", { name: "Edit" }));
	expect(screen.getByLabelText("Profile ID")).toBeDisabled();
	await user.selectOptions(
		screen.getByLabelText("Compute management credential"),
		"00000000-0000-4000-8000-0000000000a1",
	);
	await user.click(screen.getByRole("button", { name: "Next" }));
	await user.click(screen.getByRole("button", { name: "Save" }));
	await waitFor(() =>
		expect(apiFetch).toHaveBeenCalledWith(
			"/api/settings/vmaf-profiles",
			expect.objectContaining({ method: "POST" }),
		),
	);
	const body = JSON.parse(
		apiFetch.mock.calls.find(
			([url, options]) =>
				url.endsWith("vmaf-profiles") && options?.method === "POST",
		)?.[1].body,
	);
	expect(body).toMatchObject({
		expectedVersion: 3,
		enabled: true,
		profile: {
			id: cloudProfile.id,
			cpu: 8,
			memoryMiB: 32768,
			diskGiB: 500,
			maxParallel: 100,
			computeCredentialId: "00000000-0000-4000-8000-0000000000a1",
		},
	});
	expect(body.profile).not.toHaveProperty("stagingCredentialId");
	expect(apiFetch.mock.calls.some(([url]) => url === "/api/vmaf-jobs")).toBe(
		false,
	);
});
it("does not expose stored keys and clears unsaved secrets when switching cloud", async () => {
	renderWithQuery(<VmafProfilesClient />);
	const user = userEvent.setup();
	await user.click(
		await screen.findByRole("button", { name: "Add cloud credential" }),
	);
	const input = screen.getByLabelText("Secret access key");
	expect(input).toHaveAttribute("type", "password");
	await user.type(input, "do-not-retain");
	await user.selectOptions(screen.getByLabelText("Cloud"), "GCP");
	await user.selectOptions(screen.getByLabelText("Cloud"), "AWS");
	expect(screen.getByLabelText("Secret access key")).toHaveValue("");
	expect(screen.queryByDisplayValue("do-not-retain")).not.toBeInTheDocument();
});
it("does not grant settings to an operator", () => {
	admin = false;
	renderWithQuery(<VmafProfilesClient />);
	expect(apiFetch).not.toHaveBeenCalled();
	expect(screen.queryByRole("heading")).not.toBeInTheDocument();
});
it("shows the same compact settings in Japanese", async () => {
	renderWithQuery(<VmafProfilesClient />, "ja");
	expect(
		await screen.findByRole("heading", { name: "VMAF 実行プロファイル" }),
	).toBeInTheDocument();
	expect(await screen.findByText("AWS vault")).toBeInTheDocument();
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: "編集" }));
	await user.click(
		screen.getByRole("button", { name: "「VMAF 実行プロファイル」の説明" }),
	);
	expect(screen.getByText(/計算リソースは自動選択します/)).toBeInTheDocument();
	await user.keyboard("{Escape}");
	await user.click(screen.getByRole("button", { name: "次へ" }));
	expect(screen.queryByLabelText("最大並列タスク数")).not.toBeInTheDocument();
	expect(screen.getByLabelText("試行ごとの実行期限（秒）")).toBeInTheDocument();
});
it("starts with cloud preparation and has no SVAT importer", async () => {
	renderWithQuery(<VmafProfilesClient />);
	const user = userEvent.setup();
	await user.click(await screen.findByRole("button", { name: "Add profile" }));
	expect(screen.getByLabelText("Cloud")).toHaveValue("AWS_BATCH");
	expect(screen.queryByText(/svat/i)).not.toBeInTheDocument();
	expect(document.querySelector('input[type="file"]')).toBeNull();
	expect(
		screen.queryByRole("button", { name: "Save" }),
	).not.toBeInTheDocument();
	expect(screen.queryByLabelText("Profile ID")).not.toBeInTheDocument();
	await user.selectOptions(screen.getByLabelText("Cloud"), "GCP_BATCH");
	await user.click(screen.getByRole("button", { name: "Next" }));
	expect(screen.getByText("Connect prepared resources")).toHaveFocus();
	expect(screen.getByLabelText("Storage service")).toHaveValue("GCS");
	expect(screen.getByLabelText("GCP project")).toBeInTheDocument();
	expect(screen.queryByLabelText("AWS Batch queue")).not.toBeInTheDocument();
});
it("keeps a draft when navigating and cannot skip required settings", async () => {
	renderWithQuery(<VmafProfilesClient />);
	const user = userEvent.setup();
	await user.click(await screen.findByRole("button", { name: "Add profile" }));
	const next = screen.getByRole("button", { name: "Next" });
	const form = next.closest("form");
	if (!form) throw new Error("Form missing");
	fireEvent.submit(form);
	expect(screen.getByLabelText("Profile ID")).toBeInTheDocument();
	await user.type(screen.getByLabelText("Name"), "Keep my draft");
	fireEvent.submit(form);
	expect(
		screen.queryByRole("button", { name: "Save" }),
	).not.toBeInTheDocument();
	await user.click(screen.getByRole("button", { name: "Back" }));
	await user.click(screen.getByRole("button", { name: "Next" }));
	expect(screen.getByLabelText("Name")).toHaveValue("Keep my draft");
	expect(apiFetch.mock.calls.some(([, o]) => o?.method === "POST")).toBe(false);
});
it("clears old provider values and credential references on cloud changes", async () => {
	renderWithQuery(<VmafProfilesClient />);
	const user = userEvent.setup();
	await user.click(await screen.findByRole("button", { name: "Edit" }));
	await user.selectOptions(
		screen.getByLabelText("Compute management credential"),
		"00000000-0000-4000-8000-0000000000a1",
	);
	await user.selectOptions(
		screen.getByLabelText("Working storage credential"),
		"00000000-0000-4000-8000-0000000000a1",
	);
	await user.click(screen.getByRole("button", { name: "Back" }));
	await user.selectOptions(screen.getByLabelText("Cloud"), "GCP_BATCH");
	await user.click(screen.getByRole("button", { name: "Next" }));
	expect(screen.getByLabelText("Storage service")).toHaveValue("GCS");
	expect(screen.getByLabelText("Compute management credential")).toHaveValue(
		"",
	);
	expect(screen.getByLabelText("Working storage credential")).toHaveValue("");
	expect(screen.getByLabelText("Compute region")).toHaveValue("");
	expect(screen.getByLabelText("Name")).toHaveValue(cloudProfile.label);
	await user.click(screen.getByRole("button", { name: "Back" }));
	await user.selectOptions(screen.getByLabelText("Cloud"), "AWS_BATCH");
	await user.click(screen.getByRole("button", { name: "Next" }));
	expect(screen.getByLabelText("AWS Batch queue")).toHaveValue("");
});
it("returns to settings for a schema error without losing the limits draft", async () => {
	renderWithQuery(<VmafProfilesClient />);
	const user = userEvent.setup();
	await user.click(await screen.findByRole("button", { name: "Edit" }));
	await user.clear(screen.getByLabelText("Container image (immutable digest)"));
	await user.type(
		screen.getByLabelText("Container image (immutable digest)"),
		"image:latest",
	);
	await user.click(screen.getByRole("button", { name: "Next" }));
	await user.click(screen.getByRole("button", { name: "Save" }));
	expect(screen.getByRole("alert")).toHaveTextContent(
		"Complete the required fields",
	);
	expect(screen.getByRole("alert")).toHaveFocus();
	expect(
		screen.getByLabelText("Container image (immutable digest)"),
	).toHaveValue("image:latest");
	expect(
		screen.queryByRole("button", { name: "Save" }),
	).not.toBeInTheDocument();
	expect(apiFetch.mock.calls.some(([, o]) => o?.method === "POST")).toBe(false);
});
it("keeps numeric validation errors on the budget step", async () => {
	renderWithQuery(<VmafProfilesClient />);
	const user = userEvent.setup();
	await user.click(await screen.findByRole("button", { name: "Edit" }));
	await user.click(screen.getByRole("button", { name: "Next" }));
	const timeout = screen.getByLabelText("Run timeout per attempt (seconds)");
	await user.clear(timeout);
	await user.type(timeout, "0");
	await user.click(screen.getByRole("button", { name: "Save" }));
	expect(screen.getByRole("alert")).toHaveTextContent(
		"Complete the required fields",
	);
	expect(screen.getByRole("alert")).toHaveFocus();
	expect(
		screen.getByLabelText("Run timeout per attempt (seconds)"),
	).toHaveValue(0);
	expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
	expect(apiFetch.mock.calls.some(([, o]) => o?.method === "POST")).toBe(false);
});

it("shows automatic compute without manual hardware or concurrency controls", async () => {
	renderWithQuery(<VmafProfilesClient />);
	const user = userEvent.setup();
	await user.click(await screen.findByRole("button", { name: "Edit" }));
	await user.click(screen.getByRole("button", { name: "Next" }));
	await user.click(
		screen.getByRole("button", {
			name: "VMAF compute profiles — more information",
		}),
	);
	expect(
		screen.getByText(/Compute resources are selected automatically/),
	).toBeInTheDocument();
	for (const name of [
		"vCPUs per task",
		"Memory (MiB)",
		"Disk (GiB)",
		"Maximum parallel tasks",
	]) {
		expect(screen.queryByLabelText(name)).not.toBeInTheDocument();
	}
	expect(
		screen.getByLabelText("Hourly cost ceiling (USD)"),
	).toBeInTheDocument();
	expect(
		screen.getByLabelText("Maximum staged input (GiB)"),
	).toBeInTheDocument();
});

it.each([
	"GCP_BATCH",
	"AKAMAI_VM",
] as const)("creates a %s profile without asking for hardware", async (provider) => {
	const save = vi.fn();
	renderWithQuery(
		<ProfileForm credentials={[]} pending={false} onSave={save} />,
	);
	const user = userEvent.setup();
	await user.selectOptions(screen.getByLabelText("Cloud"), provider);
	await user.click(screen.getByRole("button", { name: "Next" }));
	const fields: Record<string, string> = {
		Name: "Auto test",
		"Profile ID": "auto-test",
		"Compute region": "us-east1",
		"Container image (immutable digest)": cloudProfile.image,
		Bucket: "auto-work",
		...(provider === "GCP_BATCH"
			? {
					"GCP project": "my-project",
					"Task service account": "vmaf@example.com",
				}
			: {
					"Akamai boot image": "linode/ubuntu24.04",
					"Storage region": "us-east-1",
				}),
	};
	for (const [label, value] of Object.entries(fields))
		fireEvent.change(screen.getByLabelText(label), { target: { value } });
	expect(screen.queryByLabelText("Machine type")).not.toBeInTheDocument();
	expect(
		screen.queryByLabelText("Akamai instance type"),
	).not.toBeInTheDocument();
	if (provider === "AKAMAI_VM")
		await user.click(
			screen.getByLabelText("An independent cleanup controller is running"),
		);
	await user.click(screen.getByRole("button", { name: "Next" }));
	for (const [label, value] of Object.entries({
		"Hourly cost ceiling (USD)": "5",
		"Transfer ceiling (USD/GiB)": "0.1",
		"Other cost allowance per task (USD)": "1",
	}))
		fireEvent.change(screen.getByLabelText(label), { target: { value } });
	await user.click(screen.getByRole("button", { name: "Save" }));
	expect(save).toHaveBeenCalledWith(
		expect.objectContaining({
			enabled: true,
			profile: expect.objectContaining({
				provider,
				cpu: 8,
				memoryMiB: 32768,
				diskGiB: 500,
				maxParallel: 100,
				...(provider === "GCP_BATCH"
					? {
							machineType: "n2-standard-8",
							spotPolicy: { maxRetries: 2, deadlineSeconds: 21600 },
						}
					: { instanceType: "auto" }),
			}),
		}),
	);
	const call = save.mock.calls[0];
	if (!call) throw new Error("Missing save payload");
	const payload = call[0];
	expect(payload).not.toHaveProperty("expectedVersion");
	expect(vmafCloudProfileSchema.safeParse(payload.profile).success).toBe(true);
});

it("preserves legacy GCP profiles unless Spot fallback is explicitly enabled", async () => {
	const {
		jobQueue: _queue,
		jobDefinition: _definition,
		...base
	} = cloudProfile;
	const profile = vmafCloudProfileSchema.parse({
		...base,
		provider: "GCP_BATCH",
		project: "my-project",
		serviceAccount: "vmaf@example.com",
		machineType: "n2-standard-8",
		spot: true,
		staging: { provider: "GCS", bucket: "work" },
	});
	const save = vi.fn();
	renderWithQuery(
		<ProfileForm
			row={{
				id: profile.id,
				label: profile.label,
				config: profile,
				version: 2,
				enabled: true,
			}}
			credentials={[]}
			pending={false}
			onSave={save}
		/>,
	);
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: "Next" }));
	expect(
		screen.getByLabelText("Keep Spot, then allow Standard fallback"),
	).not.toBeChecked();
	await user.click(screen.getByRole("button", { name: "Save" }));
	expect(save.mock.calls[0]?.[0].profile).not.toHaveProperty("spotPolicy");
	await user.click(
		screen.getByLabelText("Keep Spot, then allow Standard fallback"),
	);
	fireEvent.change(screen.getByLabelText("Maximum Spot retries"), {
		target: { value: "3" },
	});
	fireEvent.change(screen.getByLabelText("Overall Spot window (seconds)"), {
		target: { value: "7200" },
	});
	await user.click(screen.getByRole("button", { name: "Save" }));
	expect(save.mock.calls[1]?.[0].profile.spotPolicy).toEqual({
		maxRetries: 3,
		deadlineSeconds: 7200,
	});
});

it("keeps cloud credentials and their retry action visible after a disable fails", async () => {
	const read = apiFetch.getMockImplementation();
	apiFetch.mockImplementation((url: string, options?: { method?: string }) =>
		options?.method === "DELETE"
			? Promise.reject(new Error("offline"))
			: read?.(url, options),
	);
	renderWithQuery(<VmafProfilesClient />);
	const credential = (await screen.findByText("AWS vault")).closest("li");
	if (!credential) throw new Error("Credential row missing");
	await userEvent.click(
		within(credential).getByRole("button", { name: "Disable" }),
	);
	await screen.findByRole("alert");
	expect(screen.getByText("AWS vault")).toBeInTheDocument();
	expect(
		within(credential).getByRole("button", { name: "Disable" }),
	).toBeEnabled();
});

it("prevents editing profiles until failed credential dependencies recover", async () => {
	const read = apiFetch.getMockImplementation();
	apiFetch.mockImplementation((url: string, options?: { method?: string }) =>
		url.endsWith("vmaf-credentials")
			? Promise.reject(new Error("offline"))
			: read?.(url, options),
	);
	renderWithQuery(<VmafProfilesClient />);
	expect(await screen.findByRole("button", { name: "Edit" })).toBeDisabled();
	const retries = await screen.findAllByRole("button", { name: "Retry" });
	if (!read || !retries[0]) throw new Error("Missing recovery fixture");
	apiFetch.mockImplementation(read);
	await userEvent.click(retries[0]);
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled(),
	);
});
