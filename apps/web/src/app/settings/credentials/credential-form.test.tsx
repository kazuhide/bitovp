import {
	CREDENTIAL_PROVIDER_GROUP,
	CREDENTIAL_PROVIDER_LABELS,
	CREDENTIAL_PROVIDERS,
} from "@bitovp/core";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized as renderL } from "@/test/render";
import { CredentialForm } from "./credential-form";

describe("CredentialForm", () => {
	it("renders AWS fields by default and switches providers", async () => {
		const user = userEvent.setup();
		renderL(<CredentialForm submitting={false} onSubmit={vi.fn()} />);

		expect(screen.getByLabelText("Region")).toBeInTheDocument();
		expect(screen.getByLabelText("Secret access key")).toHaveAttribute(
			"type",
			"password",
		);

		await user.selectOptions(
			screen.getByLabelText("Provider"),
			"AKAMAI_OBJECT_STORAGE",
		);
		expect(await screen.findByLabelText("Host")).toBeInTheDocument();
	});

	it("blocks an Akamai host that violates C10", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		renderL(<CredentialForm submitting={false} onSubmit={onSubmit} />);

		await user.selectOptions(
			screen.getByLabelText("Provider"),
			"AKAMAI_OBJECT_STORAGE",
		);
		await user.type(screen.getByLabelText("Label"), "akamai");
		await user.type(screen.getByLabelText("Host"), "s3.amazonaws.com");
		await user.type(screen.getByLabelText("Access key"), "a");
		await user.type(screen.getByLabelText("Secret key"), "s");
		await user.click(screen.getByRole("button", { name: "Create credential" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			/linodeobjects\.com/,
		);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("submits a valid AWS credential", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		renderL(<CredentialForm submitting={false} onSubmit={onSubmit} />);

		await user.type(screen.getByLabelText("Label"), "prod");
		await user.type(screen.getByLabelText("Region"), "ap-northeast-1");
		await user.type(screen.getByLabelText("Access key ID"), "AKIAX");
		await user.type(screen.getByLabelText("Secret access key"), "shh");
		await user.click(screen.getByRole("button", { name: "Create credential" }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
		expect(onSubmit).toHaveBeenCalledWith({
			provider: "AWS_S3",
			label: "prod",
			config: { region: "ap-northeast-1" },
			secret: { accessKeyId: "AKIAX", secretAccessKey: "shh" },
		});
	});

	it("submits a POIS_ENDPOINT credential with both halves as write-only secrets", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		renderL(<CredentialForm submitting={false} onSubmit={onSubmit} />);

		await user.selectOptions(
			screen.getByLabelText("Provider"),
			"POIS_ENDPOINT",
		);
		await user.type(screen.getByLabelText("Label"), "pois-prod");
		await user.type(screen.getByLabelText("Username"), "esam-operator");
		const password = screen.getByLabelText("Password");
		// The password half is masked while typing; both halves live in the
		// write-only secret fieldset (username is vaulted too — PII-ish).
		expect(password).toHaveAttribute("type", "password");
		await user.type(password, "pois-secret");
		await user.click(screen.getByRole("button", { name: "Create credential" }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
		expect(onSubmit).toHaveBeenCalledWith({
			provider: "POIS_ENDPOINT",
			label: "pois-prod",
			config: {},
			secret: { username: "esam-operator", password: "pois-secret" },
		});
	});

	/**
	 * MSL5's Digest pair —  PR 1, and this arm exists because a
	 * declared field is not a rendered one.
	 *
	 * `PROVIDER_FIELDS.AKAMAI_MSL.secret` went from `[]` to two entries. The
	 * form gates its whole secret fieldset on `fields.secret.length > 0`, so
	 * until this commit that provider rendered NO secret inputs at all — and a
	 * table entry with nothing reading it is the "named slot is not a filled
	 * one" shape. This asserts the inputs exist, that the password half is
	 * masked, and that both halves reach `secret` rather than `config` (where
	 * they would be plaintext JSONB returned to any VIEWER).
	 */
	it("submits an AKAMAI_MSL credential with the Digest pair as write-only secrets", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		renderL(<CredentialForm submitting={false} onSubmit={onSubmit} />);

		await user.selectOptions(screen.getByLabelText("Provider"), "AKAMAI_MSL");
		await user.type(screen.getByLabelText("Label"), "msl5-japan");
		await user.type(screen.getByLabelText("Stream ID"), "20001601");
		await user.type(screen.getByLabelText("Event name"), "my-live-event");
		await user.type(
			screen.getByLabelText("MSL5 publishing username (Digest)"),
			"pub-user",
		);
		const password = screen.getByLabelText("MSL5 publishing password (Digest)");
		expect(password).toHaveAttribute("type", "password");
		await user.type(password, "S3gm3nt!");
		await user.click(screen.getByRole("button", { name: "Create credential" }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
		expect(onSubmit).toHaveBeenCalledWith({
			provider: "AKAMAI_MSL",
			label: "msl5-japan",
			// The provisioning identity is readable CONFIG; the Digest pair is
			// SECRET. Getting that split wrong is what F10 was about, and this
			// assertion is the one that would catch it.
			// The form COERCES streamId to a number (`type: "number"`), which
			// independently corroborates the vendor finding that MSL5 stream ids
			// are numeric — the design's "UUID-form" claim would have been
			// unrepresentable here.
			config: { streamId: 20001601, eventName: "my-live-event" },
			secret: { username: "pub-user", password: "S3gm3nt!" },
		});
	});

	/**
	 * An MSL4 credential — no pair — must stay creatable, because MSL4 is the
	 * incumbent until its EOL 2026-12-31 and every existing row looks like this.
	 * A required pair would have made them all unsaveable.
	 */
	it("still creates an AKAMAI_MSL credential with NO Digest pair", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		renderL(<CredentialForm submitting={false} onSubmit={onSubmit} />);

		await user.selectOptions(screen.getByLabelText("Provider"), "AKAMAI_MSL");
		await user.type(screen.getByLabelText("Label"), "msl4-legacy");
		await user.type(screen.getByLabelText("Stream ID"), "2108679");
		await user.type(screen.getByLabelText("Event name"), "legacy-event");
		await user.click(screen.getByRole("button", { name: "Create credential" }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
		const submitted = onSubmit.mock.calls[0]?.[0] as { secret?: unknown };
		// Empty or absent, both acceptable — what matters is that the form does
		// not manufacture a half pair, which the schema refuses to store.
		expect(submitted.secret ?? {}).toEqual({});
	});

	/**
	 * The delivery edge base URL (2026-09-02). It is readable CONFIG — every
	 * viewer's player loads it — so it must land in `config`, next to the two
	 * identifiers, and never in `secret`.
	 */
	it("submits an AKAMAI_MSL credential with the delivery edge base URL as readable config", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		renderL(<CredentialForm submitting={false} onSubmit={onSubmit} />);

		await user.selectOptions(screen.getByLabelText("Provider"), "AKAMAI_MSL");
		await user.type(screen.getByLabelText("Label"), "msl4-jp");
		await user.type(screen.getByLabelText("Stream ID"), "2126636");
		await user.type(
			screen.getByLabelText("Event name"),
			"bitmovinhlsjp20260821",
		);
		await user.type(
			screen.getByLabelText("Delivery edge base URL (optional)"),
			"https://bitmovinmsl4hlsjp.akamaized.net/hls/live/2126636/bitmovinhlsjp20260821",
		);
		await user.click(screen.getByRole("button", { name: "Create credential" }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
		expect(onSubmit).toHaveBeenCalledWith({
			provider: "AKAMAI_MSL",
			label: "msl4-jp",
			config: {
				streamId: 2126636,
				eventName: "bitmovinhlsjp20260821",
				edgeBaseUrl:
					"https://bitmovinmsl4hlsjp.akamaized.net/hls/live/2126636/bitmovinhlsjp20260821",
			},
			secret: {},
		});
	});

	/* Build the MSL4 delivery candidate from the operator-entered host and existing identity fields; enable it only when those values are available. */
	it("fills the MSL4 candidate from a typed host — never a guessed one — and submits it", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		renderL(<CredentialForm submitting={false} onSubmit={onSubmit} />);

		await user.selectOptions(screen.getByLabelText("Provider"), "AKAMAI_MSL");
		const fill = screen.getByRole("button", { name: "Fill candidate" });
		// No host, no identity: nothing to fill from.
		expect(fill).toBeDisabled();
		await user.type(screen.getByLabelText("Label"), "msl4-jp");
		await user.type(screen.getByLabelText("Stream ID"), "20001601");
		await user.type(screen.getByLabelText("Event name"), "my-live-event");
		// Identity alone is not enough — the host is the one thing the app
		// cannot know, and it is not defaulted.
		expect(fill).toBeDisabled();
		const host = screen.getByLabelText("Akamai hostname");
		await user.type(host, "https://example.akamaized.net");
		// A URL in the host box is refused, with the bare-hostname rail's words.
		expect(
			await screen.findByText(
				"Host must be a bare hostname (no scheme, path or port)",
			),
		).toBeInTheDocument();
		expect(fill).toBeDisabled();
		await user.clear(host);
		await user.type(host, "Live.Example.Net");
		expect(fill).toBeEnabled();
		// A host that is NOT the placeholder: a candidate built from a guessed
		// host instead of the typed one would fail here.
		expect(
			screen.getByText(
				"https://live.example.net/hls/live/20001601/my-live-event",
			),
		).toBeInTheDocument();
		// The stream format decides the event-root prefix; DASH is /dash/live/.
		await user.selectOptions(screen.getByLabelText("Stream format"), "DASH");
		await user.click(fill);
		const field = screen.getByLabelText("Delivery edge base URL (optional)");
		expect(field).toHaveValue(
			"https://live.example.net/dash/live/20001601/my-live-event",
		);
		await user.click(screen.getByRole("button", { name: "Create credential" }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
		expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
			config: {
				streamId: 20001601,
				eventName: "my-live-event",
				edgeBaseUrl:
					"https://live.example.net/dash/live/20001601/my-live-event",
			},
		});
	});

	it("refuses a signed edge URL and a trailing slash with the authored sentence, before submit", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		renderL(<CredentialForm submitting={false} onSubmit={onSubmit} />);

		await user.selectOptions(screen.getByLabelText("Provider"), "AKAMAI_MSL");
		await user.type(screen.getByLabelText("Label"), "msl4-jp");
		await user.type(screen.getByLabelText("Stream ID"), "2126636");
		await user.type(screen.getByLabelText("Event name"), "ev");
		const field = screen.getByLabelText("Delivery edge base URL (optional)");
		await user.type(field, "https://x.akamaized.net/hls/live/2126636/ev/");
		await user.click(screen.getByRole("button", { name: "Create credential" }));
		expect(
			await screen.findByText(
				"Edge base URL must not end with a slash — the app appends the manifest name itself",
			),
		).toBeInTheDocument();
		expect(onSubmit).not.toHaveBeenCalled();

		await user.clear(field);
		await user.type(
			field,
			"https://x.akamaized.net/hls/live/2126636/ev?hdnts=abc",
		);
		await user.click(screen.getByRole("button", { name: "Create credential" }));
		expect(
			await screen.findByText(
				"Edge base URL must not carry a query or fragment — supply the event root, not a signed playback URL",
			),
		).toBeInTheDocument();
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("edits an MSL4 credential registered before the field existed and adds the edge root via PATCH", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		renderL(
			<CredentialForm
				submitting={false}
				onSubmit={onSubmit}
				credential={{
					id: "1",
					label: "msl4-legacy",
					provider: "AKAMAI_MSL",
					hasSecret: false,
					config: { streamId: 2126636, eventName: "ev" },
					createdAt: "",
					updatedAt: "",
				}}
			/>,
		);
		const field = screen.getByLabelText("Delivery edge base URL (optional)");
		expect(field).toHaveValue("");
		await user.type(field, "https://x.akamaized.net/hls/live/2126636/ev");
		await user.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
		expect(onSubmit).toHaveBeenCalledWith({
			label: "msl4-legacy",
			config: {
				streamId: 2126636,
				eventName: "ev",
				edgeBaseUrl: "https://x.akamaized.net/hls/live/2126636/ev",
			},
		});
	});

	it("submits a KANTAR credential with a MASKED password and both halves write-only", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		renderL(<CredentialForm submitting={false} onSubmit={onSubmit} />);

		await user.selectOptions(screen.getByLabelText("Provider"), "KANTAR");
		await user.type(screen.getByLabelText("Label"), "kantar-prod");
		await user.type(screen.getByLabelText("Login"), "kantar-operator");
		const password = screen.getByLabelText("Password");
		// Review catch M1: this shipped as type="text", so the live service
		// password rendered on screen while typing — every other
		// password-class secret in provider-fields.ts masks it.
		expect(password).toHaveAttribute("type", "password");
		await user.type(password, "kantar-secret");
		await user.click(screen.getByRole("button", { name: "Create credential" }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
		expect(onSubmit).toHaveBeenCalledWith({
			provider: "KANTAR",
			label: "kantar-prod",
			config: {},
			secret: { login: "kantar-operator", password: "kantar-secret" },
		});
	});

	it("rejects a POIS_ENDPOINT credential missing the password half", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		renderL(<CredentialForm submitting={false} onSubmit={onSubmit} />);

		await user.selectOptions(
			screen.getByLabelText("Provider"),
			"POIS_ENDPOINT",
		);
		await user.type(screen.getByLabelText("Label"), "pois");
		await user.type(screen.getByLabelText("Username"), "esam-operator");
		await user.click(screen.getByRole("button", { name: "Create credential" }));

		expect(await screen.findByText("Password is required")).toBeInTheDocument();
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("round-trips publicBaseUrls between the stored map and the textarea", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		renderL(
			<CredentialForm
				submitting={false}
				onSubmit={onSubmit}
				credential={{
					id: "1",
					label: "prod",
					provider: "AWS_S3",
					hasSecret: true,
					config: {
						region: "us-east-1",
						publicBaseUrls: { "out-bucket": "https://cdn.example.com/vod" },
					},
					createdAt: "",
					updatedAt: "",
				}}
			/>,
		);

		// Stored as an object, edited as text.
		const field = screen.getByLabelText("Public base URLs (optional)");
		expect(field).toHaveValue("out-bucket = https://cdn.example.com/vod");

		await user.clear(field);
		await user.type(field, "other = https://origin.example.com/live/");
		await user.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
		expect(onSubmit).toHaveBeenCalledWith({
			label: "prod",
			config: {
				region: "us-east-1",
				// Trailing slash normalised away — it would double against the path.
				publicBaseUrls: { other: "https://origin.example.com/live" },
			},
		});
	});

	it("drops publicBaseUrls entirely when the textarea is cleared", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		renderL(
			<CredentialForm
				submitting={false}
				onSubmit={onSubmit}
				credential={{
					id: "1",
					label: "prod",
					provider: "AWS_S3",
					hasSecret: true,
					config: {
						region: "us-east-1",
						publicBaseUrls: { b: "https://x.dev" },
					},
					createdAt: "",
					updatedAt: "",
				}}
			/>,
		);
		await user.clear(screen.getByLabelText("Public base URLs (optional)"));
		await user.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
		// An empty object would persist a meaningless key; the field must vanish.
		expect(onSubmit).toHaveBeenCalledWith({
			label: "prod",
			config: { region: "us-east-1" },
		});
	});

	it("treats a whitespace-only field as absent, not as a value", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		renderL(<CredentialForm submitting={false} onSubmit={onSubmit} />);

		await user.type(screen.getByLabelText("Label"), "prod");
		await user.type(screen.getByLabelText("Region"), "ap-northeast-1");
		await user.type(screen.getByLabelText("Access key ID"), "AKIAX");
		await user.type(screen.getByLabelText("Secret access key"), "shh");
		// `normalize` drops blank optional fields, but "  " is not blank to it —
		// without the urlmap skip it would reach zod as a string and be rejected
		// with a shape error the operator cannot act on.
		await user.type(
			screen.getByLabelText("Public base URLs (optional)"),
			"   ",
		);
		await user.click(screen.getByRole("button", { name: "Create credential" }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
		expect(onSubmit).toHaveBeenCalledWith({
			provider: "AWS_S3",
			label: "prod",
			config: { region: "ap-northeast-1" },
			secret: { accessKeyId: "AKIAX", secretAccessKey: "shh" },
		});
	});

	it("names the offending line instead of submitting a broken base URL", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		renderL(<CredentialForm submitting={false} onSubmit={onSubmit} />);

		await user.type(screen.getByLabelText("Label"), "prod");
		await user.type(screen.getByLabelText("Region"), "ap-northeast-1");
		await user.type(screen.getByLabelText("Access key ID"), "AKIAX");
		await user.type(screen.getByLabelText("Secret access key"), "shh");
		await user.type(
			screen.getByLabelText("Public base URLs (optional)"),
			"out = cdn.example.com",
		);
		await user.click(screen.getByRole("button", { name: "Create credential" }));

		expect(await screen.findByText(/line 1 \(out\)/)).toBeInTheDocument();
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("offers the field on every bucket-bearing provider and no others", async () => {
		const user = userEvent.setup();
		renderL(<CredentialForm submitting={false} onSubmit={vi.fn()} />);
		const provider = screen.getByLabelText("Provider");
		const label = "Public base URLs (optional)";

		for (const id of [
			"AWS_S3",
			"AWS_S3_ROLE_BASED",
			"AKAMAI_OBJECT_STORAGE",
			"OCI_OBJECT_STORAGE",
			"GENERIC_S3",
			"GCS_HMAC",
			"GCS_SERVICE_ACCOUNT",
			"AZURE_BLOB",
		]) {
			await user.selectOptions(provider, id);
			expect(screen.queryByLabelText(label), id).toBeInTheDocument();
		}
		// SFTP outputs have no bucket to key the map on, and the rest hold no
		// storage at all — offering the field there would imply otherwise.
		for (const id of ["SFTP", "DRM_CENC", "KANTAR", "ZIXI"]) {
			await user.selectOptions(provider, id);
			expect(screen.queryByLabelText(label), id).not.toBeInTheDocument();
		}
	});

	it("keeps secrets write-only in edit mode until replacement is requested", async () => {
		const user = userEvent.setup();
		renderL(
			<CredentialForm
				submitting={false}
				onSubmit={vi.fn()}
				credential={{
					id: "1",
					label: "prod",
					provider: "AWS_S3",
					hasSecret: true,
					config: { region: "us-east-1" },
					createdAt: "",
					updatedAt: "",
				}}
			/>,
		);

		expect(screen.queryByLabelText("Secret access key")).toBeNull();
		await user.click(screen.getByLabelText("Replace secret material"));
		expect(screen.getByLabelText("Secret access key")).toBeInTheDocument();
	});
});

/**
 * The provider field tables live at module scope, where there is no hook to call,
 * so their labels and hints became `MessageKey`s rather than strings. These assert
 * the keys actually resolve — a wrong key throws, but a key pointing at the wrong
 * entry renders plausible copy that only a literal catches.
 */
describe("CredentialForm — Japanese", () => {
	it("labels the AWS fields and the write-only hint in Japanese", async () => {
		renderL(<CredentialForm submitting={false} onSubmit={vi.fn()} />, "ja");
		for (const label of ["ラベル", "リージョン", "アクセスキー ID"]) {
			expect(
				(await screen.findAllByText(new RegExp(label))).length,
				label,
			).toBeGreaterThan(0);
		}
		for (const english of ["Access key ID", "Secret access key"]) {
			expect(screen.queryByText(english), english).not.toBeInTheDocument();
		}
	});

	it("switches to OCI and shows its Japanese hint", async () => {
		const user = userEvent.setup();
		renderL(<CredentialForm submitting={false} onSubmit={vi.fn()} />, "ja");
		await user.selectOptions(
			await screen.findByLabelText(/プロバイダ|Provider/),
			"OCI_OBJECT_STORAGE",
		);
		// The hint is the interesting one: `hintKey` is optional, so a table entry
		// that lost it would still render a perfectly good-looking field.
		expect(
			await screen.findByText(
				"OCI → ユーザー設定 → カスタマーシークレットキー",
			),
		).toBeInTheDocument();
		expect(screen.queryByText(/Customer secret key/)).not.toBeInTheDocument();
	});

	it("switches to Akamai MSL and shows the edge field, its hint and the candidate block in Japanese", async () => {
		const user = userEvent.setup();
		renderL(<CredentialForm submitting={false} onSubmit={vi.fn()} />, "ja");
		await user.selectOptions(
			await screen.findByLabelText(/プロバイダ|Provider/),
			"AKAMAI_MSL",
		);
		expect(
			await screen.findByLabelText("配信エッジのベース URL(任意)"),
		).toBeInTheDocument();
		expect(screen.getByText(/視聴者側のエッジであり/)).toBeInTheDocument();
		expect(screen.getByLabelText("Akamai ホスト名")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "候補を入力" }),
		).toBeInTheDocument();
		for (const english of [
			"Delivery edge base URL (optional)",
			"Fill candidate",
			"Akamai hostname",
		]) {
			expect(screen.queryByText(english), english).not.toBeInTheDocument();
		}
	});

	it("localises an edge URL refusal — the schema's English sentence never reaches the ja form", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		renderL(<CredentialForm submitting={false} onSubmit={onSubmit} />, "ja");
		await user.selectOptions(
			await screen.findByLabelText(/プロバイダ|Provider/),
			"AKAMAI_MSL",
		);
		await user.type(screen.getByLabelText("ラベル"), "msl4");
		await user.type(screen.getByLabelText("ストリーム ID"), "1");
		await user.type(screen.getByLabelText("イベント名"), "ev");
		await user.type(
			screen.getByLabelText("配信エッジのベース URL(任意)"),
			"https://x.akamaized.net/hls/live/1/ev/",
		);
		await user.click(screen.getByRole("button", { name: "資格情報を作成" }));
		expect(
			await screen.findByText(/末尾にスラッシュを付けないでください/),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/must not end with a slash/),
		).not.toBeInTheDocument();
		expect(onSubmit).not.toHaveBeenCalled();
	});
});

describe("the provider dropdown is grouped by purpose (ledger #141)", () => {
	/* The creation dialog groups provider choices consistently with the credential list. */
	const EXPECTED_HEADING: Record<string, string> = {
		STORAGE: "Storage",
		DRM: "DRM",
		LIVE_INGEST: "Live ingest",
		INTEGRATION: "Integrations",
	};

	function optionsByProvider(): Map<string, HTMLOptionElement> {
		renderL(<CredentialForm submitting={false} onSubmit={vi.fn()} />);
		const select = screen.getByLabelText("Provider") as HTMLSelectElement;
		return new Map(
			[...select.querySelectorAll("option")].map((o) => [o.value, o]),
		);
	}

	it("offers EVERY provider — a grouping that drops one is worse than a flat list", () => {
		const options = optionsByProvider();
		// Population is the schema's own list, so a provider added later joins
		// this assertion without anyone remembering to.
		const missing = CREDENTIAL_PROVIDERS.filter((p) => !options.has(p));
		expect(missing, "these are unreachable in the add dialog").toEqual([]);
		expect(options.size).toBe(CREDENTIAL_PROVIDERS.length);
	});

	it("files each provider under ITS group's heading, not merely under some heading", () => {
		const options = optionsByProvider();
		for (const provider of CREDENTIAL_PROVIDERS) {
			const option = options.get(provider);
			const parent = option?.parentElement;
			// Asserting "is inside an optgroup" would pass with all eighteen in
			// one group — the exact state being fixed. The label has to match the
			// provider's own classification.
			expect(parent?.tagName, `${provider} is not inside any group`).toBe(
				"OPTGROUP",
			);
			expect(
				(parent as HTMLOptGroupElement).label,
				`${provider} (${CREDENTIAL_PROVIDER_LABELS[provider]}) is filed wrong`,
			).toBe(EXPECTED_HEADING[CREDENTIAL_PROVIDER_GROUP[provider]]);
		}
	});

	it("keeps a DRM key out of the storage group — the complaint that started this", () => {
		const options = optionsByProvider();
		const drm = options.get("DRM_CENC")?.parentElement as HTMLOptGroupElement;
		expect(drm.label).toBe("DRM");
		expect(drm.label).not.toBe("Storage");
	});
});

describe("SPEKE credentials", () => {
	it("submits URL and Basic auth exclusively in encrypted secret", async () => {
		const user = userEvent.setup(),
			onSubmit = vi.fn();
		renderL(<CredentialForm submitting={false} onSubmit={onSubmit} />);
		await user.selectOptions(screen.getByLabelText("Provider"), "DRM_SPEKE");
		await user.type(screen.getByLabelText("Label"), "keys");
		await user.type(
			screen.getByLabelText("SPEKE endpoint"),
			"https://keys.example.com/speke",
		);
		await user.type(screen.getByLabelText("Username"), "user");
		await user.type(screen.getByLabelText("Password"), "secret");
		await user.click(screen.getByRole("button", { name: "Create credential" }));
		await waitFor(() =>
			expect(onSubmit).toHaveBeenCalledWith({
				provider: "DRM_SPEKE",
				label: "keys",
				config: {},
				secret: {
					url: "https://keys.example.com/speke",
					username: "user",
					password: "secret",
				},
			}),
		);
	});
});
