import { describe, expect, it, vi } from "vitest";

import {
  aggregateFieldCapability,
  parseProbeArgs,
  probeMeegleWriteContract,
  redactProbeOutput,
  validateFieldFixturesAgainstMetadata,
} from "../../../scripts/probe-meegle-write-contract.mjs";
import {
  disabledWriteCapabilities,
  loadWriteCapabilityManifest,
  writeCapabilityManifestSchema,
} from "../src/writeback/write-capability-manifest.js";

describe("Meegle isolated write probe", () => {
  it.each([
    [[]],
    [["--project-key", "test-project", "--work-item-id", "wi-1"]],
    [["--project-key", "test-project", "--confirm-isolated-fixture", "FLOWRIVET_WRITE_PROBE"]],
    [["--work-item-id", "wi-1", "--confirm-isolated-fixture", "FLOWRIVET_WRITE_PROBE"]],
  ])("rejects an incomplete isolated fixture: %j", (args) => {
    expect(() => parseProbeArgs(args)).toThrow("isolated_fixture_required");
  });

  it("accepts explicit field fixtures without interpreting their values", () => {
    expect(parseProbeArgs([
      "--project-key", "test-project",
      "--work-item-id", "wi-1",
      "--confirm-isolated-fixture", "FLOWRIVET_WRITE_PROBE",
      "--field-fixture", "text:result_field:probe:value",
      "--output", "probe.json",
      "--manifest-output", "candidate.json",
    ])).toMatchObject({
      projectKey: "test-project",
      workItemId: "wi-1",
      fieldFixtures: [{ type: "text", fieldKey: "result_field", testValue: "probe:value" }],
    });
  });

  it.each(["state", "role", "assignee", "schedule", "title", "description", "body"])(
    "rejects a high-impact field fixture: %s",
    (fieldKey) => {
      expect(() => parseProbeArgs([
        "--project-key", "test-project",
        "--work-item-id", "wi-1",
        "--confirm-isolated-fixture", "FLOWRIVET_WRITE_PROBE",
        "--field-fixture", `text:${fieldKey}:unsafe`,
      ])).toThrow("field_fixture_forbidden");
    },
  );

  it.each(["mystery", "user", "multi-user"])(
    "rejects unsupported field type before any remote command: %s",
    (type) => {
      expect(() => parseProbeArgs([
        "--project-key", "test-project",
        "--work-item-id", "wi-1",
        "--confirm-isolated-fixture", "FLOWRIVET_WRITE_PROBE",
        "--field-fixture", `${type}:uuid-field:value`,
      ])).toThrow("field_type_unsupported");
    },
  );

  it("does not send update when unsupported fixture bypasses argument parsing", async () => {
    const calls: string[][] = [];
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args);
      const command = commandName(args);
      if (command === "--version") return commandResult({ version: "1.0.19" });
      if (command === "auth status") return commandResult({ authenticated: true });
      if (command === "user me") return commandResult({ user_key: "user-example" });
      if (command === "workitem get") return commandResult({
        work_item_attribute: { work_item_name: "[TEST] probe", work_item_type: { key: "story" } },
      });
      if (command === "workitem meta-fields") {
        return commandResult({ pagination: { has_more: false }, list: [{ key: "uuid-field", name: "Mystery", type: "mystery" }] });
      }
      if (command === "comment list") return commandResult({ pagination: { has_more: false }, list: [] });
      return commandResult({});
    });

    const result = await probeMeegleWriteContract({
      ...baseOptions(), fieldFixtures: [{ type: "mystery", fieldKey: "uuid-field", testValue: "value" }],
    }, { resolveCommand: vi.fn().mockResolvedValue("C:\\tools\\meegle.exe"), runCommand });

    expect(result).toMatchObject({ ok: false, errorCode: "field_type_unsupported" });
    expect(calls.some((args) => commandName(args) === "workitem update")).toBe(false);
  });

  it("redacts content, tokens, email addresses, ids, and field values", () => {
    const redacted = JSON.stringify(redactProbeOutput({
      body: "secret result",
      token: "token-secret",
      ownerEmail: "person@example.com",
      fieldValue: "private field value",
      workItemId: "business-id-123",
      pagination: { page: 1, hasMore: false },
      error: { code: "permission_denied", message: "secret result" },
    }));

    expect(redacted).not.toMatch(/secret result|token-secret|person@example\.com|private field value|business-id-123/i);
    expect(redacted).toContain("permission_denied");
    expect(redacted).toContain("hasMore");
  });

  it("refuses a target whose title is not visibly marked as a test fixture", async () => {
    const runCommand = vi.fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ version: "1.0.19" }), stderr: "" })
      .mockResolvedValueOnce(commandResult({ authenticated: true }))
      .mockResolvedValueOnce(commandResult({ user_key: "user-example" }))
      .mockResolvedValueOnce(commandResult({
        work_item_attribute: {
          work_item_name: "Production delivery",
          work_item_type: { key: "story" },
        },
      }));

    await expect(probeMeegleWriteContract(parseProbeArgs([
      "--project-key", "test-project",
      "--work-item-id", "wi-1",
      "--confirm-isolated-fixture", "FLOWRIVET_WRITE_PROBE",
    ]), {
      resolveCommand: vi.fn().mockResolvedValue("C:\\tools\\meegle.exe"),
      runCommand,
    })).resolves.toMatchObject({ ok: false, errorCode: "test_marker_required" });
    expect(runCommand).toHaveBeenCalledTimes(4);
  });

  it("requires manual cleanup and fails when a field restore fails", async () => {
    let getCount = 0;
    let updateCount = 0;
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      const command = commandName(args);
      if (command === "--version") return commandResult({ version: "1.0.19" });
      if (command === "auth status") return commandResult({ authenticated: true });
      if (command === "user me") return commandResult({ user_key: "user-example" });
      if (command === "workitem get") {
        getCount += 1;
        return commandResult({
          work_item_attribute: { work_item_name: "[TEST] probe", work_item_type: { key: "story" } },
          work_item_fields: [{ key: "result", value: getCount >= 3 ? "after" : "before" }],
        });
      }
      if (command === "workitem meta-fields") {
        return commandResult({ pagination: { has_more: false }, list: [{ key: "result", name: "Result", type: "text" }] });
      }
      if (command === "comment list") return successfulCommentListResult();
      if (command === "workitem meta-roles") return commandResult({ pagination: { has_more: false }, list: [] });
      if (command === "comment add" && args.includes("create")) return commandResult({ comment_id: "comment-1" });
      if (command === "workitem update") {
        updateCount += 1;
        if (updateCount === 3) return { exitCode: 1, stdout: "", stderr: "private failure" };
      }
      if (command === "workflow list-state-transitions") return commandResult({ list: [] });
      return commandResult({});
    });

    const result = await probeMeegleWriteContract(parseProbeArgs([
      "--project-key", "test-project",
      "--work-item-id", "wi-1",
      "--confirm-isolated-fixture", "FLOWRIVET_WRITE_PROBE",
      "--field-fixture", "text:result:after",
    ]), {
      resolveCommand: vi.fn().mockResolvedValue("C:\\tools\\meegle.exe"),
      runCommand,
    });

    expect(result).toMatchObject({ ok: false, manual_cleanup_required: true });
    expect(result.candidateManifest.fieldTypes.text).toMatchObject({
      enabled: false,
      write: true,
      read: true,
      repeat: true,
      restore: false,
    });
    expect(JSON.stringify(result)).not.toContain("private failure");
  });

  it("queries transitions then required fields before node and role metadata", async () => {
    const calls: string[][] = [];
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args);
      const command = commandName(args);
      if (command === "--version") return commandResult({ version: "1.0.19" });
      if (command === "auth status") return commandResult({ authenticated: true });
      if (command === "user me") return commandResult({ user_key: "user-example" });
      if (command === "workitem get") return commandResult({
        work_item_attribute: { work_item_name: "[TEST] probe", work_item_type: { key: "story" } },
      });
      if (command === "comment list") return successfulCommentListResult();
      if (command === "workitem meta-fields" || command === "workitem meta-roles") {
        return commandResult({ pagination: { has_more: false }, list: [] });
      }
      if (command === "comment add" && args.includes("create")) return commandResult({ comment_id: "comment-1" });
      if (command === "workflow list-state-transitions") return commandResult({ list: [{ state_key: "done" }] });
      return commandResult({});
    });

    const result = await probeMeegleWriteContract(baseOptions(), {
      resolveCommand: vi.fn().mockResolvedValue("C:\\tools\\meegle.exe"),
      runCommand,
    });
    expect(result.ok).toBe(true);
    expect(calls.map(commandName)).toEqual(expect.arrayContaining([
      "workflow list-state-transitions",
      "workflow list-state-required",
      "workflow meta-node-fields",
      "workitem meta-roles",
    ]));
    const tail = calls.map(commandName).slice(-4);
    expect(tail).toEqual([
      "workflow list-state-transitions",
      "workflow list-state-required",
      "workflow meta-node-fields",
      "workitem meta-roles",
    ]);
  });

  it.each([
    "workflow list-state-transitions",
    "workflow list-state-required",
    "workflow meta-node-fields",
    "workitem meta-roles",
  ])("does not verify a candidate when fixed-sequence query fails: %s", async (failedCommand) => {
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      const command = commandName(args);
      if (command === failedCommand) return { exitCode: 1, stdout: "", stderr: "private" };
      if (command === "--version") return commandResult({ version: "1.0.19" });
      if (command === "auth status") return commandResult({ authenticated: true });
      if (command === "user me") return commandResult({ user_key: "user-example" });
      if (command === "workitem get") return commandResult({
        work_item_attribute: { work_item_name: "[TEST] probe", work_item_type: { key: "story" } },
      });
      if (command === "comment list") return successfulCommentListResult();
      if (command === "workitem meta-fields" || command === "workitem meta-roles") {
        return commandResult({ pagination: { has_more: false }, list: [] });
      }
      if (command === "comment add" && args.includes("create")) return commandResult({ comment_id: "comment-1" });
      if (command === "workflow list-state-transitions") return commandResult({ list: [{ state_key: "done" }] });
      return commandResult({});
    });

    const result = await probeMeegleWriteContract(baseOptions(), {
      resolveCommand: vi.fn().mockResolvedValue("C:\\tools\\meegle.exe"),
      runCommand,
    });
    expect(result).toMatchObject({ ok: false, candidateManifest: { verifiedAt: null } });
  });

  it("verifies restoration with a final read-back", async () => {
    let getCount = 0;
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      const command = commandName(args);
      if (command === "--version") return commandResult({ version: "1.0.19" });
      if (command === "auth status") return commandResult({ authenticated: true });
      if (command === "user me") return commandResult({ user_key: "user-example" });
      if (command === "workitem get") {
        getCount += 1;
        return commandResult({
          work_item_attribute: { work_item_name: "[TEST] probe", work_item_type: { key: "story" } },
          work_item_fields: [{ key: "uuid-result", value: getCount === 2 ? { text: "before" } : { text: "after" } }],
        });
      }
      if (command === "workitem meta-fields") {
        return commandResult({ pagination: { has_more: false }, list: [{ key: "uuid-result", name: "Result", type: "text" }] });
      }
      if (command === "comment list") return successfulCommentListResult();
      if (command === "workitem meta-roles") return commandResult({ pagination: { has_more: false }, list: [] });
      if (command === "comment add" && args.includes("create")) return commandResult({ comment_id: "comment-1" });
      if (command === "workflow list-state-transitions") return commandResult({ list: [] });
      return commandResult({});
    });
    const result = await probeMeegleWriteContract({
      ...baseOptions(),
      fieldFixtures: [{ type: "text", fieldKey: "uuid-result", testValue: "after" }],
    }, { resolveCommand: vi.fn().mockResolvedValue("C:\\tools\\meegle.exe"), runCommand });

    expect(getCount).toBe(5);
    expect(result).toMatchObject({ ok: false, manual_cleanup_required: true });
    expect(result.candidateManifest.fieldTypes.text.restore).toBe(false);
  });

  it("rejects UUID fixtures using forbidden metadata semantics and fails closed without metadata", () => {
    const fixture = [{ type: "text", fieldKey: "uuid-custom", testValue: "x" }];
    expect(() => validateFieldFixturesAgainstMetadata(fixture, [
      { key: "uuid-custom", name: "负责人", type: "user" },
    ])).toThrow("field_fixture_forbidden");
    expect(() => validateFieldFixturesAgainstMetadata(fixture, [
      { key: "another-field", name: "Result", type: "text" },
    ])).toThrow("field_metadata_unrecognized");
  });

  it("aggregates repeated fixtures of one type fail closed", () => {
    const passed = { enabled: true, write: true, read: true, repeat: true, restore: true };
    const failed = { enabled: false, write: true, read: false, repeat: false, restore: true };
    expect(aggregateFieldCapability(passed, failed)).toEqual({
      enabled: false, write: true, read: false, repeat: false, restore: true,
    });
    expect(aggregateFieldCapability(failed, passed).enabled).toBe(false);
  });

  it("uses the verified Meegle 1.0.19 argv contract and propagates type/profile", async () => {
    const calls: string[][] = [];
    let getCount = 0;
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args);
      const command = commandName(args);
      if (command === "--version") return commandResult({ version: "1.0.19" });
      if (command === "auth status") return commandResult({ authenticated: true });
      if (command === "user me") return commandResult({ user_key: "user-example" });
      if (command === "workitem get") {
        getCount += 1;
        return commandResult({
          work_item_attribute: {
            work_item_name: "[TEST] probe",
            work_item_type: { key: "story" },
          },
          work_item_fields: [{ key: "uuid-result", value: getCount === 3 || getCount === 4 ? "after" : "before" }],
        });
      }
      if (command === "workitem meta-fields") {
        return commandResult({
          pagination: { has_more: false },
          list: [{ key: "uuid-result", name: "Result", type: "text" }],
        });
      }
      if (command === "comment list") return successfulCommentListResult();
      if (command === "comment add" && args.includes("create")) return commandResult({ comment_id: "comment-1" });
      if (command === "workflow list-state-transitions") {
        return commandResult({ list: [{ state_key: "done" }, { state_key: "closed" }] });
      }
      if (command === "workitem meta-roles") return commandResult({ pagination: { has_more: false }, list: [] });
      return commandResult({});
    });

    const result = await probeMeegleWriteContract({
      ...baseOptions(),
      profile: "isolated",
      fieldFixtures: [{ type: "text", fieldKey: "uuid-result", testValue: "after" }],
    }, { resolveCommand: vi.fn().mockResolvedValue("C:\\tools\\meegle.exe"), runCommand });

    expect(result.ok).toBe(true);
    expect(calls).toContainEqual(["--version"]);
    expect(calls).toContainEqual(["--profile", "isolated", "auth", "status", "--format", "json"]);
    expect(calls).toContainEqual(["--profile", "isolated", "user", "me", "--format", "json"]);
    expect(calls).toContainEqual([
      "--profile", "isolated", "workitem", "meta-fields",
      "--project-key", "test-project", "--work-item-type", "story", "--page-num", "1", "--format", "json",
    ]);
    expect(calls).toContainEqual([
      "--profile", "isolated", "comment", "list",
      "--project-key", "test-project", "--work-item-id", "wi-1", "--page-num", "1", "--format", "json",
    ]);
    expect(calls.some((args) => commandName(args) === "comment add"
      && args.includes("--action") && args.includes("create") && args.includes("--content"))).toBe(true);
    expect(calls.some((args) => commandName(args) === "comment add"
      && args.includes("--action") && args.includes("update")
      && args.includes("--comment-id") && args.includes("comment-1"))).toBe(true);
    expect(calls).toContainEqual([
      "--profile", "isolated", "workitem", "update",
      "--project-key", "test-project", "--work-item-id", "wi-1",
      "--fields", JSON.stringify([{ field_key: "uuid-result", field_value: "after" }]), "--format", "json",
    ]);
    expect(calls).toContainEqual([
      "--profile", "isolated", "workflow", "list-state-transitions",
      "--project-key", "test-project", "--work-item-id", "wi-1",
      "--work-item-type", "story", "--user-key", "user-example", "--format", "json",
    ]);
    for (const stateKey of ["done", "closed"]) {
      expect(calls).toContainEqual([
        "--profile", "isolated", "workflow", "list-state-required",
        "--project-key", "test-project", "--work-item-id", "wi-1",
        "--state-key", stateKey, "--format", "json",
      ]);
    }
    expect(calls).toContainEqual([
      "--profile", "isolated", "workflow", "meta-node-fields",
      "--project-key", "test-project", "--work-item-type", "story", "--format", "json",
    ]);
    expect(calls).toContainEqual([
      "--profile", "isolated", "workitem", "meta-roles",
      "--project-key", "test-project", "--work-item-type", "story", "--page-num", "1", "--format", "json",
    ]);
    expect(calls.some((args) => args.includes("field") && args.includes("update"))).toBe(false);
  });

  it("paginates page-number Meegle lists until has_more is false", async () => {
    const calls: string[][] = [];
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args);
      const command = commandName(args);
      const page = args[args.indexOf("--page-num") + 1];
      if (command === "--version") return commandResult({ version: "1.0.19" });
      if (command === "auth status") return commandResult({ authenticated: true });
      if (command === "user me") return commandResult({ user_key: "user-example" });
      if (command === "workitem get") return commandResult({
        work_item_attribute: { work_item_name: "[TEST] probe", work_item_type: { key: "story" } },
      });
      if (command === "comment list") {
        return commandResult({
          pagination: { has_more: page === "1" },
          list: page === "2" ? JSON.parse(successfulCommentListResult().stdout).list : [],
        });
      }
      if (["workitem meta-fields", "workitem meta-roles"].includes(command)) {
        return commandResult({ pagination: { has_more: page === "1" }, list: [] });
      }
      if (command === "comment add" && args.includes("create")) return commandResult({ comment_id: "comment-1" });
      if (command === "workflow list-state-transitions") return commandResult({ list: [] });
      return commandResult({});
    });

    await probeMeegleWriteContract({ ...baseOptions(), profile: "isolated" }, {
      resolveCommand: vi.fn().mockResolvedValue("C:\\tools\\meegle.exe"), runCommand,
    });

    for (const command of ["workitem meta-fields", "workitem meta-roles"]) {
      const pages = calls.filter((args) => commandName(args) === command)
        .map((args) => args[args.indexOf("--page-num") + 1]);
      expect(pages).toEqual(["1", "2"]);
    }
    const commentPages = calls.filter((args) => commandName(args) === "comment list")
      .map((args) => args[args.indexOf("--page-num") + 1]);
    expect(commentPages).toEqual(["1", "2", "1", "2", "1", "2", "1", "2"]);
  });

  it.each([
    [10_000, true],
    [10_001, false],
  ])("enforces the final-page item limit at %i items", async (itemTotal, expectedOk) => {
    const result = await runPaginationBoundaryProbe({ itemTotal });
    expect(result.ok).toBe(expectedOk);
    if (!expectedOk) expect(result.errorCode).toBe("probe_read_failed");
  });

  it("enforces the final-page byte limit without an off-by-one", async () => {
    const page = { pagination: { has_more: false }, list: [{ key: "field" }] };
    const pageBytes = Math.max(
      Buffer.byteLength(JSON.stringify(page)),
      Buffer.byteLength(successfulCommentListResult().stdout),
    );
    await expect(runPaginationBoundaryProbe({ itemTotal: 1, paginationByteLimit: pageBytes }))
      .resolves.toMatchObject({ ok: true });
    await expect(runPaginationBoundaryProbe({ itemTotal: 1, paginationByteLimit: pageBytes - 1 }))
      .resolves.toMatchObject({ ok: false, errorCode: "probe_read_failed" });
  });

  it("counts raw UTF-8 response bytes including insignificant whitespace", async () => {
    const semanticPage = { pagination: { has_more: false }, list: [{ key: "field" }] };
    const rawPage = `${JSON.stringify(semanticPage)}${" \n\t".repeat(100)}`;
    const rawBytes = Buffer.byteLength(rawPage, "utf8");
    await expect(runPaginationBoundaryProbe({
      itemTotal: 1,
      paginationByteLimit: rawBytes,
      rawMetaFields: rawPage,
    })).resolves.toMatchObject({ ok: true });
    await expect(runPaginationBoundaryProbe({
      itemTotal: 1,
      paginationByteLimit: rawBytes - 1,
      rawMetaFields: rawPage,
    })).resolves.toMatchObject({ ok: false, errorCode: "probe_read_failed" });
  });

  it("requests the fixture field on every field read", async () => {
    const calls: string[][] = [];
    let getCount = 0;
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args);
      const command = commandName(args);
      if (command === "--version") return commandResult({ version: "1.0.19" });
      if (command === "auth status") return commandResult({ authenticated: true });
      if (command === "user me") return commandResult({ user_key: "user-example" });
      if (command === "workitem get") {
        getCount += 1;
        const value = getCount === 1 || getCount === 2 || getCount === 5 ? "before" : "after";
        return commandResult({
          work_item_attribute: { work_item_name: "[TEST] probe", work_item_type: { key: "story" } },
          work_item_fields: [{ key: "uuid-result", value }],
        });
      }
      if (command === "workitem meta-fields") {
        return commandResult({ pagination: { has_more: false }, list: [{ key: "uuid-result", name: "Result", type: "text" }] });
      }
      if (command === "comment list") return successfulCommentListResult();
      if (command === "workitem meta-roles") return commandResult({ pagination: { has_more: false }, list: [] });
      if (command === "comment add" && args.includes("create")) return commandResult({ comment_id: "comment-1" });
      if (command === "workflow list-state-transitions") return commandResult({ list: [] });
      return commandResult({});
    });

    await probeMeegleWriteContract({
      ...baseOptions(),
      fieldFixtures: [{ type: "text", fieldKey: "uuid-result", testValue: "after" }],
    }, { resolveCommand: vi.fn().mockResolvedValue("C:\\tools\\meegle.exe"), runCommand });

    const fieldReads = calls.filter((args) => commandName(args) === "workitem get").slice(1);
    expect(fieldReads).toHaveLength(4);
    for (const args of fieldReads) {
      const fieldsIndex = args.indexOf("--fields");
      expect(args.slice(fieldsIndex, fieldsIndex + 2)).toEqual(["--fields", "uuid-result"]);
    }
  });

  it.each([
    ["select", "option-field", { option_id: "before" }, "after"],
    ["multi-select", "multi-field", [{ option_id: "a" }, { option_id: "b" }], "after"],
    ["link", "link-field", { url: "https://example.test", title: "Example" }, "after"],
  ])("restores %s fields without stringifying the original value", async (type, fieldKey, originalValue, testValue) => {
    const calls: string[][] = [];
    let getCount = 0;
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args);
      const command = commandName(args);
      if (command === "--version") return commandResult({ version: "1.0.19" });
      if (command === "auth status") return commandResult({ authenticated: true });
      if (command === "user me") return commandResult({ user_key: "user-example" });
      if (command === "workitem get") {
        getCount += 1;
        const value = getCount === 1 || getCount === 2 || getCount === 5 ? originalValue : testValue;
        return commandResult({
          work_item_attribute: { work_item_name: "[TEST] probe", work_item_type: { key: "story" } },
          work_item_fields: [{ key: fieldKey, value }],
        });
      }
      if (command === "workitem meta-fields") {
        return commandResult({ pagination: { has_more: false }, list: [{ key: fieldKey, name: "Safe field", type }] });
      }
      if (command === "comment list") return successfulCommentListResult();
      if (command === "workitem meta-roles") return commandResult({ pagination: { has_more: false }, list: [] });
      if (command === "comment add" && args.includes("create")) return commandResult({ comment_id: "comment-1" });
      if (command === "workflow list-state-transitions") return commandResult({ list: [] });
      return commandResult({});
    });

    await probeMeegleWriteContract({
      ...baseOptions(), fieldFixtures: [{ type, fieldKey, testValue }],
    }, { resolveCommand: vi.fn().mockResolvedValue("C:\\tools\\meegle.exe"), runCommand });

    const updates = calls.filter((args) => commandName(args) === "workitem update");
    expect(updates).toHaveLength(3);
    const restoreFields = JSON.parse(updates[2]![updates[2]!.indexOf("--fields") + 1]!);
    expect(restoreFields).toEqual([{ field_key: fieldKey, field_value: originalValue }]);
  });

  it.each([
    ["first update command fails", { firstUpdateFails: true }],
    ["first readback fails", { firstReadbackFails: true }],
    ["repeat command fails", { repeatCommandFails: true }],
    ["repeat readback fails", { repeatReadbackFails: true }],
  ])("best-effort restores after %s", async (_label, failure) => {
    const calls: string[][] = [];
    let getCount = 0;
    let updateCount = 0;
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args);
      const command = commandName(args);
      if (command === "--version") return commandResult({ version: "1.0.19" });
      if (command === "auth status") return commandResult({ authenticated: true });
      if (command === "user me") return commandResult({ user_key: "user-example" });
      if (command === "workitem get") {
        getCount += 1;
        if (getCount === 3 && failure.firstReadbackFails) return { exitCode: 1, stdout: "", stderr: "private" };
        if (getCount === 4 && failure.repeatReadbackFails) return { exitCode: 1, stdout: "", stderr: "private" };
        const value = getCount === 1 || getCount === 2 || getCount === 5 ? "before" : "after";
        return commandResult({
          work_item_attribute: { work_item_name: "[TEST] probe", work_item_type: { key: "story" } },
          work_item_fields: [{ key: "result", value }],
        });
      }
      if (command === "workitem meta-fields") {
        return commandResult({ pagination: { has_more: false }, list: [{ key: "result", name: "Result", type: "text" }] });
      }
      if (command === "comment list") return successfulCommentListResult();
      if (command === "workitem meta-roles") return commandResult({ pagination: { has_more: false }, list: [] });
      if (command === "comment add" && args.includes("create")) return commandResult({ comment_id: "comment-1" });
      if (command === "workitem update") {
        updateCount += 1;
        if (updateCount === 1 && failure.firstUpdateFails) return { exitCode: 1, stdout: "", stderr: "private" };
        if (updateCount === 2 && failure.repeatCommandFails) return { exitCode: 1, stdout: "", stderr: "private" };
      }
      if (command === "workflow list-state-transitions") return commandResult({ list: [] });
      return commandResult({});
    });

    const result = await probeMeegleWriteContract({
      ...baseOptions(), fieldFixtures: [{ type: "text", fieldKey: "result", testValue: "after" }],
    }, { resolveCommand: vi.fn().mockResolvedValue("C:\\tools\\meegle.exe"), runCommand });

    const updates = calls.filter((args) => commandName(args) === "workitem update");
    const fieldReads = calls.filter((args) => commandName(args) === "workitem get" && args.includes("--fields"));
    expect(updates.at(-1)?.[updates.at(-1)!.indexOf("--fields") + 1]).toBe(
      JSON.stringify([{ field_key: "result", field_value: "before" }]),
    );
    expect(fieldReads.at(-1)?.slice(fieldReads.at(-1)!.indexOf("--fields"), fieldReads.at(-1)!.indexOf("--fields") + 2))
      .toEqual(["--fields", "result"]);
    expect(result.ok).toBe(false);
    expect(result.candidateManifest.fieldTypes.text.enabled).toBe(false);
  });

  it("fails closed without update or restore when the target field is missing", async () => {
    const calls: string[][] = [];
    const runCommand = createFieldPresenceRunner(calls, { missing: true });

    const result = await probeMeegleWriteContract({
      ...baseOptions(), fieldFixtures: [{ type: "text", fieldKey: "result", testValue: "after" }],
    }, { resolveCommand: vi.fn().mockResolvedValue("C:\\tools\\meegle.exe"), runCommand });

    expect(result).toMatchObject({ ok: false, manual_cleanup_required: false });
    expect(calls.filter((args) => commandName(args) === "workitem update")).toHaveLength(0);
    expect(result.candidateManifest.fieldTypes.text).toMatchObject({ write: false, restore: false });
  });

  it("does not require cleanup when the pre-write field read fails", async () => {
    const calls: string[][] = [];
    const runCommand = createFieldPresenceRunner(calls, { firstFieldReadFails: true });
    const result = await probeMeegleWriteContract({
      ...baseOptions(), fieldFixtures: [{ type: "text", fieldKey: "result", testValue: "after" }],
    }, { resolveCommand: vi.fn().mockResolvedValue("C:\\tools\\meegle.exe"), runCommand });

    expect(result).toMatchObject({ ok: false, manual_cleanup_required: false });
    expect(calls.some((args) => commandName(args) === "workitem update")).toBe(false);
    expect(result.candidateManifest.fieldTypes.text).toMatchObject({ enabled: false, restore: false });
  });

  it("requires cleanup after a write attempt when final restore verification fails", async () => {
    const calls: string[][] = [];
    const runCommand = createFieldPresenceRunner(calls, {
      restoreVerificationFails: true,
      originalValue: "private-original-value",
      fieldKey: "private-field-key",
    });
    const result = await probeMeegleWriteContract({
      ...baseOptions(), fieldFixtures: [{ type: "text", fieldKey: "private-field-key", testValue: "private-test-value" }],
    }, { resolveCommand: vi.fn().mockResolvedValue("C:\\tools\\meegle.exe"), runCommand });

    expect(calls.some((args) => commandName(args) === "workitem update")).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      manual_cleanup_required: true,
      cleanup_guidance: "check isolated work item and restore probe field original values manually",
    });
    expect(result.candidateManifest.fieldTypes.text).toMatchObject({ enabled: false, restore: false });
    expect(JSON.stringify(result.cleanup_guidance)).not.toMatch(/private-field-key|private-original-value|private-test-value|text/iu);
  });

  it("combines comment and field cleanup guidance without fixture details", async () => {
    const calls: string[][] = [];
    const base = createFieldPresenceRunner(calls, {
      restoreVerificationFails: true,
      originalValue: "both-original-secret",
      fieldKey: "both-secret-key",
    });
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (commandName(args) === "comment list") return commandResult({ pagination: { has_more: false }, list: [] });
      return base(command, args);
    });
    const result = await probeMeegleWriteContract({
      ...baseOptions(), fieldFixtures: [{ type: "text", fieldKey: "both-secret-key", testValue: "both-test-secret" }],
    }, { resolveCommand: vi.fn().mockResolvedValue("C:\\tools\\meegle.exe"), runCommand });
    expect(result).toMatchObject({ ok: false, manual_cleanup_required: true });
    expect(result.cleanup_guidance).toContain("FLOWRIVET_WRITE_PROBE marker");
    expect(result.cleanup_guidance).toContain("restore probe field original values manually");
    expect(result.cleanup_guidance).not.toMatch(/both-secret-key|both-original-secret|both-test-secret|text/iu);
  });

  it("treats an explicitly present null field as restorable", async () => {
    const calls: string[][] = [];
    const runCommand = createFieldPresenceRunner(calls, { originalValue: null });

    const result = await probeMeegleWriteContract({
      ...baseOptions(), fieldFixtures: [{ type: "text", fieldKey: "result", testValue: "after" }],
    }, { resolveCommand: vi.fn().mockResolvedValue("C:\\tools\\meegle.exe"), runCommand });

    expect(result.ok).toBe(true);
    const updates = calls.filter((args) => commandName(args) === "workitem update");
    expect(updates).toHaveLength(3);
    const restoreFields = JSON.parse(updates.at(-1)![updates.at(-1)!.indexOf("--fields") + 1]!);
    expect(restoreFields).toEqual([{ field_key: "result", field_value: null }]);
  });

  it("enables comments only after paged list, create/read, update/read, and repeated update/read", async () => {
    const calls: string[][] = [];
    let commentState = "";
    const runCommand = createSuccessfulRunner(calls, {
      onCommentAdd(args) {
        commentState = args[args.indexOf("--content") + 1]!;
        return commandResult({ comment_id: "comment-1" });
      },
      commentList() {
        return commentState ? [{ id: "comment-1", content: commentState }] : [];
      },
    });

    const result = await probeMeegleWriteContract(baseOptions(), {
      resolveCommand: vi.fn().mockResolvedValue("C:\\tools\\meegle.exe"), runCommand,
    });

    expect(result).toMatchObject({ ok: true, manual_cleanup_required: false });
    expect(result.candidateManifest.comment).toEqual({
      enabled: true, list: true, create: true, read: true, update: true, repeat: true, cleanup: false,
    });
    expect(calls.filter((args) => commandName(args) === "comment add")).toHaveLength(3);
    expect(calls.filter((args) => commandName(args) === "comment list").length).toBeGreaterThanOrEqual(4);
  });

  it("fails comment capability and requires cleanup when the created marker cannot be read back", async () => {
    const calls: string[][] = [];
    const runCommand = createSuccessfulRunner(calls, {
      onCommentAdd: () => commandResult({ comment_id: "comment-1" }),
      commentList: () => [],
    });
    const result = await probeMeegleWriteContract(baseOptions(), {
      resolveCommand: vi.fn().mockResolvedValue("C:\\tools\\meegle.exe"), runCommand,
    });
    expect(result).toMatchObject({ ok: false, manual_cleanup_required: true });
    expect(result.candidateManifest.comment).toMatchObject({ enabled: false, create: true, read: false, cleanup: false });
    expect(calls.filter((args) => commandName(args) === "comment add")).toHaveLength(1);
  });

  it.each([
    ["create", true],
    ["update", true],
    ["update-read", true],
    ["repeat", true],
    ["repeat-read", true],
  ] as const)("fails closed when comment %s fails", async (failedStage, cleanupRequired) => {
    const calls: string[][] = [];
    let addCount = 0;
    let listCount = 0;
    const runCommand = createSuccessfulRunner(calls, {
      onCommentAdd() {
        addCount += 1;
        if ((failedStage === "create" && addCount === 1)
          || (failedStage === "update" && addCount === 2)
          || (failedStage === "repeat" && addCount === 3)) {
          return { exitCode: 1, stdout: "", stderr: "private" };
        }
        return commandResult({ comment_id: "comment-1" });
      },
      commentList() {
        listCount += 1;
        if ((failedStage === "update-read" && listCount === 3)
          || (failedStage === "repeat-read" && listCount === 4)) return [];
        return [
          { id: "comment-1", content: "FLOWRIVET_WRITE_PROBE:test-nonce" },
          { id: "comment-1", content: "FLOWRIVET_WRITE_PROBE:test-nonce:updated" },
        ];
      },
    });
    const result = await probeMeegleWriteContract(baseOptions(), {
      resolveCommand: vi.fn().mockResolvedValue("C:\\tools\\meegle.exe"), runCommand,
    });
    expect(result).toMatchObject({ ok: false, manual_cleanup_required: cleanupRequired });
    expect(result.candidateManifest.comment.enabled).toBe(false);
    expect(result.cleanup_guidance).not.toContain("field");
  });

  it.each([
    ["throw", () => { throw new Error("transport_lost"); }],
    ["nonzero", () => ({ exitCode: 1, stdout: "", stderr: "private" })],
    ["timeout", () => ({ exitCode: -1, stdout: "", stderr: "" })],
    ["invalid-json", () => ({ exitCode: 0, stdout: "not-json", stderr: "" })],
  ] as const)("requires cleanup when comment create has an uncertain %s result", async (_kind, createResult) => {
    const calls: string[][] = [];
    const runCommand = createSuccessfulRunner(calls, {
      onCommentAdd: createResult,
      commentList: () => [],
    });
    const result = await probeMeegleWriteContract(baseOptions(), {
      resolveCommand: vi.fn().mockResolvedValue("C:\\tools\\meegle.exe"), runCommand,
    });
    expect(result).toMatchObject({
      ok: false,
      manual_cleanup_required: true,
      cleanup_guidance: "search isolated work item for FLOWRIVET_WRITE_PROBE marker and clean up manually",
    });
    expect(result.candidateManifest.comment.enabled).toBe(false);
    expect(JSON.stringify(result)).not.toContain("test-nonce");
    expect(calls.filter((args) => commandName(args) === "comment add")).toHaveLength(1);
  });

  it("restores after the field runner throws following the first update attempt", async () => {
    const calls: string[][] = [];
    const base = createFieldPresenceRunner(calls, { originalValue: "before", restoreAfterFirstUpdateException: true });
    let updates = 0;
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (commandName(args) === "workitem update" && ++updates === 1) throw new Error("transport_lost");
      return base(command, args);
    });
    const result = await probeMeegleWriteContract({
      ...baseOptions(), fieldFixtures: [{ type: "text", fieldKey: "result", testValue: "after" }],
    }, { resolveCommand: vi.fn().mockResolvedValue("C:\\tools\\meegle.exe"), runCommand });
    expect(result).toMatchObject({ ok: false, manual_cleanup_required: false });
    expect(calls.filter((args) => commandName(args) === "workitem update")).toHaveLength(1);
  });
});

describe("write capability manifest", () => {
  const validManifest = {
    cliVersion: "1.0.19",
    probeVersion: "1",
    comment: { enabled: false, list: false, create: false, read: false, update: false, repeat: false, cleanup: false },
    fieldTypes: { text: { enabled: false } },
    state: { enabled: false },
    node: { enabled: false },
    role: { enabled: false },
    verifiedAt: null,
  };

  it("uses a strict, versioned typed contract", () => {
    expect(writeCapabilityManifestSchema.parse(validManifest)).toEqual(validManifest);
    expect(() => writeCapabilityManifestSchema.parse({ ...validManifest, surprise: true })).toThrow();
    expect(() => writeCapabilityManifestSchema.parse({ ...validManifest, cliVersion: undefined })).toThrow();
  });

  it("enables a field type only after all four probe stages succeeded", () => {
    const loaded = loadWriteCapabilityManifest({
      ...validManifest,
      comment: { enabled: true, list: true, create: true, read: true, update: true, repeat: true, cleanup: false },
      fieldTypes: {
        text: { enabled: true, write: true, read: true, repeat: true, restore: true },
        select: { enabled: true, write: true, read: true, repeat: false, restore: true },
      },
      verifiedAt: "2026-08-13T00:00:00.000Z",
    }, { cliVersion: "1.0.19", probeVersion: "1" });

    expect(loaded.comment.enabled).toBe(true);
    expect(loaded.fieldTypes.text?.enabled).toBe(true);
    expect(loaded.fieldTypes.select?.enabled).toBe(false);
    expect(loaded.fieldTypes.unknown?.enabled).toBeUndefined();
  });

  it("fails closed for missing, malformed, or version-mismatched manifests", () => {
    expect(loadWriteCapabilityManifest(undefined, { cliVersion: "1.0.19", probeVersion: "1" }))
      .toEqual(disabledWriteCapabilities);
    expect(loadWriteCapabilityManifest({ ...validManifest, extra: true }, { cliVersion: "1.0.19", probeVersion: "1" }))
      .toEqual(disabledWriteCapabilities);
    expect(loadWriteCapabilityManifest(validManifest, { cliVersion: "1.0.20", probeVersion: "1" }))
      .toEqual(disabledWriteCapabilities);
  });

  it("rejects field types outside the explicit runtime allowlist", () => {
    const unknown = {
      ...validManifest,
      fieldTypes: { mystery: { enabled: true, write: true, read: true, repeat: true, restore: true } },
      verifiedAt: "2026-08-13T00:00:00.000Z",
    };
    expect(() => writeCapabilityManifestSchema.parse(unknown)).toThrow();
    expect(loadWriteCapabilityManifest(unknown, { cliVersion: "1.0.19", probeVersion: "1" }))
      .toEqual(disabledWriteCapabilities);
  });

  it.each(["user", "multi-user"])("rejects high-impact personnel field type: %s", (type) => {
    const manifest = {
      ...validManifest,
      fieldTypes: { [type]: { enabled: true, write: true, read: true, repeat: true, restore: true } },
      verifiedAt: "2026-08-13T00:00:00.000Z",
    };
    expect(() => writeCapabilityManifestSchema.parse(manifest)).toThrow();
    expect(loadWriteCapabilityManifest(manifest, { cliVersion: "1.0.19", probeVersion: "1" }))
      .toEqual(disabledWriteCapabilities);
  });
});

function baseOptions() {
  return {
    projectKey: "test-project",
    workItemId: "wi-1",
    fieldFixtures: [],
    probeNonce: "FLOWRIVET_WRITE_PROBE:test-nonce",
  };
}

function commandResult(value: unknown) {
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
}

function successfulCommentListResult() {
  return commandResult({
    pagination: { has_more: false },
    list: [
      { id: "comment-1", content: "FLOWRIVET_WRITE_PROBE:test-nonce" },
      { id: "comment-1", content: "FLOWRIVET_WRITE_PROBE:test-nonce:updated" },
    ],
  });
}

function commandName(args: string[]) {
  const offset = args[0] === "--profile" ? 2 : 0;
  return args.slice(offset, offset + 2).join(" ").trim();
}

function createSuccessfulRunner(
  calls: string[][],
  comments: {
    onCommentAdd(args: string[]): ReturnType<typeof commandResult> | { exitCode: number; stdout: string; stderr: string };
    commentList(): unknown[];
  },
) {
  return vi.fn(async (_command: string, args: string[]) => {
    calls.push(args);
    const command = commandName(args);
    if (command === "--version") return commandResult({ version: "1.0.19" });
    if (command === "auth status") return commandResult({ authenticated: true });
    if (command === "user me") return commandResult({ user_key: "user-example" });
    if (command === "workitem get") return commandResult({
      work_item_attribute: { work_item_name: "[TEST] probe", work_item_type: { key: "story" } },
    });
    if (command === "workitem meta-fields" || command === "workitem meta-roles") {
      return commandResult({ pagination: { has_more: false }, list: [] });
    }
    if (command === "comment list") {
      return commandResult({ pagination: { has_more: false }, list: comments.commentList() });
    }
    if (command === "comment add") return comments.onCommentAdd(args);
    if (command === "workflow list-state-transitions") return commandResult({ list: [] });
    return commandResult({});
  });
}

async function runPaginationBoundaryProbe(options: {
  itemTotal: number;
  paginationByteLimit?: number;
  rawMetaFields?: string;
}) {
  const largePage = options.itemTotal === 1
    ? [{ key: "field" }]
    : Array.from({ length: options.itemTotal }, (_, index) => ({ key: `f${index}` }));
  const runCommand = vi.fn(async (_command: string, args: string[]) => {
    const command = commandName(args);
    if (command === "--version") return commandResult({ version: "1.0.19" });
    if (command === "auth status") return commandResult({ authenticated: true });
    if (command === "user me") return commandResult({ user_key: "user-example" });
    if (command === "workitem get") return commandResult({
      work_item_attribute: { work_item_name: "[TEST] probe", work_item_type: { key: "story" } },
    });
    if (command === "workitem meta-fields") {
      if (options.rawMetaFields) return { exitCode: 0, stdout: options.rawMetaFields, stderr: "" };
      return commandResult({ pagination: { has_more: false }, list: largePage });
    }
    if (command === "comment list") return successfulCommentListResult();
    if (command === "workitem meta-roles") return commandResult({ pagination: { has_more: false }, list: [] });
    if (command === "comment add" && args.includes("create")) return commandResult({ comment_id: "comment-1" });
    if (command === "workflow list-state-transitions") return commandResult({ list: [] });
    return commandResult({});
  });
  return probeMeegleWriteContract({
    ...baseOptions(),
    ...(options.paginationByteLimit === undefined ? {} : { paginationByteLimit: options.paginationByteLimit }),
  }, { resolveCommand: vi.fn().mockResolvedValue("C:\\tools\\meegle.exe"), runCommand });
}

function createFieldPresenceRunner(
  calls: string[][],
  options: {
    missing?: boolean;
    originalValue?: unknown;
    firstFieldReadFails?: boolean;
    restoreVerificationFails?: boolean;
    restoreAfterFirstUpdateException?: boolean;
    fieldKey?: string;
  },
  ) {
  let getCount = 0;
  const fieldKey = options.fieldKey ?? "result";
  return vi.fn(async (_command: string, args: string[]) => {
    calls.push(args);
    const command = commandName(args);
    if (command === "--version") return commandResult({ version: "1.0.19" });
    if (command === "auth status") return commandResult({ authenticated: true });
    if (command === "user me") return commandResult({ user_key: "user-example" });
    if (command === "workitem get") {
      getCount += 1;
      if (options.firstFieldReadFails && getCount === 2) {
        return { exitCode: 1, stdout: "", stderr: "private" };
      }
      const value = getCount === 1 || getCount === 2 || getCount === 5
        || (options.restoreAfterFirstUpdateException && getCount === 3) ? options.originalValue : "after";
      const effectiveValue = options.restoreVerificationFails && getCount === 5 ? "after" : value;
      return commandResult({
        work_item_attribute: { work_item_name: "[TEST] probe", work_item_type: { key: "story" } },
        work_item_fields: options.missing && getCount === 2 ? [] : [{ key: fieldKey, value: effectiveValue }],
      });
    }
    if (command === "workitem meta-fields") {
      return commandResult({ pagination: { has_more: false }, list: [{ key: fieldKey, name: "Result", type: "text" }] });
    }
    if (command === "comment list") return successfulCommentListResult();
    if (command === "workitem meta-roles") return commandResult({ pagination: { has_more: false }, list: [] });
    if (command === "comment add" && args.includes("create")) return commandResult({ comment_id: "comment-1" });
    if (command === "workflow list-state-transitions") return commandResult({ list: [] });
    return commandResult({});
  });
}
