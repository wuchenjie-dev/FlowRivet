import { describe, expect, it } from "vitest";

import type { AdmissionReminderPlan } from "../src/reminders/admission.js";
import {
  recordAdmissionReminder,
  type RequirementCommentAdmin,
} from "../src/tapd/reminder-record.js";

const reminder: AdmissionReminderPlan = {
  requirementId: "1150396062001000019",
  title: "[FLOWRIVET_POC] 跨模块：ABF 检测结果闭环",
  requirementUrl: "https://www.tapd.cn/50396062/prong/stories/view/1150396062001000019",
  recipientOpenId: "ou_fixture_user",
  findings: [
    { code: "ADM-METRIC-MISSING", message: "缺少可度量的成功指标" },
    { code: "GATE-BLOCKING-QUESTION-OPEN", message: "仍有 1 个阻断问题未关闭" },
  ],
};

class CommentAdmin implements RequirementCommentAdmin {
  descriptions: string[] = [];

  async listRequirementComments(): Promise<string[]> {
    return [...this.descriptions];
  }

  async addRequirementComment(input: { description: string }): Promise<void> {
    this.descriptions.push(input.description);
  }
}

describe("recordAdmissionReminder", () => {
  it("previews without writing a TAPD comment", async () => {
    const admin = new CommentAdmin();

    const result = await recordAdmissionReminder(admin, reminder, {
      dryRun: true,
      author: "wuchenjie",
    });

    expect(result).toEqual({ dryRun: true, created: false, duplicate: false });
    expect(admin.descriptions).toEqual([]);
  });

  it("writes one traceable comment and skips the same blocker state", async () => {
    const admin = new CommentAdmin();

    const first = await recordAdmissionReminder(admin, reminder, {
      dryRun: false,
      author: "wuchenjie",
    });
    const second = await recordAdmissionReminder(admin, reminder, {
      dryRun: false,
      author: "wuchenjie",
    });

    expect(first).toEqual({ dryRun: false, created: true, duplicate: false });
    expect(second).toEqual({ dryRun: false, created: false, duplicate: true });
    expect(admin.descriptions).toHaveLength(1);
    expect(admin.descriptions[0]).toContain("FlowRivet 已发送飞书阻塞提醒");
    expect(admin.descriptions[0]).toContain("ADM-METRIC-MISSING");
    expect(admin.descriptions[0]).not.toContain("ou_fixture_user");
  });
});
