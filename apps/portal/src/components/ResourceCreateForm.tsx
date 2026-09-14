// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Boxes, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ResourceDocument, ResourceRevisionDocument } from "@/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export type CreatedResource = ResourceDocument & { firstRevision?: ResourceRevisionDocument };

interface ResourceCreateFormProps {
  onCreated?: (resource: CreatedResource) => void;
  onCancel?: () => void;
  className?: string;
  compact?: boolean;
}

export function ResourceCreateForm({ onCreated, onCancel, className, compact = false }: ResourceCreateFormProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [setupBody, setSetupBody] = useState("");
  const [teardownBody, setTeardownBody] = useState("");
  const [exportsText, setExportsText] = useState("");

  const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const humanize = (value: string) =>
    value.replace(/-+/g, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());

  const handleNameChange = (value: string) => {
    setName(value);
    setNameEdited(value.trim().length > 0);
    if (!slugEdited) setSlug(slugify(value));
  };

  const handleSlugChange = (value: string) => {
    const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-");
    setSlug(normalized);
    setSlugEdited(normalized.trim().length > 0);
    if (!nameEdited) setName(humanize(normalized));
  };

  const exportsList = useMemo(() => parseExports(exportsText), [exportsText]);
  const invalidExports = exportsList.filter((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name));

  const resetFields = () => {
    setName("");
    setSlug("");
    setNameEdited(false);
    setSlugEdited(false);
    setDescription("");
    setSetupBody("");
    setTeardownBody("");
    setExportsText("");
  };

  const createMutation = useMutation({
    mutationFn: () => api.createResource({
      name: name.trim(),
      ...(slug.trim() ? { slug: slug.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      setup: { sh: setupBody.trimEnd() },
      ...(teardownBody.trim() ? { teardown: { sh: teardownBody.trimEnd() } } : {}),
      exports: exportsList,
    }),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["resources"] });
      toast.success(`Resource "${created.slug}" created`);
      onCreated?.(created);
      resetFields();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to create resource"),
  });

  const canCreate = name.trim().length > 0
    && setupBody.trim().length > 0
    && invalidExports.length === 0
    && !createMutation.isPending;

  return (
    <div className={cn("space-y-4", className)}>
      <div className={cn("grid gap-4", compact ? "grid-cols-1" : "sm:grid-cols-2")}>
        <div className="space-y-2">
          <Label htmlFor="resource-name">Name *</Label>
          <Input id="resource-name" value={name} onChange={(e) => handleNameChange(e.target.value)} placeholder="GitHub simulator" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="resource-slug">Slug</Label>
          <Input id="resource-slug" value={slug} onChange={(e) => handleSlugChange(e.target.value)} placeholder="auto-generated" className="font-mono" />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="resource-description">Description</Label>
        <Textarea id="resource-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={compact ? 2 : 3} placeholder="What dependency this provisions for a run" />
      </div>

      <div className="space-y-2">
        <Label htmlFor="resource-setup">Setup script *</Label>
        <Textarea
          id="resource-setup"
          value={setupBody}
          onChange={(e) => setSetupBody(e.target.value)}
          rows={compact ? 5 : 9}
          className="font-mono text-xs"
          placeholder={'docker run -d --name github-sim ...\nprintf "SIMULATOR_URL=http://localhost:8080\\n" >> "$SCOPE_SETUP_ENV"'}
        />
        <p className="text-xs text-muted-foreground">Runs with <span className="font-mono">sh -e</span> and publishes connection details through <span className="font-mono">$SCOPE_SETUP_ENV</span>.</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="resource-teardown">Teardown script</Label>
        <Textarea
          id="resource-teardown"
          value={teardownBody}
          onChange={(e) => setTeardownBody(e.target.value)}
          rows={compact ? 3 : 6}
          className="font-mono text-xs"
          placeholder="docker rm -f github-sim >/dev/null 2>&1 || true"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="resource-exports">Exports</Label>
        <Textarea
          id="resource-exports"
          value={exportsText}
          onChange={(e) => setExportsText(e.target.value)}
          rows={compact ? 2 : 3}
          className="font-mono text-xs"
          placeholder={"SIMULATOR_URL\nSIM_TOKEN"}
        />
        <p className="text-xs text-muted-foreground">Enter environment variable names separated by commas, spaces, or new lines.</p>
        {invalidExports.length > 0 && (
          <p className="text-xs text-destructive">Invalid export name{invalidExports.length === 1 ? "" : "s"}: {invalidExports.join(", ")}</p>
        )}
      </div>

      <div className="flex justify-end gap-2">
        {onCancel && <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>}
        <Button type="button" size="sm" className="gap-1.5" disabled={!canCreate} onClick={() => createMutation.mutate()}>
          {createMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : compact ? <Plus className="h-3.5 w-3.5" /> : <Boxes className="h-3.5 w-3.5" />}
          Create resource
        </Button>
      </div>
    </div>
  );
}

function parseExports(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean))];
}
