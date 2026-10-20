import React, { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ForceLink, Simulation, SimulationLinkDatum, SimulationNodeDatum, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';
import { Minus, Plus, Scan, X } from 'lucide-react';
import { useT } from '../../lib/phrases/app';
import { GraphLink, Placed, Relation, fitAll, nodeAt, radiusOf, related, relatedTo } from './graph';

interface View {
  x: number;
  y: number;
  k: number;
}
interface GraphNode extends SimulationNodeDatum {
  id: string;
  r: number;
}
type GraphEdge = SimulationLinkDatum<GraphNode>;

/** How a node is drawn; `on` when it is chosen, aimed at or under the pointer. */
export interface NodeLook {
  fill: string;
  stroke: string;
  strokeWidth: number;
  /** A rounded square (an idea of the research space) rather than a circle. */
  square?: boolean;
  /** Labelled at every zoom, in bold (the logic's start). */
  strong?: boolean;
}

/** What the views around the graph ask of it. */
export interface ForceGraphHandle {
  /** A point of the window in the graph's units; null outside the canvas. */
  pointAt(clientX: number, clientY: number): [number, number] | null;
  /** The node at a point of the window, other than those in `skip`. */
  nodeAt(clientX: number, clientY: number, skip?: ReadonlySet<string>): string | null;
  /** Shows a node as where a drop from outside the graph would go (null: none). */
  aim(id: string | null): void;
  /** Keeps a node where it was put, in this browser; a node not in the graph yet shows there when it comes. */
  pin(id: string, at: [number, number]): void;
  unpin(id: string): void;
  /** A clear place in the middle of what is in sight, for a new node alone. */
  freeSpot(): [number, number];
  /** Lets every node the author put go and lets the forces lay them out again. */
  relayout(): void;
  /** The whole graph in sight. */
  fit(): void;
  /** Brings a node into the middle of the view, beside the panel. */
  focus(id: string): void;
}

interface Props {
  ids: string[];
  /** The lines from each node to the nodes that hang under it. */
  links: GraphLink[];
  /** Lines drawn by hand between related nodes. */
  lines: Relation[];
  /** The node held in the middle unless put elsewhere (the logic's start). */
  center?: string | null;
  /** Where nodes put by hand are kept, in this browser: a layout, not part of the data. */
  pinKey: string;
  label: (id: string) => string;
  /** More about a node, shown when the pointer rests on it (where a block comes from). */
  detail?: (id: string) => string | undefined;
  look: (id: string, on: boolean) => NodeLook;
  /** What the kinds of node mean, beside the lines' meaning under the graph. */
  keys?: { label: string; look: NodeLook }[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** The nodes `id` cannot go under (itself and those under it); null when it goes under none (the start). */
  branchOf: (id: string) => ReadonlySet<string> | null;
  onPlace: (id: string, under: string) => void;
  /** The nodes a line from `id` cannot go to. */
  lineSkip: (id: string) => ReadonlySet<string>;
  onRelate: (a: string, b: string, on: boolean) => void;
  /** A node let go outside the canvas: true when what is there took it (the logic's list takes blocks out). */
  onDropOutside?: (id: string, clientX: number, clientY: number) => boolean;
  /** A double click on an empty place: the point in the graph, and where in the canvas a menu fits. */
  onEmptyDoubleClick?: (at: [number, number], menu: { left: number; top: number }) => void;
  /** The largest menu a double click opens, kept inside the canvas. */
  menuSize?: { width: number; height: number };
  /** A double click on a node. */
  onOpen?: (id: string) => void;
  /** Where a new node will show, while its kind is chosen. */
  ghost?: [number, number] | null;
  /** The wheel zooms (a view of its own); on a page that scrolls, only with ⌘/Ctrl held or a pinch. */
  wheelZooms?: boolean;
  /** Whether the canvas is on screen: the first view waits for it. */
  visible?: boolean;
  /** Room a panel takes on the right of a wide canvas, kept clear when a node is brought into view. */
  aside?: number;
  /** What the graph is, for screen readers. */
  title: string;
  /** Shown in place of a graph without nodes. */
  empty?: React.ReactNode;
  /** Shown over the bottom of the canvas. */
  hint?: React.ReactNode;
  /** Whether any node is put by hand, for a button that lets them go. */
  onPinned?: (any: boolean) => void;
  className?: string;
  /** Over the canvas: a panel, a menu. */
  children?: React.ReactNode;
}

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const shortTitle = (title: string) => (title.length > 28 ? `${title.slice(0, 27)}…` : title);

type Pins = Record<string, [number, number]>;
function readPins(key: string): Pins {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') as Pins;
  } catch {
    return {};
  }
}
function writePins(key: string, pins: Pins): void {
  try {
    if (Object.keys(pins).length > 0) localStorage.setItem(key, JSON.stringify(pins));
    else localStorage.removeItem(key);
  } catch {
    // The layout stays for this visit only.
  }
}

/**
 * A graph like Obsidian's: nodes laid out by forces, a line from each node to the nodes under it, dashed lines
 * drawn by hand between related ones. Dragged onto another node a node goes under it, anywhere else it stays
 * where it is put; a line is drawn from the small dot of the node under the pointer to another node. The views
 * around it (the logic of a paper, the research space) own the data and say what each change means.
 */
const ForceGraph = React.forwardRef<ForceGraphHandle, Props>(function ForceGraph(
  {
    ids,
    links,
    lines,
    center = null,
    pinKey,
    label,
    detail,
    look,
    keys = [],
    selected,
    onSelect,
    branchOf,
    onPlace,
    lineSkip,
    onRelate,
    onDropOutside,
    onEmptyDoubleClick,
    menuSize = { width: 160, height: 170 },
    onOpen,
    ghost = null,
    wheelZooms = true,
    visible = true,
    aside = 0,
    title,
    empty,
    hint,
    onPinned,
    className = '',
    children,
  },
  ref,
) {
  const t = useT();
  const [hovered, setHovered] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  // A line being drawn from a node to the pointer, and a line clicked to take it away.
  const [drawing, setDrawing] = useState<{ from: string; x: number; y: number } | null>(null);
  const [pickedLine, setPickedLine] = useState<Relation | null>(null);
  const [, setFrame] = useState(0);
  const viewport = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const pins = useRef<Pins>(readPins(pinKey));
  const pinned = useRef(onPinned);
  pinned.current = onPinned;
  const tellPins = () => pinned.current?.(Object.keys(pins.current).length > 0);
  useEffect(() => {
    tellPins();
  }, []);

  // Who hangs under whom, from the branch lines.
  const parentOf = useMemo(() => new Map(links.map((line) => [line.target, line.source])), [links]);
  const childrenOf = useMemo(() => {
    const found = new Map<string, string[]>();
    for (const line of links) found.set(line.source, [...(found.get(line.source) ?? []), line.target]);
    return found;
  }, [links]);

  // The forces, and the nodes they move, kept across renders so every node keeps its place.
  const simulation = useRef<Simulation<GraphNode, GraphEdge> | null>(null);
  const nodes = useRef(new Map<string, GraphNode>());
  const frame = useRef(0);
  const animate = useCallback(() => {
    const forces = simulation.current;
    if (!forces || frame.current) return;
    const step = () => {
      forces.tick();
      setFrame((n) => n + 1);
      frame.current = forces.alpha() > forces.alphaMin() || forces.alphaTarget() > 0 ? requestAnimationFrame(step) : 0;
    };
    frame.current = requestAnimationFrame(step);
  }, []);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      simulation.current?.stop();
    },
    [],
  );

  // The graph anew: nodes in and out (a new one next to the node it hangs under), the lines, then the forces settle.
  useEffect(() => {
    const forces =
      simulation.current ??
      forceSimulation<GraphNode>()
        .stop()
        .force('charge', forceManyBody<GraphNode>().strength(-520).distanceMax(900))
        .force(
          'collide',
          // Room for the label under each node, too.
          forceCollide<GraphNode>((node) => node.r + 38),
        )
        .force('x', forceX<GraphNode>(0).strength(0.03))
        .force('y', forceY<GraphNode>(0).strength(0.03))
        .force(
          'link',
          forceLink<GraphNode, GraphEdge>([])
            .id((node) => node.id)
            .distance(130)
            .strength(0.5),
        )
        // A drawn line pulls its nodes a little closer, not as hard as a branch.
        .force(
          'relations',
          forceLink<GraphNode, GraphEdge>([])
            .id((node) => node.id)
            .distance(170)
            .strength(0.06),
        );
    simulation.current = forces;
    const before = nodes.current;
    const next = new Map<string, GraphNode>();
    for (const id of ids) {
      const parent = parentOf.get(id);
      const anchor = parent ? (next.get(parent) ?? before.get(parent)) : undefined;
      const pin = pins.current[id];
      const node = before.get(id) ?? {
        id,
        r: 0,
        x: pin ? pin[0] : (anchor?.x ?? 0) + (Math.random() - 0.5) * 80,
        y: pin ? pin[1] : (anchor?.y ?? 0) + 50 + Math.random() * 40,
      };
      node.r = radiusOf(childrenOf.get(id)?.length ?? 0, id === center);
      // The center holds the middle unless put elsewhere; nodes put by hand stay where they were put.
      const fixed = pin ?? (id === center ? [0, 0] : null);
      node.fx = fixed ? fixed[0] : null;
      node.fy = fixed ? fixed[1] : null;
      next.set(id, node);
    }
    nodes.current = next;
    forces.nodes([...next.values()]);
    (forces.force('link') as ForceLink<GraphNode, GraphEdge>).links(links.map((line) => ({ ...line })));
    (forces.force('relations') as ForceLink<GraphNode, GraphEdge>).links(lines.map(([source, target]) => ({ source, target })));
    forces.alpha(before.size === 0 ? 1 : 0.6);
    // Settled at once (a tab in the background never animates), then gliding the rest of the way.
    for (let tick = 0; tick < (before.size === 0 ? 300 : 160); tick += 1) forces.tick();
    setFrame((n) => n + 1);
    animate();
  }, [ids, links, lines, center, parentOf, childrenOf, animate]);

  const placed: Placed[] = [...nodes.current.values()].map((node) => ({ id: node.id, x: node.x ?? 0, y: node.y ?? 0, r: node.r }));
  const placedRef = useRef(placed);
  placedRef.current = placed;

  // The middle of the view the first time the canvas has a size (a large graph all in sight).
  const shown = useRef(false);
  useLayoutEffect(() => {
    const rect = viewport.current?.getBoundingClientRect();
    if (!visible || shown.current || !rect || rect.width === 0) return;
    shown.current = true;
    setView(placedRef.current.length > 6 ? fitAll(placedRef.current, rect.width, rect.height) : { x: rect.width / 2, y: rect.height / 2.4, k: 1 });
  });

  const fitView = () => {
    const element = viewport.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setView(fitAll(placed, width, height));
  };

  /** Zooms by `factor` keeping the point (px, py) of the view where it is. */
  const zoom = useCallback((factor: number, px?: number, py?: number) => {
    const rect = viewport.current?.getBoundingClientRect();
    const x = px ?? (rect ? rect.width / 2 : 0);
    const y = py ?? (rect ? rect.height / 2 : 0);
    setView((current) => {
      const k = clamp(current.k * factor, MIN_ZOOM, MAX_ZOOM);
      const ratio = k / current.k;
      return { k, x: x - (x - current.x) * ratio, y: y - (y - current.y) * ratio };
    });
  }, []);

  // The wheel zooms around the pointer (a pinch on a trackpad too). On a page that scrolls, a plain wheel scrolls it.
  useEffect(() => {
    const element = viewport.current;
    if (!element) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (!wheelZooms && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const delta = (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1) * event.deltaY;
      zoom(Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0015)), event.clientX - rect.left, event.clientY - rect.top);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoom, wheelZooms]);

  /** A point of the window in the graph's own units. */
  const toGraph = (clientX: number, clientY: number) => {
    const rect = viewport.current?.getBoundingClientRect();
    const current = viewRef.current;
    return { x: (clientX - (rect?.left ?? 0) - current.x) / current.k, y: (clientY - (rect?.top ?? 0) - current.y) / current.k };
  };
  const inside = (clientX: number, clientY: number) => {
    const rect = viewport.current?.getBoundingClientRect();
    return !!rect && clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  };

  /** Room in sight beside the panel, when one is open on a wide canvas. */
  const roomOf = (width: number, panelOpen: boolean) => (panelOpen && aside > 0 && width >= 640 ? width - aside : width);

  useImperativeHandle(ref, () => ({
    pointAt: (clientX, clientY) => {
      if (!inside(clientX, clientY)) return null;
      const at = toGraph(clientX, clientY);
      return [at.x, at.y];
    },
    nodeAt: (clientX, clientY, skip) => {
      if (!inside(clientX, clientY)) return null;
      const at = toGraph(clientX, clientY);
      return nodeAt(placedRef.current, at.x, at.y, skip);
    },
    aim: (id) => setTarget(id),
    pin: (id, at) => {
      pins.current[id] = at;
      writePins(pinKey, pins.current);
      const node = nodes.current.get(id);
      if (node) {
        node.fx = node.x = at[0];
        node.fy = node.y = at[1];
      }
      tellPins();
      setFrame((n) => n + 1);
    },
    unpin: (id) => {
      if (!pins.current[id]) return;
      delete pins.current[id];
      writePins(pinKey, pins.current);
      tellPins();
    },
    freeSpot: () => {
      const rect = viewport.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return [0, 0];
      const room = roomOf(rect.width, selected !== null);
      const centre = toGraph(rect.left + room / 2, rect.top + rect.height / 2);
      // Clear of the nodes there and their labels: the middle, else the nearest such place around it, below first.
      const free = (x: number, y: number) => placedRef.current.every((node) => Math.abs(node.x - x) > 80 || Math.abs(node.y - y) > 50);
      for (let ring = 0; ring <= 6; ring += 1) {
        for (let step = 0; step < (ring === 0 ? 1 : 8); step += 1) {
          const angle = Math.PI / 2 + (step * Math.PI) / 4;
          const x = centre.x + Math.cos(angle) * ring * 60;
          const y = centre.y + Math.sin(angle) * ring * 60;
          if (free(x, y)) return [x, y];
        }
      }
      return [centre.x, centre.y];
    },
    relayout: () => {
      pins.current = {};
      writePins(pinKey, {});
      tellPins();
      for (const node of nodes.current.values()) {
        node.fx = node.id === center ? 0 : null;
        node.fy = node.id === center ? 0 : null;
      }
      const forces = simulation.current;
      if (!forces) return;
      forces.alpha(1);
      for (let tick = 0; tick < 200; tick += 1) forces.tick();
      setFrame((n) => n + 1);
      animate();
    },
    fit: () => fitView(),
    focus: (id) => {
      const node = nodes.current.get(id);
      const element = viewport.current;
      if (!node || !element) return;
      const { width, height } = element.getBoundingClientRect();
      const room = roomOf(width, true);
      setView((current) => ({ ...current, x: room / 2 - (node.x ?? 0) * current.k, y: height / 2 - (node.y ?? 0) * current.k }));
    },
  }));

  // The node the last press was on (null: anything else). A pressed node captures the pointer for the canvas, so
  // the double click that follows reaches the canvas rather than the node.
  const pressed = useRef<string | null>(null);
  const onPressCapture = (event: React.PointerEvent) => {
    const element = event.target as Element;
    pressed.current = element.closest('.cursor-crosshair') ? null : (element.closest('[data-graph-node]')?.getAttribute('data-graph-node') ?? null);
  };

  /** A double click on a node opens it; on an empty place of the canvas, what the view offers there. */
  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (pressed.current) {
      onOpen?.(pressed.current);
      return;
    }
    if (!onEmptyDoubleClick || (event.target as Element).closest('[data-graph-line], button, .cursor-crosshair')) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const at = toGraph(event.clientX, event.clientY);
    onEmptyDoubleClick([at.x, at.y], {
      left: clamp(event.clientX - rect.left + 16, 8, rect.width - menuSize.width),
      top: clamp(event.clientY - rect.top - 12, 8, rect.height - menuSize.height),
    });
  };

  // A node in hand, or the canvas: the middle button drags the canvas anywhere, the left one where there is no node.
  const grab = useRef<
    | { kind: 'node'; id: string; pointer: number; x: number; y: number; moved: boolean; skip: ReadonlySet<string> | null }
    | { kind: 'pan'; pointer: number; x: number; y: number; from: View; moved: boolean }
    | { kind: 'line'; from: string; pointer: number; x: number; y: number; moved: boolean }
    | null
  >(null);
  const capture = (pointerId: number) => {
    try {
      viewport.current?.setPointerCapture(pointerId);
    } catch {
      // A pointer the browser no longer tracks: the drag still follows it over the canvas.
    }
  };
  const onHandleDown = (event: React.PointerEvent, id: string) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    capture(event.pointerId);
    const node = nodes.current.get(id);
    grab.current = { kind: 'line', from: id, pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    setDrawing({ from: id, x: node?.x ?? 0, y: node?.y ?? 0 });
    setPickedLine(null);
  };
  const onNodeDown = (event: React.PointerEvent, id: string) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    capture(event.pointerId);
    grab.current = { kind: 'node', id, pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false, skip: branchOf(id) };
  };
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 1 && event.button !== 0) return;
    // The middle button would otherwise scroll the page (or paste, on Linux).
    event.preventDefault();
    capture(event.pointerId);
    grab.current = { kind: 'pan', pointer: event.pointerId, x: event.clientX, y: event.clientY, from: viewRef.current, moved: false };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const held = grab.current;
    if (!held || held.pointer !== event.pointerId) return;
    const dx = event.clientX - held.x;
    const dy = event.clientY - held.y;
    if (!held.moved && Math.abs(dx) + Math.abs(dy) <= 4) return;
    held.moved = true;
    if (held.kind === 'pan') {
      setView({ ...held.from, x: held.from.x + dx, y: held.from.y + dy });
      return;
    }
    const at = toGraph(event.clientX, event.clientY);
    if (held.kind === 'line') {
      setDrawing({ from: held.from, x: at.x, y: at.y });
      setTarget(nodeAt(placed, at.x, at.y, lineSkip(held.from)));
      return;
    }
    const node = nodes.current.get(held.id);
    if (!node) return;
    // Held where the pointer is, drawn there at once, whether or not the forces have ticked.
    node.fx = node.x = at.x;
    node.fy = node.y = at.y;
    simulation.current?.alphaTarget(0.25);
    animate();
    setTarget(held.skip ? nodeAt(placed, at.x, at.y, held.skip) : null);
    setFrame((n) => n + 1);
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const held = grab.current;
    if (!held || held.pointer !== event.pointerId) return;
    grab.current = null;
    if (held.kind === 'pan') {
      // A click on the canvas, not a drag of it, puts the node (or the line) in hand down.
      if (!held.moved && event.button === 0) {
        onSelect(null);
        setPickedLine(null);
      }
      return;
    }
    if (held.kind === 'line') {
      const at = toGraph(event.clientX, event.clientY);
      const to = held.moved ? nodeAt(placed, at.x, at.y, lineSkip(held.from)) : null;
      setDrawing(null);
      setTarget(null);
      if (to) onRelate(held.from, to, true);
      return;
    }
    simulation.current?.alphaTarget(0);
    const node = nodes.current.get(held.id);
    setTarget(null);
    if (!held.moved || !node) {
      onSelect(held.id);
      return;
    }
    if (!inside(event.clientX, event.clientY) && onDropOutside?.(held.id, event.clientX, event.clientY)) return;
    const over = held.skip ? nodeAt(placed, node.fx ?? 0, node.fy ?? 0, held.skip) : null;
    if (over) {
      // Under its new node, where the forces put it.
      delete pins.current[held.id];
      node.fx = null;
      node.fy = null;
      writePins(pinKey, pins.current);
      tellPins();
      onPlace(held.id, over);
      return;
    }
    pins.current[held.id] = [node.fx ?? 0, node.fy ?? 0];
    writePins(pinKey, pins.current);
    tellPins();
    setFrame((n) => n + 1);
    animate();
  };

  // The node under the pointer and what it is linked to, by a branch or a drawn line.
  const focus = hovered ?? target;
  const neighbours = useMemo(() => {
    if (!focus) return null;
    const near = new Set([focus, ...(childrenOf.get(focus) ?? []), ...relatedTo(lines, focus)]);
    const parent = parentOf.get(focus);
    if (parent) near.add(parent);
    return near;
  }, [focus, childrenOf, parentOf, lines]);
  const control = 'flex h-8 min-w-8 items-center justify-center rounded-md px-1.5 text-gray-600 hover:bg-black/[0.05] hover:text-gray-900';
  const strokeOf = (width: number) => width / Math.max(0.6, view.k);
  const dash = `${6 / Math.max(0.6, view.k)} ${5 / Math.max(0.6, view.k)}`;

  return (
    <div className={`relative min-h-0 ${className}`}>
      <div
        ref={viewport}
        onPointerDownCapture={onPressCapture}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onAuxClick={(event) => event.preventDefault()}
        className={`absolute inset-0 touch-none select-none overflow-hidden bg-[#fafafb] ${grab.current?.moved ? 'cursor-grabbing' : 'cursor-grab'}`}
        style={{
          backgroundImage: 'radial-gradient(circle, rgba(0,0,0,0.07) 1px, transparent 1.2px)',
          backgroundSize: `${24 * view.k}px ${24 * view.k}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
      >
        {ids.length === 0 ? (
          empty
        ) : (
          <svg className="absolute inset-0 h-full w-full overflow-visible" aria-label={title}>
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              {/* Lines drawn by hand: dashed, under the branches; a wide clear line takes the click. */}
              {lines.map(([a, b]) => {
                const from = nodes.current.get(a);
                const to = nodes.current.get(b);
                if (!from || !to) return null;
                const lit = focus === a || focus === b;
                const picked = pickedLine?.[0] === a && pickedLine[1] === b;
                return (
                  <g key={`line-${a}-${b}`}>
                    <line
                      x1={from.x}
                      y1={from.y}
                      x2={to.x}
                      y2={to.y}
                      stroke={picked ? '#2563eb' : '#60a5fa'}
                      strokeWidth={strokeOf(lit || picked ? 2 : 1.4)}
                      strokeDasharray={dash}
                      opacity={neighbours && !lit ? 0.3 : 1}
                    />
                    <line
                      x1={from.x}
                      y1={from.y}
                      x2={to.x}
                      y2={to.y}
                      stroke="transparent"
                      strokeWidth={14 / view.k}
                      data-graph-line
                      className="cursor-pointer"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => setPickedLine([a, b])}
                    >
                      <title>{t('「{a}」和「{b}」的关联', { a: label(a), b: label(b) })}</title>
                    </line>
                  </g>
                );
              })}
              {drawing && nodes.current.get(drawing.from) && (
                <line
                  x1={nodes.current.get(drawing.from)?.x}
                  y1={nodes.current.get(drawing.from)?.y}
                  x2={drawing.x}
                  y2={drawing.y}
                  stroke="#2563eb"
                  strokeWidth={strokeOf(1.8)}
                  strokeDasharray={dash}
                  className="pointer-events-none"
                />
              )}
              {links.map((line) => {
                const from = nodes.current.get(line.source);
                const to = nodes.current.get(line.target);
                if (!from || !to) return null;
                const lit = neighbours ? neighbours.has(line.source) && neighbours.has(line.target) : false;
                return (
                  <line
                    key={`${line.source}-${line.target}`}
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    stroke={lit ? '#8b5cf6' : '#cfcfd6'}
                    strokeWidth={strokeOf(lit ? 1.8 : 1.2)}
                    opacity={neighbours && !lit ? 0.35 : 1}
                  />
                );
              })}
              {ids.map((id) => {
                const node = nodes.current.get(id);
                if (!node) return null;
                const on = id === selected || id === target || id === hovered;
                const shape = look(id, on);
                const dim = neighbours && !neighbours.has(id);
                // Linked to nothing yet: a dashed outline.
                const alone = id !== center && !parentOf.has(id) && !childrenOf.has(id);
                const showLabel = view.k >= 0.55 || on || shape.strong;
                const ring = (grow: number, props: { fill: string; stroke: string; strokeWidth: number; strokeDasharray?: string }) =>
                  shape.square ? (
                    <rect x={-node.r - grow} y={-node.r - grow} width={2 * (node.r + grow)} height={2 * (node.r + grow)} rx={(node.r + grow) * 0.35} {...props} />
                  ) : (
                    <circle r={node.r + grow} {...props} />
                  );
                return (
                  <g
                    key={id}
                    data-graph-node={id}
                    transform={`translate(${node.x ?? 0} ${node.y ?? 0})`}
                    role="button"
                    tabIndex={0}
                    aria-label={label(id)}
                    aria-pressed={id === selected}
                    onPointerDown={(event) => onNodeDown(event, id)}
                    onPointerEnter={() => setHovered(id)}
                    onPointerLeave={() => setHovered((current) => (current === id ? null : current))}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onSelect(id);
                      }
                    }}
                    className="cursor-pointer outline-none"
                    opacity={dim ? 0.3 : 1}
                  >
                    {detail?.(id) && <title>{detail(id)}</title>}
                    {id === target && ring(9, { fill: 'rgba(139,92,246,0.14)', stroke: '#8b5cf6', strokeWidth: 1.5 })}
                    {id === selected && ring(5, { fill: 'none', stroke: '#7c3aed', strokeWidth: 2 })}
                    {ring(0, { fill: shape.fill, stroke: shape.stroke, strokeWidth: shape.strokeWidth, strokeDasharray: alone ? '3 2' : undefined })}
                    {showLabel && (
                      <text
                        y={node.r + 14}
                        textAnchor="middle"
                        className="pointer-events-none select-none"
                        fontSize={shape.strong ? 13 : 12}
                        fontWeight={shape.strong || on ? 600 : 400}
                        fill={shape.strong || on ? '#1f2937' : '#4b5563'}
                        stroke="#fafafb"
                        strokeWidth={3}
                        paintOrder="stroke"
                      >
                        {shortTitle(label(id))}
                      </text>
                    )}
                    {id === target && (
                      <text y={-node.r - 12} textAnchor="middle" className="pointer-events-none" fontSize={11} fill={drawing ? '#2563eb' : '#6d28d9'} fontWeight={600} stroke="#fafafb" strokeWidth={3} paintOrder="stroke">
                        {drawing ? t('连到「{name}」', { name: shortTitle(label(id)) }) : t('挂到「{name}」下面', { name: shortTitle(label(id)) })}
                      </text>
                    )}
                    {/* The dot a line is drawn from, on the node under the pointer or the one chosen. */}
                    {(id === hovered || id === selected) && !drawing && !(grab.current?.kind === 'node' && grab.current.moved) && (
                      <g transform={`translate(${node.r * 0.75 + 5} ${-(node.r * 0.75 + 5)})`} onPointerDown={(event) => onHandleDown(event, id)} className="cursor-crosshair">
                        <title>{t('拖到另一个节点上，连一条关联线')}</title>
                        <circle r={6.5} fill="#ffffff" stroke="#2563eb" strokeWidth={1.5} />
                        <path d="M -3 0 H 3 M 0 -3 V 3" stroke="#2563eb" strokeWidth={1.5} strokeLinecap="round" />
                      </g>
                    )}
                  </g>
                );
              })}
              {ghost && (
                <circle cx={ghost[0]} cy={ghost[1]} r={10} fill="rgba(139,92,246,0.12)" stroke="#8b5cf6" strokeWidth={1.5} strokeDasharray="3 2" className="pointer-events-none" />
              )}
            </g>
          </svg>
        )}
        {hint}
        {/* A line clicked: what can be done with it, at its middle. */}
        {pickedLine &&
          (() => {
            const from = nodes.current.get(pickedLine[0]);
            const to = nodes.current.get(pickedLine[1]);
            if (!from || !to || !related(lines, pickedLine[0], pickedLine[1])) return null;
            const x = (((from.x ?? 0) + (to.x ?? 0)) / 2) * view.k + view.x;
            const y = (((from.y ?? 0) + (to.y ?? 0)) / 2) * view.k + view.y;
            return (
              <button
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => {
                  onRelate(pickedLine[0], pickedLine[1], false);
                  setPickedLine(null);
                }}
                className="absolute z-10 inline-flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 whitespace-nowrap rounded-full bg-white px-2.5 py-1 text-xs text-red-700 shadow-md ring-1 ring-black/[0.08] hover:bg-red-50"
                style={{ left: x, top: y }}
              >
                <X size={12} />
                {t('删除这条关联')}
              </button>
            );
          })()}
      </div>

      {/* The zoom and what the lines mean, over the canvas. */}
      <div className="absolute bottom-3 left-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-lg bg-white/95 p-0.5 shadow-sm ring-1 ring-black/[0.06]">
          <button type="button" onClick={() => zoom(1 / 1.25)} aria-label={t('缩小')} title={t('缩小')} className={control}>
            <Minus size={15} />
          </button>
          <span className="w-12 text-center text-xs tabular-nums text-gray-600">{Math.round(view.k * 100)}%</span>
          <button type="button" onClick={() => zoom(1.25)} aria-label={t('放大')} title={t('放大')} className={control}>
            <Plus size={15} />
          </button>
          <button type="button" onClick={fitView} aria-label={t('显示全部')} title={t('显示全部')} className={control}>
            <Scan size={15} />
          </button>
        </div>
        <div className="hidden items-center gap-3 rounded-lg bg-white/95 px-3 py-1.5 text-[11.5px] text-gray-500 shadow-sm ring-1 ring-black/[0.06] sm:flex">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-5 rounded bg-[#cfcfd6]" />
            {t('分支')}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-5 border-t-2 border-dashed border-[#60a5fa]" />
            {t('关联')}
          </span>
          {keys.map((key) => (
            <span key={key.label} className="inline-flex items-center gap-1.5">
              <svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true">
                {key.look.square ? (
                  <rect x={-4.5} y={-4.5} width={9} height={9} rx={2.5} fill={key.look.fill} stroke={key.look.stroke} strokeWidth={1.5} />
                ) : (
                  <circle r={4.5} fill={key.look.fill} stroke={key.look.stroke} strokeWidth={1.5} />
                )}
              </svg>
              {key.label}
            </span>
          ))}
        </div>
      </div>
      {children}
    </div>
  );
});

export default ForceGraph;
