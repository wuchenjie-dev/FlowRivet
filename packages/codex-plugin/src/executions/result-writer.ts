const MAX_RESULT_LENGTH = 7_999;

export interface ExecutionResultInput {
  executionId: string;
  artifactType: string;
  revision: number;
  summary: string;
  repository?: string;
  branch?: string;
  mergeRequestUrl?: string;
  pipelineStatus?: string;
}

export class ResultWriter {
  build(input: ExecutionResultInput) {
    const marker = `<!-- flowrivet:execution=${cleanToken(input.executionId)};artifact=${cleanToken(input.artifactType)};revision=${input.revision} -->`;
    const lines = [marker, "", "## FlowRivet 执行结果", "", input.summary.trim()];
    const details = [
      ["仓库", input.repository],
      ["分支", input.branch],
      ["合并请求", input.mergeRequestUrl],
      ["流水线", input.pipelineStatus],
    ].filter((entry): entry is [string, string] => Boolean(entry[1]));
    if (details.length > 0) {
      lines.push("", "### 研发信息", "", ...details.map(([label, value]) => `- ${label}：${value}`));
    }
    return lines.join("\n").slice(0, MAX_RESULT_LENGTH).trimEnd();
  }
}

function cleanToken(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 200);
}
