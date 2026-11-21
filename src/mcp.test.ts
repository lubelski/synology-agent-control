/**
 * MCP server tests. The tools are generated from the command registry, so
 * these check the generation and the gate, not the commands themselves.
 *
 * Every call goes through an in-memory client/server pair with a stub device
 * client. Nothing here dials a NAS or reads credentials.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { COMMANDS } from "./commands.js";
import { SERVER_NAME, createServer, toolName, type McpOptions } from "./mcp.js";

const HERE = dirname(fileURLToPath(import.meta.url));

interface StubCall {
  api: string;
  method: string;
  post?: boolean;
  params?: Record<string, string>;
}

/** Point the process at a fake target for one test, then put the env back. */
async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function fakeTarget(auditDir: string): Record<string, string | undefined> {
  return {
    DSM_BASE_URL: "https://nas.test:5001",
    DSM_USER: "agent",
    DSM_SID_CACHE_FILE: join(auditDir, "session.json"),
    DSM_TLS_SKIP_VERIFY: undefined,
    AUDIT_LOG_DIR: auditDir,
  };
}

/** A connected client plus the calls the stub device client received. */
async function connect(opts: McpOptions = {}, respond: (call: StubCall) => unknown = () => ({})) {
  const calls: StubCall[] = [];
  const server = createServer({
    ...opts,
    createClient: () =>
      ({
        call: async (call: StubCall) => {
          calls.push(call);
          return respond(call);
        },
      }) as any,
  });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, calls };
}

const textOf = (result: any): string => result.content[0].text;

function auditRecords(dir: string): any[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("mcp: one tool per registry command, named and described from it", async () => {
  const { client } = await connect();
  assert.equal(client.getServerVersion()?.name, SERVER_NAME);
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    COMMANDS.map(toolName)
  );
  assert.equal(new Set(tools.map((t) => t.name)).size, tools.length);
  for (const tool of tools) assert.match(tool.name, /^[a-z0-9_]+$/);
  for (const command of COMMANDS) {
    const tool = tools.find((t) => t.name === toolName(command))!;
    assert.equal(tool.description, command.summary);
  }
  assert.ok(tools.some((t) => t.name === "containers_logs"));
  assert.ok(tools.some((t) => t.name === "shares_snapshot_config"));
});

test("mcp: input schemas come from the registry's arguments and flags", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const schema = (name: string) => tools.find((t) => t.name === name)!.inputSchema as any;

  const logs = schema("containers_logs");
  assert.deepEqual(logs.required, ["name"]);
  assert.equal(logs.properties.limit.type, "integer");
  assert.ok(logs.properties.name.description);
  assert.equal(logs.properties.confirm, undefined);
  assert.equal(logs.additionalProperties, false);

  const control = schema("packages_control");
  assert.deepEqual(control.required, ["name", "action"]);
  assert.deepEqual(control.properties.action.enum, ["start", "stop", "restart"]);

  const raw = schema("raw");
  assert.deepEqual(raw.required, ["api", "method"]);
  assert.equal(raw.properties.params_json.type, "object");
  assert.deepEqual(raw.properties.target.enum, ["dsm", "srm"]);
  assert.equal(raw.properties.verbose, undefined);
  assert.equal(raw.properties.yes, undefined);
});

test("mcp: annotations follow the registry's mutating flag", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  for (const command of COMMANDS) {
    const tool = tools.find((t) => t.name === toolName(command))!;
    const props = (tool.inputSchema as any).properties ?? {};
    if (command.mutating) {
      assert.equal(tool.annotations?.readOnlyHint, false, command.name);
      assert.equal(tool.annotations?.destructiveHint, true, command.name);
      assert.equal(tool.annotations?.idempotentHint, Boolean(command.idempotent), command.name);
      assert.equal(props.confirm?.type, "boolean", command.name);
    } else if (command.name === "raw") {
      // Not marked mutating, but it can reach a write endpoint.
      assert.equal(tool.annotations?.readOnlyHint, false);
      assert.equal(props.confirm?.type, "boolean");
    } else {
      assert.equal(tool.annotations?.readOnlyHint, true, command.name);
      assert.equal(tool.annotations?.destructiveHint, undefined, command.name);
      assert.equal(props.confirm, undefined, command.name);
    }
  }
});

test("mcp: a mutating tool without confirm is refused before anything loads", async () => {
  // No target is configured, so reaching the loader would report a missing
  // variable instead of the refusal.
  await withEnv({ DSM_BASE_URL: undefined, DSM_USER: undefined }, async () => {
    const { client, calls } = await connect();
    for (const args of [
      { name: "SynologyDrive" },
      { name: "SynologyDrive", confirm: false },
    ]) {
      const result = await client.callTool({ name: "packages_update", arguments: args });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Refusing to run "packages_update" without confirm: true/);
    }
    assert.equal(calls.length, 0);
  });
});

test("mcp: raw keeps the CLI's confirmation rule, and a confirmed write is audited", async () => {
  const auditDir = mkdtempSync(join(tmpdir(), "synology-agent-control-mcp-"));
  await withEnv(fakeTarget(auditDir), async () => {
    const { client, calls } = await connect({}, () => ({ done: true }));

    const read = await client.callTool({
      name: "raw",
      arguments: { api: "SYNO.Core.Share", method: "list", params_json: { name: "docs" } },
    });
    assert.notEqual(read.isError, true, textOf(read));
    assert.deepEqual(JSON.parse(textOf(read)), { done: true });
    // The object went through the CLI's --params-json encoding.
    assert.deepEqual(calls[0].params, { name: '"docs"' });

    const write = { api: "SYNO.Core.Share", method: "delete", extra_args: ['name="docs"'] };
    const refused = await client.callTool({ name: "raw", arguments: write });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /without confirm: true/);
    assert.equal(calls.length, 1);
    assert.deepEqual(auditRecords(auditDir), []);

    const confirmed = await client.callTool({
      name: "raw",
      arguments: { ...write, confirm: true },
    });
    assert.notEqual(confirmed.isError, true, textOf(confirmed));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].params, { name: '"docs"' });

    // The confirmed write went through the same audit record the CLI writes.
    const records = auditRecords(auditDir);
    assert.equal(records.length, 1);
    assert.equal(records[0].tool, "raw:SYNO.Core.Share.delete");
    assert.equal(records[0].ok, true);
  });
});

test("mcp: read-only mode registers no mutating tool and refuses raw writes", async () => {
  const auditDir = mkdtempSync(join(tmpdir(), "synology-agent-control-mcp-"));
  await withEnv(fakeTarget(auditDir), async () => {
    const { client, calls } = await connect({ readOnly: true }, () => ({ shares: [] }));
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      COMMANDS.filter((c) => !c.mutating).map(toolName)
    );
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
      assert.equal((tool.inputSchema as any).properties?.confirm, undefined, tool.name);
    }
    assert.match(tools.find((t) => t.name === "raw")!.description!, /read-only/);

    const hidden = await client.callTool({
      name: "packages_uninstall",
      arguments: { name: "SynologyDrive", keep_data: true, confirm: true },
    });
    assert.equal(hidden.isError, true);
    assert.match(textOf(hidden), /read-only/);

    for (const args of [
      { api: "SYNO.Core.Share", method: "delete", confirm: true },
      { api: "SYNO.Core.Share", method: "list", post: true, confirm: true },
    ]) {
      const refused = await client.callTool({ name: "raw", arguments: args });
      assert.equal(refused.isError, true);
      assert.match(textOf(refused), /read-only/);
    }
    assert.equal(calls.length, 0);

    const read = await client.callTool({
      name: "raw",
      arguments: { api: "SYNO.Core.Share", method: "list" },
    });
    assert.notEqual(read.isError, true, textOf(read));
    assert.equal(calls.length, 1);
    assert.deepEqual(auditRecords(auditDir), []);
  });
});

test("mcp: end to end, a read tool returns the JSON the CLI prints", async () => {
  const auditDir = mkdtempSync(join(tmpdir(), "synology-agent-control-mcp-"));
  await withEnv(fakeTarget(auditDir), async () => {
    const { client, calls } = await connect({}, (call) => {
      assert.equal(call.api, "SYNO.Virtualization.API.Guest");
      return { guests: [{ guest_name: "haos", status: "running" }] };
    });
    const result = await client.callTool({ name: "vms_list", arguments: {} });
    assert.notEqual(result.isError, true, textOf(result));
    const expected = { guests: [{ name: "haos", status: "running" }] };
    assert.equal(textOf(result), JSON.stringify(expected, null, 2));
    assert.equal(calls.length, 1);
  });
});

test("mcp: a missing target is a tool error with the CLI's message, not a crash", async () => {
  await withEnv({ DSM_BASE_URL: undefined, SRM_BASE_URL: undefined }, async () => {
    const { client } = await connect();
    assert.equal((await client.listTools()).tools.length, COMMANDS.length);
    const dsm = await client.callTool({ name: "status", arguments: {} });
    assert.equal(dsm.isError, true);
    assert.equal(textOf(dsm), "Missing required env: DSM_BASE_URL");
    const srm = await client.callTool({ name: "router_update_check", arguments: {} });
    assert.equal(textOf(srm), "Missing required env: SRM_BASE_URL");
    // Still serving.
    assert.equal((await client.listTools()).tools.length, COMMANDS.length);
  });
});

test("mcp: bad arguments are tool errors", async () => {
  const { client, calls } = await connect();
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["containers_logs", {}, /missing required argument "name"/],
    ["containers_logs", { name: "app", limit: "ten" }, /"limit" must be an integer/],
    ["containers_logs", { name: "app", lines: 5 }, /unknown argument "lines"/],
    ["packages_control", { name: "x", action: "pause", confirm: true }, /must be one of start, stop, restart/],
    ["no_such_tool", {}, /Unknown tool: no_such_tool/],
  ];
  for (const [name, args, message] of cases) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    assert.match(textOf(result), message);
  }
  assert.equal(calls.length, 0);
});

test("mcp: the stdio subcommand speaks only protocol on stdout, with no target configured", async () => {
  const stray: Error[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(HERE, "cli.ts"), "mcp", "--read-only"],
    cwd: join(HERE, ".."),
    // No DSM_* or SRM_* variables: the server must start and list tools anyway.
    env: { PATH: process.env.PATH ?? "", HOME: mkdtempSync(join(tmpdir(), "synology-agent-control-home-")) },
    stderr: "pipe",
  });
  // A stdout line that is not a JSON-RPC message surfaces here.
  transport.onerror = (err) => stray.push(err);
  let stderr = "";
  transport.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  const client = new Client({ name: "test", version: "0" });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, SERVER_NAME);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      COMMANDS.filter((c) => !c.mutating).map(toolName)
    );
    const result = await client.callTool({ name: "status", arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "Missing required env: DSM_BASE_URL");
  } finally {
    await client.close();
  }
  assert.deepEqual(stray, []);
  assert.match(stderr, /MCP server .* on stdio \(read-only\)/);
});
