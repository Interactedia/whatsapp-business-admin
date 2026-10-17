"use client";

import { useCallback, useEffect } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type EdgeProps,
  type Connection,
  type NodeTypes,
  type EdgeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { cn } from "@/lib/utils";
import { useI18n } from "@/components/i18n/language-provider";
import type { FlowScreen } from "@/lib/whatsapp/flow-types";

type ScreenNodeData = { title: string; screenId: string; terminal?: boolean; active: boolean };
type RoutingEdgeData = { onDelete: () => void };

function ScreenNode({ data }: { data: ScreenNodeData }) {
  const { t } = useI18n();
  return <div className={cn("min-w-[150px] rounded-md border bg-card px-3 py-2 text-xs shadow-xs", data.active && "border-primary ring-1 ring-primary/30")}>
    <Handle type="target" position={Position.Left} className="h-2! w-2! border-none! bg-primary!" />
    <div className="truncate font-medium">{data.title}</div>
    <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
      <span className="truncate">{data.screenId}</span>
      {data.terminal && <span className="shrink-0 rounded-sm bg-emerald-100 px-1 text-emerald-700">{t("builder.terminalMark")}</span>}
    </div>
    <Handle type="source" position={Position.Right} className="h-2! w-2! border-none! bg-primary!" />
  </div>;
}

function RoutingEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps) {
  const { t } = useI18n();
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const onDelete = (data as RoutingEdgeData | undefined)?.onDelete;
  return <>
    <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={{ strokeWidth: 1.5 }} />
    <EdgeLabelRenderer>
      <button
        type="button"
        title={t("graph.removeRoute")}
        onClick={(event) => { event.stopPropagation(); onDelete?.(); }}
        style={{ position: "absolute", transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: "all" }}
        className="flex h-4 w-4 items-center justify-center rounded-full border bg-background text-[10px] leading-none text-destructive shadow-xs hover:bg-destructive hover:text-white"
      >×</button>
    </EdgeLabelRenderer>
  </>;
}

const nodeTypes: NodeTypes = { screen: ScreenNode };
const edgeTypes: EdgeTypes = { removable: RoutingEdge };

/** Layers screens by BFS depth from routing_model roots (screens with no incoming route), purely for an initial layout — positions are session-only and not persisted. */
function layoutScreens(screens: FlowScreen[], routingModel: Record<string, string[]>): Map<string, { x: number; y: number }> {
  const ids = screens.map((screen) => screen.id);
  const incoming = new Set<string>();
  for (const targets of Object.values(routingModel)) for (const target of targets) incoming.add(target);
  const roots = ids.filter((id) => !incoming.has(id));
  const depth = new Map<string, number>();
  const queue: string[] = roots.length ? roots : ids.slice(0, 1);
  for (const id of queue) depth.set(id, 0);
  while (queue.length) {
    const id = queue.shift() as string;
    const current = depth.get(id) ?? 0;
    for (const target of routingModel[id] || []) {
      if (!depth.has(target)) { depth.set(target, current + 1); queue.push(target); }
    }
  }
  for (const id of ids) if (!depth.has(id)) depth.set(id, 0);
  const columns = new Map<number, string[]>();
  for (const id of ids) {
    const d = depth.get(id) || 0;
    columns.set(d, [...(columns.get(d) || []), id]);
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const [depthLevel, columnIds] of columns) columnIds.forEach((id, index) => positions.set(id, { x: depthLevel * 220, y: index * 110 }));
  return positions;
}

export function FlowScreenGraph({ screens, routingModel, currentScreenId, onSelectScreen, onChangeRouting }: {
  screens: FlowScreen[];
  routingModel: Record<string, string[]>;
  currentScreenId: string;
  onSelectScreen: (id: string) => void;
  onChangeRouting: (next: Record<string, string[]>) => void;
}) {
  const { t } = useI18n();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<ScreenNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const screenIdsKey = screens.map((screen) => screen.id).join("|");
  const screenLabelsKey = screens.map((screen) => `${screen.title || ""}:${screen.terminal ? "1" : "0"}`).join("|");

  useEffect(() => {
    setNodes((current) => {
      const byId = new Map(current.map((node) => [node.id, node]));
      const layout = layoutScreens(screens, routingModel);
      return screens.map((screen) => {
        const existing = byId.get(screen.id);
        const position = existing?.position || layout.get(screen.id) || { x: 0, y: 0 };
        return {
          id: screen.id,
          type: "screen",
          position,
          data: { title: screen.title || screen.id, screenId: screen.id, terminal: screen.terminal, active: screen.id === currentScreenId },
        };
      });
    });
    // Re-run only when the set of screens or their labels/terminal flags change, or selection moves — not on every routing edit (that would fight manual dragging).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenIdsKey, screenLabelsKey, currentScreenId, setNodes]);

  useEffect(() => {
    const next: Edge[] = [];
    for (const [from, targets] of Object.entries(routingModel)) {
      for (const target of targets) {
        next.push({
          id: `${from}=>${target}`,
          source: from,
          target,
          type: "removable",
          markerEnd: { type: MarkerType.ArrowClosed },
          data: { onDelete: () => onChangeRouting({ ...routingModel, [from]: (routingModel[from] || []).filter((id) => id !== target) }) },
        });
      }
    }
    setEdges(next);
  }, [routingModel, onChangeRouting, setEdges]);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    const current = routingModel[connection.source] || [];
    if (current.includes(connection.target)) return;
    onChangeRouting({ ...routingModel, [connection.source]: [...current, connection.target] });
  }, [routingModel, onChangeRouting]);

  const onNodeClick = useCallback((_event: unknown, node: Node) => onSelectScreen(node.id), [onSelectScreen]);

  if (screens.length < 2) {
    return <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">{t("graph.addAnotherScreen")}</div>;
  }

  return <div className="h-64 overflow-hidden rounded-md border bg-muted/10">
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodeClick={onNodeClick}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={16} />
      <Controls showInteractive={false} />
    </ReactFlow>
  </div>;
}
