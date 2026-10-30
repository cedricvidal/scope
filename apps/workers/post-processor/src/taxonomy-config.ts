// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/** Provider-resolved model selection used when Taxonome has prompt elements. */
export const DEFAULT_TAXONOME_MODEL = "auto";

/** Resolves the dedicated Taxonome model independently from coding-run fields. */
export function resolveTaxonomeModel(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.TAXONOME_MODEL?.trim() || DEFAULT_TAXONOME_MODEL;
}
