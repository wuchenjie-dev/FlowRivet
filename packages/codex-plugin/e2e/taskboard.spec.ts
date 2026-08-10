import { expect, test, type Page } from "@playwright/test";

function boardFrame(page: Page) {
  return page.frameLocator('iframe[title="FlowRivet MCP App"]');
}

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

test("disconnected scenario shows token login without empty columns", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=disconnected");
  const board = boardFrame(page);

  await expect(board.getByLabel("TAPD Token")).toHaveAttribute("type", "password");
  await expect(board.getByRole("button", { name: "连接 TAPD" })).toBeVisible();
  await expect(board.locator(".task-column")).toHaveCount(0);
});

test("expired scenario requires login again and hides stale data", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=expired");
  const board = boardFrame(page);

  await expect(board.getByRole("button", { name: "重新连接 TAPD" })).toBeVisible();
  await expect(board.locator(".work-card")).toHaveCount(0);
});

test("token login opens the board and clears the secret input", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=disconnected");
  const board = boardFrame(page);
  const token = board.getByLabel("TAPD Token");

  await token.fill("e2e-placeholder-token");
  await board.getByRole("button", { name: "连接 TAPD" }).click();

  await expect(board.getByRole("heading", { name: "我的待办" })).toBeVisible();
  await expect(token).toHaveCount(0);
  await expect(board.locator(".task-column")).toHaveCount(4);
});

test("disconnect removes board data and returns to login", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=connected");
  const board = boardFrame(page);

  await board.getByRole("button", { name: "打开连接菜单" }).click();
  await board.getByRole("button", { name: "断开 TAPD" }).click();

  await expect(board.getByRole("button", { name: "连接 TAPD" })).toBeVisible();
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
  const cardBox = await board.getByText("统一检索结果的排序与筛选体验").boundingBox();
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

test("keyboard reaches controls and opens a work item detail", async ({ page }) => {
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
  await expect(board.getByRole("dialog", { name: "统一检索结果的排序与筛选体验" })).toBeVisible();
  await expect(board.getByRole("button", { name: "关闭详情" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => board.getByRole("dialog").evaluate(
    (dialog) => dialog.contains(dialog.ownerDocument.activeElement),
  )).toBe(true);
  await page.keyboard.press("Tab");
  await expect(board.getByRole("button", { name: "关闭详情" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(board.getByRole("dialog")).toHaveCount(0);
  await expect(workItemButton).toBeFocused();
});

test("desktop detail drawer renders live fields with bounded overlay geometry", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/src/ui/demo-harness.html?scenario=connected");
  const board = boardFrame(page);

  await board.getByRole("button", {
    name: "打开工作项：统一检索结果的排序与筛选体验",
  }).click();
  const dialog = board.getByRole("dialog", { name: "统一检索结果的排序与筛选体验" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("产品经理")).toBeVisible();
  await expect(dialog.getByText("稳定排序")).toBeVisible();
  const externalLink = dialog.getByRole("link", { name: "在 TAPD 中打开" });
  await expect(externalLink).toHaveAttribute("target", "_blank");
  await expect(externalLink).toHaveAttribute("rel", "noreferrer");
  await expect(dialog.locator("script, iframe, img, form")).toHaveCount(0);

  const panelBox = await dialog.locator(".detail-panel").boundingBox();
  expect(panelBox?.width).toBe(520);
  expect(panelBox?.height).toBe(900);
  expect(panelBox?.x).toBe(920);

  await page.mouse.click(120, 450);
  await expect(dialog).toHaveCount(0);
});

test("mobile detail layer fills the viewport without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/src/ui/demo-harness.html?scenario=connected");
  const board = boardFrame(page);

  await board.getByRole("button", {
    name: "打开工作项：统一检索结果的排序与筛选体验",
  }).click();
  const dialog = board.getByRole("dialog", { name: "统一检索结果的排序与筛选体验" });
  await expect(dialog).toBeVisible();
  const panelBox = await dialog.locator(".detail-panel").boundingBox();
  expect(panelBox?.width).toBe(390);
  expect(panelBox?.height).toBe(844);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(dialog.getByRole("button", { name: "关闭详情" })).toBeVisible();
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

test("offline snapshot stays browsable and reconnect restores focus", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/src/ui/demo-harness.html?scenario=offline");
  const board = boardFrame(page);
  const reconnect = board.getByRole("button", { name: "重新连接 TAPD" });

  await expect(board.getByRole("region", { name: "工作项看板" })).toBeVisible();
  await expect(board.getByRole("status")).toContainText("正在显示离线缓存");
  await expect(board.locator(".cache-badge")).toHaveCount(7);
  await reconnect.click();
  await expect(board.getByRole("dialog", { name: "重新连接 TAPD" })).toBeVisible();
  await expect(board.getByLabel("TAPD Token")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(board.getByRole("dialog", { name: "重新连接 TAPD" })).toHaveCount(0);
  await expect(reconnect).toBeFocused();
  await expect(board.locator(".work-card")).toHaveCount(7);
});

test("offline status and reconnect dialog do not overflow mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/src/ui/demo-harness.html?scenario=offline");
  const board = boardFrame(page);

  await expect(board.getByRole("button", { name: "重新连接 TAPD" })).toBeVisible();
  expect(await board.locator("html").evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);
  await board.getByRole("button", { name: "重新连接 TAPD" }).click();
  const dialog = board.getByRole("dialog", { name: "重新连接 TAPD" });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("cached card detail failure asks the user to reconnect", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=offline-detail-error");
  const board = boardFrame(page);

  await board.getByRole("button", {
    name: "打开缓存工作项：统一检索结果的排序与筛选体验",
  }).click();
  await expect(board.getByText("重新连接后加载详情")).toBeVisible();
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
