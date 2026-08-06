import { useState } from "react";
import { LogIn, ShieldAlert } from "lucide-react";

import type { CanonicalStage, TaskboardSnapshot } from "../contracts/taskboard.js";
import type { McpAppsBridge } from "./bridge.js";
import { AppHeader } from "./components/AppHeader.js";
import { ConnectionMenu } from "./components/ConnectionMenu.js";
import { ProjectSidebar, type BoardFilter } from "./components/ProjectSidebar.js";
import { TaskBoard } from "./components/TaskBoard.js";

interface AppProps {
  initialSnapshot: TaskboardSnapshot;
  bridge: McpAppsBridge;
}

export function App({ initialSnapshot, bridge }: AppProps) {
  const [items, setItems] = useState(initialSnapshot.items);
  const [selectedFilter, setSelectedFilter] = useState<BoardFilter>("all");
  const [menuOpen, setMenuOpen] = useState(false);
  const [pingState, setPingState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [notice, setNotice] = useState<string>();
  const tapdState = initialSnapshot.connection.tapd;
  const canDrag = tapdState === "connected";

  const filteredItems = items.filter((item) => {
    if (selectedFilter === "all") return true;
    if (selectedFilter === "due_soon") {
      if (!item.dueAt) return false;
      const remaining = new Date(item.dueAt).getTime() - Date.now();
      return remaining >= 0 && remaining <= 7 * 24 * 60 * 60 * 1000;
    }
    if (selectedFilter === "overdue") {
      return Boolean(item.dueAt && new Date(item.dueAt).getTime() < Date.now());
    }
    return item.workspaceId === selectedFilter;
  });

  function moveItem(key: string, stage: CanonicalStage) {
    setItems((current) => current.map((item) => item.key === key ? { ...item, stage } : item));
    setNotice("Demo：看板位置已更新，未写入 TAPD");
  }

  async function pingCompanion() {
    setPingState("pending");
    try {
      await bridge.callTool("demo_ping", { message: "taskboard-ui" });
      setPingState("success");
    } catch {
      setPingState("error");
    }
  }

  function refreshDemo() {
    setItems(initialSnapshot.items);
    setNotice("Demo 数据已恢复");
  }

  const isDisconnected = tapdState === "disconnected" || tapdState === "connecting";

  return (
    <div className="app-shell">
      <AppHeader
        connection={initialSnapshot.connection}
        lastSyncedAt={initialSnapshot.lastSyncedAt}
        menuOpen={menuOpen}
        onRefresh={refreshDemo}
        onToggleMenu={() => setMenuOpen((open) => !open)}
      />
      {menuOpen ? (
        <ConnectionMenu
          connection={initialSnapshot.connection}
          pingState={pingState}
          onPing={pingCompanion}
        />
      ) : null}

      {isDisconnected ? (
        <main className="connection-empty">
          <span className="empty-icon"><LogIn size={22} /></span>
          <h1>连接 TAPD 后查看我的待办</h1>
          <p>登录后将自动发现你有权访问的项目；当前 Demo 不会发起真实授权。</p>
          <button type="button" aria-label="登录 TAPD">登录 TAPD</button>
          <small>Phase 0 演示入口</small>
        </main>
      ) : (
        <div className="workspace-layout">
          <ProjectSidebar projects={initialSnapshot.projects} selected={selectedFilter} onSelect={setSelectedFilter} />
          <main className="board-main">
            {tapdState === "expired" ? (
              <div className="stale-banner" role="status"><ShieldAlert size={16} />TAPD 登录已失效，正在展示缓存，数据可能已过期；重新登录前不可拖动。</div>
            ) : null}
            <div className="board-heading">
              <div><h1>我的待办</h1><p>{filteredItems.length} 个工作项 · {initialSnapshot.projects.length} 个项目</p></div>
              <span className="demo-chip">Demo 数据</span>
            </div>
            <TaskBoard stages={initialSnapshot.stages} items={filteredItems} disabled={!canDrag} onMove={moveItem} />
          </main>
        </div>
      )}
      {notice ? <div className="toast" role="status">{notice}</div> : null}
    </div>
  );
}
