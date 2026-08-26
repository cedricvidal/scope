// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Capability metadata is advisory unless the API enables strict enforcement.
 */
export function isAgentCapabilityEnabled(
  advertised: boolean | undefined,
  strict: boolean,
): boolean {
  return !strict || advertised === true;
}
