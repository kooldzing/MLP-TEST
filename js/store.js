const KEY = "memeLaunchpad.positions.v1";
const BACKUP_KEY = "memeLaunchpad.positions.backup.v1";

function readKey(key) {
  try {
    const raw = localStorage.getItem(key);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeKey(key, list) {
  localStorage.setItem(key, JSON.stringify(list));
}

export function loadPositions() {
  const primary = readKey(KEY);
  if (primary.length) return primary;
  const backup = readKey(BACKUP_KEY);
  if (backup.length) {
    // restore primary from backup
    try {
      writeKey(KEY, backup);
    } catch {}
    return backup;
  }
  return [];
}

export function savePositions(list) {
  const arr = Array.isArray(list) ? list : [];
  // Never wipe existing positions with an accidental empty write
  if (!arr.length) {
    const existing = readKey(KEY);
    const backup = readKey(BACKUP_KEY);
    if (existing.length || backup.length) {
      console.warn("[store] blocked empty overwrite of positions");
      return existing.length ? existing : backup;
    }
  }
  try {
    writeKey(KEY, arr);
    writeKey(BACKUP_KEY, arr);
  } catch (err) {
    // Quota â€” retry without heavy logos
    console.warn("[store] save failed, retrying slim", err);
    const slim = arr.map((p) => ({
      ...p,
      logo: p.logo && String(p.logo).length > 8000 ? "" : p.logo || "",
    }));
    try {
      writeKey(KEY, slim);
      writeKey(BACKUP_KEY, slim);
    } catch (err2) {
      console.error("[store] save failed", err2);
      throw err2;
    }
  }
  return arr;
}

export function upsertPosition(pos) {
  if (!pos || !pos.mint) return loadPositions();
  const list = loadPositions().filter((p) => p.mint !== pos.mint);
  list.unshift(pos);
  savePositions(list);
  // verify write stuck
  const check = loadPositions().some((p) => p.mint === pos.mint);
  if (!check) {
    console.error("[store] upsert verify failed for", pos.mint);
  }
  return list;
}

export function saveAllPositions(list) {
  return savePositions(Array.isArray(list) ? list : []);
}

export function removePosition(mint) {
  const list = loadPositions().filter((p) => p.mint !== mint);
  // explicit remove may empty the list â€” allow it via direct write
  try {
    writeKey(KEY, list);
    writeKey(BACKUP_KEY, list);
  } catch (err) {
    console.error(err);
  }
  return list;
}

export function getPosition(mint) {
  return loadPositions().find((p) => p.mint === mint) || null;
}

export function addLiquidity(mint, solAmount) {
  const amt = Number(solAmount) || 0;
  if (!(amt > 0)) return null;
  const list = loadPositions();
  const idx = list.findIndex((p) => p.mint === mint);
  if (idx < 0) return null;
  const pos = { ...list[idx] };
  pos.liquiditySol = (Number(pos.liquiditySol) || 0) + amt;
  pos.topUps = Array.isArray(pos.topUps) ? pos.topUps.slice() : [];
  pos.topUps.push({ sol: amt, at: Date.now() });
  list[idx] = pos;
  savePositions(list);
  return pos;
}

/** pct 1â€“100. At 100 removes the position. Returns { removed, withdrawnSol, pos }. */
export function removeLiquidityPct(mint, pct) {
  const p = Math.min(100, Math.max(0, Number(pct) || 0));
  if (!(p > 0)) return null;
  const list = loadPositions();
  const idx = list.findIndex((x) => x.mint === mint);
  if (idx < 0) return null;
  const cur = list[idx];
  const pooled = Math.max(Number(cur.liquiditySol) || 0, 0);
  const withdrawnSol = (pooled * p) / 100;
  if (p >= 100) {
    list.splice(idx, 1);
    try {
      writeKey(KEY, list);
      writeKey(BACKUP_KEY, list);
    } catch (err) {
      console.error(err);
    }
    return { removed: true, withdrawnSol, pos: null };
  }
  const pos = { ...cur, liquiditySol: Math.max(0, pooled - withdrawnSol) };
  list[idx] = pos;
  savePositions(list);
  return { removed: false, withdrawnSol, pos };
}