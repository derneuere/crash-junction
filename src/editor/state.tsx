// The editor's single source of truth — steward's WorkspaceContext pattern
// scaled to one document: the working LevelDef, a NodePath selection shared
// by tree/viewport/inspector, and a pure { past, future } undo stack of full
// level snapshots (levels are tiny; whole-object snapshots beat per-commit
// bookkeeping). Gestures (viewport drags) snapshot once at drag start so a
// whole drag undoes as one step.

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import type { LevelDef } from '../game/types';
import type { NodePath } from './schema/types';
import { getAtPath, insertListItem, removeListItem, setAtPath } from './schema/walk';
import { makeBlankLevel } from './defaults';
import { readDraft, writeDraft } from './io';

const HISTORY_CAP = 64;

export interface EditorState {
  level: LevelDef;
  selection: NodePath | null;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;

  select: (path: NodePath | null) => void;
  /** Committing write: pushes the pre-change level onto the undo stack. */
  setValueAt: (path: NodePath, value: unknown) => void;
  /** Insert a fresh item and select it. */
  addListItem: (listPath: NodePath, item: unknown) => void;
  removeAt: (listPath: NodePath, index: number) => void;
  /** Replace the whole level (load/new) — clears history + selection. */
  replaceLevel: (level: LevelDef, opts?: { dirty?: boolean }) => void;
  markSaved: () => void;
  undo: () => void;
  redo: () => void;

  /** Drag gestures: snapshot once, stream transient writes, commit at end. */
  beginGesture: () => void;
  transientSetAt: (path: NodePath, value: unknown) => void;
  endGesture: () => void;
}

const EditorContext = createContext<EditorState | null>(null);

export function useEditor(): EditorState {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error('useEditor outside EditorProvider');
  return ctx;
}

export function EditorProvider({ children }: { children: ReactNode }) {
  const [level, setLevel] = useState<LevelDef>(() => readDraft() ?? makeBlankLevel());
  const [selection, setSelection] = useState<NodePath | null>(null);
  const [dirty, setDirty] = useState(false);
  const [history, setHistory] = useState<{ past: LevelDef[]; future: LevelDef[] }>({ past: [], future: [] });
  // gesture bookkeeping lives in refs — a drag must not re-render per pointermove
  const gestureBase = useRef<LevelDef | null>(null);
  const levelRef = useRef(level);
  levelRef.current = level;

  // draft autosave (debounced) — the editor reopens where you left off
  useEffect(() => {
    const t = setTimeout(() => writeDraft(level), 400);
    return () => clearTimeout(t);
  }, [level]);

  const commit = useCallback((next: LevelDef) => {
    const prev = levelRef.current;
    setHistory((h) => ({ past: [...h.past.slice(-(HISTORY_CAP - 1)), prev], future: [] }));
    setLevel(next);
    setDirty(true);
  }, []);

  const select = useCallback((path: NodePath | null) => setSelection(path), []);

  const setValueAt = useCallback((path: NodePath, value: unknown) => {
    commit(setAtPath(levelRef.current, path, value));
  }, [commit]);

  const addListItem = useCallback((listPath: NodePath, item: unknown) => {
    const list = getAtPath(levelRef.current, listPath);
    const index = Array.isArray(list) ? list.length : 0;
    let base = levelRef.current;
    if (!Array.isArray(list)) base = setAtPath(base, listPath, []); // optional list (props) may be absent
    commit(insertListItem(base, listPath, index, item));
    setSelection([...listPath, index]);
  }, [commit]);

  const removeAt = useCallback((listPath: NodePath, index: number) => {
    commit(removeListItem(levelRef.current, listPath, index));
    setSelection(null);
  }, [commit]);

  const replaceLevel = useCallback((next: LevelDef, opts?: { dirty?: boolean }) => {
    setLevel(next);
    setSelection(null);
    setHistory({ past: [], future: [] });
    setDirty(opts?.dirty ?? false);
  }, []);

  const markSaved = useCallback(() => setDirty(false), []);

  const undo = useCallback(() => {
    setHistory((h) => {
      if (!h.past.length) return h;
      const prev = h.past[h.past.length - 1];
      const cur = levelRef.current;
      setLevel(prev);
      setDirty(true);
      setSelection(null);
      return { past: h.past.slice(0, -1), future: [...h.future, cur] };
    });
  }, []);

  const redo = useCallback(() => {
    setHistory((h) => {
      if (!h.future.length) return h;
      const next = h.future[h.future.length - 1];
      const cur = levelRef.current;
      setLevel(next);
      setDirty(true);
      setSelection(null);
      return { past: [...h.past, cur], future: h.future.slice(0, -1) };
    });
  }, []);

  const beginGesture = useCallback(() => {
    gestureBase.current = levelRef.current;
  }, []);

  const transientSetAt = useCallback((path: NodePath, value: unknown) => {
    setLevel((cur) => setAtPath(cur, path, value));
  }, []);

  const endGesture = useCallback(() => {
    const base = gestureBase.current;
    gestureBase.current = null;
    if (!base || base === levelRef.current) return; // no-op drag
    setHistory((h) => ({ past: [...h.past.slice(-(HISTORY_CAP - 1)), base], future: [] }));
    setDirty(true);
  }, []);

  const value = useMemo<EditorState>(() => ({
    level, selection, dirty,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    select, setValueAt, addListItem, removeAt, replaceLevel, markSaved,
    undo, redo, beginGesture, transientSetAt, endGesture,
  }), [
    level, selection, dirty, history,
    select, setValueAt, addListItem, removeAt, replaceLevel, markSaved,
    undo, redo, beginGesture, transientSetAt, endGesture,
  ]);

  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}
