// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useStrictAgentCapabilities(): boolean {
  const { data } = useQuery({
    queryKey: ["api-configuration"],
    queryFn: api.getConfiguration,
    staleTime: 60_000,
  });
  return data?.strictAgentCapabilities ?? false;
}
