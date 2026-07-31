import { z } from "zod";

const environmentSchema = z.object({
  TAPD_API_ENDPOINT: z.url().default("https://api.tapd.cn"),
  TAPD_TOKEN: z.string().min(1),
  TAPD_API_USER: z.string().min(1),
  TAPD_API_PASSWORD: z.string().min(1),
  TAPD_SOURCE_WORKSPACE_ID: z.string().regex(/^\d+$/),
  TAPD_SANDBOX_WORKSPACE_ID: z.string().regex(/^\d+$/),
  FLOWRIVET_DRY_RUN: z.enum(["true", "false"]).default("true"),
  FLOWRIVET_ALLOW_LIVE_WRITES: z.enum(["true", "false"]).default("false"),
  FLOWRIVET_POC_OWNER: z.string().min(1).optional(),
  FEISHU_API_ENDPOINT: z.url().default("https://open.feishu.cn/open-apis"),
  FEISHU_APP_ID: z.string().min(1),
  FEISHU_APP_SECRET: z.string().min(1),
});

export interface FlowRivetConfig {
  apiEndpoint: string;
  personalToken: string;
  apiUser: string;
  apiPassword: string;
  sourceWorkspaceId: string;
  sandboxWorkspaceId: string;
  dryRun: boolean;
  allowLiveWrites: boolean;
  pocOwner?: string;
  feishuApiEndpoint: string;
  feishuAppId: string;
  feishuAppSecret: string;
}

export function loadConfig(
  environment: Record<string, string | undefined> = process.env,
): FlowRivetConfig {
  const parsed = environmentSchema.parse(environment);
  const allowLiveWrites = parsed.FLOWRIVET_ALLOW_LIVE_WRITES === "true";

  if (
    parsed.TAPD_SOURCE_WORKSPACE_ID === parsed.TAPD_SANDBOX_WORKSPACE_ID &&
    !allowLiveWrites
  ) {
    throw new Error(
      "TAPD_SOURCE_WORKSPACE_ID and TAPD_SANDBOX_WORKSPACE_ID must be different",
    );
  }

  return {
    apiEndpoint: parsed.TAPD_API_ENDPOINT.replace(/\/$/, ""),
    personalToken: parsed.TAPD_TOKEN,
    apiUser: parsed.TAPD_API_USER,
    apiPassword: parsed.TAPD_API_PASSWORD,
    sourceWorkspaceId: parsed.TAPD_SOURCE_WORKSPACE_ID,
    sandboxWorkspaceId: parsed.TAPD_SANDBOX_WORKSPACE_ID,
    dryRun: parsed.FLOWRIVET_DRY_RUN === "true",
    allowLiveWrites,
    pocOwner: parsed.FLOWRIVET_POC_OWNER,
    feishuApiEndpoint: parsed.FEISHU_API_ENDPOINT.replace(/\/$/, ""),
    feishuAppId: parsed.FEISHU_APP_ID,
    feishuAppSecret: parsed.FEISHU_APP_SECRET,
  };
}
