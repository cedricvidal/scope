// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { api } from "@/lib/api";
import type { ResourceDocument, ResourceRevisionDocument } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ResourceCreateForm } from "@/components/ResourceCreateForm";

interface ResourcePickerProps {
  selected: string[];
  onChange: (specs: string[]) => void;
  disabled?: boolean;
}

function parseResourceSpec(spec: string): { slug: string; revisionRef?: string } {
  const at = spec.lastIndexOf("@r");
  if (at > 0) return { slug: spec.substring(0, at), revisionRef: spec };
  return { slug: spec };
}

export function ResourcePicker({ selected, onChange, disabled = false }: ResourcePickerProps) {
  const queryClient = useQueryClient();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);

  const { data: resources = [], isLoading } = useQuery({ queryKey: ["resources"], queryFn: () => api.listResources() });
  const activeResources = useMemo(() => resources.filter((resource: ResourceDocument) => !resource.deletedAt), [resources]);
  const parsedSpecs = useMemo(() => selected.map(parseResourceSpec), [selected]);
  const selectedSlugs = useMemo(() => new Set(parsedSpecs.map((spec) => spec.slug)), [parsedSpecs]);

  const matches = useMemo(() => {
    const available = activeResources.filter((resource) => !selectedSlugs.has(resource.slug) && !selectedSlugs.has(resource._id));
    if (!query.trim()) return available.slice(0, 8);
    const q = query.toLowerCase();
    return available.filter((resource) => `${resource.slug} ${resource.name} ${resource.description ?? ""}`.toLowerCase().includes(q));
  }, [activeResources, query, selectedSlugs]);

  useEffect(() => setHighlightIdx(0), [matches.length]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const addResource = (resource: ResourceDocument) => {
    onChange([...selected, resource.slug]);
    setQuery("");
    setOpen(false);
    inputRef.current?.focus();
  };

  const replaceSpec = (index: number, spec: string) => {
    onChange(selected.map((current, i) => i === index ? spec : current));
  };

  const removeSpec = (index: number) => {
    onChange(selected.filter((_, i) => i !== index));
  };

  const showDropdown = open && (matches.length > 0 || query.trim().length > 0);

  if (isLoading) return <Skeleton className="h-9 w-full" />;

  return (
    <div ref={containerRef} className="relative space-y-2">
      {selected.length === 0 ? (
        <div className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          None selected — runs provision no additional lifecycle resources.
        </div>
      ) : (
        <div className="space-y-2">
          {selected.map((spec, index) => (
            <SelectedResource
              key={`${spec}-${index}`}
              spec={spec}
              resources={activeResources}
              disabled={disabled}
              onReplace={(next) => replaceSpec(index, next)}
              onRemove={() => removeSpec(index)}
            />
          ))}
        </div>
      )}

      {!disabled && (
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setHighlightIdx((i) => Math.min(i + 1, matches.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setHighlightIdx((i) => Math.max(i - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); const item = matches[highlightIdx]; if (item) addResource(item); }
              else if (e.key === "Escape") setOpen(false);
            }}
            placeholder="Search resources…"
            className="h-9 pl-9 font-mono text-sm"
          />
        </div>
      )}

      {showDropdown && (
        <div className="absolute top-full z-50 mt-1 w-full rounded-md border bg-popover shadow-md">
          <div className="max-h-64 overflow-y-auto p-1">
            {matches.map((resource, idx) => (
              <button
                key={resource._id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => addResource(resource)}
                onMouseEnter={() => setHighlightIdx(idx)}
                className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors ${idx === highlightIdx ? "bg-accent text-accent-foreground" : ""}`}
              >
                <Boxes className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="shrink-0 font-mono font-medium">{resource.slug}</span>
                <Badge variant="outline" className="text-[10px]">{resource.latestRevisionNumber ? `r${resource.latestRevisionNumber}` : "no revisions"}</Badge>
                <span className="truncate text-xs text-muted-foreground">{resource.name}</span>
              </button>
            ))}
            {matches.length === 0 && <div className="p-3 text-center text-sm text-muted-foreground">No matching resources found</div>}
          </div>
        </div>
      )}

      {!disabled && (
        <div className="mt-1.5">
          <button type="button" onClick={() => setCreateOpen(!createOpen)} className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
            {createOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            Create a resource
          </button>
          {createOpen && (
            <div className="mt-2 rounded-md border bg-muted/30 p-3">
              <ResourceCreateForm
                compact
                onCreated={(created) => {
                  setCreateOpen(false);
                  queryClient.setQueryData<ResourceDocument[]>(["resources"], (old) => {
                    if (!old) return [created];
                    return old.some((resource) => resource._id === created._id) ? old : [created, ...old];
                  });
                  queryClient.invalidateQueries({ queryKey: ["resources"] });
                  onChange([...selected, created.firstRevision?.ref ?? created.slug]);
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SelectedResource({
  spec,
  resources,
  disabled,
  onReplace,
  onRemove,
}: {
  spec: string;
  resources: ResourceDocument[];
  disabled: boolean;
  onReplace: (spec: string) => void;
  onRemove: () => void;
}) {
  const parsed = useMemo(() => parseResourceSpec(spec), [spec]);
  const resource = useMemo(
    () => resources.find((candidate) => candidate.slug === parsed.slug || candidate._id === parsed.slug) ?? null,
    [parsed.slug, resources],
  );
  const { data: revisions = [], isLoading } = useQuery({
    queryKey: ["resource-revisions", resource?.slug],
    queryFn: () => api.listResourceRevisions(resource!.slug, 20),
    enabled: !!resource,
  });

  if (!resource) {
    return (
      <div className="flex items-center gap-2 rounded-md border p-2">
        <Boxes className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="flex-1 font-mono text-xs">{spec}</span>
        <Badge variant="secondary" className="text-[10px]">resolved revision</Badge>
        {!disabled && <X className="h-3 w-3 cursor-pointer text-muted-foreground hover:text-destructive" onClick={onRemove} />}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border p-2">
      <div className="flex items-center gap-1.5">
        <Boxes className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="font-mono text-xs font-medium">{resource.slug}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{resource.name}</span>
        {!disabled && <X className="h-3 w-3 cursor-pointer text-muted-foreground hover:text-destructive" onClick={onRemove} />}
      </div>
      <div className="space-y-1 pl-6">
        <Label className="text-xs">Revision</Label>
        <Select value={parsed.revisionRef ?? "__latest__"} onValueChange={(value) => onReplace(value === "__latest__" ? resource.slug : value)} disabled={disabled}>
          <SelectTrigger className="h-8 w-full text-xs font-mono"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__latest__">latest at submit ({resource.latestRevisionNumber ? `${resource.slug}@r${resource.latestRevisionNumber}` : "no revisions yet"})</SelectItem>
            {isLoading && <SelectItem value="__loading__" disabled>Loading…</SelectItem>}
            {revisions.map((revision: ResourceRevisionDocument) => (
              <SelectItem key={revision._id} value={revision.ref}>
                {revision.ref}{revision._id === resource.latestRevisionId ? " (latest)" : ""} — {revision.exports.length} export{revision.exports.length === 1 ? "" : "s"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">Bare selections pin the latest revision when the run is submitted.</p>
      </div>
    </div>
  );
}
