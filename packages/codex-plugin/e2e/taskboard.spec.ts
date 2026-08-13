import { expect, test, type Page } from "@playwright/test";

function boardFrame(page: Page) {
  return page.frameLocator('iframe[title="FlowRivet MCP App"]');
}

test.beforeEach(async ({ context }) => {
  await context.route("https://project.feishu.cn/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><title>Feishu Project test target</title>",
  }));
});

test("desktop renders four columns without page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/src/ui/demo-harness.html?scenario=connected");
  const board = boardFrame(page);

  await expect(board.getByRole("heading", { name: "我的待办" })).toBeVisible();
  await expect(board.getByRole("complementary", { name: "项目导航" })).toBeVisible();
  await expect(board.locator(".task-column")).toHaveCount(4);
  const shell = await board.locator(".app-shell").boundingBox();
  expect(shell?.width).toBe(1440);
  expect(shell?.height).toBe(900);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  const screenshot = await page.screenshot();
  expect(screenshot.byteLength).toBeGreaterThan(10_000);
  expect(new Set(screenshot).size).toBeGreaterThan(32);
});

test("compact viewport keeps controls separate and board scrollable", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto("/src/ui/demo-harness.html?scenario=connected");
  const board = boardFrame(page);
  await expect(board.getByRole("heading", { name: "我的待办" })).toBeVisible();

  const metrics = await board.locator(".task-board").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);

  const refresh = await board.getByRole("button", { name: "刷新看板" }).boundingBox();
  const account = await board.getByRole("button", { name: "打开连接菜单" }).boundingBox();
  expect(refresh && account && refresh.x + refresh.width <= account.x).toBe(true);
});

test("one click starts browser authorization and automatically opens the board", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=disconnected");
  const board = boardFrame(page);

  await expect(board.getByLabel(/Token/)).toHaveCount(0);
  await board.getByRole("button", { name: "连接飞书项目" }).click();
  await expect(board.getByRole("heading", { name: "正在准备安全授权会话" })).toBeVisible();
  await expect(board.getByRole("button", { name: "关闭飞书授权" })).toHaveCount(0);
  await expect(board.getByText("DEMO-CODE")).toHaveCount(0);
  await expect(board.getByRole("link")).toHaveCount(0);
  await expect(board.getByRole("button", { name: /检查.*结果/ })).toHaveCount(0);
  await expect(board.getByRole("heading", { name: "请在浏览器中完成飞书授权" })).toBeVisible();
  await expect(board.getByRole("heading", { name: "我的待办" })).toBeVisible({ timeout: 8_000 });
  await expect(board.locator(".task-column")).toHaveCount(4);
});

test("notification center marks an item read and opens the Feishu record", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=connected");
  const board = boardFrame(page);
  const opened = page.waitForEvent("popup");

  await board.getByRole("button", { name: "通知，1 条未读" }).click();
  await expect(board.getByRole("heading", { name: "工作项通知" })).toBeVisible();
  await board.locator(".notification-panel")
    .getByRole("button", { name: /统一检索结果/ }).click();

  const popup = await opened;
  expect(popup.url()).toContain("project.feishu.cn/demo/work_item/1");
  await expect(board.getByText("0 条未读")).toBeVisible();
});

test("notification drawer fills a mobile viewport without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/src/ui/demo-harness.html?scenario=connected");
  const board = boardFrame(page);

  await board.getByRole("button", { name: "通知，1 条未读" }).click();
  const panel = await board.locator(".notification-panel").boundingBox();
  expect(panel?.width).toBe(390);
  expect(await board.locator("html").evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);
});

test("expired scenario requires login again and hides stale data", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=expired");
  const board = boardFrame(page);

  await expect(board.getByRole("button", { name: "连接飞书项目" })).toBeVisible();
  await expect(board.locator(".work-card")).toHaveCount(0);
});

test("reloading the plugin reconnects to the same active authorization", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=disconnected");
  const board = boardFrame(page);

  await board.getByRole("button", { name: "连接飞书项目" }).click();
  await expect(board.getByRole("heading", { name: "请在浏览器中完成飞书授权" })).toBeVisible();
  await page.locator('iframe[title="FlowRivet MCP App"]').evaluate((frame) => {
    (frame as HTMLIFrameElement).contentWindow?.location.reload();
  });

  await expect(board.getByRole("heading", { name: "正在确认账号" })).toBeVisible();
  await expect(board.getByRole("heading", { name: "我的待办" })).toBeVisible({ timeout: 5_000 });
  await expect(board.locator(".task-column")).toHaveCount(4);
  await expect(board.getByText("数据来自 飞书项目")).toBeVisible();
});

test("manual browser fallback is temporary and long waits remain cancellable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install();
  await page.goto("/src/ui/demo-harness.html?scenario=manual-browser");
  const board = boardFrame(page);

  await board.getByRole("button", { name: "连接飞书项目" }).click();
  await expect(board.getByRole("link", { name: "打开临时授权页" }))
    .toHaveAttribute("rel", "noreferrer");
  await expect(board.getByRole("status", { name: "飞书备用授权码" })).toHaveText("DEMO-CODE");
  await page.clock.fastForward(15_000);
  await expect(board.getByRole("heading", { name: "仍在等待飞书确认" })).toBeVisible();
  await expect(board.getByRole("button", { name: "重新打开授权页" })).toBeVisible();
  await expect(board.getByRole("button", { name: "取消授权" })).toBeVisible();
  expect(await board.locator("html").evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);
});

test("expired authorization stops waiting and offers one recovery action", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=expired-login");
  const board = boardFrame(page);

  await board.getByRole("button", { name: "连接飞书项目" }).click();
  await expect(board.getByRole("button", { name: "重新授权" })).toBeVisible({ timeout: 6_000 });
  await expect(board.getByRole("alert")).toHaveText("本次飞书授权已过期。");
  await expect(board.getByRole("button", { name: "取消授权" })).toHaveCount(0);
});

test("missing CLI gives an install command without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/src/ui/demo-harness.html?scenario=cli_missing");
  const board = boardFrame(page);

  await expect(board.getByText("npx -y @lark-project/meegle@latest install")).toBeVisible();
  await expect(board.getByRole("button", { name: "重新检查飞书项目连接" })).toBeVisible();
  expect(await board.locator("html").evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);
});

test("disconnect removes board data and returns to login", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=connected");
  const board = boardFrame(page);

  await board.getByRole("button", { name: "打开连接菜单" }).click();
  await board.getByRole("button", { name: "断开飞书项目" }).click();

  await expect(board.getByRole("button", { name: "连接飞书项目" })).toBeVisible();
  await expect(board.locator(".work-card")).toHaveCount(0);
});

test("cards are read-only and pointer movement cannot change counts", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/src/ui/demo-harness.html?scenario=connected");
  const board = boardFrame(page);
  const todo = board.getByRole("region", { name: "待处理列" });
  const progress = board.getByRole("region", { name: "进行中列" });

  await expect(board.locator(".work-card")).toHaveCount(7);
  await expect(board.locator('.work-card[aria-readonly="true"]')).toHaveCount(7);
  await expect(board.locator(".drag-handle")).toHaveCount(0);
  await expect(todo.locator(".column-header span")).toHaveText("2");
  await expect(progress.locator(".column-header span")).toHaveText("2");
  const cardBox = await board.locator(".task-board")
    .getByText("统一检索结果的排序与筛选体验").boundingBox();
  const targetBox = await progress.boundingBox();
  expect(cardBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  if (!cardBox || !targetBox) return;
  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cardBox.x + cardBox.width / 2 + 12, cardBox.y + cardBox.height / 2, { steps: 4 });
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 90, { steps: 12 });
  await page.mouse.up();
  await expect(todo.locator(".column-header span")).toHaveText("2");
  await expect(progress.locator(".column-header span")).toHaveText("2");
  await expect(board.getByText(/看板位置已更新/)).toHaveCount(0);
});

test("keyboard reaches controls and opens a Feishu work item URL", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=connected");
  const board = boardFrame(page);

  await board.getByRole("button", { name: "刷新看板" }).focus();
  await expect(board.getByRole("button", { name: "刷新看板" })).toBeFocused();
  await board.getByRole("button", { name: "打开连接菜单" }).focus();
  await expect(board.getByRole("button", { name: "打开连接菜单" })).toBeFocused();
  await board.getByRole("button", { name: "筛选项目：ABF 产品研发" }).focus();
  await expect(board.getByRole("button", { name: "筛选项目：ABF 产品研发" })).toBeFocused();
  const workItemButton = board.getByRole("button", {
    name: "打开工作项：统一检索结果的排序与筛选体验",
  });
  await workItemButton.focus();
  await expect(workItemButton).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(board.getByRole("dialog")).toBeVisible();
  const popupPromise = page.context().waitForEvent("page");
  await board.getByRole("link", { name: /在飞书项目中打开/ }).click();
  const popup = await popupPromise;
  expect(popup.url()).toMatch(/^https:\/\/project\.feishu\.cn\/demo\/work_item\/1/);
  await popup.close();
});

test("desktop Feishu cards open outside the read-only board", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/src/ui/demo-harness.html?scenario=connected");
  const board = boardFrame(page);

  await board.getByRole("button", {
    name: "打开工作项：统一检索结果的排序与筛选体验",
  }).click();
  await expect(board.getByRole("dialog")).toBeVisible();
  const popupPromise = page.context().waitForEvent("page");
  await board.getByRole("link", { name: /在飞书项目中打开/ }).click();
  const popup = await popupPromise;
  expect(popup.url()).toContain("project.feishu.cn/demo/work_item/1");
  await expect(board.getByRole("dialog")).toBeVisible();
  await popup.close();
});

test("execution drawer shows GitLab progress and local writeback fallback", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/src/ui/demo-harness.html?scenario=connected");
  const board = boardFrame(page);

  await board.getByRole("button", {
    name: "打开工作项：统一检索结果的排序与筛选体验",
  }).click();
  await board.getByRole("button", { name: "交给 Codex 处理" }).click();

  const dialog = board.getByRole("dialog");
  await expect(dialog.getByText("研发实现")).toBeVisible();
  await expect(dialog.getByText("尚未写回，结果已保存在本地")).toBeVisible();
  await expect(dialog.getByText("codex/feishu-work-item-123")).toBeVisible();
  await expect(dialog.getByRole("link", { name: /查看 MR/ })).toHaveAttribute(
    "href",
    "https://gitlab-aiabu.ruijie.com.cn/cc/flowrivet/-/merge_requests/9",
  );
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("repository dialog selects native directories without submitting", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/src/ui/demo-harness.html?scenario=repository&directory=selected");
  const board = boardFrame(page);

  await board.getByRole("button", {
    name: "打开工作项：统一检索结果的排序与筛选体验",
  }).click();
  await board.getByRole("button", { name: "交给 Codex 处理" }).click();
  await board.getByRole("button", { name: "关联研发仓库" }).click();
  const dialog = board.getByRole("dialog", { name: "选择研发仓库" });
  await dialog.getByRole("option", { name: /team\/flowrivet/ }).click();
  await dialog.getByRole("button", { name: "选择本地仓库文件夹" }).click();
  await expect(dialog.getByLabel("本地仓库绝对路径")).toHaveValue("C:\\workspace\\example");
  await expect(dialog.getByRole("button", { name: "确认关联" })).toBeEnabled();
  await dialog.getByRole("button", { name: "克隆到父目录" }).click();
  await dialog.getByRole("button", { name: "选择克隆父文件夹" }).click();
  await expect(dialog.getByLabel("父目录绝对路径")).toHaveValue("C:\\workspace\\example");
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("repository directory cancellation preserves a manual path on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/src/ui/demo-harness.html?scenario=repository&directory=cancelled");
  const board = boardFrame(page);

  await board.getByRole("button", {
    name: "打开工作项：统一检索结果的排序与筛选体验",
  }).click();
  await board.getByRole("button", { name: "交给 Codex 处理" }).click();
  await board.getByRole("button", { name: "关联研发仓库" }).click();
  const dialog = board.getByRole("dialog", { name: "选择研发仓库" });
  const input = dialog.getByLabel("本地仓库绝对路径");
  await input.fill("C:\\manual\\repository");
  await dialog.getByRole("button", { name: "选择本地仓库文件夹" }).click();
  await expect(input).toHaveValue("C:\\manual\\repository");
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("opens all accessible projects without a selection step", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=connected");
  const board = boardFrame(page);

  await expect(board.getByRole("heading", { name: "我的待办" })).toBeVisible();
  await expect(board.getByRole("button", { name: "筛选项目：ABF 产品研发" })).toBeVisible();
  await expect(board.getByRole("button", { name: "筛选项目：学科工具" })).toBeVisible();
  await expect(board.getByRole("heading", { name: "选择项目" })).toHaveCount(0);
  await expect(board.getByRole("button", { name: "管理项目" })).toHaveCount(0);
  await expect(board.getByText(/Demo/)).toHaveCount(0);
});

test("refreshes the real read-only snapshot", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=connected");
  const board = boardFrame(page);

  await board.getByRole("button", { name: "刷新看板" }).click();
  await expect(board.getByText("已同步 7 个工作项")).toBeVisible();
  await expect(board.locator(".work-card")).toHaveCount(7);
});

test("partial sync preserves available work items and reports the failed project", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=partial");
  const board = boardFrame(page);

  await expect(board.getByText("1 个项目同步失败，已保留其他结果")).toBeVisible();
  await expect(board.locator(".work-card")).toHaveCount(7);
});

test("full sync failure is not presented as an empty success", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=error");
  const board = boardFrame(page);

  await expect(board.getByText("工作项同步失败，请重试")).toBeVisible();
  await expect(board.locator(".work-card")).toHaveCount(0);
  await expect(board.getByText(/已同步 0 个工作项/)).toHaveCount(0);
});

test("mobile viewport keeps controls visible without outer overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/src/ui/demo-harness.html?scenario=connected");
  const board = boardFrame(page);

  await expect(board.getByRole("heading", { name: "我的待办" })).toBeVisible();
  await expect(board.getByRole("button", { name: "刷新看板" })).toBeVisible();
  await expect(board.getByRole("button", { name: "打开连接菜单" })).toBeVisible();
  expect(await board.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  const boardMetrics = await board.locator(".task-board").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(boardMetrics.scrollWidth).toBeGreaterThan(boardMetrics.clientWidth);
});

test("mixed snapshot identifies cached scopes and cards", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=mixed");
  const board = boardFrame(page);

  await expect(board.getByRole("status")).toContainText("2 个范围使用缓存");
  await expect(board.locator(".cache-badge")).toHaveCount(2);
  await expect(board.getByRole("button", { name: /打开缓存工作项/ })).toHaveCount(2);
  expect(await board.locator("html").evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);
});

test("offline snapshot stays browsable while Feishu reconnects", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/src/ui/demo-harness.html?scenario=offline");
  const board = boardFrame(page);
  const reconnect = board.getByRole("button", { name: "重新连接飞书项目" });

  await expect(board.getByRole("region", { name: "工作项看板" })).toBeVisible();
  await expect(board.getByRole("status")).toContainText("正在显示离线缓存");
  await expect(board.locator(".cache-badge")).toHaveCount(7);
  await reconnect.click();
  await expect(board.getByRole("dialog", { name: "重新连接飞书项目" })).toBeVisible();
  await expect(board.getByText("DEMO-CODE")).toHaveCount(0);
  await expect(board.locator(".work-card")).toHaveCount(7);
  await board.getByRole("button", { name: "关闭飞书授权" }).click();
  await expect(board.getByRole("dialog", { name: "重新连接飞书项目" })).toHaveCount(0);
  await expect(reconnect).toBeFocused();
  await expect(board.getByText("飞书项目 授权中")).toBeVisible();
});

test("offline status and reconnect dialog do not overflow mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/src/ui/demo-harness.html?scenario=offline");
  const board = boardFrame(page);

  await expect(board.getByRole("button", { name: "重新连接飞书项目" })).toBeVisible();
  expect(await board.locator("html").evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);
  await board.getByRole("button", { name: "重新连接飞书项目" }).click();
  const dialog = board.getByRole("dialog", { name: "重新连接飞书项目" });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("cached Feishu cards still open their validated provider URL", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=offline-detail-error");
  const board = boardFrame(page);

  await board.getByRole("button", {
    name: "打开缓存工作项：统一检索结果的排序与筛选体验",
  }).click();
  await expect(board.getByRole("dialog")).toBeVisible();
  const popupPromise = page.context().waitForEvent("page");
  await board.getByRole("link", { name: /在飞书项目中打开/ }).click();
  const popup = await popupPromise;
  expect(popup.url()).toContain("project.feishu.cn/demo/work_item/1");
  await popup.close();
});

test("auto-refresh presets persist for the open Harness page", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=connected");
  const board = boardFrame(page);

  await board.getByRole("button", { name: "打开连接菜单" }).click();
  await expect(board.getByRole("menuitemradio", { name: "每 60 秒" }))
    .toHaveAttribute("aria-checked", "true");
  await board.getByRole("menuitemradio", { name: "不自动刷新" }).click();
  await expect(board.getByRole("menuitemradio", { name: "不自动刷新" }))
    .toHaveAttribute("aria-checked", "true");
  await board.getByRole("button", { name: "打开连接菜单" }).click();
  await board.getByRole("button", { name: "打开连接菜单" }).click();
  await expect(board.getByRole("menuitemradio", { name: "不自动刷新" }))
    .toHaveAttribute("aria-checked", "true");
});

test("five-second automatic refresh fires exactly once", async ({ page }) => {
  await page.clock.install();
  await page.goto("/src/ui/demo-harness.html?scenario=connected");
  const board = boardFrame(page);

  await board.getByRole("button", { name: "打开连接菜单" }).click();
  await board.getByRole("menuitemradio", { name: "每 5 秒" }).click();
  await expect(page.getByLabel("刷新调用次数")).toHaveText("0");
  await page.clock.fastForward(4_000);
  await expect(page.getByLabel("刷新调用次数")).toHaveText("0");
  await page.clock.fastForward(1_000);
  await expect(page.getByLabel("刷新调用次数")).toHaveText("1");
});

test("custom refresh dialog validates input and restores keyboard focus", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=connected");
  const board = boardFrame(page);

  await board.getByRole("button", { name: "打开连接菜单" }).click();
  const opener = board.getByRole("button", { name: "自定义刷新频率" });
  await opener.click();
  const dialog = board.getByRole("dialog", { name: "自定义刷新频率" });
  const input = board.getByLabel("刷新间隔（秒）");
  await expect(input).toBeFocused();
  await input.fill("4");
  await expect(dialog.getByRole("button", { name: "保存刷新频率" })).toBeDisabled();
  await input.fill("137");
  await dialog.getByRole("button", { name: "保存刷新频率" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(opener).toContainText("自定义：每 137 秒");
});

test("mobile refresh settings and custom dialog avoid outer overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/src/ui/demo-harness.html?scenario=connected");
  const board = boardFrame(page);

  await board.getByRole("button", { name: "打开连接菜单" }).click();
  await expect(board.getByRole("menuitemradio", { name: "每 60 秒" })).toBeVisible();
  expect(await board.locator("html").evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);
  await board.getByRole("button", { name: "自定义刷新频率" }).click();
  const dialog = board.getByRole("dialog", { name: "自定义刷新频率" });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);
  const screenshot = await page.screenshot();
  expect(screenshot.byteLength).toBeGreaterThan(10_000);
  expect(new Set(screenshot).size).toBeGreaterThan(32);
});
