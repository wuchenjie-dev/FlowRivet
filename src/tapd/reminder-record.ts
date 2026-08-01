import { createHash } from "node:crypto";

import type { AdmissionReminderPlan } from "../reminders/admission.js";

export interface RequirementCommentAdmin {
  listRequirementComments(requirementId: string): Promise<string[]>;
  addRequirementComment(input: {
    requirementId: string;
    author: string;
    description: string;
  }): Promise<void>;
}

export interface ReminderRecordResult {
  dryRun: boolean;
  created: boolean;
  duplicate: boolean;
}

export async function recordAdmissionReminder(
  admin: RequirementCommentAdmin,
  reminder: AdmissionReminderPlan,
  options: { dryRun: boolean; author: string },
): Promise<ReminderRecordResult> {
  if (options.dryRun) return { dryRun: true, created: false, duplicate: false };

  const marker = buildMarker(reminder);
  const comments = await admin.listRequirementComments(reminder.requirementId);
  if (comments.some((comment) => comment.includes(marker))) {
    return { dryRun: false, created: false, duplicate: true };
  }

  const findings = reminder.findings
    .map((finding) => `${escapeHtml(finding.code)}：${escapeHtml(finding.message)}`)
    .join("<br>");
  await admin.addRequirementComment({
    requirementId: reminder.requirementId,
    author: options.author,
    description:
      `<p>${marker}</p>` +
      "<p>FlowRivet 已发送飞书阻塞提醒。</p>" +
      `<p>${findings}</p>`,
  });
  return { dryRun: false, created: true, duplicate: false };
}

function buildMarker(reminder: AdmissionReminderPlan): string {
  const state = [
    reminder.requirementId,
    ...reminder.findings.map((finding) => finding.code).sort(),
  ].join(":");
  const digest = createHash("sha256").update(state).digest("hex").slice(0, 24);
  return `[FlowRivet:admission-reminder:${digest}]`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
