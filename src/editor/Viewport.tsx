// React wrapper around EditorScene — mounts the raw-three view once, streams
// level/selection changes into it, and wires its pick/drag callbacks into
// the editor context. Rebuilds are skipped mid-drag (the scene already moved
// the mesh); the drag-end handler forces one final sync rebuild.

import { useEffect, useRef } from 'react';
import type { LevelDef } from '../game/types';
import { EditorScene } from './viewport/EditorScene';
import { useEditor } from './state';

export function Viewport() {
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
      onTransientMove: (itemPath, patch) => {
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
    if (scene && !scene.isDragging()) scene.setLevel(level);
  }, [level]);

  useEffect(() => {
    sceneRef.current?.setSelection(selection);
  }, [selection]);

  return <div className="edViewport" ref={containerRef} />;
}
