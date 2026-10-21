import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import type { HeartbeatReception } from "../live-shared";
import { HeartbeatReceptionPanel } from "./heartbeat-reception-panel";

const now = Date.parse("2026-09-07T08:00:00Z");
const data: HeartbeatReception = {
	state: "available",
	runId: "run-1",
	configuredIntervalS: 20,
	latest: {
		receivedAt: "2026-09-07T07:59:50Z",
		sampledAt: "2026-09-07T07:59:48Z",
		raw: {
			ingest: {
				status: "CONNECTED",
				streams: [{ mediaType: "VIDEO", incomingBitrate: 500_000, rate: 30 }],
			},
		},
	},
	previousReceivedAt: "2026-09-07T07:59:30Z",
};
async function openDetails() {
	const panel = screen.getByText("Signed Push telemetry").closest("details");
	const summary = panel?.querySelector("summary");
	if (!panel || !summary) throw new Error("Missing receipt details");
	expect(panel.open).toBe(false);
	await userEvent.click(summary);
	expect(panel.open).toBe(true);
	return panel;
}
describe("HeartbeatReceptionPanel", () => {
	it("labels unsupported encoders as regular status checks, not legacy registration", async () => {
		renderLocalized(
			<HeartbeatReceptionPanel
				reception={{
					...data,
					latest: null,
					registration: {
						mode: "POLL_ONLY",
						requestedEncoderVersion: "2.284.0",
						resolvedEncoderVersion: "2.284.0",
						status: "SKIPPED",
					},
				}}
				runId="run-1"
				nowMs={now}
				mode="live"
			/>,
		);
		await openDetails();
		expect(
			screen.getByText("Regular status checks only (encoder unsupported)"),
		).toBeVisible();
		expect(screen.queryByText("Legacy account-wide")).toBeNull();
	});
	it("shows registered mode and resolved version without claiming receipt", async () => {
		renderLocalized(
			<HeartbeatReceptionPanel
				reception={{
					...data,
					latest: null,
					registration: {
						mode: "PER_ENCODING",
						requestedEncoderVersion: "BETA",
						resolvedEncoderVersion: "2.285.0",
						status: "ACTIVE",
					},
				}}
				runId="run-1"
				nowMs={now}
				mode="live"
			/>,
		);
		await openDetails();
		expect(screen.getByText("Per encoding + customData")).toBeVisible();
		expect(screen.getByText("2.285.0")).toBeVisible();
		expect(
			screen.getByText("Registered (receipt checked separately)"),
		).toBeVisible();
		expect(screen.getByText("No usable Push sample")).toBeVisible();
	});
	it("an old distinct sample does not claim that HTTP deliveries have stopped", async () => {
		if (data.state !== "available" || !data.latest) throw new Error("fixture");
		renderLocalized(
			<HeartbeatReceptionPanel
				reception={{
					...data,
					latest: {
						...data.latest,
						receivedAt: "2026-09-07T07:00:00Z",
						sampledAt: "2026-09-07T07:00:00Z",
					},
				}}
				runId="run-1"
				nowMs={now}
				mode="live"
			/>,
		);
		expect(screen.getByText("No recent sample update")).toBeInTheDocument();
		await openDetails();
		expect(
			screen.getByText("Displayed sample first received"),
		).toBeInTheDocument();
		expect(screen.queryByText("Reception is stale")).not.toBeInTheDocument();
		expect(screen.queryByText("Last accepted Push")).not.toBeInTheDocument();
	});
	it("empty usable samples do not claim that Push has never arrived historically", () => {
		renderLocalized(
			<HeartbeatReceptionPanel
				reception={{
					state: "available",
					runId: "run-1",
					configuredIntervalS: 20,
					latest: null,
					previousReceivedAt: null,
				}}
				runId="run-1"
				nowMs={now}
				mode="live"
			/>,
		);
		expect(screen.getByText("No usable Push sample")).toBeInTheDocument();
		expect(screen.queryByText("No Push received yet")).not.toBeInTheDocument();
	});
	it("labels signed Push, receipt, provider sample and observed distinct-sample interval separately inside optional details", async () => {
		renderLocalized(
			<HeartbeatReceptionPanel
				reception={data}
				runId="run-1"
				nowMs={now}
				mode="live"
			/>,
		);
		expect(screen.getByText("4.00 Mbps")).not.toBeVisible();
		const panel = await openDetails();
		expect(
			within(panel).getByText("Sample updated recently"),
		).toBeInTheDocument();
		expect(
			within(panel).getByText("Displayed sample first received"),
		).toBeInTheDocument();
		expect(within(panel).getByText("Provider sample time")).toBeInTheDocument();
		expect(
			within(panel).getByText(
				/Push takes priority when both receipt and sample are within 90 seconds/,
			),
		).toBeInTheDocument();
		expect(
			within(panel).getByText("Interval between distinct-sample receipts"),
		).toBeInTheDocument();
		expect(within(panel).getByText("4.00 Mbps")).toBeVisible();
	});
	it("wrong run never leaks the older run's input metrics", () => {
		renderLocalized(
			<HeartbeatReceptionPanel
				reception={data}
				runId="run-2"
				nowMs={now}
				mode="live"
			/>,
		);
		expect(screen.getByText("Reception unavailable")).toBeInTheDocument();
		expect(screen.queryByText("CONNECTED")).not.toBeInTheDocument();
	});
	it("new receipt with old provider timestamp is visibly a stale sample", async () => {
		if (data.state !== "available" || !data.latest) throw new Error("fixture");
		renderLocalized(
			<HeartbeatReceptionPanel
				reception={{
					...data,
					latest: { ...data.latest, sampledAt: "2026-09-07T07:00:00Z" },
				}}
				runId="run-1"
				nowMs={now}
				mode="live"
			/>,
		);
		expect(screen.getByText("Sample updated recently")).toBeInTheDocument();
		await openDetails();
		expect(
			screen.getByText("Provider sample is stale; not current input health."),
		).toBeInTheDocument();
	});
	it("finished run remains historical, not receiving", () => {
		renderLocalized(
			<HeartbeatReceptionPanel
				reception={data}
				runId="run-1"
				nowMs={now}
				mode="finished"
			/>,
		);
		expect(screen.getByText("Historical reception")).toBeInTheDocument();
		expect(
			screen.queryByText("Sample updated recently"),
		).not.toBeInTheDocument();
	});
	it("renders Japanese missing-receipt state without raw i18n keys", () => {
		renderLocalized(
			<HeartbeatReceptionPanel
				reception={{
					state: "available",
					runId: "run-1",
					configuredIntervalS: 20,
					latest: null,
					previousReceivedAt: null,
				}}
				runId="run-1"
				nowMs={now}
				mode="live"
			/>,
			"ja",
		);
		expect(
			screen.getByText("表示できる Push 通知の計測値がありません"),
		).toBeInTheDocument();
	});

	it("can expand and collapse receipt metrics using its native summary", async () => {
		renderLocalized(
			<HeartbeatReceptionPanel
				reception={data}
				runId="run-1"
				nowMs={now}
				mode="live"
			/>,
		);
		const metric = screen.getByText("4.00 Mbps");
		expect(metric).not.toBeVisible();
		const panel = await openDetails();
		expect(metric).toBeVisible();
		const summary = panel.querySelector("summary");
		if (!summary) throw new Error("Missing summary");
		await userEvent.click(summary);
		expect(metric).not.toBeVisible();
	});
});
