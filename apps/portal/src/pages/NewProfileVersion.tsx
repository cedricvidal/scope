// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isRoutableAgent, type CodingAgent, type McpServerDocument } from "@/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { SkillPicker } from "@/components/SkillPicker";
import { ExtensionPicker } from "@/components/ExtensionPicker";
import { useModelCapabilities, useReasoningEffort, ReasoningEffortSelect, ModelSelectItems } from "@/components/ReasoningEffortSelect";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { isAgentCapabilityEnabled } from "@/lib/agent-capabilities";
import { useStrictAgentCapabilities } from "@/hooks/useApiConfiguration";

export function NewProfileVersion() {
  const { profileId } = useParams<{ profileId: string }>();
  const navigate = useNavigate();

  // Configuration fields
  const [worker, setWorker] = useState("");
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [selectedAgentVersion, setSelectedAgentVersion] = useState("");
  const [selectedMcpServers, setSelectedMcpServers] = useState<string[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [selectedExtensions, setSelectedExtensions] = useState<string[]>([]);
  const strictAgentCapabilities = useStrictAgentCapabilities();

  // Fetch profile to pre-fill from latest version
  const { data: profile, isLoading: profileLoading } = useQuery({
    queryKey: ["profile", profileId],
    queryFn: () => api.getProfile(profileId!),
    enabled: !!profileId,
  });

  // Fetch agents (workers)
  const { data: agents = [] } = useQuery({
    queryKey: ["agents"],
    queryFn: api.listAgents,
  });

  // Fetch MCP servers
  const { data: mcpServers = [] } = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: api.listMcpServers,
  });

  // Pre-fill from latest version
  useEffect(() => {
    if (profile?.version) {
      setWorker(profile.version.workerType);
      setModel(profile.version.model);
      setReasoningEffort(profile.version.reasoningEffort ?? "");
      setSelectedAgentVersion(profile.version.agentVersion ?? "");
      setSelectedMcpServers(profile.version.mcpServers ?? []);
      setSelectedSkills(profile.version.skillRevisions ?? []);
      setSelectedExtensions(profile.version.extensions ?? []);
    }
  }, [profile]);

  // Find selected agent for model/version lists
  const availableAgents = agents.filter(isRoutableAgent);
  const selectedAgent = availableAgents.find((a: CodingAgent) => a._id === worker);
  const supportsMcpServers = isAgentCapabilityEnabled(
    selectedAgent?.capabilities?.supportsMcpServers,
    strictAgentCapabilities,
  );
  const supportsSkills = isAgentCapabilityEnabled(
    selectedAgent?.capabilities?.supportsSkills,
    strictAgentCapabilities,
  );
  const supportsExtensions = isAgentCapabilityEnabled(
    selectedAgent?.capabilities?.supportsExtensions,
    strictAgentCapabilities,
  );
  const supportsReasoningEffort = isAgentCapabilityEnabled(
    selectedAgent?.capabilities?.supportsReasoningEffort,
    strictAgentCapabilities,
  );

  // Model capabilities and effort management
  const { capabilitiesMap, activeModelIds } = useModelCapabilities(worker || undefined);
  const supportedModels = activeModelIds.length > 0
    ? activeModelIds
    : (selectedAgent?.supportedModels ?? []);
  const onEffortChange = useCallback((v: string) => setReasoningEffort(v), []);
  const { supportedEfforts, workerEffortWarning } = useReasoningEffort({
    model,
    capabilitiesMap,
    value: reasoningEffort,
    onChange: onEffortChange,
    agentSupportsEffort: supportsReasoningEffort,
  });

  // Clear optional features that the selected worker does not support.
  useEffect(() => {
    if (!supportsMcpServers) setSelectedMcpServers([]);
    if (!supportsSkills) setSelectedSkills([]);
    if (!supportsExtensions) setSelectedExtensions([]);
  }, [supportsExtensions, supportsMcpServers, supportsSkills]);

  // Fetch agent versions
  const { data: agentVersions = [] } = useQuery({
    queryKey: ["agent-versions", worker],
    queryFn: () => api.listAgentVersions(worker),
    enabled: !!worker,
  });

  const sortedVersions = [...agentVersions].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  const createVersionMutation = useMutation({
    mutationFn: () => api.createProfileVersion(profileId!, {
      workerType: worker,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(selectedAgentVersion ? { agentVersion: selectedAgentVersion } : {}),
      ...(selectedMcpServers.length > 0 ? { mcpServers: selectedMcpServers } : {}),
      ...(selectedSkills.length > 0 ? { skillRevisions: selectedSkills } : {}),
      ...(selectedExtensions.length > 0 ? { extensions: selectedExtensions } : {}),
    }),
    onSuccess: (data) => {
      toast.success(`Created version ${data.version} of profile`);
      navigate(`/profiles/${profileId}`);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to create version");
    },
  });

  if (profileLoading) {
    return (
      <div className="space-y-6 max-w-3xl">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" onClick={() => navigate("/profiles")}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back
        </Button>
        <p className="text-muted-foreground">Profile not found.</p>
      </div>
    );
  }

  const ev = profile?.version;
  const hasChanges = !!ev && (
    worker !== ev.workerType ||
    model !== ev.model ||
    (reasoningEffort || "") !== (ev.reasoningEffort || "") ||
    (selectedAgentVersion || "") !== (ev.agentVersion || "") ||
    JSON.stringify([...selectedMcpServers].sort()) !== JSON.stringify([...(ev.mcpServers ?? [])].sort()) ||
    JSON.stringify([...selectedSkills].sort()) !== JSON.stringify([...(ev.skillRevisions ?? [])].sort()) ||
    JSON.stringify([...selectedExtensions].sort()) !== JSON.stringify([...(ev.extensions ?? [])].sort())
  );

  const canSubmit = worker && model && hasChanges;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(`/profiles/${profileId}`)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">New Version</h1>
          <p className="text-muted-foreground">
            Create a new immutable configuration snapshot for <span className="font-medium text-foreground">{profile.name}</span>.
            The previous version is preserved.
          </p>
        </div>
      </div>

      {/* Agent Configuration */}
      <Card>
        <CardHeader>
          <CardTitle>Agent Configuration</CardTitle>
          <CardDescription>Worker, model, and agent version</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="worker">Worker *</Label>
            <Select value={worker} onValueChange={(v) => { setWorker(v); setModel(""); setSelectedAgentVersion(""); }}>
              <SelectTrigger id="worker">
                <SelectValue placeholder="Select a worker" />
              </SelectTrigger>
              <SelectContent>
                {availableAgents.map((a: CodingAgent) => (
                  <SelectItem key={a._id} value={a._id}>{a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {supportedModels.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="model">Model *</Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger id="model">
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  <ModelSelectItems
                    models={supportedModels}
                    capabilitiesMap={capabilitiesMap}
                  />
                </SelectContent>
              </Select>
            </div>
          )}

          <ReasoningEffortSelect
            supportedEfforts={supportedEfforts}
            value={reasoningEffort}
            onChange={onEffortChange}
            workerEffortWarning={workerEffortWarning}
          />

          {sortedVersions.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="agentVersion">Agent Version</Label>
              <Select value={selectedAgentVersion} onValueChange={setSelectedAgentVersion}>
                <SelectTrigger id="agentVersion">
                  <SelectValue placeholder="Select version" />
                </SelectTrigger>
                <SelectContent>
                  {sortedVersions.map((v, i) => (
                    <SelectItem key={v.agentVersion} value={v.agentVersion}>
                      {v.agentVersion}{i === 0 ? " (latest)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </CardContent>
      </Card>

      {/* MCP Servers */}
      {supportsMcpServers && mcpServers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>MCP Servers</CardTitle>
            <CardDescription>Select MCP servers to include in this version</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {mcpServers.map((s: McpServerDocument) => (
                <div key={s._id} className="flex items-center space-x-2">
                  <Checkbox
                    id={`mcp-${s._id}`}
                    checked={selectedMcpServers.includes(s._id)}
                    onCheckedChange={(checked) => {
                      setSelectedMcpServers((prev) =>
                        checked ? [...prev, s._id] : prev.filter((id) => id !== s._id)
                      );
                    }}
                  />
                  <Label htmlFor={`mcp-${s._id}`} className="font-mono text-sm">{s._id}</Label>
                  <span className="text-muted-foreground text-xs">{s.name}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Skills */}
      {supportsSkills && (
        <Card>
          <CardHeader>
            <CardTitle>Skills</CardTitle>
            <CardDescription>Select skills to include — pinned to their current revision</CardDescription>
          </CardHeader>
          <CardContent>
            <SkillPicker selected={selectedSkills} onChange={setSelectedSkills} />
          </CardContent>
        </Card>
      )}

      {/* Extensions */}
      {supportsExtensions && (
        <Card>
          <CardHeader>
            <CardTitle>Extensions</CardTitle>
            <CardDescription>Select VS Code extensions — pinned to their current marketplace version</CardDescription>
          </CardHeader>
          <CardContent>
            <ExtensionPicker selected={selectedExtensions} onChange={setSelectedExtensions} />
          </CardContent>
        </Card>
      )}

      {/* Save */}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => navigate(`/profiles/${profileId}`)}>
          Cancel
        </Button>
        <Button
          onClick={() => createVersionMutation.mutate()}
          disabled={!canSubmit || createVersionMutation.isPending}
        >
          {createVersionMutation.isPending ? (
            <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creating...</>
          ) : (
            <><Save className="mr-2 h-4 w-4" /> Create Version</>
          )}
        </Button>
      </div>
    </div>
  );
}
