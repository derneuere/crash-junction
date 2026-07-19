// The LEVEL EDITOR screen — steward's three-pane workspace shape: hierarchy
// tree | 3D viewport | schema inspector, under a toolbar that owns file I/O
// (new / load / save-as-JSON), undo/redo and PLAYTEST (App mounts the real
// Game on the working level). Mounted as its own Phase; no Game runs here.

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { LevelDef, RoadDef } from '../game/types';
import { CATEGORY_BY_KEY, makeBlankLevel } from './defaults';
import { downloadLevel, parseLevelFile, writeDraft } from './io';
import type { GizmoMode } from './viewport/EditorScene';
import { Hierarchy } from './Hierarchy';
import { Inspector } from './Inspector';
import { Viewport } from './Viewport';
import { EditorProvider, useEditor } from './state';

export interface EditorAppProps {
  onBack: () => void;
  onPlaytest: (level: LevelDef) => void;
}

function isTyping(): boolean {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable);
}

function EditorShell({ onBack, onPlaytest }: EditorAppProps) {
  const {
    level, selection, dirty, canUndo, canRedo,
    undo, redo, removeAt, setValueAt, addListItem, replaceLevel, markSaved,
  } = useEditor();
  const fileRef = useRef<HTMLInputElement>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>('translate');

  // keyboard: undo/redo, gizmo mode (W/E), delete-selected — never while typing
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if ((mod && e.code === 'KeyY') || (mod && e.shiftKey && e.code === 'KeyZ')) { e.preventDefault(); redo(); return; }
      if (isTyping()) return;
      if (e.code === 'KeyW' && !mod) { setGizmoMode('translate'); return; }
      if (e.code === 'KeyE' && !mod) { setGizmoMode('rotate'); return; }
      if (e.code === 'Delete' || e.code === 'Backspace') {
        if (!selection) return;
        // list items live at [listKey, i]; race waypoints at ['mode','race','waypoints', i]
        if (selection[0] === 'mode' && selection[2] === 'waypoints' && typeof selection[3] === 'number') {
          const wps = level.mode.kind === 'race' ? level.mode.race.waypoints ?? [] : [];
          if (wps.length > 3) {
            e.preventDefault();
            removeAt(['mode', 'race', 'waypoints'], selection[3]);
          }
          return;
        }
        if (selection.length >= 2 && typeof selection[1] === 'number') {
          e.preventDefault();
          removeAt([selection[0]], selection[1] as number);
        }
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [undo, redo, removeAt, selection, level]);

  const loadText = (text: string) => {
    try {
      replaceLevel(parseLevelFile(text));
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  };

  // drag-drop a .json level anywhere on the editor
  useEffect(() => {
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f) f.text().then(loadText);
    };
    const onDrag = (e: DragEvent) => e.preventDefault();
    addEventListener('drop', onDrop);
    addEventListener('dragover', onDrag);
    return () => {
      removeEventListener('drop', onDrop);
      removeEventListener('dragover', onDrag);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replaceLevel]);

  const onPickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) f.text().then(loadText);
    e.target.value = '';
  };

  const fresh = () => {
    if (dirty && !confirm('Discard unsaved changes and start a new level?')) return;
    replaceLevel(makeBlankLevel());
  };

  return (
    <div className="edRoot">
      <div className="edToolbar">
        <button className="edBtn back" onClick={onBack}>◂ MENU</button>
        <span className="edTitle">LEVEL EDITOR</span>
        <span className={`edDirty${dirty ? ' on' : ''}`}>{dirty ? '● unsaved' : '✓ saved'}</span>
        <span className="edToolGap" />
        <button className="edBtn" onClick={fresh}>NEW</button>
        <button className="edBtn" onClick={() => fileRef.current?.click()}>LOAD</button>
        <button
          className="edBtn primary"
          onClick={() => { downloadLevel(level); markSaved(); }}
          title="download the level as a JSON file"
        >
          SAVE JSON
        </button>
        <span className="edToolGap" />
        <button
          className={`edBtn${gizmoMode === 'translate' ? ' active' : ''}`}
          onClick={() => setGizmoMode('translate')}
          title="W — gizmo moves (arrows)"
        >
          ✥ MOVE
        </button>
        <button
          className={`edBtn${gizmoMode === 'rotate' ? ' active' : ''}`}
          onClick={() => setGizmoMode('rotate')}
          title="E — gizmo rotates (yaw ring; cars, props, roads)"
        >
          ⟳ ROTATE
        </button>
        <span className="edToolGap" />
        <button
          className="edBtn"
          title="add a straight road strip at the origin"
          onClick={() => addListItem(['roads'], CATEGORY_BY_KEY.roads.makeEmpty())}
        >
          + ROAD
        </button>
        <button
          className="edBtn"
          title="stamp two crossing road strips (a junction)"
          onClick={() => {
            const roads = (level.roads ?? []) as RoadDef[];
            setValueAt(['roads'], [
              ...roads,
              { x: 0, z: 0, yaw: 0, length: 120, width: 14, dashes: true },
              { x: 0, z: 0, yaw: Math.PI / 2, length: 120, width: 14, dashes: true },
            ]);
          }}
        >
          + CROSSROAD
        </button>
        <span className="edToolGap" />
        <button className="edBtn" disabled={!canUndo} onClick={undo} title="Ctrl+Z">↶ UNDO</button>
        <button className="edBtn" disabled={!canRedo} onClick={redo} title="Ctrl+Y">↷ REDO</button>
        <span className="edToolGap" />
        <button
          className="edBtn play"
          onClick={() => {
            writeDraft(level); // the editor unmounts during playtest — pin the draft NOW
            onPlaytest(level);
          }}
        >
          ▶ PLAYTEST
        </button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={onPickFile} />
      </div>
      {loadError && (
        <div className="edLoadError">
          Couldn&apos;t load level: {loadError}
          <button className="edMini" onClick={() => setLoadError(null)}>×</button>
        </div>
      )}
      <div className="edPanes">
        <div className="edPane left"><Hierarchy /></div>
        <div className="edPane center"><Viewport gizmoMode={gizmoMode} /></div>
        <div className="edPane right"><Inspector /></div>
      </div>
      <div className="edFoot">
        W/E = move/rotate gizmo · drag = move · shift = snap (0.5 m / 15°) · click empty = deselect ·
        DEL = remove · drop a .json to load · orbit with left-drag on ground, wheel zooms
      </div>
    </div>
  );
}

export function EditorApp(props: EditorAppProps) {
  return (
    <EditorProvider>
      <EditorShell {...props} />
    </EditorProvider>
  );
}
