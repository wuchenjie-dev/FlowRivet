import { describe, expect, it } from "vitest";

import {
  canonicalStages,
  taskboardSnapshotSchema,
} from "../src/contracts/taskboard.js";
import { demoTaskboardSnapshot } from "../src/demo/fixtures.js";

describe("taskboard demo contract", () => {
  it("provides a valid connected board snapshot", () => {
    expect(taskboardSnapshotSchema.parse(demoTaskboardSnapshot)).toMatchObject({
      connection: { tapd: "connected", gitlab: "not_configured" },
      stages: ["todo", "in_progress", "in_review", "done"],
    });
  });

  it("covers every work item kind across multiple projects", () => {
    expect(new Set(demoTaskboardSnapshot.items.map((item) => item.kind))).toEqual(
      new Set(["story", "task", "bug"]),
    );
    expect(demoTaskboardSnapshot.projects.length).toBeGreaterThan(1);
  });

  it("covers every canonical stage", () => {
    expect(new Set(demoTaskboardSnapshot.items.map((item) => item.stage))).toEqual(
      new Set(canonicalStages),
    );
  });
});
