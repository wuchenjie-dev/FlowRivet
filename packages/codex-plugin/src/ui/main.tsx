import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  taskboardSnapshotSchema,
  type TaskboardSnapshot,
} from "../contracts/taskboard.js";
import { App } from "./App.js";
import { createMcpAppsBridge } from "./bridge.js";
import "./styles.css";

const bridge = createMcpAppsBridge();

function TaskboardRoot() {
  const [snapshot, setSnapshot] = useState<TaskboardSnapshot>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const unsubscribe = bridge.onToolResult((result) => {
      const parsed = taskboardSnapshotSchema.safeParse(result.structuredContent);
      if (parsed.success) {
        setSnapshot(parsed.data);
        setError(undefined);
      } else {
        setError("看板数据格式无效，请重新打开 FlowRivet 看板。");
      }
    });

    void bridge
      .initialize({ name: "flowrivet-taskboard", version: "0.1.0" })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "无法连接 Codex 宿主。");
      });

    return () => {
      unsubscribe();
      void bridge.dispose();
    };
  }, []);

  if (error) {
    return <main className="boot-state boot-state--error">{error}</main>;
  }
  if (!snapshot) {
    return <main className="boot-state">正在载入 FlowRivet 看板...</main>;
  }
  return <App initialSnapshot={snapshot} bridge={bridge} />;
}

const root = document.getElementById("root");
if (!root) throw new Error("FlowRivet UI root is missing");

createRoot(root).render(<TaskboardRoot />);
