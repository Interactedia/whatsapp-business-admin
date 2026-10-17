"use client";

import React, { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, CheckCircle2, XCircle, RefreshCw, Save, KeyRound, Plus, Trash2, Sparkles, ArrowRightLeft, Bell } from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { useI18n } from "@/components/i18n/language-provider";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/use-toast";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

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

type FlowConnector = {
  id: string;
  name: string;
  baseUrl: string;
  allowedHosts: string[];
  authType: string;
  credentialsSet: boolean;
};

// Automation preview state (disabled by design)
type AutomationPreview = {
  copilotEnabled: boolean;
  followUpEnabled: boolean;
  followUpFirstReminder: string;
  followUpUnit: string;
  followUpMaxReminders: string;
  followUpTimeFrom: string;
  followUpTimeTo: string;
  followUpTimezone: string;
  followUpMessageType: string;
  followUpCancelOnReply: boolean;
  followUpCancelOnClose: boolean;
};

export function SettingsClient({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<string>("meta");
  const [metaFormEdited, setMetaFormEdited] = useState(false);

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

  const [connector, setConnector] = useState({
    name: "",
    baseUrl: "",
    authType: "NONE",
    token: "",
    username: "",
    password: "",
    headerName: "",
    headerValue: "",
  });

  // Automation preview state
  const [automation, setAutomation] = useState<AutomationPreview>({
    copilotEnabled: false,
    followUpEnabled: false,
    followUpFirstReminder: "30",
    followUpUnit: "minutes",
    followUpMaxReminders: "3",
    followUpTimeFrom: "09:00",
    followUpTimeTo: "21:00",
    followUpTimezone: "America/Santiago",
    followUpMessageType: "template",
    followUpCancelOnReply: true,
    followUpCancelOnClose: true,
  });

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
    setMetaFormEdited(false);
  }, [data, tenantId]);

  const save = useMutation({
    mutationFn: () => apiFetch(`/api/tenants/${tenantId}/settings`, { method: "PUT", body: JSON.stringify(form) }),
    onSuccess: () => {
      toast({ title: "Configuración guardada" });
      setForm((f) => ({ ...f, accessToken: "", appSecret: "" }));
      qc.invalidateQueries({ queryKey: ["settings", tenantId] });
      setMetaFormEdited(false);
    },
    onError: (e: Error) => toast({ variant: "destructive", title: t("settings.toast.saveError"), description: e.message }),
  });

  const test = useMutation({
    mutationFn: () =>
      apiFetch<{ success: boolean; message?: string; verifiedName?: string }>(
        `/api/tenants/${tenantId}/settings/test`,
        { method: "POST" }
      ),
    onSuccess: (r) => {
      setTestResult(r);
      if (r.success) {
        toast({ title: "Conectado", description: r.verifiedName });
      }
    },
    onError: (e: Error) => toast({ variant: "destructive", title: t("settings.toast.testError"), description: e.message }),
  });

  const rotateFlowKey = useMutation({
    mutationFn: () => apiFetch(`/api/tenants/${tenantId}/settings/flow-key`, { method: "POST" }),
    onSuccess: () => {
      toast({ title: "Clave Rotada" });
      qc.invalidateQueries({ queryKey: ["flow-key", tenantId] });
    },
    onError: (e: Error) => toast({ variant: "destructive", title: t("settings.toast.keyRotateError"), description: e.message }),
  });

  const addConnector = useMutation({
    mutationFn: () =>
      apiFetch("/api/flow-connectors", {
        method: "POST",
        body: JSON.stringify(connector),
      }),
    onSuccess: () => {
      toast({ title: t("settings.toast.connectorAdded") });
      setConnector({ name: "", baseUrl: "", authType: "NONE", token: "", username: "", password: "", headerName: "", headerValue: "" });
      qc.invalidateQueries({ queryKey: ["flow-connectors"] });
    },
    onError: (e: Error) => toast({ variant: "destructive", title: t("settings.toast.connectorError"), description: e.message }),
  });

  const removeConnector = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/flow-connectors/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["flow-connectors"] }),
    onError: (e: Error) => toast({ variant: "destructive", title: t("settings.toast.deleteError"), description: e.message }),
  });

  const handleTabChange = (value: string) => {
    if (metaFormEdited && value !== "meta") {
      const confirmed = window.confirm(
        t("settings.tab.unsavedChanges")
      );
      if (!confirmed) return;
    }
    setActiveTab(value);
  };

  const handleFormChange = () => {
    setMetaFormEdited(true);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* PageHeader estandarizado */}
      <PageHeader
        title={t("settings.title")}
        description={t("settings.description")}
      />

      {/* Conexión Meta indicator */}
      {data?.connected && (
        <div className="border-b bg-emerald-50 px-4 py-2 dark:bg-emerald-950/20 sm:px-6">
          <div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4" />
            <span>
              {t("settings.connectionIndicator.connected")}{" "}
              <span className="font-medium">{data.businessName || data.phoneNumberDisplay}</span>
            </span>
          </div>
        </div>
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={handleTabChange} className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 border-b bg-card px-4 sm:px-6">
          <TabsList>
            <TabsTrigger value="meta">{t("settings.tab.meta")}</TabsTrigger>
            <TabsTrigger value="automation">{t("settings.tab.automation")}</TabsTrigger>
          </TabsList>
        </div>

        {/* TAB: Conexión con Meta */}
        <TabsContent value="meta" className="min-h-0 flex-1 overflow-auto">
          <MetaConnectionTab
            form={form}
            setForm={(f) => { setForm(f); handleFormChange(); }}
            data={data}
            flowKey={flowKey}
            connectors={connectors}
            connector={connector}
            setConnector={setConnector}
            testResult={testResult}
            save={save}
            test={test}
            rotateFlowKey={rotateFlowKey}
            addConnector={addConnector}
            removeConnector={removeConnector}
            isLoading={isLoading}
            t={t}
          />
        </TabsContent>

        {/* TAB: Automatización */}
        <TabsContent value="automation" className="min-h-0 flex-1 overflow-auto">
          <AutomationPreviewTab automation={automation} setAutomation={setAutomation} t={t} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// Meta Connection Tab Component
function MetaConnectionTab({
  form,
  setForm,
  data,
  flowKey,
  connectors,
  connector,
  setConnector,
  testResult,
  save,
  test,
  rotateFlowKey,
  addConnector,
  removeConnector,
  isLoading,
  t,
}: {
  form: {
    wabaId: string;
    metaAppId: string;
    phoneNumberId: string;
    apiVersion: string;
    webhookVerifyToken: string;
    accessToken: string;
    appSecret: string;
  };
  setForm: (f: typeof form) => void;
  data?: Settings;
  flowKey?: FlowKey;
  connectors: FlowConnector[];
  connector: {
    name: string;
    baseUrl: string;
    authType: string;
    token: string;
    username: string;
    password: string;
    headerName: string;
    headerValue: string;
  };
  setConnector: (c: typeof connector) => void;
  testResult: { success: boolean; message?: string } | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  save: { mutate: () => void; isPending: boolean };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  test: { mutate: () => void; isPending: boolean };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rotateFlowKey: { mutate: () => void; isPending: boolean };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addConnector: { mutate: () => void; isPending: boolean };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeConnector: { mutate: (id: string) => void; isPending: boolean };
  isLoading: boolean;
  t: (key: string, fallback?: string) => string;
}) {
  const copy = (text: string) => navigator.clipboard.writeText(text);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-muted-foreground">{t("settings.loading", "Cargando configuración...")}</div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Credenciales de WhatsApp Business */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("settings.meta.title")}</CardTitle>
          <CardDescription>
            {t("settings.meta.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="WABA ID">
              <Input
                value={form.wabaId}
                onChange={(e) => setForm({ ...form, wabaId: e.target.value })}
                placeholder="WABA1234567890"
              />
            </Field>
            <Field label="Phone Number ID">
              <Input
                value={form.phoneNumberId}
                onChange={(e) => setForm({ ...form, phoneNumberId: e.target.value })}
                placeholder="1234567890"
              />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Graph API Version">
              <Input
                value={form.apiVersion}
                onChange={(e) => setForm({ ...form, apiVersion: e.target.value })}
                placeholder="v21.0"
              />
            </Field>
            <Field label="Meta App ID">
              <Input
                value={form.metaAppId}
                onChange={(e) => setForm({ ...form, metaAppId: e.target.value })}
                placeholder="App ID"
              />
            </Field>
          </div>
        </CardContent>
      </Card>

      {/* Access Token */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Access Token</CardTitle>
          <CardDescription>
            {t("settings.accessToken.description")}
            {data?.accessTokenSet && (
              <span className="ml-1 text-emerald-600"> ({t("settings.meta.configured")})</span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Field label="Access Token">
            <div className="relative">
              <Input
                type="password"
                value={form.accessToken}
                onChange={(e) => setForm({ ...form, accessToken: e.target.value })}
                placeholder={data?.accessTokenSet ? t("settings.accessToken.placeholder.keep") : t("settings.accessToken.placeholder.empty")}
                className="pr-10"
              />
              {data?.accessTokenSet && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2"
                  onClick={() => copy(data.accessTokenMasked)}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              )}
            </div>
          </Field>
        </CardContent>
      </Card>

      {/* Webhook Configuration */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("settings.webhook.title")}</CardTitle>
          <CardDescription>
            {t("settings.webhook.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Webhook Callback URL">
            <div className="relative">
              <Input
                value={data?.callbackUrl ?? ""}
                readOnly
                placeholder={t("settings.webhook.callbackPlaceholder")}
                className="pr-10"
              />
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2"
                onClick={() => copy(data?.callbackUrl ?? "")}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </Field>
          <Field label="Verify Token">
            <Input
              value={form.webhookVerifyToken}
              onChange={(e) => setForm({ ...form, webhookVerifyToken: e.target.value })}
              placeholder={t("settings.webhook.verifyTokenPlaceholder")}
            />
          </Field>
        </CardContent>
      </Card>

      {/* App Secret */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">App Secret</CardTitle>
          <CardDescription>
            {t("settings.appSecret.description")}
            {data?.appSecretSet && (
              <span className="ml-1 text-emerald-600"> ({t("settings.meta.configured")})</span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Field label="App Secret">
            <Input
              type="password"
              value={form.appSecret}
              onChange={(e) => setForm({ ...form, appSecret: e.target.value })}
              placeholder={data?.appSecretSet ? t("settings.appSecret.placeholder.keep") : t("settings.appSecret.placeholder.empty")}
            />
          </Field>
        </CardContent>
      </Card>

      {/* WhatsApp Flow Encryption */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("settings.flowEncryption.title")}</CardTitle>
          <CardDescription>
            {t("settings.flowEncryption.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            {flowKey?.configured ? (
              <>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  {t("settings.flowEncryption.registered")}
                </div>
                <code className="block break-all text-[10px] text-muted-foreground sm:truncate">
                  SHA-256 {flowKey.fingerprint}
                </code>
              </>
            ) : (
              <div className="text-sm text-muted-foreground">
                {t("settings.flowEncryption.notConfigured")}
              </div>
            )}
          </div>
          <Button
            variant="outline"
            onClick={() =>
              confirm(
                flowKey?.configured
                  ? t("settings.flowEncryption.confirmRotate")
                  : t("settings.flowEncryption.confirmConfigure")
              ) && rotateFlowKey.mutate()
            }
            disabled={rotateFlowKey.isPending}
          >
            <KeyRound className="h-4 w-4" />
            {flowKey?.configured ? t("settings.flowEncryption.rotate") : t("settings.flowEncryption.configure")}
          </Button>
        </CardContent>
      </Card>

      {/* Dynamic Flow Connectors */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("settings.flowConnectors.title")}</CardTitle>
          <CardDescription>
            {t("settings.flowConnectors.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_2fr_130px_auto]">
            <Field label={t("settings.flowConnectors.name")} htmlFor="connector-name">
              <Input
                id="connector-name"
                value={connector.name}
                onChange={(e) => setConnector({ ...connector, name: e.target.value })}
                placeholder={t("settings.flowConnectors.namePlaceholder")}
              />
            </Field>
            <Field label={t("settings.flowConnectors.baseUrl")} htmlFor="connector-base-url">
              <Input
                id="connector-base-url"
                value={connector.baseUrl}
                onChange={(e) => setConnector({ ...connector, baseUrl: e.target.value })}
                placeholder={t("settings.flowConnectors.baseUrlPlaceholder")}
              />
            </Field>
            <Field label={t("settings.flowConnectors.auth")} htmlFor="connector-auth-type">
              <Select
                value={connector.authType}
                onValueChange={(v) => setConnector({ ...connector, authType: v })}
              >
                <SelectTrigger id="connector-auth-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">{t("settings.flowConnectors.authNone")}</SelectItem>
                  <SelectItem value="BEARER">{t("settings.flowConnectors.authBearer")}</SelectItem>
                  <SelectItem value="BASIC">{t("settings.flowConnectors.authBasic")}</SelectItem>
                  <SelectItem value="HEADER">{t("settings.flowConnectors.authHeader")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Button
              size="icon"
              onClick={() => addConnector.mutate()}
              disabled={!connector.name || !connector.baseUrl || addConnector.isPending}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>

          {connector.authType === "BEARER" && (
            <Input
              type="password"
              value={connector.token}
              onChange={(e) => setConnector({ ...connector, token: e.target.value })}
              placeholder={t("settings.flowConnectors.tokenPlaceholder")}
            />
          )}
          {connector.authType === "BASIC" && (
            <div className="grid grid-cols-2 gap-2">
              <Input
                value={connector.username}
                onChange={(e) => setConnector({ ...connector, username: e.target.value })}
                placeholder={t("settings.flowConnectors.usernamePlaceholder")}
              />
              <Input
                type="password"
                value={connector.password}
                onChange={(e) => setConnector({ ...connector, password: e.target.value })}
                placeholder={t("settings.flowConnectors.passwordPlaceholder")}
              />
            </div>
          )}
          {connector.authType === "HEADER" && (
            <div className="grid grid-cols-2 gap-2">
              <Input
                value={connector.headerName}
                onChange={(e) => setConnector({ ...connector, headerName: e.target.value })}
                placeholder={t("settings.flowConnectors.headerNamePlaceholder")}
              />
              <Input
                type="password"
                value={connector.headerValue}
                onChange={(e) => setConnector({ ...connector, headerValue: e.target.value })}
                placeholder={t("settings.flowConnectors.headerValuePlaceholder")}
              />
            </div>
          )}

          <div className="space-y-1">
            {connectors.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-3 rounded-md border px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{item.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {item.baseUrl} · {item.authType}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    confirm(t("settings.flowConnectors.deleteConfirm", `¿Eliminar conector "${item.name}"?`).replace("{name}", item.name)) &&
                    removeConnector.mutate(item.id)
                  }
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
            {!connectors.length && (
              <p className="text-xs text-muted-foreground">
                {t("settings.flowConnectors.empty")}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Save & Test */}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          <Save className="h-4 w-4" /> {t("settings.button.save")}
        </Button>
        <Button variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>
          <RefreshCw className={`h-4 w-4 ${test.isPending ? "animate-spin" : ""}`} /> {test.isPending ? t("settings.button.testing") : t("settings.button.testConnection")}
        </Button>
        {testResult && (
          <span
            className={`flex items-center gap-1 text-xs ${
              testResult.success ? "text-emerald-600" : "text-destructive"
            }`}
          >
            {testResult.success ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : (
              <XCircle className="h-4 w-4" />
            )}
            {testResult.success ? t("settings.toast.testSuccess") : testResult.message}
          </span>
        )}
      </div>
    </div>
  );
}

// Automation Preview Tab Component
function AutomationPreviewTab({
  automation,
  setAutomation,
  t,
}: {
  automation: AutomationPreview;
  setAutomation: (a: AutomationPreview) => void;
  t: (key: string, fallback?: string) => string;
}) {
  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Preview Banner */}
      <div className="rounded-lg border border-dashed border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/20">
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-amber-100 p-2 dark:bg-amber-900">
            <Sparkles className="h-5 w-5 text-amber-600 dark:text-amber-400" />
          </div>
          <div>
            <h3 className="font-medium text-amber-800 dark:text-amber-200">
              {t("settings.automationPreview.bannerTitle")}
            </h3>
            <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
              {t("settings.automationPreview.bannerDescription")}
            </p>
          </div>
        </div>
      </div>

      {/* Copilot Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-violet-600 dark:text-violet-400" />
            <CardTitle className="text-sm">{t("settings.automation.copilot.title")}</CardTitle>
          </div>
          <CardDescription>
            {t("settings.automation.copilot.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label htmlFor="copilot-enabled" className="cursor-pointer">
                {t("settings.automation.copilot.enable")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("settings.automation.copilot.enableHint")}
              </p>
            </div>
            <Switch
              id="copilot-enabled"
              checked={automation.copilotEnabled}
              onCheckedChange={(checked) =>
                setAutomation({ ...automation, copilotEnabled: checked })
              }
              disabled
            />
          </div>
        </CardContent>
      </Card>

      {/* Handoff Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ArrowRightLeft className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            <CardTitle className="text-sm">{t("settings.automation.handoff.title")}</CardTitle>
          </div>
          <CardDescription>
            {t("settings.automation.handoff.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border p-4 opacity-60">
            <div className="mb-3 text-sm font-medium">{t("settings.automation.handoff.policy")}</div>
            <div className="space-y-3">
              <label className="flex cursor-not-allowed items-start gap-3 rounded-md border p-3 text-sm opacity-50">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked
                  disabled
                />
                <div>
                  <span className="font-medium">{t("settings.automation.handoff.humanTransfer")}</span>
                  <p className="text-xs text-muted-foreground">
                    {t("settings.automation.handoff.humanTransferDesc")}
                  </p>
                </div>
              </label>
              <label className="flex cursor-not-allowed items-start gap-3 rounded-md border p-3 text-sm opacity-50">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked
                  disabled
                />
                <div>
                  <span className="font-medium">{t("settings.automation.handoff.copilotReactivate")}</span>
                  <p className="text-xs text-muted-foreground">
                    {t("settings.automation.handoff.copilotReactivateDesc")}
                  </p>
                </div>
              </label>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("settings.automation.handoff.policyHint")}
          </p>
        </CardContent>
      </Card>

      {/* Follow-up Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            <CardTitle className="text-sm">{t("settings.automation.followup.title")}</CardTitle>
          </div>
          <CardDescription>
            {t("settings.automation.followup.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Enable toggle */}
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label htmlFor="followup-enabled" className="cursor-not-allowed">
                {t("settings.automation.followup.enable")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("settings.automation.followup.enableHint")}
              </p>
            </div>
            <Switch
              id="followup-enabled"
              checked={automation.followUpEnabled}
              onCheckedChange={(checked) =>
                setAutomation({ ...automation, followUpEnabled: checked })
              }
              disabled
            />
          </div>

          {/* Follow-up timing */}
          <div className="rounded-lg border p-4 opacity-60">
            <div className="mb-3 text-sm font-medium">{t("settings.automation.followup.timing")}</div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1">
                <Label className="text-xs">{t("settings.automation.followup.firstReminder")}</Label>
                <Input
                  type="number"
                  value={automation.followUpFirstReminder}
                  onChange={(e) =>
                    setAutomation({ ...automation, followUpFirstReminder: e.target.value })
                  }
                  disabled
                  className="cursor-not-allowed"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t("settings.automation.followup.unit")}</Label>
                <Select
                  value={automation.followUpUnit}
                  onValueChange={(v) => setAutomation({ ...automation, followUpUnit: v })}
                  disabled
                >
                  <SelectTrigger className="cursor-not-allowed">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="minutes">{t("settings.automation.followup.unitMinutes")}</SelectItem>
                    <SelectItem value="hours">{t("settings.automation.followup.unitHours")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t("settings.automation.followup.maxReminders")}</Label>
                <Input
                  type="number"
                  value={automation.followUpMaxReminders}
                  onChange={(e) =>
                    setAutomation({ ...automation, followUpMaxReminders: e.target.value })
                  }
                  disabled
                  className="cursor-not-allowed"
                />
              </div>
            </div>
          </div>

          {/* Allowed hours */}
          <div className="rounded-lg border p-4 opacity-60">
            <div className="mb-3 text-sm font-medium">{t("settings.automation.followup.allowedHours")}</div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1">
                <Label className="text-xs">{t("settings.automation.followup.from")}</Label>
                <Input
                  type="time"
                  value={automation.followUpTimeFrom}
                  onChange={(e) =>
                    setAutomation({ ...automation, followUpTimeFrom: e.target.value })
                  }
                  disabled
                  className="cursor-not-allowed"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t("settings.automation.followup.to")}</Label>
                <Input
                  type="time"
                  value={automation.followUpTimeTo}
                  onChange={(e) =>
                    setAutomation({ ...automation, followUpTimeTo: e.target.value })
                  }
                  disabled
                  className="cursor-not-allowed"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t("settings.automation.followup.timezone")}</Label>
                <Select
                  value={automation.followUpTimezone}
                  onValueChange={(v) => setAutomation({ ...automation, followUpTimezone: v })}
                  disabled
                >
                  <SelectTrigger className="cursor-not-allowed">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="America/Santiago">Santiago (UTC-3)</SelectItem>
                    <SelectItem value="America/Buenos_Aires">Buenos Aires (UTC-3)</SelectItem>
                    <SelectItem value="America/Mexico_City">Ciudad de México (UTC-6)</SelectItem>
                    <SelectItem value="America/New_York">Nueva York (UTC-5)</SelectItem>
                    <SelectItem value="Europe/Madrid">Madrid (UTC+1)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* Message type */}
          <div className="rounded-lg border p-4 opacity-60">
            <div className="mb-3 text-sm font-medium">{t("settings.automation.followup.messageType")}</div>
            <div className="flex gap-2">
              <label className="flex cursor-not-allowed items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <input type="radio" name="msgType" value="template" checked={automation.followUpMessageType === "template"} onChange={() => setAutomation({ ...automation, followUpMessageType: "template" })} disabled />
                {t("settings.automation.followup.messageTypePredefined")}
              </label>
              <label className="flex cursor-not-allowed items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <input type="radio" name="msgType" value="ai" checked={automation.followUpMessageType === "ai"} onChange={() => setAutomation({ ...automation, followUpMessageType: "ai" })} disabled />
                {t("settings.automation.followup.messageTypeAI")}
              </label>
            </div>
          </div>

          {/* Cancellation conditions */}
          <div className="rounded-lg border p-4 opacity-60">
            <div className="mb-3 text-sm font-medium">{t("settings.automation.followup.cancellationConditions")}</div>
            <div className="space-y-2">
              <label className="flex cursor-not-allowed items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={automation.followUpCancelOnReply}
                  onChange={(e) =>
                    setAutomation({ ...automation, followUpCancelOnReply: e.target.checked })
                  }
                  disabled
                />
                {t("settings.automation.followup.cancelOnReply")}
              </label>
              <label className="flex cursor-not-allowed items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={automation.followUpCancelOnClose}
                  onChange={(e) =>
                    setAutomation({ ...automation, followUpCancelOnClose: e.target.checked })
                  }
                  disabled
                />
                {t("settings.automation.followup.cancelOnClose")}
              </label>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            {t("settings.automation.followup.disclaimer")}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}
