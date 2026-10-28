// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Network, Plus, Trash2 } from "lucide-react";
import { parse as parseYaml } from "yaml";
import { api } from "@/lib/api";
import type {
  TaxonomyDocument,
  TaxonomyElementDocument,
  TaxonomyElementRevisionDocument,
} from "@/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

const EMPTY_TAXONOMY = `schema_version: scope/taxonomy/v1
id: my-taxonomy
version: 1.0.0
surfaces: []
elements:
  - ref: beh-discovered@r1
`;

/** Project taxonomy management with immutable revisions and read-only built-ins. */
export function TaxonomyList() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [yaml, setYaml] = useState(EMPTY_TAXONOMY);
  const [expanded, setExpanded] = useState<string>();
  const [editingElement, setEditingElement] = useState<{
    root: TaxonomyElementDocument;
    revision: TaxonomyElementRevisionDocument;
  }>();
  const [prompt, setPrompt] = useState("");
  const { data: taxonomies = [], isLoading } = useQuery({
    queryKey: ["taxonomies"],
    queryFn: api.listTaxonomies,
  });
  const { data: revisions = [] } = useQuery({
    queryKey: ["taxonomies", expanded, "revisions"],
    queryFn: () => api.listTaxonomyRevisions(expanded!),
    enabled: Boolean(expanded),
  });
  const { data: elements = [] } = useQuery({
    queryKey: ["taxonomy-elements"],
    queryFn: api.listTaxonomyElements,
  });

  const create = useMutation({
    mutationFn: () =>
      api.createTaxonomy({ name, content: parseYaml(yaml) as unknown }),
    onSuccess: () => {
      setCreateOpen(false);
      setName("");
      queryClient.invalidateQueries({ queryKey: ["taxonomies"] });
      toast.success("Taxonomy created");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Creation failed"),
  });
  const remove = useMutation({
    mutationFn: api.deleteTaxonomy,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["taxonomies"] });
      toast.success("Taxonomy deleted");
    },
  });
  const copy = useMutation({
    mutationFn: async (taxonomy: TaxonomyDocument) => {
      const exact = await api.listTaxonomyRevisions(taxonomy._id);
      const latest = exact[0];
      if (!latest) throw new Error("Built-in taxonomy has no revision");
      return api.copyTaxonomyRevision(latest._id, {
        name: `${taxonomy.name} copy`,
        id: `${taxonomy.id}-copy`,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["taxonomies"] });
      toast.success("Built-in taxonomy copied");
    },
  });
  const reviseElement = useMutation({
    mutationFn: async () => {
      if (!editingElement) throw new Error("No element selected");
      return api.createTaxonomyElementRevision(editingElement.root._id, {
        id: editingElement.revision.id,
        label: editingElement.revision.label,
        ...(editingElement.revision.description
          ? { description: editingElement.revision.description }
          : {}),
        implementation: { type: "prompt", prompt },
        preconditions: editingElement.revision.preconditions,
        output: editingElement.revision.output,
      });
    },
    onSuccess: () => {
      setEditingElement(undefined);
      queryClient.invalidateQueries({ queryKey: ["taxonomy-elements"] });
      toast.success("Prompt element revision created");
    },
  });

  async function editPromptElement(root: TaxonomyElementDocument) {
    const exact = await api.listTaxonomyElementRevisions(root._id);
    const revision = exact[0];
    if (!revision || revision.implementation.type !== "prompt") {
      toast.info("Deterministic code elements are read-only");
      return;
    }
    setPrompt(revision.implementation.prompt);
    setEditingElement({ root, revision });
  }

  return (
    <div className="container space-y-6 py-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Network className="h-6 w-6" /> Taxonomies
          </h1>
          <p className="text-sm text-muted-foreground">
            Manage project-scoped Taxonome definitions and exact immutable revisions.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" /> New taxonomy
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading taxonomies…</p>
      ) : (
        <div className="grid gap-4">
          {taxonomies.map((taxonomy) => (
            <Card key={taxonomy._id}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      {taxonomy.name}
                      <Badge variant={taxonomy.sourceType === "builtin" ? "secondary" : "outline"}>
                        {taxonomy.sourceType === "builtin" ? "Built-in · read-only" : "User"}
                      </Badge>
                    </CardTitle>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      {taxonomy.id}{taxonomy.latestRevision ? `@r${taxonomy.latestRevision}` : ""}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setExpanded(expanded === taxonomy._id ? undefined : taxonomy._id)}>
                      Revisions
                    </Button>
                    {taxonomy.sourceType === "builtin" ? (
                      <Button variant="outline" size="sm" onClick={() => copy.mutate(taxonomy)}>
                        <Copy className="mr-2 h-4 w-4" /> Copy
                      </Button>
                    ) : (
                      <Button variant="ghost" size="icon" aria-label={`Delete ${taxonomy.name}`} onClick={() => remove.mutate(taxonomy._id)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}

                    <section className="space-y-3">
                      <div>
                        <h2 className="text-xl font-semibold">Elements</h2>
                        <p className="text-sm text-muted-foreground">
                          Prompt elements can append revisions. Built-in and deterministic code elements are read-only.
                        </p>
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        {elements.map((element) => (
                          <Card key={element._id}>
                            <CardContent className="flex items-center justify-between gap-4 p-4">
                              <div>
                                <p className="font-medium">{element.name}</p>
                                <p className="font-mono text-xs text-muted-foreground">
                                  {element.id}@r{element.latestRevision}
                                </p>
                              </div>
                              <div className="flex items-center gap-2">
                                <Badge variant="outline">
                                  {element.sourceType === "builtin" ? "Built-in · read-only" : "User"}
                                </Badge>
                                {element.sourceType === "user" && (
                                  <Button size="sm" variant="outline" onClick={() => void editPromptElement(element)}>
                                    Edit prompt
                                  </Button>
                                )}
                              </div>
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                    </section>
                  </div>
                </div>
              </CardHeader>
              {expanded === taxonomy._id && (
                <CardContent className="space-y-2 border-t pt-4">
                  {revisions.map((revision) => (
                    <div key={revision._id} className="flex items-center justify-between rounded-md border p-3 text-sm">
                      <span className="font-mono">{revision.ref}</span>
                      <span className="font-mono text-xs text-muted-foreground">{revision.contentSha256.slice(0, 12)}</span>
                    </div>
                  ))}
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="grid max-h-[85vh] max-w-3xl grid-rows-[auto_minmax(0,1fr)]">
          <DialogHeader><DialogTitle>Create taxonomy</DialogTitle></DialogHeader>
          <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
            <div className="space-y-2">
              <Label htmlFor="taxonomy-name">Name</Label>
              <Input id="taxonomy-name" value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="taxonomy-yaml">Portable YAML</Label>
              <Textarea id="taxonomy-yaml" className="min-h-80 font-mono text-xs" value={yaml} onChange={(event) => setYaml(event.target.value)} />
            </div>
            <div className="sticky bottom-0 flex justify-end border-t bg-background py-3">
              <Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
                Create revision 1
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editingElement)} onOpenChange={(open) => !open && setEditingElement(undefined)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>Edit prompt element</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Textarea className="min-h-80 font-mono text-xs" value={prompt} onChange={(event) => setPrompt(event.target.value)} />
            <div className="flex justify-end">
              <Button disabled={!prompt.trim() || reviseElement.isPending} onClick={() => reviseElement.mutate()}>
                Create new revision
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
