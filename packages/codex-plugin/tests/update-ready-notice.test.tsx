// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UpdateReadyNotice } from "../src/ui/components/UpdateReadyNotice.js";

afterEach(cleanup);

describe("UpdateReadyNotice", () => {
  it("copies the verified reopen command and can be dismissed", async () => {
    const copy = vi.fn(async () => undefined);
    const dismiss = vi.fn();
    render(<UpdateReadyNotice onCopy={copy} onDismiss={dismiss} />);
    expect(screen.getByText("新版已就绪")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "复制重新打开指令" }));
    expect(copy).toHaveBeenCalledWith("重新打开 FlowRivet 看板");
    await userEvent.click(screen.getByRole("button", { name: "稍后" }));
    expect(dismiss).toHaveBeenCalled();
  });
});
