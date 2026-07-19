// Immutable path walker over the level object — steward's lib/schema/walk.ts
// pattern. All editor mutations funnel through setAtPath/insert/remove so the
// undo stack can snapshot plain values and React state stays referentially
// honest (every ancestor along the path is re-created, siblings are shared).

import type { LevelSchema, NodePath, RecordSchema } from './types';

export function getAtPath(root: unknown, path: NodePath): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

/** Immutable write: returns a new root with `value` at `path`. Creates
 *  nothing — a missing intermediate is a caller bug and throws. */
export function setAtPath<T>(root: T, path: NodePath, value: unknown): T {
  if (path.length === 0) return value as T;
  const [head, ...rest] = path;
  if (root == null || typeof root !== 'object') {
    throw new Error(`setAtPath: no container at segment '${String(head)}'`);
  }
  if (Array.isArray(root)) {
    const idx = head as number;
    const copy = root.slice();
    copy[idx] = setAtPath(root[idx], rest, value);
    return copy as T;
  }
  const obj = root as Record<string, unknown>;
  return { ...obj, [head as string]: setAtPath(obj[head as string], rest, value) } as T;
}

/** Immutable list insert; index === list.length appends. */
export function insertListItem<T>(root: T, listPath: NodePath, index: number, item: unknown): T {
  const list = getAtPath(root, listPath);
  if (!Array.isArray(list)) throw new Error('insertListItem: not a list at path');
  const copy = list.slice();
  copy.splice(index, 0, item);
  return setAtPath(root, listPath, copy);
}

export function removeListItem<T>(root: T, listPath: NodePath, index: number): T {
  const list = getAtPath(root, listPath);
  if (!Array.isArray(list)) throw new Error('removeListItem: not a list at path');
  const copy = list.slice();
  copy.splice(index, 1);
  return setAtPath(root, listPath, copy);
}

/** Where a path lands in the schema: the deepest RECORD at-or-above the path.
 *  The inspector renders records — a path pointing at a leaf field resolves
 *  to its parent record with `recordPath` trimmed accordingly. */
export interface SchemaLocation {
  record: RecordSchema;
  /** Path of the object the record schema describes. */
  recordPath: NodePath;
}

export function resolveRecordAtPath(schema: LevelSchema, path: NodePath): SchemaLocation | null {
  let record = schema.registry[schema.rootType];
  if (!record) return null;
  let recordPath: NodePath = [];
  let i = 0;
  while (i < path.length) {
    const seg = path[i];
    const field = record.fields[seg as string];
    if (!field) break; // leaf or unknown — stop at the current record
    if (field.kind === 'record') {
      const next = schema.registry[field.type];
      if (!next) break;
      record = next;
      recordPath = path.slice(0, i + 1);
      i += 1;
    } else if (field.kind === 'list') {
      // need an index segment to descend into the item record
      if (i + 1 >= path.length) break;
      const next = schema.registry[field.item];
      if (!next) break;
      record = next;
      recordPath = path.slice(0, i + 2);
      i += 2;
    } else {
      break; // primitive leaf — record stays the parent
    }
  }
  return { record, recordPath };
}
