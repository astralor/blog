import {
	LinkPreset,
	type NavBarConfig,
	type NavBarLink,
	type NavBarSearchConfig,
	NavBarSearchMethod,
} from "../types/config";
import { siteConfig } from "./siteConfig";

const getDynamicNavBarConfig = (): NavBarConfig => {
	const links: (NavBarLink | LinkPreset)[] = [
		// 主页
		LinkPreset.Home,

		// 归档
		LinkPreset.Archive,

		// 我的
		{
			name: "我的",
			url: "/my/",
			icon: "material-symbols:person",
			children: [
				// 留言板（根据配置动态显示）
				...(siteConfig.pages.guestbook ? [LinkPreset.Guestbook] : []),
			],
		},

		// 关于
		LinkPreset.About,
	];

	return { links } as NavBarConfig;
};

// 导航搜索配置
export const navBarSearchConfig: NavBarSearchConfig = {
	method: NavBarSearchMethod.PageFind,
};

export const navBarConfig: NavBarConfig = getDynamicNavBarConfig();
