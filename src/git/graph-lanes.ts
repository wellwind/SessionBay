/**
 * Incremental lane layout for a topologically ordered commit list. The
 * state carries across pages, so appending a page never re-lays earlier rows.
 */
export interface GraphRow {
  column: number;
  /** Lanes entering from above; `intoCommit` lanes end at this commit's node. */
  above: { lane: number; intoCommit: boolean }[];
  /** Lanes leaving below: `continues` passes straight down, `fromCommit`
   *  starts at this commit's node (both may hold for a shared parent). */
  below: { lane: number; continues: boolean; fromCommit: boolean }[];
  width: number;
}
export interface LaneState { lanes: (string | null)[] }
export const emptyLanes = (): LaneState => ({ lanes: [] });

function freeSlot(lanes: (string | null)[]) {
  const index = lanes.indexOf(null);
  return index < 0 ? lanes.length : index;
}

export function layout(commits: { oid: string; parents: string[] }[], state: LaneState): { rows: GraphRow[]; state: LaneState } {
  const lanes = [...state.lanes];
  const rows: GraphRow[] = [];
  for (const commit of commits) {
    const before = [...lanes];
    let column = before.indexOf(commit.oid);
    if (column < 0) column = freeSlot(lanes);
    const above = before.flatMap((oid, lane) => oid === null ? [] : [{ lane, intoCommit: oid === commit.oid }]);
    for (let lane = 0; lane < lanes.length; lane++) if (lanes[lane] === commit.oid) lanes[lane] = null;
    const starts = new Set<number>();
    commit.parents.forEach((parent, index) => {
      const existing = lanes.indexOf(parent);
      if (existing >= 0) { starts.add(existing); return; }
      const slot = index === 0 && lanes[column] == null ? column : freeSlot(lanes);
      lanes[slot] = parent;
      starts.add(slot);
    });
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const below = lanes.flatMap((oid, lane) => oid === null ? [] : [{
      lane, fromCommit: starts.has(lane), continues: before[lane] === oid && oid !== commit.oid,
    }]);
    const width = Math.max(column + 1, ...above.map(entry => entry.lane + 1), ...below.map(entry => entry.lane + 1));
    rows.push({ column, above, below, width });
  }
  return { rows, state: { lanes } };
}
