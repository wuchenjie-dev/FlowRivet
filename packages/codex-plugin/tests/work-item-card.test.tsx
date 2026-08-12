// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkItem } from "../src/contracts/taskboard.js";
import { WorkItemCard } from "../src/ui/components/WorkItemCard.js";

afterEach(cleanup);

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    key: "feishu-project:PROJ:task:1",
    providerId: "feishu-project",
    externalId: "1",
    projectExternalId: "PROJ",
    projectName: "FlowRivet",
    kind: "task",
    providerItemType: "task",
    title: "Completed task",
    stage: "done",
    providerStatus: "done",
    freshness: "fresh",
    ...overrides,
  };
}

describe("work item card time", () => {
  it("shows the completion date and time for completed work", () => {
    render(<WorkItemCard
      item={item({ completedAt: "2026-08-10T09:14:00.000Z" })}
      onOpen={vi.fn()}
    />);

    const time = screen.getByText(/完成/);
    expect(time.tagName).toBe("TIME");
    expect(time.getAttribute("datetime")).toBe("2026-08-10T09:14:00.000Z");
    expect(time.textContent).toMatch(/完成.*8.*10.*17.*14/u);
  });
});
