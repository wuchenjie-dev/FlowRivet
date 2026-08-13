import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

import {
  printProbeResult,
  resolveCommand,
  runCommand,
} from "../packages/codex-plugin/scripts/probe-runtime.mjs";

export const PROBE_VERSION = "1";
const ISOLATION_CONFIRMATION = "FLOWRIVET_WRITE_PROBE";
const TEST_TITLE_PATTERN = /(?:\btest\b|\[test\]|测试|flowrivet[ _-]write[ _-]probe)/iu;
const FORBIDDEN_FIELD_KEYS = new Set([
  "state", "status", "node", "role", "assignee", "owner", "schedule",
  "start_time", "end_time", "title", "description", "body",
]);
const FORBIDDEN_FIELD_SEMANTICS = /(?:负责人|经办人|处理人|排期|开始时间|结束时间|截止时间|正文|描述|状态|节点|角色|assignee|owner|schedule|start.?time|end.?time|due.?date|description|body|state|status|node|role)/iu;
const FORBIDDEN_FIELD_TYPES = new Set(["user", "multi-user", "state", "status", "node", "role"]);
const SUPPORTED_FIELD_TYPES = new Set(["text", "link", "number", "boolean", "select", "multi-select", "date"]);
const DEFAULT_PAGINATION_BYTE_LIMIT = 10 * 1024 * 1024;

const HELP = `Usage: node scripts/probe-meegle-write-contract.mjs [options]

Destructively probes one explicitly selected isolated test work item. Never use a
production project or work item.

Required:
  --project-key <key>              Isolated test project key
  --work-item-id <id>              Isolated test work item id
  --confirm-isolated-fixture FLOWRIVET_WRITE_PROBE

Optional:
  --profile <name>                 Meegle CLI profile
  --field-fixture <type>:<fieldKey>:<testValue> (repeatable)
  --output <path>                  Redacted probe evidence JSON
  --manifest-output <path>         Candidate manifest for human review
  --help                           Show this help

The target title must visibly contain TEST, [TEST], 测试, or
FLOWRIVET_WRITE_PROBE. The probe never changes state, node, role, assignee,
schedule, title, description, or body fields. Meegle CLI 1.0.19 has no comment
delete command, so a successful probe leaves one redacted marker comment on the
isolated test work item. If create has an uncertain result, search that isolated
item for the FLOWRIVET_WRITE_PROBE marker and clean it up manually.`;

export function parseProbeArgs(args) {
  if (args.includes("--help")) return { help: true };
  const options = { fieldFixtures: [] };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("probe_argument_invalid");
    }
    index += 1;
    if (flag === "--project-key") options.projectKey = value;
    else if (flag === "--work-item-id") options.workItemId = value;
    else if (flag === "--confirm-isolated-fixture") options.confirmation = value;
    else if (flag === "--profile") options.profile = value;
    else if (flag === "--output") options.output = value;
    else if (flag === "--manifest-output") options.manifestOutput = value;
    else if (flag === "--field-fixture") options.fieldFixtures.push(parseFieldFixture(value));
    else throw new Error("probe_argument_invalid");
  }
  if (!options.projectKey || !options.workItemId || options.confirmation !== ISOLATION_CONFIRMATION) {
    throw new Error("isolated_fixture_required");
  }
  return options;
}

function parseFieldFixture(value) {
  const first = value.indexOf(":");
  const second = value.indexOf(":", first + 1);
  if (first <= 0 || second <= first + 1 || second === value.length - 1) {
    throw new Error("field_fixture_invalid");
  }
  const type = value.slice(0, first);
  const fieldKey = value.slice(first + 1, second);
  if (!/^[a-z][a-z0-9_-]*$/u.test(type) || !/^[A-Za-z0-9_-]+$/u.test(fieldKey)) {
    throw new Error("field_fixture_invalid");
  }
  if (!SUPPORTED_FIELD_TYPES.has(type)) throw new Error("field_type_unsupported");
  if (FORBIDDEN_FIELD_KEYS.has(fieldKey.toLowerCase())) {
    throw new Error("field_fixture_forbidden");
  }
  return { type, fieldKey, testValue: value.slice(second + 1) };
}

export function redactProbeOutput(value) {
  return redactValue(value, "");
}

function redactValue(value, key) {
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      redactValue(childValue, childKey),
    ]));
  }
  if (typeof value !== "string") return value;
  if (/(?:body|content|description|token|email|value|title|name|id|key|message)/iu.test(key)) {
    return "[REDACTED]";
  }
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[REDACTED]")
    .replace(/(?:access|refresh)?_?token[=: ]+\S+/giu, "[REDACTED]");
}

export async function probeMeegleWriteContract(options, dependencies = {}) {
  const resolve = dependencies.resolveCommand ?? resolveCommand;
  const run = dependencies.runCommand ?? runCommand;
  const executablePath = await resolve("meegle");
  if (!executablePath) return failure("provider_cli_missing");

  const versionResult = await run(executablePath, ["--version"]);
  const cliVersion = extractVersion(versionResult.stdout);
  if (versionResult.exitCode !== 0 || !cliVersion) return failure("provider_cli_unsupported");

  const global = options.profile ? ["--profile", options.profile] : [];
  const project = ["--project-key", options.projectKey];
  const auth = await runJson(run, executablePath, [...global, "auth", "status", "--format", "json"]);
  if (!auth.ok || auth.value?.authenticated !== true) return failure("provider_not_connected", { cliVersion });
  const user = await runJson(run, executablePath, [...global, "user", "me", "--format", "json"]);
  const userKey = findString(user.value, ["user_key", "userKey"]);
  if (!user.ok || !userKey) return failure("provider_identity_unavailable", { cliVersion });
  const workItemArgs = [
    ...global, "workitem", "get", ...project, "--work-item-id", options.workItemId, "--format", "json",
  ];
  const workItem = await runJson(run, executablePath, workItemArgs);
  if (!workItem.ok) return failure("work_item_unavailable", { cliVersion });
  const title = extractWorkItemTitle(workItem.value);
  if (!title || !TEST_TITLE_PATTERN.test(title)) return failure("test_marker_required", { cliVersion });
  const workItemType = extractWorkItemType(workItem.value);
  if (!workItemType) return failure("work_item_type_unavailable", { cliVersion });

  const evidence = { cliVersion, probeVersion: PROBE_VERSION, stages: [] };
  const metaFields = await collectNumberedPages(run, executablePath, [
    ...global, "workitem", "meta-fields", ...project, "--work-item-type", workItemType,
  ], options.paginationByteLimit);
  evidence.stages.push(stage("meta_fields", metaFields));
  const comments = await collectNumberedPages(run, executablePath, [
    ...global, "comment", "list", ...project, "--work-item-id", options.workItemId,
  ], options.paginationByteLimit);
  evidence.stages.push(stage("comment_list", comments));
  if (!metaFields.ok || !comments.ok) return failure("probe_read_failed", { cliVersion, evidence });
  try {
    validateFieldFixturesAgainstMetadata(options.fieldFixtures, metaFields.items);
  } catch (error) {
    return failure(error instanceof Error ? error.message : "field_metadata_unrecognized", { cliVersion, evidence });
  }

  const nonce = options.probeNonce ?? `FLOWRIVET_WRITE_PROBE:${randomUUID()}`;
  let createAttempted = false;
  createAttempted = true;
  const created = await runJson(run, executablePath, [
    ...global, "comment", "add", ...project, "--work-item-id", options.workItemId,
    "--action", "create", "--content", nonce, "--format", "json",
  ]);
  const commentId = findString(created.value, ["comment_id", "commentId", "id"]);
  const createdComments = created.ok && commentId
    ? await collectNumberedPages(run, executablePath, [
        ...global, "comment", "list", ...project, "--work-item-id", options.workItemId,
      ], options.paginationByteLimit)
    : { ok: false, items: [] };
  const createdRead = createdComments.ok && hasComment(createdComments.items, commentId, nonce);
  const updated = createdRead
    ? await runJson(run, executablePath, [
        ...global, "comment", "add", ...project, "--work-item-id", options.workItemId,
        "--action", "update", "--comment-id", commentId, "--content", `${nonce}:updated`,
        "--format", "json",
      ])
    : { ok: false };
  const updatedComments = updated.ok
    ? await collectNumberedPages(run, executablePath, [
        ...global, "comment", "list", ...project, "--work-item-id", options.workItemId,
      ], options.paginationByteLimit)
    : { ok: false, items: [] };
  const updatedRead = updatedComments.ok && hasComment(updatedComments.items, commentId, `${nonce}:updated`);
  const repeated = updatedRead
    ? await runJson(run, executablePath, [
        ...global, "comment", "add", ...project, "--work-item-id", options.workItemId,
        "--action", "update", "--comment-id", commentId, "--content", `${nonce}:updated`,
        "--format", "json",
      ])
    : { ok: false };
  const repeatedComments = repeated.ok
    ? await collectNumberedPages(run, executablePath, [
        ...global, "comment", "list", ...project, "--work-item-id", options.workItemId,
      ], options.paginationByteLimit)
    : { ok: false, items: [] };
  const repeatedRead = repeatedComments.ok && hasComment(repeatedComments.items, commentId, `${nonce}:updated`);
  const commentCapability = {
    enabled: comments.ok && created.ok && createdRead && updated.ok && updatedRead && repeated.ok && repeatedRead,
    list: comments.ok,
    create: created.ok,
    read: createdRead && updatedRead && repeatedRead,
    update: updated.ok,
    repeat: repeated.ok && repeatedRead,
    cleanup: false,
  };
  evidence.stages.push(
    stage("comment_create", created), stage("comment_create_read", { ok: createdRead }),
    stage("comment_update", updated), stage("comment_update_read", { ok: updatedRead }),
    stage("comment_repeat", repeated), stage("comment_repeat_read", { ok: repeatedRead }),
  );

  const fieldTypes = {};
  const commentCleanupRequired = createAttempted && !commentCapability.enabled;
  let fieldCleanupRequired = false;
  for (const fixture of options.fieldFixtures) {
    const result = await probeFieldFixture(run, executablePath, global, project, options.workItemId, fixture);
    fieldTypes[fixture.type] = fieldTypes[fixture.type]
      ? aggregateFieldCapability(fieldTypes[fixture.type], result.capability)
      : result.capability;
    evidence.stages.push(...result.stages);
    fieldCleanupRequired ||= result.writeAttempted && !result.capability.restore;
  }
  const manualCleanupRequired = commentCleanupRequired || fieldCleanupRequired;

  const transitions = await runJson(run, executablePath, [
    ...global, "workflow", "list-state-transitions", ...project, "--work-item-id", options.workItemId,
    "--work-item-type", workItemType, "--user-key", userKey, "--format", "json",
  ]);
  const stateKeys = transitions.ok ? extractStateKeys(transitions.value) : [];
  const requiredResults = [];
  for (const stateKey of stateKeys) {
    requiredResults.push(await runJson(run, executablePath, [
      ...global, "workflow", "list-state-required", ...project, "--work-item-id", options.workItemId,
      "--state-key", stateKey, "--format", "json",
    ]));
  }
  const requiredFields = {
    ok: transitions.ok && requiredResults.every((result) => result.ok),
    itemCount: requiredResults.length,
  };
  const nodes = await runJson(run, executablePath, [
    ...global, "workflow", "meta-node-fields", ...project, "--work-item-type", workItemType, "--format", "json",
  ]);
  const roles = await collectNumberedPages(run, executablePath, [
    ...global, "workitem", "meta-roles", ...project, "--work-item-type", workItemType,
  ], options.paginationByteLimit);
  evidence.stages.push(
    stage("state_transitions", transitions),
    stage("state_required_fields", requiredFields),
    stage("node_meta", nodes),
    stage("role_meta", roles),
  );

  const fixedSequenceSucceeded = commentCapability.enabled
    && Object.values(fieldTypes).every((field) => field.enabled)
    && transitions.ok && requiredFields.ok && nodes.ok && roles.ok;
  const probeSucceeded = fixedSequenceSucceeded && !manualCleanupRequired;

  const candidateManifest = {
    cliVersion,
    probeVersion: PROBE_VERSION,
    comment: commentCapability,
    fieldTypes,
    state: { enabled: false },
    node: { enabled: false },
    role: { enabled: false },
    verifiedAt: probeSucceeded ? new Date().toISOString() : null,
  };
  const result = {
    ok: probeSucceeded,
    capability: "meegle_write",
    cliVersion,
    probeVersion: PROBE_VERSION,
    manual_cleanup_required: manualCleanupRequired,
    ...(manualCleanupRequired ? {
      cleanup_guidance: cleanupGuidance(commentCleanupRequired, fieldCleanupRequired),
    } : {}),
    candidateManifest,
    evidence: redactProbeOutput(evidence),
  };
  if (options.output) await writeJson(options.output, result.evidence);
  if (options.manifestOutput) await writeJson(options.manifestOutput, candidateManifest);
  return result;
}

function cleanupGuidance(commentCleanupRequired, fieldCleanupRequired) {
  const guidance = [];
  if (commentCleanupRequired) {
    guidance.push("search isolated work item for FLOWRIVET_WRITE_PROBE marker and clean up manually");
  }
  if (fieldCleanupRequired) {
    guidance.push("check isolated work item and restore probe field original values manually");
  }
  return guidance.join("; ");
}

async function probeFieldFixture(run, executablePath, global, project, workItemId, fixture) {
  const readArgs = [
    ...global, "workitem", "get", ...project, "--work-item-id", workItemId,
    "--fields", fixture.fieldKey, "--format", "json",
  ];
  const before = await runJson(run, executablePath, readArgs);
  const originalField = findField(before.value, fixture.fieldKey);
  const writeArgs = workItemUpdateArgs(global, project, workItemId, fixture.fieldKey, fixture.testValue);
  if (!before.ok || !originalField.found) {
    return {
      writeAttempted: false,
      capability: capability(false, false, false, false),
      stages: [stage(`field_${fixture.type}_write`, { ok: false }),
        stage(`field_${fixture.type}_read`, { ok: false }),
        stage(`field_${fixture.type}_repeat`, { ok: false }),
        stage(`field_${fixture.type}_restore`, { ok: false })],
    };
  }
  const originalValue = originalField.value;
  const write = await runJson(run, executablePath, writeArgs);
  const read = write.ok ? await runJson(run, executablePath, readArgs) : { ok: false };
  const readField = findField(read.value, fixture.fieldKey);
  const readSucceeded = read.ok && readField.found && valuesEqual(
    normalizeProbeFieldValue(fixture.type, readField.value),
    normalizeProbeFieldValue(fixture.type, fixture.testValue),
  );
  const repeat = readSucceeded ? await runJson(run, executablePath, writeArgs) : { ok: false };
  const repeated = repeat.ok ? await runJson(run, executablePath, readArgs) : { ok: false };
  const repeatedField = findField(repeated.value, fixture.fieldKey);
  const repeatSucceeded = repeated.ok && repeatedField.found && valuesEqual(
    normalizeProbeFieldValue(fixture.type, repeatedField.value),
    normalizeProbeFieldValue(fixture.type, fixture.testValue),
  );
  // A failed update response is an uncertain remote outcome, so restoration is unconditional
  // once the first update command has been attempted.
  const restore = await runJson(
    run,
    executablePath,
    workItemUpdateArgs(global, project, workItemId, fixture.fieldKey, originalValue),
  );
  const restored = await runJson(run, executablePath, readArgs);
  const restoredField = findField(restored.value, fixture.fieldKey);
  const restoreSucceeded = restore.ok && restored.ok && restoredField.found
    && valuesEqual(
      normalizeProbeFieldValue(fixture.type, restoredField.value),
      normalizeProbeFieldValue(fixture.type, originalValue),
    );
  return {
    writeAttempted: true,
    capability: capability(write.ok, readSucceeded, repeatSucceeded, restoreSucceeded),
    stages: [stage(`field_${fixture.type}_write`, write), stage(`field_${fixture.type}_read`, { ok: readSucceeded }),
      stage(`field_${fixture.type}_repeat`, { ok: repeatSucceeded }),
      stage(`field_${fixture.type}_restore`, { ok: restoreSucceeded })],
  };
}

export function aggregateFieldCapability(left, right) {
  return capability(
    left.write && right.write,
    left.read && right.read,
    left.repeat && right.repeat,
    left.restore && right.restore,
  );
}

export function validateFieldFixturesAgainstMetadata(fixtures, metadata) {
  if (fixtures.length === 0) return;
  if (!Array.isArray(metadata) || metadata.length === 0) throw new Error("field_metadata_unrecognized");
  for (const fixture of fixtures) {
    if (!SUPPORTED_FIELD_TYPES.has(fixture.type)) throw new Error("field_type_unsupported");
    const definition = metadata.find((entry) => extractFieldKey(entry) === fixture.fieldKey);
    if (!definition) throw new Error("field_metadata_unrecognized");
    const semanticText = collectSemanticStrings(definition).join(" ");
    const fieldType = extractMetadataType(definition);
    if (FORBIDDEN_FIELD_SEMANTICS.test(semanticText) || (fieldType && FORBIDDEN_FIELD_TYPES.has(fieldType))) {
      throw new Error("field_fixture_forbidden");
    }
    if (!fieldType || fieldType !== fixture.type) throw new Error("field_metadata_unrecognized");
  }
}

function capability(write = false, read = write, repeat = write, restore = write) {
  return { enabled: write && read && repeat && restore, write, read, repeat, restore };
}

async function collectNumberedPages(run, executablePath, baseArgs, byteLimit = DEFAULT_PAGINATION_BYTE_LIMIT) {
  let pages = 0;
  let itemCount = 0;
  let byteCount = 0;
  const items = [];
  while (true) {
    if (pages >= 100 || itemCount >= 10_000) return { ok: false, errorCode: "pagination_limit_exceeded" };
    const args = [...baseArgs, "--page-num", String(pages + 1), "--format", "json"];
    const result = await runJson(run, executablePath, args);
    if (!result.ok) return result;
    pages += 1;
    byteCount += result.rawByteLength;
    const pageItems = findArray(result.value) ?? [];
    items.push(...pageItems);
    itemCount += pageItems.length;
    if (itemCount > 10_000 || byteCount > byteLimit) {
      return { ok: false, errorCode: "pagination_limit_exceeded" };
    }
    if (!hasMorePages(result.value, pageItems)) break;
  }
  return { ok: true, pages, itemCount, byteCount, items };
}

async function runJson(run, executablePath, args) {
  let result;
  try {
    result = await run(executablePath, args);
  } catch {
    return { ok: false, errorCode: "command_failed" };
  }
  if (result.exitCode !== 0) return { ok: false, errorCode: "command_failed" };
  const rawByteLength = Buffer.byteLength(result.stdout, "utf8");
  try {
    return { ok: true, value: JSON.parse(result.stdout), rawByteLength };
  } catch {
    return { ok: false, errorCode: "invalid_json" };
  }
}

function hasComment(items, commentId, content) {
  return items.some((item) => findString(item, ["comment_id", "commentId", "id"]) === commentId
    && findString(item, ["content"]) === content);
}

function stage(name, result) {
  return { name, ok: Boolean(result.ok), errorCode: result.errorCode };
}

function failure(errorCode, details = {}) {
  return { ok: false, capability: "meegle_write", errorCode, ...details };
}

function extractVersion(value = "") {
  return value.match(/\b(\d+\.\d+\.\d+)\b/u)?.[1];
}

function findString(value, keys) {
  if (!value || typeof value !== "object") return undefined;
  for (const key of keys) if (typeof value[key] === "string") return value[key];
  for (const child of Object.values(value)) {
    const found = findString(child, keys);
    if (found) return found;
  }
  return undefined;
}

function extractWorkItemTitle(value) {
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.title === "string") return value.title;
  for (const container of ["work_item_attribute", "workItemAttribute", "work_item_info", "workItemInfo"]) {
    const nested = value[container];
    if (nested && typeof nested === "object") {
      if (typeof nested.work_item_name === "string") return nested.work_item_name;
      if (typeof nested.workItemName === "string") return nested.workItemName;
      if (typeof nested.title === "string") return nested.title;
      if (typeof nested.name === "string") return nested.name;
    }
  }
  return undefined;
}

function extractWorkItemType(value) {
  if (!value || typeof value !== "object") return undefined;
  const attribute = value.work_item_attribute ?? value.workItemAttribute;
  if (attribute && typeof attribute === "object") {
    const type = attribute.work_item_type ?? attribute.workItemType;
    if (type && typeof type === "object" && typeof type.key === "string") return type.key;
    if (typeof attribute.work_item_type_key === "string") return attribute.work_item_type_key;
  }
  const info = value.work_item_info ?? value.workItemInfo;
  if (info && typeof info === "object") {
    if (typeof info.work_item_type_key === "string") return info.work_item_type_key;
    if (typeof info.workItemTypeKey === "string") return info.workItemTypeKey;
  }
  return undefined;
}

function extractStateKeys(value) {
  const keys = [];
  collectStateKeys(value, keys);
  return [...new Set(keys)];
}

function collectStateKeys(value, keys) {
  if (Array.isArray(value)) {
    for (const entry of value) collectStateKeys(entry, keys);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if ((key === "state_key" || key === "stateKey") && typeof child === "string") keys.push(child);
    else collectStateKeys(child, keys);
  }
}

function findArray(value) {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) return value;
  for (const child of Object.values(value)) {
    const found = findArray(child);
    if (found) return found;
  }
  return undefined;
}

function hasMorePages(value, pageItems) {
  if (value && typeof value === "object") {
    const pagination = value.pagination;
    if (pagination && typeof pagination === "object") {
      if (typeof pagination.has_more === "boolean") return pagination.has_more;
      if (typeof pagination.hasMore === "boolean") return pagination.hasMore;
    }
    if (typeof value.has_more === "boolean") return value.has_more;
    if (typeof value.hasMore === "boolean") return value.hasMore;
  }
  return pageItems.length === 50;
}

function findField(value, fieldKey) {
  if (!value || typeof value !== "object") return { found: false };
  if (value.fieldKey === fieldKey || value.field_key === fieldKey || value.key === fieldKey) {
    return Object.prototype.hasOwnProperty.call(value, "value")
      ? { found: true, value: value.value }
      : { found: false };
  }
  for (const child of Object.values(value)) {
    const found = findField(child, fieldKey);
    if (found.found) return found;
  }
  return { found: false };
}

function extractFieldKey(value) {
  if (!value || typeof value !== "object") return undefined;
  for (const key of ["key", "fieldKey", "field_key"]) {
    if (typeof value[key] === "string") return value[key];
  }
  return undefined;
}

function extractMetadataType(value) {
  if (!value || typeof value !== "object") return undefined;
  for (const key of ["type", "fieldType", "field_type", "valueType", "value_type"]) {
    if (typeof value[key] === "string") return value[key].toLowerCase();
  }
  return undefined;
}

function collectSemanticStrings(value, parentKey = "") {
  if (Array.isArray(value)) return value.flatMap((entry) => collectSemanticStrings(entry, parentKey));
  if (!value || typeof value !== "object") {
    return typeof value === "string" && /(?:name|label|type|alias|semantic|code)/iu.test(parentKey) ? [value] : [];
  }
  return Object.entries(value).flatMap(([key, child]) => collectSemanticStrings(child, key));
}

function valuesEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function normalizeProbeFieldValue(type, value) {
  if (type === "text" && value && typeof value === "object" && typeof value.text === "string") {
    return value.text;
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function workItemUpdateArgs(global, project, workItemId, fieldKey, fieldValue) {
  return [
    ...global, "workitem", "update", ...project, "--work-item-id", workItemId,
    "--fields", JSON.stringify([{ field_key: fieldKey, field_value: fieldValue }]),
    "--format", "json",
  ];
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/gu, "/")}`).href) {
  let result;
  try {
    const options = parseProbeArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(`${HELP}\n`);
    else result = await probeMeegleWriteContract(options);
  } catch (error) {
    result = failure(error instanceof Error ? error.message : "probe_failed");
  }
  if (result) printProbeResult(result);
}
