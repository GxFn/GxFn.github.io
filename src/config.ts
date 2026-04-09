export const SITE = {
  website: "https://gaoxuefeng.com/",
  author: "Gao Xuefeng",
  profile: "https://github.com/GxFn",
  desc: "Software engineer. Builder of AutoSnippet.",
  title: "Gaoxuefeng's Blog",
  ogImage: "og.png",
  lightAndDarkMode: true,
  postPerIndex: 4,
  postPerPage: 4,
  scheduledPostMargin: 15 * 60 * 1000, // 15 minutes
  showArchives: true,
  showBackButton: true,
  editPost: {
    enabled: false,
    text: "Edit page",
    url: "https://github.com/GxFn/GxFn.github.io/edit/main/",
  },
  dynamicOgImage: true,
  dir: "ltr",
  lang: "zh-CN",
  timezone: "Asia/Shanghai",
} as const;
