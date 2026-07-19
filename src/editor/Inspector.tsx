// Right pane — resolves the NodePath selection to a record schema + data and
// renders the generic RecordForm, with a breadcrumb for nested descent and
// list-item actions (duplicate/delete). The mode record's discriminated
// union gets a small bespoke arm-switcher on top of the generic form.

import type { ModeDef, RaceWaypoint } from '../game/types';
import { makeRaceLevel } from './race';
import { LEVEL_SCHEMA } from './schema/levelSchema';
import type { NodePath } from './schema/types';
import { getAtPath, insertListItem, resolveRecordAtPath } from './schema/walk';
import { RecordForm } from './Fields';
import { useEditor } from './state';

function Breadcrumb({ path }: { path: NodePath }) {
  const { select } = useEditor();
  return (
    <div className="edCrumbs">
      <button className="edCrumb" onClick={() => select(null)}>level</button>
      {path.map((seg, i) => (
        <span key={i}>
          <span className="edCrumbSep">/</span>
          <button className="edCrumb" onClick={() => select(path.slice(0, i + 1))}>{String(seg)}</button>
        </span>
      ))}
    </div>
  );
}

function ModeEditor({ mode }: { mode: ModeDef }) {
  const { level, setValueAt, select } = useEditor();
  const setKind = (kind: string) => {
    if (kind === mode.kind) return;
    if (kind === 'crash') {
      setValueAt(['mode'], { kind: 'crash', medals: { bronze: 80000, silver: 140000, gold: 200000 } });
    } else if (kind === 'practice') {
      setValueAt(['mode'], { kind: 'practice' });
    } else if (kind === 'race') {
      // a whole-level commit: default waypoint loop → derived sections,
      // rivals, player on the grid, grass ground (one undo step)
      setValueAt([], makeRaceLevel(level));
    }
  };
  return (
    <div>
      <div className="edRow">
        <label className="edLabel">kind</label>
        <select className="edSelect" value={mode.kind} onChange={(e) => setKind(e.target.value)}>
          <option value="crash">crash</option>
          <option value="practice">practice</option>
          <option value="race">race</option>
        </select>
      </div>
      {mode.kind === 'crash' && (
        <RecordForm
          record={LEVEL_SCHEMA.registry.medals}
          recordPath={['mode', 'medals']}
          data={mode.medals}
          onEdit={setValueAt}
        />
      )}
      {mode.kind === 'race' && (
        <>
          <div className="edNote">
            Drag the purple WAYPOINTS to shape the circuit — the track (sections)
            re-derives live. Shortcuts/signature zones/wall styles from code-authored
            levels are preserved verbatim.
          </div>
          <RecordForm
            record={LEVEL_SCHEMA.registry.race}
            recordPath={['mode', 'race']}
            data={mode.race}
            onEdit={setValueAt}
            onDescend={select}
          />
        </>
      )}
      {mode.kind === 'practice' && <div className="edNote">Free driving — no stakes, no report.</div>}
    </div>
  );
}

/** Race waypoints are [x, z] / [x, z, y] tuples, not schema records — a
 *  small bespoke form, like ModeEditor. Deletion stops at 3 (a loop needs
 *  three points to derive sections). */
function WaypointForm({ index }: { index: number }) {
  const { level, setValueAt, removeAt } = useEditor();
  if (level.mode.kind !== 'race') return null;
  const wps = level.mode.race.waypoints ?? [];
  const wp = wps[index];
  if (!wp) return <div className="edNote">Waypoint no longer exists.</div>;
  const path: NodePath = ['mode', 'race', 'waypoints', index];
  const setComp = (comp: 0 | 1 | 2, v: number) => {
    const next: number[] = [...wp];
    if (comp === 2 && next.length < 3) next.push(0);
    next[comp] = v;
    if (comp === 2 && v === 0) next.length = 2; // flat again — drop the elevation
    setValueAt(path, next as RaceWaypoint);
  };
  const num = (label: string, value: number, comp: 0 | 1 | 2, step = 1) => (
    <div className="edRow">
      <label className="edLabel">{label}</label>
      <input
        className="edNum"
        type="number"
        value={value}
        step={step}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) setComp(comp, v);
        }}
      />
    </div>
  );
  return (
    <div>
      {num('x', wp[0], 0)}
      {num('z', wp[1], 1)}
      {num('elevation y', wp[2] ?? 0, 2, 0.5)}
      <div className="edNote">
        Drag the purple orb in the viewport to move it — the track follows.
        {index === 0 ? ' This is the START/finish waypoint.' : ''}
      </div>
      <div className="edItemActions">
        <button
          className="edBtn danger"
          disabled={wps.length <= 3}
          title={wps.length <= 3 ? 'a loop needs at least 3 waypoints' : undefined}
          onClick={() => removeAt(['mode', 'race', 'waypoints'], index)}
        >
          DELETE
        </button>
      </div>
    </div>
  );
}

/** List-item toolbar: duplicate keeps every field, offset a touch so the
 *  copy is visible; delete asks nothing (undo covers it). */
function ItemActions({ listPath, index }: { listPath: NodePath; index: number }) {
  const { level, removeAt, select, setValueAt } = useEditor();
  const duplicate = () => {
    const item = getAtPath(level, [...listPath, index]);
    if (item == null) return;
    const copy = JSON.parse(JSON.stringify(item)) as Record<string, unknown>;
    if (typeof copy.x === 'number') copy.x += 2;
    setValueAt(listPath, (getAtPath(insertListItem(level, listPath, index + 1, copy), listPath)));
    select([...listPath, index + 1]);
  };
  return (
    <div className="edItemActions">
      <button className="edBtn" onClick={duplicate}>DUPLICATE</button>
      <button className="edBtn danger" onClick={() => removeAt(listPath, index)}>DELETE</button>
    </div>
  );
}

export function Inspector() {
  const { level, selection, setValueAt, select } = useEditor();

  // no selection → the level root form
  if (!selection || selection.length === 0) {
    return (
      <div className="edPaneScroll">
        <div className="edPaneTitle">LEVEL</div>
        <RecordForm
          record={LEVEL_SCHEMA.registry.level}
          recordPath={[]}
          data={level}
          onEdit={setValueAt}
          onDescend={select}
          skip={['mode']}
        />
        <div className="edPaneTitle">MODE</div>
        <ModeEditor mode={level.mode} />
        <div className="edNote">
          Click an item in the tree or the 3D view to edit it. Drag items in the
          viewport to move them.
        </div>
      </div>
    );
  }

  // waypoint tuples resolve to the opaque record — special-case them first
  if (selection[0] === 'mode' && selection[2] === 'waypoints' && typeof selection[3] === 'number') {
    return (
      <div className="edPaneScroll">
        <div className="edPaneTitle">WAYPOINT {selection[3]}</div>
        <WaypointForm index={selection[3]} />
      </div>
    );
  }

  const loc = resolveRecordAtPath(LEVEL_SCHEMA, selection);
  if (!loc) return <div className="edPaneScroll"><div className="edNote">Nothing selected.</div></div>;

  const { record, recordPath } = loc;
  const data = getAtPath(level, recordPath);

  // selection points into a missing object (stale after undo/delete)
  if (data === undefined && recordPath.length > 0) {
    return <div className="edPaneScroll"><div className="edNote">Selection no longer exists.</div></div>;
  }

  // list-item context: [..., listKey, index]
  const last = recordPath[recordPath.length - 1];
  const isListItem = typeof last === 'number';
  const listPath = isListItem ? recordPath.slice(0, -1) : null;

  return (
    <div className="edPaneScroll">
      <Breadcrumb path={recordPath} />
      <div className="edPaneTitle">{(record.label ?? record.name).toUpperCase()}</div>
      {record.name === 'mode' ? (
        <ModeEditor mode={level.mode} />
      ) : record.name === 'opaque' ? (
        <div className="edNote">Authored data preserved verbatim — edit it in code or JSON.</div>
      ) : (
        <RecordForm
          record={record}
          recordPath={recordPath}
          data={data}
          onEdit={setValueAt}
          onDescend={select}
        />
      )}
      {isListItem && listPath && <ItemActions listPath={listPath} index={last as number} />}
    </div>
  );
}
