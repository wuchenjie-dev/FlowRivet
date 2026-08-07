import {
  canonicalStages,
  taskboardSnapshotSchema,
} from "../contracts/taskboard.js";

export const demoTaskboardSnapshot = taskboardSnapshotSchema.parse({
  connection: {
    tapd: "connected",
    gitlab: "not_configured",
    userName: "吴晨杰",
    companyName: "FlowRivet 演示企业",
  },
  projectCatalog: {
    provider: {
      providerId: "tapd",
      displayName: "TAPD",
      state: "connected",
      accountDisplayName: "吴晨杰",
      tenantDisplayName: "FlowRivet 演示企业",
    },
    projects: [
      { providerId: "tapd", externalId: "50396062", name: "ABF 产品研发", selected: true, available: true, source: "discovered", lastVerifiedAt: "2026-08-06T11:30:00.000Z" },
      { providerId: "tapd", externalId: "56536239", name: "学科工具", selected: true, available: true, source: "discovered", lastVerifiedAt: "2026-08-06T11:30:00.000Z" },
    ],
    stale: false,
  },
  projects: [
    { providerId: "tapd", externalId: "50396062", name: "ABF 产品研发", selected: true, available: true, source: "discovered", lastVerifiedAt: "2026-08-06T11:30:00.000Z", count: 3 },
    { providerId: "tapd", externalId: "56536239", name: "学科工具", selected: true, available: true, source: "discovered", lastVerifiedAt: "2026-08-06T11:30:00.000Z", count: 4 },
  ],
  stages: canonicalStages,
  items: [
    {
      key: "50396062:story:10001",
      providerId: "tapd", externalId: "#10001", projectExternalId: "50396062", projectName: "ABF 产品研发", kind: "requirement", providerItemType: "story", providerStatus: "planning",
      externalUrl: "https://www.tapd.cn/50396062/prong/stories/view/10001",
      title: "统一检索结果的排序与筛选体验",
      stage: "todo",
      priority: "高",
      dueAt: "2026-08-09T18:00:00+08:00",
    },
    {
      key: "50396062:task:10002",
      providerId: "tapd", externalId: "#10002", projectExternalId: "50396062", projectName: "ABF 产品研发", kind: "task", providerItemType: "task", providerStatus: "progressing",
      externalUrl: "https://www.tapd.cn/50396062/prong/tasks/view/10002",
      title: "补齐搜索服务的接口契约测试",
      stage: "in_progress",
      priority: "中",
      dueAt: "2026-08-08T18:00:00+08:00",
    },
    {
      key: "50396062:bug:10003",
      providerId: "tapd", externalId: "#10003", projectExternalId: "50396062", projectName: "ABF 产品研发", kind: "defect", providerItemType: "bug", providerStatus: "testing",
      externalUrl: "https://www.tapd.cn/50396062/bugtrace/bugs/view/10003",
      title: "修复批量导入时的重复记录",
      stage: "in_review",
      priority: "紧急",
    },
    {
      key: "56536239:story:20001",
      providerId: "tapd", externalId: "#20001", projectExternalId: "56536239", projectName: "学科工具", kind: "requirement", providerItemType: "story", providerStatus: "planning",
      externalUrl: "https://www.tapd.cn/56536239/prong/stories/view/20001",
      title: "教师端支持按知识点查看练习进度",
      stage: "todo",
      priority: "中",
      dueAt: "2026-08-12T18:00:00+08:00",
    },
    {
      key: "56536239:task:20002",
      providerId: "tapd", externalId: "#20002", projectExternalId: "56536239", projectName: "学科工具", kind: "task", providerItemType: "task", providerStatus: "progressing",
      externalUrl: "https://www.tapd.cn/56536239/prong/tasks/view/20002",
      title: "整理历史题库的数据迁移清单",
      stage: "in_progress",
      priority: "低",
    },
    {
      key: "56536239:bug:20003",
      providerId: "tapd", externalId: "#20003", projectExternalId: "56536239", projectName: "学科工具", kind: "defect", providerItemType: "bug", providerStatus: "closed",
      externalUrl: "https://www.tapd.cn/56536239/bugtrace/bugs/view/20003",
      title: "修复作业详情页偶发白屏",
      stage: "done",
      priority: "高",
    },
    {
      key: "56536239:other:20004",
      providerId: "tapd", externalId: "#20004", projectExternalId: "56536239", projectName: "学科工具", kind: "other", providerItemType: "custom", providerStatus: "planning",
      externalUrl: "https://www.tapd.cn/56536239",
      title: "确认自定义工作项的展示方式",
      stage: "in_review",
    },
  ],
  lastSyncedAt: "2026-08-06T19:30:00+08:00",
});
