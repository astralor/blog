import type { AnnouncementConfig } from "../types/config";

export const announcementConfig: AnnouncementConfig = {
	title: "公告",
	content: "站点正在建设中，内容持续更新中",
	closable: true,
	link: {
		enable: true,
		text: "了解更多",
		url: "/about.html",
		external: false,
	},
};
