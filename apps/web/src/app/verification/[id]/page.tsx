import { redirect } from "next/navigation";

export default async function VerificationRunPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	await params;
	redirect("/");
}
