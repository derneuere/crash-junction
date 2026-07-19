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
import { applyLevelDerives } from './race';
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
  /** Insert a fresh item and select it; index defaults to append. */
  addListItem: (listPath: NodePath, item: unknown, index?: number) => void;
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
  // gesture bookkeeping lives in refs — a drag must not re-render per pointermove.
  // gestureChanged (not identity vs levelRef) decides whether to commit: with
  // continuous pointer events React may defer the transient re-render past
  // pointerup, so levelRef can still be stale when the gesture ends.
  const gestureBase = useRef<LevelDef | null>(null);
  const gestureChanged = useRef(false);
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
    commit(applyLevelDerives(setAtPath(levelRef.current, path, value), path));
  }, [commit]);

  const addListItem = useCallback((listPath: NodePath, item: unknown, index?: number) => {
    const list = getAtPath(levelRef.current, listPath);
    const at = index ?? (Array.isArray(list) ? list.length : 0);
    let base = levelRef.current;
    if (!Array.isArray(list)) base = setAtPath(base, listPath, []); // optional list (props/roads) may be absent
    commit(applyLevelDerives(insertListItem(base, listPath, at, item), listPath));
    setSelection([...listPath, at]);
  }, [commit]);

  const removeAt = useCallback((listPath: NodePath, index: number) => {
    commit(applyLevelDerives(removeListItem(levelRef.current, listPath, index), listPath));
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
    gestureChanged.current = false;
  }, []);

  const transientSetAt = useCallback((path: NodePath, value: unknown) => {
    if (gestureBase.current) gestureChanged.current = true;
    // derives run on transients too — a waypoint drag re-derives sections
    // live so the ribbon follows the handle
    setLevel((cur) => applyLevelDerives(setAtPath(cur, path, value), path));
  }, []);

  const endGesture = useCallback(() => {
    const base = gestureBase.current;
    const changed = gestureChanged.current;
    gestureBase.current = null;
    gestureChanged.current = false;
    if (!base || !changed) return; // grab-without-move
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
