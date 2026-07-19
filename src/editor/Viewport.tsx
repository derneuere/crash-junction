// React wrapper around EditorScene — mounts the raw-three view once, streams
// level/selection/gizmo-mode changes into it, and wires its pick/drag
// callbacks into the editor context. Rebuilds are skipped mid-drag (the
// scene already moved the mesh); the race ribbon alone updates live so a
// waypoint drag reshapes the derived track; the drag-end handler forces one
// final sync rebuild.

import { useEffect, useRef } from 'react';
import type { LevelDef, RaceWaypoint } from '../game/types';
import { EditorScene, type GizmoMode } from './viewport/EditorScene';
import { getAtPath } from './schema/walk';
import type { NodePath } from './schema/types';
import { useEditor } from './state';

export function Viewport({ gizmoMode }: { gizmoMode: GizmoMode }) {
  const { level, selection, select, beginGesture, transientSetAt, endGesture } = useEditor();
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<EditorScene | null>(null);
  const levelRef = useRef<LevelDef>(level);
  levelRef.current = level;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scene = new EditorScene(container, {
      onSelect: select,
      onTransientMove: (itemPath: NodePath, patch) => {
        // race waypoints are [x, z] / [x, z, y] tuples, not records — a move
        // rewrites the tuple whole, keeping any elevation component
        if (itemPath[0] === 'mode' && itemPath[2] === 'waypoints') {
          const old = getAtPath(levelRef.current, itemPath) as RaceWaypoint | undefined;
          const x = (patch.x as number) ?? old?.[0] ?? 0;
          const z = (patch.z as number) ?? old?.[1] ?? 0;
          const next: RaceWaypoint = old && old.length > 2 ? [x, z, old[2]!] : [x, z];
          transientSetAt(itemPath, next);
          return;
        }
        for (const [field, v] of Object.entries(patch)) {
          transientSetAt([...itemPath, field], v);
        }
      },
      onDragStart: beginGesture,
      onDragEnd: () => {
        endGesture();
        scene.setLevel(levelRef.current);
      },
    });
    sceneRef.current = scene;
    scene.setLevel(levelRef.current);
    return () => {
      sceneRef.current = null;
      scene.dispose();
    };
    // mount-once: the callbacks above are stable context fns
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (scene.isDragging()) {
      // full rebuilds would destroy the dragged mesh — but the DERIVED race
      // ribbon must follow a waypoint drag live
      scene.updateRaceRibbon(level);
    } else {
      scene.setLevel(level);
    }
  }, [level]);

  useEffect(() => {
    sceneRef.current?.setSelection(selection);
  }, [selection]);

  useEffect(() => {
    sceneRef.current?.setGizmoMode(gizmoMode);
  }, [gizmoMode]);

  return <div className="edViewport" ref={containerRef} />;
}
