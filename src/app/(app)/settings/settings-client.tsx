"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, CheckCircle2, XCircle, RefreshCw, Save, KeyRound, Plus, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/use-toast";

type Settings = {
  wabaId: string;
  metaAppId: string;
  phoneNumberId: string;
  phoneNumberDisplay: string;
  businessName: string;
  apiVersion: string;
  webhookVerifyToken: string;
  accessTokenSet: boolean;
  accessTokenMasked: string;
  appSecretSet: boolean;
  callbackUrl: string;
  connected: boolean;
};
type FlowKey = { configured: boolean; fingerprint: string | null; registeredAt: string | null };
type FlowConnector = { id: string; name: string; baseUrl: string; allowedHosts: string[]; authType: string; credentialsSet: boolean };

export function SettingsClient({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ["settings", tenantId],
    queryFn: () => apiFetch<Settings>(`/api/tenants/${tenantId}/settings`),
  });
  const { data: flowKey } = useQuery({
    queryKey: ["flow-key", tenantId],
    queryFn: () => apiFetch<FlowKey>(`/api/tenants/${tenantId}/settings/flow-key`),
  });
  const { data: connectors = [] } = useQuery({
    queryKey: ["flow-connectors"],
    queryFn: () => apiFetch<FlowConnector[]>("/api/flow-connectors"),
  });

  const [form, setForm] = useState({
    wabaId: "",
    metaAppId: "",
    phoneNumberId: "",
    apiVersion: "v21.0",
    webhookVerifyToken: "",
    accessToken: "",
    appSecret: "",
  });
  const [testResult, setTestResult] = useState<{ success: boolean; message?: string } | null>(null);
  const [connector, setConnector] = useState({ name: "", baseUrl: "", authType: "NONE", token: "", username: "", password: "", headerName: "", headerValue: "" });

  useEffect(() => {
    if (data) {
      setForm({
        wabaId: data.wabaId ?? "",
        metaAppId: data.metaAppId ?? "",
        phoneNumberId: data.phoneNumberId ?? "",
        apiVersion: data.apiVersion ?? "v21.0",
        webhookVerifyToken: data.webhookVerifyToken ?? "",
        accessToken: "",
        appSecret: "",
      });
    } else {
      setForm({
        wabaId: "",
        metaAppId: "",
        phoneNumberId: "",
        apiVersion: "v21.0",
        webhookVerifyToken: "",
        accessToken: "",
        appSecret: "",
      });
    }
    setTestResult(null);
  }, [data, tenantId]);

  const save = useMutation({
    mutationFn: () => apiFetch(`/api/tenants/${tenantId}/settings`, { method: "PUT", body: JSON.stringify(form) }),
    onSuccess: () => {
      toast({ title: "Settings saved" });
      setForm((f) => ({ ...f, accessToken: "", appSecret: "" }));
      qc.invalidateQueries({ queryKey: ["settings", tenantId] });
    },
    onError: (e: Error) => toast({ variant: "destructive", title: "Save failed", description: e.message }),
  });

  const test = useMutation({
    mutationFn: () => apiFetch<{ success: boolean; message?: string; verifiedName?: string }>(`/api/tenants/${tenantId}/settings/test`, { method: "POST" }),
    onSuccess: (r) => {
      setTestResult(r);
      if (r.success) {
        toast({ title: "Connected", description: r.verifiedName });
        qc.invalidateQueries({ queryKey: ["settings", tenantId] });
      }
    },
    onError: (e: Error) => setTestResult({ success: false, message: e.message }),
  });
  const rotateFlowKey = useMutation({
    mutationFn: () => apiFetch<FlowKey>(`/api/tenants/${tenantId}/settings/flow-key`, { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["flow-key", tenantId] }); toast({ title: "Flow encryption key registered with Meta" }); },
    onError: (e: Error) => toast({ variant: "destructive", title: "Key registration failed", description: e.message }),
  });
  const addConnector = useMutation({
    mutationFn: () => {
      const host = new URL(connector.baseUrl).hostname;
      const authConfig = connector.authType === "BEARER" ? { token: connector.token } : connector.authType === "BASIC" ? { username: connector.username, password: connector.password } : connector.authType === "HEADER" ? { name: connector.headerName, value: connector.headerValue } : undefined;
      return apiFetch("/api/flow-connectors", { method: "POST", body: JSON.stringify({ name: connector.name, baseUrl: connector.baseUrl, allowedHosts: [host], authType: connector.authType, ...(authConfig ? { authConfig } : {}) }) });
    },
    onSuccess: () => { setConnector({ name: "", baseUrl: "", authType: "NONE", token: "", username: "", password: "", headerName: "", headerValue: "" }); qc.invalidateQueries({ queryKey: ["flow-connectors"] }); toast({ title: "Flow connector created" }); },
    onError: (e: Error) => toast({ variant: "destructive", title: "Connector failed", description: e.message }),
  });
  const removeConnector = useMutation({ mutationFn: (id: string) => apiFetch(`/api/flow-connectors/${id}`, { method: "DELETE" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["flow-connectors"] }), onError: (e: Error) => toast({ variant: "destructive", title: "Delete failed", description: e.message }) });

  function copy(text: string) {
    navigator.clipboard.writeText(text);
    toast({ title: "Copied to clipboard" });
  }

  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Settings" />
        <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
          <Card className="h-64 animate-pulse bg-muted/40" />
          <Card className="h-48 animate-pulse bg-muted/40" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Settings"
        description={data?.connected ? `Connected as ${data.phoneNumberDisplay || data.phoneNumberId || "WhatsApp number"}.` : "Connect your WhatsApp Business Cloud API account."}
        actions={
          data?.connected ? (
            <Badge variant="success" className="gap-1">
              <CheckCircle2 className="h-3.5 w-3.5" /> {data.phoneNumberDisplay || "Connected"}
            </Badge>
          ) : (
            <Badge variant="secondary">Not connected</Badge>
          )
        }
      />

      <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Cloud API credentials</CardTitle>
            <CardDescription>
              Find these in Meta Business Manager → WhatsApp → API Setup.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <Field label="WhatsApp Business Account (WABA) ID">
              <Input value={form.wabaId} onChange={(e) => setForm({ ...form, wabaId: e.target.value })} placeholder="1234567890" />
            </Field>
            <Field label="Phone Number ID">
              <Input value={form.phoneNumberId} onChange={(e) => setForm({ ...form, phoneNumberId: e.target.value })} placeholder="1234567890" />
            </Field>
            <Field label="Graph API version">
              <Input value={form.apiVersion} onChange={(e) => setForm({ ...form, apiVersion: e.target.value })} placeholder="v21.0" />
            </Field>
            <Field label="Meta App ID (for media-header templates)">
              <Input value={form.metaAppId} onChange={(e) => setForm({ ...form, metaAppId: e.target.value })} placeholder="Optional — needed to upload image/video/doc header samples" />
            </Field>
            <Field
              label={`Access Token ${data?.accessTokenSet ? `(saved: ${data.accessTokenMasked})` : ""}`}
            >
              <Input
                type="password"
                value={form.accessToken}
                onChange={(e) => setForm({ ...form, accessToken: e.target.value })}
                placeholder={data?.accessTokenSet ? "•••• leave blank to keep" : "Permanent access token"}
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Webhook</CardTitle>
            <CardDescription>
              In Meta → WhatsApp → Configuration, set this Callback URL and Verify Token, then
              subscribe to the <span className="font-medium">messages</span> field.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Field label="Callback URL">
              <div className="flex gap-2">
                <Input readOnly value={data?.callbackUrl || ""} className="font-mono text-xs" />
                <Button variant="outline" size="icon" type="button" onClick={() => copy(data?.callbackUrl || "")}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Verify Token (leave blank to auto-generate)">
                <div className="flex gap-2">
                  <Input
                    value={form.webhookVerifyToken}
                    onChange={(e) => setForm({ ...form, webhookVerifyToken: e.target.value })}
                    className="font-mono text-xs"
                  />
                  <Button variant="outline" size="icon" type="button" onClick={() => copy(form.webhookVerifyToken)}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </Field>
              <Field label={`App Secret ${data?.appSecretSet ? "(saved)" : ""} — used to verify signatures`}>
                <Input
                  type="password"
                  value={form.appSecret}
                  onChange={(e) => setForm({ ...form, appSecret: e.target.value })}
                  placeholder={data?.appSecretSet ? "•••• leave blank to keep" : "Meta App Secret"}
                />
              </Field>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-sm">WhatsApp Flow encryption</CardTitle><CardDescription>Dynamic Flows require an RSA key registered against this business phone number. Rotating keeps the previous private key available for 24 hours.</CardDescription></CardHeader>
          <CardContent className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0">{flowKey?.configured ? <><div className="flex items-center gap-2 text-sm font-medium"><CheckCircle2 className="h-4 w-4 text-emerald-600" /> Registered</div><code className="block break-all text-[10px] text-muted-foreground sm:truncate">SHA-256 {flowKey.fingerprint}</code></> : <div className="text-sm text-muted-foreground">No Flow encryption key configured.</div>}</div><Button variant="outline" onClick={() => confirm(flowKey?.configured ? "Rotate the registered Flow encryption key?" : "Generate and register a Flow encryption key?") && rotateFlowKey.mutate()} disabled={rotateFlowKey.isPending}><KeyRound className="h-4 w-4" /> {flowKey?.configured ? "Rotate key" : "Set up key"}</Button></CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-sm">Dynamic Flow connectors</CardTitle><CardDescription>Approved HTTPS destinations that dynamic screens can call. Private and local network addresses are blocked.</CardDescription></CardHeader>
          <CardContent className="space-y-3"><div className="grid gap-2 sm:grid-cols-[1fr_2fr_130px_auto]"><Input value={connector.name} onChange={(e) => setConnector({ ...connector, name: e.target.value })} placeholder="Connector name" /><Input value={connector.baseUrl} onChange={(e) => setConnector({ ...connector, baseUrl: e.target.value })} placeholder="https://api.example.com/flows/" /><select value={connector.authType} onChange={(e) => setConnector({ ...connector, authType: e.target.value })} className="rounded-md border bg-background px-2 text-sm"><option value="NONE">No auth</option><option value="BEARER">Bearer token</option><option value="BASIC">Basic auth</option><option value="HEADER">Custom header</option></select><Button size="icon" onClick={() => addConnector.mutate()} disabled={!connector.name || !connector.baseUrl || addConnector.isPending}><Plus className="h-4 w-4" /></Button></div>{connector.authType === "BEARER" && <Input type="password" value={connector.token} onChange={(e) => setConnector({ ...connector, token: e.target.value })} placeholder="Bearer token (encrypted at rest)" />}{connector.authType === "BASIC" && <div className="grid grid-cols-2 gap-2"><Input value={connector.username} onChange={(e) => setConnector({ ...connector, username: e.target.value })} placeholder="Username" /><Input type="password" value={connector.password} onChange={(e) => setConnector({ ...connector, password: e.target.value })} placeholder="Password" /></div>}{connector.authType === "HEADER" && <div className="grid grid-cols-2 gap-2"><Input value={connector.headerName} onChange={(e) => setConnector({ ...connector, headerName: e.target.value })} placeholder="Header name" /><Input type="password" value={connector.headerValue} onChange={(e) => setConnector({ ...connector, headerValue: e.target.value })} placeholder="Header value" /></div>}
            <div className="space-y-1">{connectors.map((item) => <div key={item.id} className="flex items-center gap-3 rounded-md border px-3 py-2"><div className="min-w-0 flex-1"><div className="text-sm font-medium">{item.name}</div><div className="truncate text-[11px] text-muted-foreground">{item.baseUrl} · {item.authType}</div></div><Button variant="ghost" size="icon" onClick={() => confirm(`Delete connector “${item.name}”?`) && removeConnector.mutate(item.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button></div>)}{!connectors.length && <p className="text-xs text-muted-foreground">No connectors configured.</p>}</div>
          </CardContent>
        </Card>

        <div className="flex items-center gap-2">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            <Save className="h-4 w-4" /> Save settings
          </Button>
          <Button variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>
            <RefreshCw className={`h-4 w-4 ${test.isPending ? "animate-spin" : ""}`} /> Test connection
          </Button>
          {testResult && (
            <span className={`flex items-center gap-1 text-xs ${testResult.success ? "text-emerald-600" : "text-destructive"}`}>
              {testResult.success ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
              {testResult.success ? "Connection OK" : testResult.message}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
