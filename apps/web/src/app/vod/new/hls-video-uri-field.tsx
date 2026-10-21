import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";

export function HlsVideoUriField({
	id,
	value,
	perTitle = false,
	live = false,
	onChange,
}: {
	id: string;
	value?: string;
	perTitle?: boolean;
	live?: boolean;
	onChange: (value: string | undefined) => void;
}) {
	const { t } = useT();
	return (
		<Field
			label={t("wizard.hlsVideoUri")}
			htmlFor={id}
			help={
				perTitle
					? t("wizard.hlsVideoUriPerTitle")
					: live
						? t("wizard.hlsVideoUriLiveHelp")
						: t("wizard.hlsVideoUriHelp", { token: "{group}" })
			}
		>
			<Input
				id={id}
				value={value ?? ""}
				maxLength={200}
				disabled={perTitle && !value}
				onChange={(event) => onChange(event.target.value || undefined)}
			/>
			{perTitle ? (
				<p className="text-amber-400 text-xs">
					{t("wizard.hlsVideoUriPerTitle")}
				</p>
			) : null}
		</Field>
	);
}
