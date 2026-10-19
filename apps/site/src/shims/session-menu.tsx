import { LocaleSwitcher } from "@/components/locale-switcher";
import { ThemeSwitcher } from "@/components/theme-switcher";

export function SessionMenu() {
	return (
		<div className="space-y-3 text-xs text-zinc-400">
			<p>Public demo workspace</p>
			<div className="flex flex-wrap gap-2">
				<LocaleSwitcher />
				<ThemeSwitcher />
			</div>
			<a href={import.meta.env.BASE_URL} className="text-emerald-400 underline">
				About Bitovp
			</a>
		</div>
	);
}
