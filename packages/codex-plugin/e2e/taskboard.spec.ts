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

test("disconnected scenario shows login entry without empty columns", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=disconnected");
  const board = boardFrame(page);

  await expect(board.getByRole("button", { name: "登录 TAPD" })).toBeVisible();
  await expect(board.locator(".task-column")).toHaveCount(0);
});

test("expired scenario shows stale data and disables dragging", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=expired");
  const board = boardFrame(page);

  await expect(board.locator(".stale-banner")).toContainText("TAPD 登录已失效");
  await expect(board.locator(".work-card").first()).toHaveAttribute("aria-disabled", "true");
});

test("dragging a card updates counts and exposes demo notice", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/src/ui/demo-harness.html?scenario=connected");
  const board = boardFrame(page);
  const todo = board.getByRole("region", { name: "待处理列" });
  const progress = board.getByRole("region", { name: "进行中列" });

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
  await expect(todo.locator(".column-header span")).toHaveText("1");
  await expect(progress.locator(".column-header span")).toHaveText("3");
  await expect(board.getByText("Demo：看板位置已更新，未写入 TAPD")).toBeVisible();
});

test("keyboard reaches filters, refresh, connection menu, and cards", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=connected");
  const board = boardFrame(page);

  await board.getByRole("button", { name: "刷新看板" }).focus();
  await expect(board.getByRole("button", { name: "刷新看板" })).toBeFocused();
  await board.getByRole("button", { name: "打开连接菜单" }).focus();
  await expect(board.getByRole("button", { name: "打开连接菜单" })).toBeFocused();
  await board.getByRole("button", { name: "筛选项目：ABF 产品研发" }).focus();
  await expect(board.getByRole("button", { name: "筛选项目：ABF 产品研发" })).toBeFocused();
  await board.locator(".work-card").first().focus();
  await expect(board.locator(".work-card").first()).toBeFocused();
});
