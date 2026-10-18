import { notFound } from "next/navigation";
import { localizedTitle } from "@/lib/i18n/metadata";
import { readFeatureFlags } from "@/lib/server/feature-flags";
import { VmafReport } from "./vmaf-report";

export const generateMetadata = localizedTitle("pageTitles.vmafReport");

export default async function VmafReportPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	// : with QC/VMAF off this surface does not exist for the
	// deployment — 404 rather than an empty page, matching the API gate.
	if (!(await readFeatureFlags()).qcVmaf) {
		notFound();
	}
	const { id } = await params;
	return <VmafReport id={id} />;
}
