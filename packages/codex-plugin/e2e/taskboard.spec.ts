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

test("discovers projects, saves one selection and enters the board", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=projects-unselected");
  const board = boardFrame(page);

  await expect(board.getByRole("heading", { name: "选择项目" })).toBeVisible();
  await board.getByRole("button", { name: "重新发现项目" }).click();
  await expect(board.getByRole("checkbox", { name: "选择项目：ABF 产品研发" })).toBeVisible();
  await board.getByRole("checkbox", { name: "选择项目：ABF 产品研发" }).check();
  await board.getByRole("button", { name: "使用 1 个项目" }).click();

  await expect(board.getByRole("heading", { name: "我的待办" })).toBeVisible();
  await expect(board.getByRole("button", { name: "筛选项目：ABF 产品研发" })).toBeVisible();
  await expect(board.getByRole("button", { name: "筛选项目：学科工具" })).toHaveCount(0);
});

test("reopens with the saved project already in the sidebar", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=projects-selected");
  const board = boardFrame(page);

  await expect(board.getByRole("heading", { name: "我的待办" })).toBeVisible();
  await expect(board.getByRole("button", { name: "筛选项目：ABF 产品研发" })).toBeVisible();
  await board.getByRole("button", { name: "管理项目" }).click();
  await expect(board.getByRole("checkbox", { name: "选择项目：ABF 产品研发" })).toBeChecked();
});

test("preserves projects and reports stale discovery", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=projects-stale");
  const board = boardFrame(page);

  await expect(board.getByRole("heading", { name: "选择项目" })).toBeVisible();
  await expect(board.getByText(/当前显示上次保存的项目/)).toBeVisible();
  await expect(board.getByText("ABF 产品研发")).toBeVisible();
  await board.getByRole("button", { name: "重新发现项目" }).click();
  await expect(board.getByText(/当前显示上次保存的项目/)).toBeVisible();
});

test("adds a project URL manually", async ({ page }) => {
  await page.goto("/src/ui/demo-harness.html?scenario=projects-unselected");
  const board = boardFrame(page);

  await board.getByLabel("项目 ID 或 URL").fill("https://www.tapd.cn/9001");
  await board.getByRole("button", { name: "添加项目" }).click();
  await expect(board.getByText("手工验证项目")).toBeVisible();
  await expect(board.getByText("手工添加")).toBeVisible();
});

test("project selector stays within a 900 by 700 viewport", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto("/src/ui/demo-harness.html?scenario=projects-unselected");
  const board = boardFrame(page);
  await expect(board.getByRole("heading", { name: "选择项目" })).toBeVisible();

  const selector = await board.locator(".project-selector").boundingBox();
  const toolbar = await board.locator(".selector-toolbar").boundingBox();
  const manual = await board.locator(".manual-project").boundingBox();
  const actions = await board.locator(".selector-actions").boundingBox();
  expect(selector && selector.y + selector.height <= 700).toBe(true);
  expect(toolbar && manual && toolbar.y + toolbar.height <= manual.y).toBe(true);
  expect(manual && actions && manual.y + manual.height <= actions.y + 1).toBe(true);
});
