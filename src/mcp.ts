/**
 * MCP server: the command registry served as Model Context Protocol tools.
 *
 * Nothing here defines a command. Each tool is generated from one entry of
 * `COMMANDS`, takes its input schema from `commandInputs`, and is executed by
 * `runCommand`, the same path the CLI uses. A tool returns the JSON the CLI
 * would print.
 *
 * The write gate is the CLI's, with `confirm: true` standing in for `--yes`.
 * In read-only mode the mutating tools are not registered at all and `raw`
 * refuses any call the gate would have asked to confirm.
 *
 * stdout belongs to the protocol in stdio mode. Progress, traces, and errors
 * go to stderr, as they do for the CLI.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { errorMessage } from "./client.js";
import {
  COMMANDS,
  UsageError,
  commandInputs,
  requiresConfirmation,
  type CommandInput,
  type RegisteredCommand,
} from "./commands.js";
import { isConfirmed, runCommand, type Flags, type RunOptions } from "./run.js";
import { VERSION } from "./version.js";

export const SERVER_NAME = "synology-agent-control";

export interface McpOptions extends RunOptions {
  /** Register no mutating tool, and refuse `raw` calls that are not reads. */
  readOnly?: boolean;
}

/** "shares snapshot-config" → "shares_snapshot_config". */
export function toolName(command: RegisteredCommand): string {
  return command.name.replace(/[^A-Za-z0-9]+/g, "_");
}

/** `raw` is not marked mutating, but it can reach any endpoint. */
const mayMutate = (command: RegisteredCommand) =>
  Boolean(command.mutating) || command.name === "raw";

/** The commands served in this mode. */
export function servedCommands(opts: McpOptions = {}): RegisteredCommand[] {
  return COMMANDS.filter((command) => !(opts.readOnly && command.mutating));
}

function inputProperty(input: CommandInput): Record<string, unknown> & object {
  const description = input.description ? { description: input.description } : {};
  switch (input.type) {
    case "boolean":
      return { type: "boolean", ...description };
    case "integer":
      return { type: "integer", ...description };
    case "json":
      return { type: "object", additionalProperties: true, ...description };
    case "strings":
      return { type: "array", items: { type: "string" }, ...description };
    default:
      return {
        type: "string",
        ...(input.choices ? { enum: input.choices } : {}),
        ...description,
      };
  }
}

const CONFIRM_HELP =
  "Must be true to run. This tool may change device state and nothing else asks for confirmation.";
const RAW_CONFIRM_HELP =
  "Must be true for POST and for any method that is not a known read. Such a call may change device state.";
const RAW_READ_ONLY_NOTE =
  " This server is read-only: POST and any method that is not a known read are refused.";

export function toolFor(command: RegisteredCommand, opts: McpOptions = {}): Tool {
  const inputs = commandInputs(command);
  const properties: Record<string, object> = {};
  for (const input of inputs) properties[input.key] = inputProperty(input);
  const required = inputs.filter((input) => input.required).map((input) => input.key);
  const gated = mayMutate(command) && !opts.readOnly;
  if (gated) {
    properties.confirm = {
      type: "boolean",
      description: command.mutating ? CONFIRM_HELP : RAW_CONFIRM_HELP,
    };
  }
  const readOnly = !mayMutate(command) || Boolean(opts.readOnly);
  return {
    name: toolName(command),
    description:
      command.summary + (command.name === "raw" && opts.readOnly ? RAW_READ_ONLY_NOTE : ""),
    inputSchema: {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: readOnly,
      // The registry does not grade writes, so every one is declared
      // destructive. A client that prompts on the hint prompts for all of them.
      ...(readOnly ? {} : { destructiveHint: true }),
      ...(command.mutating ? { idempotentHint: Boolean(command.idempotent) } : {}),
    },
  };
}

/**
 * Turn MCP arguments into the positional arguments and flags the command
 * declares. The schema is advisory to the client, so types are checked again
 * here; `validateInvocation` then applies the CLI's own rules.
 */
export function toInvocation(
  command: RegisteredCommand,
  input: Record<string, unknown>
): { args: string[]; flags: Flags } {
  const inputs = commandInputs(command);
  const known = new Set([...inputs.map((i) => i.key), "confirm"]);
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      throw new UsageError(`unknown argument "${key}" for "${toolName(command)}"`);
    }
  }
  const args: string[] = [];
  const variadic: string[] = [];
  const flags: Flags = {};
  for (const spec of inputs) {
    const value = input[spec.key];
    if (value === undefined || value === null) {
      if (spec.source === "arg") throw new UsageError(`missing required argument "${spec.key}"`);
      continue;
    }
    const wrong = (expected: string) =>
      new UsageError(`argument "${spec.key}" must be ${expected}`);
    switch (spec.type) {
      case "boolean":
        if (typeof value !== "boolean") throw wrong("a boolean");
        if (value) flags[spec.name] = true;
        break;
      case "integer":
        if (typeof value !== "number" || !Number.isInteger(value)) throw wrong("an integer");
        flags[spec.name] = String(value);
        break;
      case "json":
        if (typeof value !== "object" || Array.isArray(value)) throw wrong("an object");
        flags[spec.name] = JSON.stringify(value);
        break;
      case "strings":
        if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
          throw wrong("an array of strings");
        }
        variadic.push(...(value as string[]));
        break;
      default:
        if (typeof value !== "string") throw wrong("a string");
        if (spec.choices && !spec.choices.includes(value)) {
          throw wrong(`one of ${spec.choices.join(", ")}`);
        }
        if (spec.source === "arg") args.push(value);
        else flags[spec.name] = value;
    }
  }
  if (input.confirm !== undefined && typeof input.confirm !== "boolean") {
    throw new UsageError(`argument "confirm" must be a boolean`);
  }
  if (input.confirm === true) flags.yes = true;
  return { args: [...args, ...variadic], flags };
}

const text = (body: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text: body }],
  ...(isError ? { isError: true } : {}),
});

/** Run one tool call. Every failure comes back as a tool error, never a throw,
 *  so a missing credential or an unreachable device cannot take the server down. */
export async function callTool(
  name: string,
  input: Record<string, unknown>,
  opts: McpOptions = {}
): Promise<CallToolResult> {
  const command = servedCommands(opts).find((c) => toolName(c) === name);
  if (!command) {
    const hidden = COMMANDS.some((c) => toolName(c) === name);
    return text(
      hidden
        ? `"${name}" changes device state and this server is read-only.`
        : `Unknown tool: ${name}`,
      true
    );
  }
  try {
    const { args, flags } = toInvocation(command, input);
    if (requiresConfirmation(command, flags, args)) {
      if (opts.readOnly) {
        return text(
          `Refusing to run "${name}": this server is read-only and this call may change device state.`,
          true
        );
      }
      if (!isConfirmed(flags)) {
        return text(
          `Refusing to run "${name}" without confirm: true.\n` +
            `This tool may change device state. Call it again with confirm: true to confirm.`,
          true
        );
      }
    }
    const result = await runCommand(command, args, flags, opts);
    return text(JSON.stringify(result, null, 2));
  } catch (err) {
    return text(errorMessage(err), true);
  }
}

const INSTRUCTIONS =
  "Tools for one Synology NAS (DSM) and, where configured, one SRM router. Every tool returns JSON. " +
  "A tool that changes device state refuses to run unless called with confirm: true. " +
  "Ask the user before confirming, and make one change at a time. " +
  "Use raw only for an endpoint no named tool covers.";

export function createServer(opts: McpOptions = {}): Server {
  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );
  const tools = servedCommands(opts).map((command) => toolFor(command, opts));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  // One call at a time. A login must not race another for the same TOTP code,
  // and a target's certificate opt-out is a process-wide setting for the
  // length of its call (see `applyTlsPolicy`).
  let queue: Promise<unknown> = Promise.resolve();
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const run = queue.then(() =>
      callTool(request.params.name, request.params.arguments ?? {}, opts)
    );
    queue = run.catch(() => undefined);
    return run;
  });
  return server;
}

export async function serveStdio(opts: McpOptions = {}): Promise<void> {
  // Anything written to stdout outside the transport would corrupt the stream.
  console.log = console.error;
  const server = createServer(opts);
  await server.connect(new StdioServerTransport());
  console.error(
    `[${SERVER_NAME}] MCP server ${VERSION} on stdio${opts.readOnly ? " (read-only)" : ""}`
  );
}
