import { localizedTitle } from "@/lib/i18n/metadata";
import { NativeOperationClient } from "./native-operation-client";

export const generateMetadata = localizedTitle("encodingNative.title");

export default function NativeOperationsPage() {
	return <NativeOperationClient />;
}
