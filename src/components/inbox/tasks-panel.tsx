"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot,
  X,
  ListTodo,
  Plus,
  AlertTriangle,
  Check,
  Clock,
  Phone,
  MessageSquare,
  FileText,
  ClipboardList,
  MoreHorizontal,
  CalendarClock,
  Calendar,
  User,
  Send,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

/**
 * WA-UI-019: Tasks & Reminders UI
 *
 * Pure UI implementation with demo data.
 * No backend, persistence, or real task creation.
 *
 * Features:
 * - Two tabs: "Asistente IA" and "Tareas"
 * - Task list with Pending/Completed sections
 * - New task form with type, title, date, time, assignee, notes
 * - Clear distinction between Reminder and Scheduled Message
 * - Demo data clearly identified
 * - Full accessibility
 */

// ============================================================================
// TYPES
// ============================================================================

export type TaskType =
  | "personal_reminder"
  | "call_client"
  | "send_message"
  | "prepare_quote"
  | "other";

export type TaskStatus = "pending" | "completed" | "overdue";

export interface Task {
  id: string;
  title: string;
  type: TaskType;
  date?: string; // YYYY-MM-DD
  time?: string; // HH:mm
  assignee: string;
  status: TaskStatus;
  notes?: string;
  isScheduled?: boolean; // true = scheduled message, false = reminder
}

// ============================================================================
// CONSTANTS
// ============================================================================

export const TASK_TYPES: { id: TaskType; label: string; icon: React.ElementType; description: string }[] = [
  { id: "personal_reminder", label: "Recordatorio personal", icon: Clock, description: "Avisarte que debes hacer algo" },
  { id: "call_client", label: "Llamar al cliente", icon: Phone, description: "Realizar una llamada telefónica" },
  { id: "send_message", label: "Enviar mensaje", icon: MessageSquare, description: "Enviar un mensaje al cliente" },
  { id: "prepare_quote", label: "Preparar cotización", icon: FileText, description: "Elaborar una cotización" },
  { id: "other", label: "Otra tarea", icon: ClipboardList, description: "Cualquier otra tarea" },
];

const DEMO_TASKS: Task[] = [
  {
    id: "demo-1",
    title: "Llamar a Patricia",
    type: "call_client",
    date: new Date(Date.now() + 86400000).toISOString().split("T")[0], // tomorrow
    time: "10:00",
    assignee: "Yo",
    status: "pending",
    notes: "Confirmar disponibilidad del pedido",
  },
  {
    id: "demo-2",
    title: "Confirmar entrega",
    type: "send_message",
    date: new Date(Date.now() + 86400000 * 3).toISOString().split("T")[0], // in 3 days (Friday)
    time: "15:00",
    assignee: "Yo",
    status: "pending",
  },
  {
    id: "demo-3",
    title: "Revisar fotografías",
    type: "other",
    assignee: "Yo",
    status: "completed",
    notes: "Verificar calidad de las fotos del producto",
  },
];

// ============================================================================
// TASK TYPE BADGE
// ============================================================================

function TaskTypeBadge({ type }: { type: TaskType }) {
  const taskType = TASK_TYPES.find((t) => t.id === type);
  if (!taskType) return null;
  const Icon = taskType.icon;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      <Icon className="h-3 w-3" aria-hidden="true" />
      <span>{taskType.label}</span>
    </span>
  );
}

// ============================================================================
// TASK ITEM
// ============================================================================

interface TaskItemProps {
  task: Task;
  onToggle?: (id: string) => void;
}

function TaskItem({ task, onToggle }: TaskItemProps) {
  const isCompleted = task.status === "completed";
  const isOverdue = task.status === "overdue";

  // Format date for display
  const formatDate = (dateStr?: string) => {
    if (!dateStr) return null;
    const date = new Date(dateStr + "T00:00:00");
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const isToday = date.toDateString() === today.toDateString();
    const isTomorrow = date.toDateString() === tomorrow.toDateString();

    if (isToday) return "Hoy";
    if (isTomorrow) return "Mañana";
    return date.toLocaleDateString("es-ES", { weekday: "long", day: "numeric" });
  };

  return (
    <div
      className={cn(
        "group relative rounded-md border p-2.5 transition-colors",
        "hover:bg-muted/50",
        isCompleted && "opacity-60",
        isOverdue && "border-destructive/50 bg-destructive/5"
      )}
    >
      <div className="flex items-start gap-2">
        {/* Checkbox */}
        <button
          type="button"
          role="checkbox"
          aria-checked={isCompleted}
          onClick={() => onToggle?.(task.id)}
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0 rounded border-2 transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
            isCompleted
              ? "border-primary bg-primary text-primary-foreground"
              : "border-muted-foreground/30 hover:border-muted-foreground/50"
          )}
          aria-label={isCompleted ? "Marcar como pendiente" : "Marcar como completada"}
        >
          {isCompleted && <Check className="h-2.5 w-2.5" />}
        </button>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <span
              className={cn(
                "text-sm font-medium",
                isCompleted && "line-through text-muted-foreground"
              )}
            >
              {task.title}
            </span>
            <button
              type="button"
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              aria-label="Más opciones"
            >
              <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>

          {/* Meta info */}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <TaskTypeBadge type={task.type} />

            {task.date && (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Calendar className="h-3 w-3" aria-hidden="true" />
                {formatDate(task.date)}
                {task.time && ` · ${task.time}`}
              </span>
            )}

            {task.isScheduled && (
              <span className="flex items-center gap-1 rounded bg-blue-100 px-1 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                <Send className="h-3 w-3" aria-hidden="true" />
                Programado
              </span>
            )}
          </div>

          {/* Assignee */}
          <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
            <User className="h-3 w-3" aria-hidden="true" />
            <span>Responsable: {task.assignee}</span>
          </div>

          {/* Notes */}
          {task.notes && (
            <p className="mt-1.5 text-[11px] text-muted-foreground/80">{task.notes}</p>
          )}

          {/* Overdue indicator */}
          {isOverdue && (
            <p className="mt-1 flex items-center gap-1 text-[10px] font-medium text-destructive">
              <AlertTriangle className="h-3 w-3" aria-hidden="true" />
              Tarea vencida
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// NEW TASK FORM
// ============================================================================

interface NewTaskFormProps {
  onCancel: () => void;
  onSubmit?: (task: Omit<Task, "id" | "status">) => void;
}

function NewTaskForm({ onCancel, onSubmit }: NewTaskFormProps) {
  const [taskType, setTaskType] = useState<TaskType>("personal_reminder");
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [assignee] = useState("Yo");
  const [notes, setNotes] = useState("");
  const [isScheduled, setIsScheduled] = useState(false);

  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Focus title field on mount
    titleRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!title.trim()) return;

      onSubmit?.({
        title: title.trim(),
        type: taskType,
        date: date || undefined,
        time: time || undefined,
        assignee,
        notes: notes || undefined,
        isScheduled,
      });
    },
    [title, taskType, date, time, assignee, notes, isScheduled, onSubmit]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    },
    [onCancel]
  );

  // Get min date for date picker (today)
  const minDate = new Date().toISOString().split("T")[0];

  return (
    <form
      onSubmit={handleSubmit}
      onKeyDown={handleKeyDown}
      className="flex flex-col gap-4"
      aria-label="Crear nueva tarea"
    >
      {/* Demo warning */}
      <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900 dark:bg-amber-950/30">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        <span className="text-xs font-medium text-amber-800 dark:text-amber-300">
          DEMOSTRACIÓN — Sin backend, no se guardará ninguna tarea
        </span>
      </div>

      {/* Task Type */}
      <div className="space-y-1.5">
        <Label htmlFor="task-type">Tipo de tarea</Label>
        <Select value={taskType} onValueChange={(v) => setTaskType(v as TaskType)}>
          <SelectTrigger id="task-type" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TASK_TYPES.map((t) => {
              const Icon = t.icon;
              return (
                <SelectItem key={t.id} value={t.id}>
                  <span className="flex items-center gap-2">
                    <Icon className="h-4 w-4" aria-hidden="true" />
                    {t.label}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>

      {/* Title */}
      <div className="space-y-1.5">
        <Label htmlFor="task-title">
          Título <span className="text-destructive">*</span>
        </Label>
        <Input
          ref={titleRef}
          id="task-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Ej: Llamar a Patricia para confirmar pedido"
          required
          aria-required="true"
        />
      </div>

      {/* Date & Time */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="task-date">Fecha</Label>
          <Input
            id="task-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            min={minDate}
            className="cursor-pointer"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="task-time">Hora</Label>
          <Input
            id="task-time"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </div>
      </div>

      {/* Assignee */}
      <div className="space-y-1.5">
        <Label htmlFor="task-assignee">Responsable</Label>
        <Select value={assignee} disabled>
          <SelectTrigger id="task-assignee">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="Yo">Yo</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-[10px] text-muted-foreground">
          Selector visual preparado para usuarios futuros
        </p>
      </div>

      {/* Scheduled Message Toggle */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between rounded-md border border-dashed border-muted-foreground/30 bg-muted/30 p-3">
          <div className="flex items-center gap-2">
            <Send className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <div>
              <Label className="text-sm font-medium">Envío programado</Label>
              <p className="text-[10px] text-muted-foreground">
                Enviar un mensaje automáticamente en fecha y hora
              </p>
            </div>
          </div>
          <Input
            type="checkbox"
            role="switch"
            checked={isScheduled}
            onChange={(e) => setIsScheduled(e.target.checked)}
            disabled
            className="h-4 w-8 cursor-not-allowed opacity-50"
            aria-label="Envío programado (deshabilitado)"
          />
        </div>
        <p className="flex items-center gap-1 text-[10px] text-muted-foreground/70">
          <AlertTriangle className="h-3 w-3" aria-hidden="true" />
          Disponible próximamente — no implementado
        </p>
      </div>

      {/* Notes */}
      <div className="space-y-1.5">
        <Label htmlFor="task-notes">Notas</Label>
        <Textarea
          id="task-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Detalles adicionales (opcional)"
          rows={2}
        />
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 border-t pt-4">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" size="sm" disabled>
          <CalendarClock className="mr-1 h-4 w-4" aria-hidden="true" />
          Crear tarea
        </Button>
      </div>

      {/* Create button disabled note */}
      <p className="text-center text-[10px] text-muted-foreground">
        Botón deshabilitado — backend no conectado
      </p>
    </form>
  );
}

// ============================================================================
// TASKS PANEL CONTENT
// ============================================================================

interface TasksPanelContentProps {
  onClose: () => void;
}

function TasksPanelContent({ onClose }: TasksPanelContentProps) {
  const [tasks, setTasks] = useState<Task[]>(DEMO_TASKS);
  const [showNewTaskForm, setShowNewTaskForm] = useState(false);

  const pendingTasks = tasks.filter((t) => t.status === "pending");
  const completedTasks = tasks.filter((t) => t.status === "completed");

  const handleToggleTask = useCallback((id: string) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, status: t.status === "completed" ? "pending" : "completed" }
          : t
      )
    );
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleNewTask = useCallback((task: Omit<Task, "id" | "status">) => {
    // Demo: just close the form, don't add task
    // task parameter intentionally unused - no backend
    setShowNewTaskForm(false);
  }, []);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">Tareas</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onClose}
          aria-label="Cerrar panel de tareas"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {showNewTaskForm ? (
          <div className="p-3">
            <h3 className="mb-3 text-sm font-semibold">Nueva tarea</h3>
            <NewTaskForm
              onCancel={() => setShowNewTaskForm(false)}
              onSubmit={handleNewTask}
            />
          </div>
        ) : (
          <div className="p-3 space-y-4">
            {/* Demo indicator */}
            <div className="flex items-center gap-2 rounded-md border border-dashed border-muted-foreground/30 bg-muted/30 px-3 py-2">
              <ListTodo className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="text-xs text-muted-foreground">
                DEMOSTRACIÓN — Datos de ejemplo
              </span>
            </div>

            {/* Title and New Task Button */}
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Tareas de la conversación</h3>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowNewTaskForm(true)}
                className="h-7 gap-1"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Nueva tarea
              </Button>
            </div>

            {/* Empty State */}
            {tasks.length === 0 && (
              <div className="flex flex-col items-center justify-center rounded-md border border-dashed py-8 text-center">
                <ListTodo className="mb-2 h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
                <p className="text-sm text-muted-foreground">
                  No hay tareas para esta conversación
                </p>
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => setShowNewTaskForm(true)}
                  className="mt-2 h-7"
                >
                  <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                  Crear primera tarea
                </Button>
              </div>
            )}

            {/* Pending Tasks */}
            {pendingTasks.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Pendientes ({pendingTasks.length})
                </h4>
                <div className="space-y-2">
                  {pendingTasks.map((task) => (
                    <TaskItem
                      key={task.id}
                      task={task}
                      onToggle={handleToggleTask}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Completed Tasks */}
            {completedTasks.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Completadas ({completedTasks.length})
                </h4>
                <div className="space-y-2">
                  {completedTasks.map((task) => (
                    <TaskItem
                      key={task.id}
                      task={task}
                      onToggle={handleToggleTask}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// AI ASSISTANT PANEL CONTENT
// ============================================================================

function AiAssistantPanelContent() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
      <Bot className="mb-3 h-10 w-10 text-muted-foreground/50" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">
        Próximamente podrás consultar información<br />
        relacionada con esta conversación.
      </p>
    </div>
  );
}

// ============================================================================
// MAIN ASSISTANT PANEL (with tabs)
// ============================================================================

export type AssistantTab = "ai" | "tasks";

interface AssistantPanelProps {
  activeTab: AssistantTab;
  onTabChange: (tab: AssistantTab) => void;
  onClose: () => void;
}

/**
 * Assistant Panel with tabs for AI Assistant and Tasks.
 * Replaces the original AiAssistantPanel.
 */
export function AssistantPanel({ activeTab, onTabChange, onClose }: AssistantPanelProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Tabs Header */}
      <Tabs value={activeTab} onValueChange={(v) => onTabChange(v as AssistantTab)}>
        <div className="flex items-center border-b">
          <TabsList className="h-auto w-full justify-start rounded-none border-b-0 bg-transparent p-0">
            <TabsTrigger
              value="ai"
              className={cn(
                "flex items-center gap-1.5 rounded-none border-b-2 border-transparent px-3 py-2 text-xs",
                "data-[state=active]:border-primary data-[state=active]:bg-transparent"
              )}
            >
              <Bot className="h-3.5 w-3.5" aria-hidden="true" />
              Asistente IA
            </TabsTrigger>
            <TabsTrigger
              value="tasks"
              className={cn(
                "flex items-center gap-1.5 rounded-none border-b-2 border-transparent px-3 py-2 text-xs",
                "data-[state=active]:border-primary data-[state=active]:bg-transparent"
              )}
            >
              <ListTodo className="h-3.5 w-3.5" aria-hidden="true" />
              Tareas
            </TabsTrigger>
          </TabsList>
        </div>

        {/* AI Assistant Content */}
        <TabsContent value="ai" className="m-0 flex-1 overflow-hidden">
          <AiAssistantPanelContent />
        </TabsContent>

        {/* Tasks Content */}
        <TabsContent value="tasks" className="m-0 flex-1 overflow-hidden">
          <TasksPanelContent onClose={onClose} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ============================================================================
// TASKS SHORTCUT BUTTON
// ============================================================================

interface TasksButtonProps {
  onClick: () => void;
  active?: boolean;
}

export function TasksButton({ onClick, active }: TasksButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("h-8 w-8", active && "bg-accent text-accent-foreground")}
      onClick={onClick}
      title="Tareas"
      aria-label="Abrir panel de tareas"
      aria-pressed={active}
    >
      <ListTodo className="h-4 w-4" />
    </Button>
  );
}
