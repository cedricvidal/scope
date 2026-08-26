// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";
import { dimTimestamp, label, value } from "./style.js";
import { generateOutputFormatsHelp } from "./helpFormatter.js";

/** Strip trailing slashes from a URL to avoid double-slash issues when appending paths */
export const normalizeUrl = (url: string): string => url.replace(/\/+$/, '');

/**
 * Detect how the CLI was invoked and return the appropriate command prefix.
 * - Bundled binary (SCOPE_CLI_VERSION injected at build time): "scope"
 * - Development via tsx/pnpm (no build-time injection): "pnpm cli"
 */
export function getCliName(): string {
  // In bundled mode, esbuild replaces process.env.SCOPE_CLI_VERSION with a literal string.
  // In dev mode, it remains undefined (read from actual env which is unset).
  if (process.env.SCOPE_CLI_VERSION !== undefined) {
    return "scope";
  }
  return "pnpm cli";
}

export function printFollowUpCommands(id: string): void {
  const cli = getCliName();
  console.log(`\n${label('Run ID:')} ${value(id)}`);
  console.log(`\n${label('Next steps:')}`);
  console.log(`  ${dimTimestamp('Get details:')}   ${cli} run get -i ${id}`);
  console.log(`  ${dimTimestamp('Check status:')}  ${cli} run status -i ${id}`);
  console.log(`  ${dimTimestamp('Stream logs:')}   ${cli} run logs -i ${id}`);
  console.log(`  ${dimTimestamp('Download:')}      ${cli} run download -i ${id}`);
  console.log(`  ${dimTimestamp('List all runs:')} ${cli} run list`);
}

/**
 * Default API URL. Computed lazily so that dotenv and applyApiPortFallback()
 * have a chance to populate process.env before this is read.
 * In dev mode this is localhost; the esbuild bundle replaces
 * SCOPE_DEFAULT_API_URL with the production URL at build time.
 */
export function getDefaultApiUrl(): string {
  return process.env.SCOPE_API_URL || process.env.SCOPE_DEFAULT_API_URL || "http://localhost:3100";
}

// For backward compatibility — used in help text generation at setup time
export const DEFAULT_API_URL: string = process.env.SCOPE_DEFAULT_API_URL || "http://localhost:3100";

// Environment variable definitions surfaced in `--help`
export const ENV_VARS = {
  SCOPE_API_URL: {
    description: 'Default API base URL used by the -u, --url option of every command',
    default: DEFAULT_API_URL,
  },
  SCOPE_API_PORT: {
    description: 'When SCOPE_API_URL is unset, derive it as http://localhost:$SCOPE_API_PORT (useful for local docker-compose setups)',
  },
  SCOPE_MT_DOWNLOAD_OUTPUT_DIR: {
    description: 'Default download directory for `run get` / `run watch` when --download-output-dir is omitted',
  },
  SCOPE_PROJECT: {
    description: 'Project ID used to scope commands when --project is omitted. Overridden by --project; overrides the saved `project use` selection. Required (via one of these) for scoped lists and creates — there is no default project.',
  },
} as const;

/**
 * Derive the default `SCOPE_API_URL` from `SCOPE_API_PORT` when `SCOPE_API_URL`
 * is not already set. Useful for local docker-compose setups where the API
 * port is the only piece of configuration that varies.
 *
 * Mutates `env` in place when a port is present and the port string is purely
 * numeric. Whitespace around `SCOPE_API_PORT` is tolerated; non-numeric values
 * are ignored so a typo doesn't silently produce an unreachable URL.
 *
 * Idempotent: if `SCOPE_API_URL` is already defined, `env` is left untouched.
 */
export function applyApiPortFallback(env: NodeJS.ProcessEnv = process.env): void {
  if (env.SCOPE_API_URL || !env.SCOPE_API_PORT) return;
  const port = env.SCOPE_API_PORT.trim();
  if (!/^\d+$/.test(port)) return;
  env.SCOPE_API_URL = `http://localhost:${port}`;
}

// Output format definitions with descriptions and categories
export const OUTPUT_FORMATS = {
  table: { section: 'Human-readable formats', description: 'Formatted table with borders (default for lists)' },
  tsv:   { section: 'Machine-readable formats', description: 'Tab-separated values for Unix tools (cut, awk, grep, xargs)' },
  json:  { section: 'Machine-readable formats', description: 'JSON format for programmatic access and AI agents' },
  yaml:  { section: 'Machine-readable formats', description: 'YAML format for human-friendly structured data' },
} as const;

/**
 * Add the standard `-o, --output <format>` option to a command.
 * @param cmd - The Commander command to add the option to.
 * @param extra - Additional format names beyond the defaults (table, tsv, json, yaml).
 * @returns The command (for chaining).
 */
export function withOutputOption(cmd: Command, extra?: string[]): Command {
  const formats = ['table', 'tsv', 'json', 'yaml', ...(extra ?? [])];
  return cmd.option("-o, --output <format>", `Output format: ${formats.join(', ')}`, "table");
}

/**
 * Add the standard `--project <id>` option to a scoped command. No short flag is
 * assigned to avoid colliding with per-command shorthands (e.g. `-p`).
 *
 * The option only *carries* an override — commands resolve the effective project
 * via {@link file://./config.ts resolveProjectId}/`requireProjectId`, which falls
 * back to `SCOPE_PROJECT` then the saved `project use` selection. There is no
 * default project, so scoped lists/creates error when none resolves.
 *
 * @param cmd - The Commander command to add the option to.
 * @returns The command (for chaining).
 */
export function withProjectOption(cmd: Command): Command {
  return cmd.option(
    "--project <id>",
    "Project ID for scoped operations (overrides SCOPE_PROJECT and the saved selection)",
  );
}
