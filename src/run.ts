/**
 * The one path from a resolved command to its handler, shared by the CLI and
 * the MCP server. Each front end parses its own input into positional
 * arguments and flags; everything after that is here, so the write gate,
 * target loading, and the handlers (with their audit records) cannot differ
 * between the two.
 */

import { loadRuntimeConfig, loadTarget, type TargetConfig } from "./config.js";
import { SynoClient } from "./client.js";
import {
  UsageError,
  requiresConfirmation,
  selectPlatform,
  validateInvocation,
  type RegisteredCommand,
} from "./commands.js";

export type Flags = Record<string, string | true>;

export interface RunOptions {
  /** Builds the device client. Tests substitute a stub. */
  createClient?: (target: TargetConfig, opts: { verbose: boolean }) => SynoClient;
}

/** Whether the caller passed the confirmation flag (`--yes`, MCP `confirm`). */
export function isConfirmed(flags: Flags): boolean {
  return flags.yes === true || flags.yes === "true";
}

/** True when this invocation may change device state and was not confirmed. */
export function needsConfirmation(
  command: RegisteredCommand,
  args: string[],
  flags: Flags
): boolean {
  return requiresConfirmation(command, flags, args) && !isConfirmed(flags);
}

/** What NODE_TLS_REJECT_UNAUTHORIZED held before any target touched it. */
const TLS_ENV_AT_START = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

/**
 * A target that opts out of certificate checks turns them off process-wide.
 * The CLI runs one command per process, so that covers only its target. The
 * MCP server outlives a call, so the setting is put back for a target that
 * did not opt out, and the server runs one call at a time. A per-fetch undici
 * dispatcher was tried upstream and reverted: it interacted badly with Node's
 * built-in fetch (intermittent "fetch failed" and silently-empty responses).
 */
function applyTlsPolicy(target: TargetConfig): void {
  if (target.tlsSkipVerify) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  else if (TLS_ENV_AT_START === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = TLS_ENV_AT_START;
}

/**
 * Validate, load the one target the command uses, and run the handler.
 * Validation comes first so a bad invocation never loads credentials. The
 * caller checks `needsConfirmation` between its own parsing and this call
 * because the refusal is worded per front end.
 */
export async function runCommand(
  command: RegisteredCommand,
  args: string[],
  flags: Flags,
  opts: RunOptions = {}
): Promise<unknown> {
  validateInvocation(command, args, flags);
  if (needsConfirmation(command, args, flags)) {
    throw new UsageError(`"${command.name}" may change device state and was not confirmed`);
  }
  const runtime = loadRuntimeConfig();
  const verbose = flags.verbose === true || flags.verbose === "true";
  const platform = selectPlatform(command, flags);
  let target;
  try {
    target = loadTarget(platform);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Missing required env:")) {
      throw new UsageError(err.message);
    }
    throw err;
  }
  applyTlsPolicy(target);
  const client = opts.createClient
    ? opts.createClient(target, { verbose })
    : new SynoClient(target, { verbose });
  return command.run({ runtime, target, client, args, flags });
}
