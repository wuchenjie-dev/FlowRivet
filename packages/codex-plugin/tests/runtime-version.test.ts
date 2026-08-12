import { describe, expect, it } from "vitest";

import {
  FLOWRIVET_PROTOCOL_VERSION,
  runtimeVersionSchema,
} from "../src/contracts/runtime-version.js";

describe("runtime version contract", () => {
  it("accepts one semantic runtime and UI version", () => {
    expect(runtimeVersionSchema.parse({
      version: "0.2.1",
      protocolVersion: 1,
      uiVersion: "0.2.1",
    })).toEqual({
      version: "0.2.1",
      protocolVersion: FLOWRIVET_PROTOCOL_VERSION,
      uiVersion: "0.2.1",
    });
  });

  it.each([
    { version: "next", protocolVersion: 1, uiVersion: "0.2.1" },
    { version: "0.2.1", protocolVersion: 0, uiVersion: "0.2.1" },
    { version: "0.2.1", protocolVersion: 1.5, uiVersion: "0.2.1" },
    { version: "0.2.1", protocolVersion: 1, uiVersion: "latest" },
  ])("rejects malformed runtime metadata %#", (value) => {
    expect(runtimeVersionSchema.safeParse(value).success).toBe(false);
  });
});
