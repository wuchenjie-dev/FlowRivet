import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("Codex taskboard demo operations guide", () => {
  it("documents the full local registration and verification path", async () => {
    const guide = await readFile(
      resolve(repositoryRoot, "docs/operations/codex-plugin-demo.md"),
      "utf8",
    );

    expect(guide).toContain("Node.js 22.5");
    expect(guide).toContain("npm start --workspace @flowrivet/codex-plugin");
    expect(guide).toContain("http://127.0.0.1:43120/health");
    expect(guide).toContain("codex plugin marketplace add");
    expect(guide).toContain(".plugin-appserver\\codex.exe");
    expect(guide).toContain("plugin add flowrivet@flowrivet-local");
    expect(guide).toContain("API Key");
    expect(guide).toContain("远程插件目录");
    expect(guide).toContain("打开我的待办看板");
    expect(guide).toContain("飞书项目");
    expect(guide).toContain("npx -y @lark-project/meegle@latest install");
    expect(guide).toContain("meegle config set host project.feishu.cn");
    expect(guide).toContain("CLI 版本不低于 `1.0.19`");
    expect(guide).toContain("meegle auth status --format json");
    expect(guide).toContain("系统默认浏览器");
    expect(guide).toContain("不需要复制验证码或手动检查授权结果");
    expect(guide).toContain("Companion 重启不会恢复内存中的临时授权会话");
    expect(guide).toContain("官方飞书项目 MCP");
    expect(guide).toContain("不是必需");
    expect(guide).toContain("系统钥匙串");
    expect(guide).toContain("真实工作项");
    expect(guide).toContain("当前账号");
    expect(guide).toContain("refresh_my_work_items");
    expect(guide).toContain("flowrivet.db");
    expect(guide).toContain("超过 7 天才自动删除");
    expect(guide).toContain("taskboard-preferences.json");
    expect(guide).toContain("默认 60 秒");
    expect(guide).toContain("不自动刷新");
    expect(guide).toContain("5～3600");
    expect(guide).toContain("页面隐藏");
    expect(guide).toContain("Retry-After");
    expect(guide).toContain("多个看板");
    expect(guide).toContain("授权失效时暂停");
    expect(guide).toContain("偏好读取失败");
    expect(guide).toContain("重新连接飞书项目");
    expect(guide).toContain("probe:cache");
    expect(guide).toContain("requiredFieldsPresent");
    expect(guide).not.toContain("当前看板中的工作项仍是 Demo 数据");
    expect(guide).not.toMatch(/TAPD_(?:TOKEN|SECRET)\s*=\s*["'][^"']+["']/i);
    expect(guide).not.toMatch(/client_secret\s*(?:=|:)\s*["'][^"']+["']/i);
    expect(guide).not.toMatch(/Meegle Token|飞书项目 Token/i);
  });

  it("links the guide and design from the README", async () => {
    const readme = await readFile(resolve(repositoryRoot, "README.md"), "utf8");

    expect(readme).toContain("docs/operations/codex-plugin-demo.md");
    expect(readme).toContain("飞书项目 CLI");
    expect(readme).toContain("设备授权");
    expect(readme).toContain("2026-08-06-tapd-my-work-taskboard-design.md");
  });
});
