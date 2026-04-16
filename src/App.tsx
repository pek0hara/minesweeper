import { useState, useEffect, useCallback, useRef, useMemo } from "react";

const storage = {
  async get(key: string, shared: boolean): Promise<{ value: string } | null> {
    if (!shared) {
      const v = localStorage.getItem(key);
      return v ? { value: v } : null;
    }
    const res = await fetch(`/api/kv/${encodeURIComponent(key)}`);
    if (!res.ok) return null;
    return res.json();
  },
  async set(key: string, value: string, shared: boolean): Promise<void> {
    if (!shared) {
      localStorage.setItem(key, value);
      return;
    }
    await fetch(`/api/kv/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
  },
};

const COLS = 200, ROWS = 250, MINES = 9999;
const S_BOARD = "ms:board-200x250v2", S_SCORES = "ms:scores2", S_ME = "ms:myplayer", S_HISTORY = "ms:history2";
const LONG_PRESS_MS = 200, MOVE_THRESHOLD = 6, BUFFER = 3;
const TOTAL_SAFE = ROWS * COLS - MINES;
const CELL = 26, GAP = 1, PAD = 4, BORDER = 2;
const CELL_STEP = CELL + GAP;
const BOARD_W = COLS * CELL_STEP - GAP + PAD * 2 + BORDER * 2;
const BOARD_H = ROWS * CELL_STEP - GAP + PAD * 2 + BORDER * 2;
const DEFAULT_COLS_VISIBLE = 20;
const MIN_SCALE = 0.1, MAX_SCALE = 6;

const NUM_COLORS = ["","#60a5fa","#34d399","#f87171","#818cf8","#f97316","#22d3ee","#e879f9","#e2e8f0"];
const PALETTE = ["#f59e0b","#34d399","#60a5fa","#f87171","#a78bfa","#fb923c","#22d3ee","#e879f9"];

function generateBoard() {
  const cells = Array(ROWS * COLS).fill(null).map(() => ({
    hasMine: false, revealed: false, exploded: false, number: 0, revealedBy: null, flags: {},
  }));
  let placed = 0;
  while (placed < MINES) {
    const i = Math.floor(Math.random() * ROWS * COLS);
    if (!cells[i].hasMine) { cells[i].hasMine = true; placed++; }
  }
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const i = r * COLS + c;
    if (!cells[i].hasMine) {
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && cells[nr * COLS + nc].hasMine) n++;
      }
      cells[i].number = n;
    }
  }
  return cells;
}

function floodReveal(board, idx, pid) {
  const nb = board.map(c => ({ ...c, flags: { ...c.flags } }));
  let count = 0;
  const q = [idx], vis = new Set();
  while (q.length) {
    const i = q.shift();
    if (vis.has(i)) continue; vis.add(i);
    const c = nb[i];
    if (c.revealed || c.flags[pid] || c.hasMine) continue;
    nb[i].revealed = true; nb[i].revealedBy = pid; count++;
    if (c.number === 0) {
      const rr = Math.floor(i / COLS), cc = i % COLS;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const nr = rr + dr, nc = cc + dc;
        if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) q.push(nr * COLS + nc);
      }
    }
  }
  return { board: nb, count };
}

function mergeBoards(local, remote) {
  return local.map((cell, i) => {
    const rc = remote[i];
    if (!rc) return cell;
    if ((rc.revealed || rc.exploded) && !cell.revealed && !cell.exploded)
      return { ...rc, flags: cell.flags };
    return cell;
  });
}

function loadBoardData(raw) {
  if (!raw) return { cells: null, gameId: null };
  if (Array.isArray(raw)) return { cells: raw, gameId: "legacy" };
  return { cells: raw.cells ?? null, gameId: raw.gameId ?? null };
}

function pickColor(scores) {
  const taken = Object.values(scores).map(s => s.color);
  return PALETTE.find(c => !taken.includes(c)) ?? PALETTE[Object.keys(scores).length % PALETTE.length];
}

export default function MultiMinesweeper() {
  const [board,      setBoard]      = useState(null);
  const [gameId,     setGameId]     = useState(null);
  const [me,         setMe]         = useState(null);
  const [scores,     setScores]     = useState({});
  const [nameInput,  setNameInput]  = useState("");
  const [loading,    setLoading]    = useState(true);
  const [flash,      setFlash]      = useState(null);
  const [cleared,    setCleared]    = useState(false);
  const [history,    setHistory]    = useState([]);
  const [view,       setView]       = useState({ x: 0, y: 0, scale: 1 });
  const [vpSize,     setVpSize]     = useState({ w: 0, h: 0 });
  const [viewportEl, setViewportEl] = useState(null);

  const viewRef    = useRef({ x: 0, y: 0, scale: 1 });
  const viewportRef = useRef(null);
  const boardRef   = useRef(null);
  const gameIdRef  = useRef(null);
  const meRef      = useRef(null);
  const scoresRef  = useRef({});

  useEffect(() => { viewRef.current   = view;   }, [view]);
  useEffect(() => { boardRef.current  = board;  }, [board]);
  useEffect(() => { gameIdRef.current = gameId; }, [gameId]);
  useEffect(() => { meRef.current     = me;     }, [me]);
  useEffect(() => { scoresRef.current = scores; }, [scores]);

  const viewportCbRef = useCallback((el) => {
    viewportRef.current = el;
    setViewportEl(el);
    if (el) setVpSize({ w: el.clientWidth, h: el.clientHeight });
  }, []);

  const T = useRef({
    ptrs: {}, mode: "idle", timer: null, cell: null,
    panSX: 0, panSY: 0, panVX: 0, panVY: 0,
    pinchD0: 0, pinchS0: 1, pinchBX: 0, pinchBY: 0, pinchMX: 0, pinchMY: 0,
  });

  const clampView = useCallback((v) => {
    const vp = viewportRef.current;
    if (!vp) return v;
    const vpW = vp.clientWidth, vpH = vp.clientHeight;
    const bW = BOARD_W * v.scale, bH = BOARD_H * v.scale;
    const x = bW <= vpW ? (vpW - bW) / 2 : Math.max(vpW - bW, Math.min(0, v.x));
    const y = bH <= vpH ? (vpH - bH) / 2 : Math.max(vpH - bH, Math.min(0, v.y));
    return { ...v, x, y };
  }, []);

  const initView = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const s = Math.min(MAX_SCALE, vp.clientWidth / (DEFAULT_COLS_VISIBLE * CELL_STEP));
    const v = clampView({ x: 0, y: 0, scale: s });
    viewRef.current = v;
    setView(v);
    setVpSize({ w: vp.clientWidth, h: vp.clientHeight });
  }, [clampView]);

  const saveBoard = useCallback(async (b, gid) => {
    try { await storage.set(S_BOARD, JSON.stringify({ gameId: gid, cells: b }), true); } catch {}
  }, []);
  const saveScores = useCallback(async sc => { try { await storage.set(S_SCORES, JSON.stringify(sc), true); } catch {} }, []);
  const saveMe     = useCallback(async m  => { try { await storage.set(S_ME, JSON.stringify(m), false); } catch {} }, []);

  useEffect(() => {
    async function load() {
      try {
        const [bR, sR, mR, hR] = await Promise.all([
          storage.get(S_BOARD,   true).catch(() => null),
          storage.get(S_SCORES,  true).catch(() => null),
          storage.get(S_ME,     false).catch(() => null),
          storage.get(S_HISTORY, true).catch(() => null),
        ]);
        const { cells: pb, gameId: gid } = loadBoardData(bR ? JSON.parse(bR.value) : null);
        const validBoard = pb && pb.length === ROWS * COLS;
        const lb = validBoard ? pb : generateBoard();
        const newGid = validBoard ? gid : `${Date.now()}`;
        lb.forEach(c => { if (!c.flags) c.flags = {}; });
        boardRef.current = lb; gameIdRef.current = newGid;
        setBoard(lb); setGameId(newGid);
        setScores(sR ? JSON.parse(sR.value) : {});
        setMe(mR ? JSON.parse(mR.value) : null);
        setHistory(hR ? JSON.parse(hR.value) : []);
      } catch { 
        const nb = generateBoard();
        const gid = `${Date.now()}`;
        boardRef.current = nb; gameIdRef.current = gid;
        setBoard(nb); setGameId(gid);
      }
      setLoading(false);
    }
    load();
  }, []);

  useEffect(() => { if (!loading) setTimeout(initView, 30); }, [loading, initView]);

  // 60秒ごとにポーリング
  useEffect(() => {
    if (loading) return;
    const interval = setInterval(async () => {
      try {
        const [bR, sR] = await Promise.all([
          storage.get(S_BOARD,  true).catch(() => null),
          storage.get(S_SCORES, true).catch(() => null),
        ]);
        if (bR) {
          const { cells: remote, gameId: remoteGid } = loadBoardData(JSON.parse(bR.value));
          if (remote && remote.length === ROWS * COLS && remoteGid === gameIdRef.current) {
            const merged = mergeBoards(boardRef.current, remote);
            boardRef.current = merged;
            setBoard(merged);
          }
        }
        if (sR) {
          const remote = JSON.parse(sR.value);
          const m = meRef.current;
          const merged = { ...remote, ...(m && scoresRef.current[m.id] ? { [m.id]: scoresRef.current[m.id] } : {}) };
          scoresRef.current = merged;
          setScores(merged);
        }
      } catch {}
    }, 60000);
    return () => clearInterval(interval);
  }, [loading]);

  const register = async () => {
    const name = nameInput.trim(); if (!name) return;
    const sc = scoresRef.current;
    const color = pickColor(sc);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    const newMe = { id, name, color };
    const newScores = { ...sc, [id]: { name, color, score: 0, opened: 0, explosions: 0 } };
    setMe(newMe); setScores(newScores);
    await saveMe(newMe); await saveScores(newScores);
  };

  const patchScore = useCallback(async (patch) => {
    const m = meRef.current; if (!m) return;
    let base = scoresRef.current;
    try {
      const sR = await storage.get(S_SCORES, true).catch(() => null);
      if (sR) base = { ...JSON.parse(sR.value), ...scoresRef.current };
    } catch {}
    const cur = base[m.id] ?? { name: m.name, color: m.color, score: 0, opened: 0, explosions: 0 };
    const newScores = { ...base, [m.id]: { ...cur, ...patch } };
    scoresRef.current = newScores;
    setScores(newScores);
    await saveScores(newScores);
  }, [saveScores]);

  const toggleFlag = useCallback((idx) => {
    const b = boardRef.current, m = meRef.current; if (!b || !m) return;
    if (b[idx].revealed && !b[idx].exploded) return;
    const nb = b.map(c => ({ ...c, flags: { ...c.flags } }));
    if (nb[idx].flags[m.id]) delete nb[idx].flags[m.id]; else nb[idx].flags[m.id] = true;
    boardRef.current = nb;
    setBoard(nb); saveBoard(nb, gameIdRef.current);
  }, [saveBoard]);

  const openCell = useCallback(async (idx) => {
    const b = boardRef.current, m = meRef.current, sc = scoresRef.current;
    if (!b || !m) return;
    const cell = b[idx];
    if (cell.revealed && !cell.exploded) return;
    if (cell.flags[m.id]) return;

    if (cell.hasMine) {
      if (cell.exploded) return;
      const nb = b.map(c => ({ ...c, flags: { ...c.flags } }));
      nb[idx] = { ...nb[idx], revealed: true, exploded: true, revealedBy: m.id };
      boardRef.current = nb;
      setBoard(nb); saveBoard(nb, gameIdRef.current);
      setFlash({ idx, type: "explode" }); setTimeout(() => setFlash(null), 600);
      const cur = sc[m.id] ?? { name: m.name, color: m.color, score: 0, opened: 0, explosions: 0 };
      const penalty = cur.score <= 50 ? 10 : 25;
      patchScore({ score: Math.max(0, cur.score - penalty), explosions: (cur.explosions ?? 0) + 1 });
    } else {
      const { board: nb, count } = floodReveal(b, idx, m.id);
      boardRef.current = nb;
      setBoard(nb);
      if (count > 0) {
        setFlash({ idx, type: "open" }); setTimeout(() => setFlash(null), 300);
        const cur = sc[m.id] ?? { name: m.name, color: m.color, score: 0, opened: 0, explosions: 0 };
        patchScore({ score: cur.score + count, opened: (cur.opened ?? 0) + count });
        if (nb.filter(c => c.revealed && !c.exploded).length >= TOTAL_SAFE) setCleared(true);
      }
      // マージ・保存は非同期で後から
      try {
        const latest = await storage.get(S_BOARD, true).catch(() => null);
        const base = boardRef.current;
        if (latest) {
          const { cells: remote, gameId: remoteGid } = loadBoardData(JSON.parse(latest.value));
          if (remote && remote.length === ROWS * COLS && remoteGid === gameIdRef.current) {
            const merged = mergeBoards(base, remote);
            boardRef.current = merged;
            setBoard(merged);
            saveBoard(merged, gameIdRef.current);
            return;
          }
        }
        saveBoard(base, gameIdRef.current);
      } catch { saveBoard(boardRef.current, gameIdRef.current); }
    }
  }, [saveBoard, patchScore]);

  const getCellIdx = useCallback((cx, cy) => {
    const vp = viewportRef.current; if (!vp) return null;
    const rect = vp.getBoundingClientRect();
    const v = viewRef.current;
    const bx = (cx - rect.left - v.x) / v.scale - PAD;
    const by = (cy - rect.top  - v.y) / v.scale - PAD;
    const col = Math.floor(bx / CELL_STEP);
    const row = Math.floor(by / CELL_STEP);
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null;
    if (bx - col * CELL_STEP > CELL || by - row * CELL_STEP > CELL) return null;
    return row * COLS + col;
  }, []);

  const pDist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const pMid  = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  const onWheel = useCallback((e) => {
    e.preventDefault();
    const vp = viewportRef.current; if (!vp) return;
    const rect = vp.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const oldS = viewRef.current.scale;
      const ns = Math.max(MIN_SCALE, Math.min(MAX_SCALE, oldS * delta));
      const bx = (e.clientX - rect.left - viewRef.current.x) / oldS;
      const by = (e.clientY - rect.top  - viewRef.current.y) / oldS;
      const nv = clampView({ x: e.clientX - rect.left - bx * ns, y: e.clientY - rect.top - by * ns, scale: ns });
      viewRef.current = nv; setView(nv);
      setVpSize({ w: vp.clientWidth, h: vp.clientHeight });
    } else {
      const nv = clampView({ ...viewRef.current, x: viewRef.current.x - e.deltaX, y: viewRef.current.y - e.deltaY });
      viewRef.current = nv; setView(nv);
      setVpSize({ w: vp.clientWidth, h: vp.clientHeight });
    }
  }, [clampView]);

  const onPD = useCallback((e) => {
    if (!meRef.current) return;
    if (e.button === 2) { e.preventDefault(); return; }
    e.preventDefault();
    try { viewportRef.current?.setPointerCapture(e.pointerId); } catch {}
    const t = T.current;
    t.ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
    const pts = Object.values(t.ptrs);
    if (pts.length === 1) {
      clearTimeout(t.timer);
      t.mode = "lp";
      t.cell = getCellIdx(e.clientX, e.clientY);
      t.panSX = e.clientX; t.panSY = e.clientY;
      t.panVX = viewRef.current.x; t.panVY = viewRef.current.y;
      t.timer = setTimeout(() => {
        if (t.mode === "lp" && t.cell !== null) { t.mode = "fired"; toggleFlag(t.cell); }
      }, LONG_PRESS_MS);
    } else if (pts.length === 2) {
      clearTimeout(t.timer);
      t.mode = "pinch";
      const [p1, p2] = pts;
      t.pinchD0 = pDist(p1, p2);
      t.pinchS0 = viewRef.current.scale;
      const mid = pMid(p1, p2);
      t.pinchMX = mid.x; t.pinchMY = mid.y;
      const vp = viewportRef.current;
      if (vp) {
        const rect = vp.getBoundingClientRect();
        t.pinchBX = (mid.x - rect.left - viewRef.current.x) / viewRef.current.scale;
        t.pinchBY = (mid.y - rect.top  - viewRef.current.y) / viewRef.current.scale;
      }
    }
  }, [getCellIdx, toggleFlag]);

  const onPM = useCallback((e) => {
    if (!meRef.current) return;
    e.preventDefault();
    const t = T.current;
    if (!t.ptrs[e.pointerId]) return;
    t.ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
    const pts = Object.values(t.ptrs);
    if (t.mode === "lp") {
      if (Math.hypot(e.clientX - t.panSX, e.clientY - t.panSY) > MOVE_THRESHOLD) {
        clearTimeout(t.timer); t.mode = "pan";
      }
    }
    if (t.mode === "pan") {
      const nv = clampView({ ...viewRef.current, x: t.panVX + (e.clientX - t.panSX), y: t.panVY + (e.clientY - t.panSY) });
      viewRef.current = nv; setView(nv);
      const vp = viewportRef.current;
      if (vp) setVpSize({ w: vp.clientWidth, h: vp.clientHeight });
    } else if (t.mode === "pinch" && pts.length === 2) {
      const [p1, p2] = pts;
      const ns = Math.max(MIN_SCALE, Math.min(MAX_SCALE, t.pinchS0 * pDist(p1, p2) / t.pinchD0));
      const vp = viewportRef.current; if (!vp) return;
      const rect = vp.getBoundingClientRect();
      const nv = clampView({
        x: t.pinchMX - rect.left - t.pinchBX * ns,
        y: t.pinchMY - rect.top  - t.pinchBY * ns,
        scale: ns,
      });
      viewRef.current = nv; setView(nv);
      setVpSize({ w: vp.clientWidth, h: vp.clientHeight });
    }
  }, [clampView]);

  const onPU = useCallback((e) => {
    if (!meRef.current) return;
    if (e.button === 2) return;
    e.preventDefault();
    const t = T.current;
    const wasMode = t.mode, wasCell = t.cell;
    delete t.ptrs[e.pointerId];
    if (wasMode === "lp") {
      clearTimeout(t.timer); t.mode = "idle";
      if (wasCell !== null) openCell(wasCell);
    } else if (Object.keys(t.ptrs).length === 0) {
      t.mode = "idle";
    }
  }, [openCell]);

  const onPC = useCallback((e) => {
    const t = T.current;
    clearTimeout(t.timer);
    delete t.ptrs[e.pointerId];
    if (Object.keys(t.ptrs).length === 0) t.mode = "idle";
  }, []);

  useEffect(() => {
    const el = viewportEl;
    if (!el) return;
    el.addEventListener("pointerdown",   onPD,    { passive: false });
    el.addEventListener("pointermove",   onPM,    { passive: false });
    el.addEventListener("pointerup",     onPU,    { passive: false });
    el.addEventListener("pointercancel", onPC);
    el.addEventListener("wheel",         onWheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown",   onPD);
      el.removeEventListener("pointermove",   onPM);
      el.removeEventListener("pointerup",     onPU);
      el.removeEventListener("pointercancel", onPC);
      el.removeEventListener("wheel",         onWheel);
    };
  }, [viewportEl, onPD, onPM, onPU, onPC, onWheel]);

  const warp = useCallback(() => {
    const vp = viewportRef.current; if (!vp) return;
    const s = viewRef.current.scale;
    const maxX = BOARD_W * s - vp.clientWidth;
    const maxY = BOARD_H * s - vp.clientHeight;
    const tx = maxX > 0 ? -(Math.random() * maxX) : (vp.clientWidth  - BOARD_W * s) / 2;
    const ty = maxY > 0 ? -(Math.random() * maxY) : (vp.clientHeight - BOARD_H * s) / 2;
    const nv = { ...viewRef.current, x: tx, y: ty };
    viewRef.current = nv; setView(nv);
    setVpSize({ w: vp.clientWidth, h: vp.clientHeight });
  }, []);

  const nextGame = async () => {
    const sc = scoresRef.current;
    const entry = {
      date: new Date().toISOString(),
      players: Object.values(sc).map(s => ({
        name: s.name, color: s.color,
        score: s.score ?? 0, opened: s.opened ?? 0, explosions: s.explosions ?? 0,
      })).sort((a, b) => b.score - a.score),
    };
    const newHistory = [entry, ...history].slice(0, 10);
    setHistory(newHistory);
    try { await storage.set(S_HISTORY, JSON.stringify(newHistory), true); } catch {}
    const resetScores = Object.fromEntries(
      Object.entries(sc).map(([id, s]) => [id, { ...s, score: 0, opened: 0, explosions: 0 }])
    );
    scoresRef.current = resetScores;
    setScores(resetScores);
    await saveScores(resetScores);
    const nb = generateBoard();
    const newGid = `${Date.now()}`;
    boardRef.current = nb; gameIdRef.current = newGid;
    setBoard(nb); setGameId(newGid); setCleared(false);
    await saveBoard(nb, newGid); setTimeout(initView, 30);
  };

  const visibleRange = useMemo(() => {
    const { x, y, scale } = view;
    const { w, h } = vpSize;
    const bxStart = (-x) / scale - PAD;
    const byStart = (-y) / scale - PAD;
    const bxEnd   = bxStart + w / scale;
    const byEnd   = byStart + h / scale;
    return {
      c0: Math.max(0, Math.floor(bxStart / CELL_STEP) - BUFFER),
      c1: Math.min(COLS - 1, Math.ceil(bxEnd  / CELL_STEP) + BUFFER),
      r0: Math.max(0, Math.floor(byStart / CELL_STEP) - BUFFER),
      r1: Math.min(ROWS - 1, Math.ceil(byEnd  / CELL_STEP) + BUFFER),
    };
  }, [view, vpSize]);

  if (loading) return (
    <div style={{ background:"#0a0a0f", height:"100svh", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", color:"#f59e0b", fontFamily:"monospace", fontSize:18, gap:8 }}>
      LOADING…
      <span style={{ fontSize:11, color:"#475569" }}>200×250マスを生成中</span>
    </div>
  );

  const myFlags      = board && me ? board.filter(c => c.flags[me.id]).length : 0;
  const myScore      = me ? (scores[me.id] ?? null) : null;
  const revealedSafe = board ? board.filter(c => c.revealed && !c.exploded).length : 0;
  const sortedScores = Object.entries(scores).sort((a, b) => b[1].score - a[1].score);

  return (
    <div style={{
      background:"#0a0a0f", height:"100svh", overflow:"hidden",
      fontFamily:"'Courier New', monospace", userSelect:"none", WebkitUserSelect:"none",
      display:"flex", flexDirection:"column", alignItems:"stretch", gap:6,
      boxSizing:"border-box", width:"100%", padding:"8px 8px 0",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap');
        @keyframes explodePulse { 0%{transform:scale(1.4);background:#fbbf24!important} 100%{transform:scale(1)} }
        @keyframes openPulse { 0%{transform:scale(1.1)} 100%{transform:scale(1)} }
        input { background:#1a2535; border:1px solid #2d4060; color:#e2e8f0; padding:6px 10px; border-radius:4px; font-family:'Courier New',monospace; font-size:12px; outline:none; }
        input:focus { border-color:#60a5fa; }
        .btn { padding:6px 12px; border-radius:4px; cursor:pointer; font-family:'Courier New',monospace; font-size:11px; border:none; }
        .btn-blue  { background:#1e3a5f; border:1px solid #3b82f6!important; color:#93c5fd; }
        .btn-green { background:#14532d; border:1px solid #22c55e!important; color:#86efac; font-size:14px; padding:10px 28px; }
        ::-webkit-scrollbar { height:3px; width:3px; } ::-webkit-scrollbar-thumb { background:#2d4060; border-radius:2px; }
      `}</style>

      <div style={{ fontFamily:"'Press Start 2P',monospace", fontSize:10, color:"#f59e0b", letterSpacing:2, textShadow:"0 0 20px #f59e0b88", textAlign:"center", flexShrink:0 }}>
        💣 MULTI MINESWEEPER
      </div>

      <div style={{ width:"100%", boxSizing:"border-box", flexShrink:0 }}>
        {!me ? (
          <div style={{ background:"#111827", border:"1px solid #1e3a5f", borderRadius:8, padding:"12px 16px", display:"flex", flexDirection:"column", gap:8, alignItems:"center" }}>
            <div style={{ color:"#94a3b8", fontSize:11 }}>あなたの名前を入力してゲームに参加</div>
            <div style={{ display:"flex", gap:8 }}>
              <input value={nameInput} onChange={e => setNameInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && register()} placeholder="名前" style={{ width:140 }} />
              <button className="btn btn-blue" onClick={register}>参加</button>
            </div>
          </div>
        ) : (
          <div style={{ background:"#111827", border:`1px solid ${me.color}55`, borderRadius:8, padding:"6px 12px", display:"flex", flexWrap:"wrap", alignItems:"center", gap:"4px 14px" }}>
            <div style={{ display:"flex", alignItems:"center", gap:6 }}>
              <div style={{ width:8, height:8, borderRadius:"50%", background:me.color }} />
              <span style={{ color:me.color, fontWeight:"bold", fontSize:12 }}>{me.name}</span>
            </div>
            <span style={{ color:"#64748b", fontSize:11 }}>💣 {MINES - myFlags}</span>
            <span style={{ color:"#34d399", fontSize:11 }}>✓ {revealedSafe}/{TOTAL_SAFE}</span>
            <span style={{ color:"#f59e0b", fontSize:11 }}>🚩 {myFlags}</span>
            <span style={{ color:"#f59e0b", fontSize:12, fontWeight:"bold" }}>{myScore?.score ?? 0}pt</span>
            <span style={{ color:"#475569", fontSize:9 }}>200×250 / 地雷{MINES}</span>
          </div>
        )}
      </div>

      {me && (
        <div style={{ fontSize:9, color:"#475569", flexShrink:0, textAlign:"center", display:"flex", alignItems:"center", justifyContent:"center", gap:12 }}>
          <span>タップ: 開く　<span style={{ color:"#f59e0b" }}>長押し/右クリック: 🚩</span>　ドラッグ: 移動　ピンチ/Ctrl+ホイール: ズーム</span>
          <button className="btn" onClick={warp}
            style={{ background:"#2d1b69", border:"1px solid #7c3aed", color:"#c4b5fd", fontSize:10, padding:"3px 10px", flexShrink:0 }}>
            ⚡ ワープ
          </button>
        </div>
      )}

      {board && me ? (
        <div
          ref={viewportCbRef}
          style={{ flex:1, width:"100%", overflow:"hidden", position:"relative", touchAction:"none", cursor:"grab", minHeight:0 }}
          onContextMenu={e => e.preventDefault()}
        >
          <div style={{
            position:"absolute", top:0, left:0,
            transform:`translate(${view.x}px,${view.y}px) scale(${view.scale})`,
            transformOrigin:"0 0",
            width:BOARD_W, height:BOARD_H,
            willChange:"transform",
          }}>
            <div style={{ position:"absolute", inset:0, background:"#0d1520", border:"2px solid #1e3a5f", borderRadius:6, boxShadow:"0 0 30px #1e3a5f44" }} />
            {(() => {
              const { c0, c1, r0, r1 } = visibleRange;
              const cells = [];
              for (let r = r0; r <= r1; r++) {
                for (let c = c0; c <= c1; c++) {
                  const i = r * COLS + c;
                  const cell = board[i];
                  const isFlash = flash?.idx === i;
                  const myFlag  = !!(me && cell.flags[me.id]);
                  let bg = "#1e2a3a", borderColor = "#2d4060", boxShadow = "inset 1px 1px 0 #2d4a6a,inset -1px -1px 0 #0d1520";
                  let color = "", content = null, anim = "";

                  if (cell.exploded) {
                    bg = "#7f1d1d"; borderColor = "#ef4444"; boxShadow = "";
                    content = "💥"; if (isFlash) anim = "explodePulse 0.5s ease-out";
                  } else if (myFlag) {
                    bg = "#1a2535"; borderColor = me.color; boxShadow = "";
                    content = "🚩";
                  } else if (cell.revealed) {
                    bg = "#111827"; borderColor = "#1a2535"; boxShadow = "";
                    if (cell.number > 0) { color = NUM_COLORS[cell.number]; content = cell.number; }
                    if (cell.revealedBy) { const rp = scores[cell.revealedBy]; if (rp) boxShadow = `inset 0 -2px 0 ${rp.color}`; }
                    if (isFlash) anim = "openPulse 0.2s ease-out";
                  }

                  cells.push(
                    <div key={i} style={{
                      position:"absolute",
                      left: PAD + c * CELL_STEP,
                      top:  PAD + r * CELL_STEP,
                      width: CELL, height: CELL,
                      background: bg, border: `1px solid ${borderColor}`,
                      boxShadow, color, borderRadius: 2,
                      display:"flex", alignItems:"center", justifyContent:"center",
                      fontSize:11, fontWeight:"bold",
                      animation: anim || undefined,
                    }}
                      onContextMenu={ev => { ev.preventDefault(); toggleFlag(i); }}
                    >{content}</div>
                  );
                }
              }
              return cells;
            })()}
          </div>
        </div>
      ) : (
        <div style={{ flex:1, minHeight:0 }} />
      )}

      {sortedScores.length > 0 && (
        <div style={{ width:"100%", boxSizing:"border-box", flexShrink:0 }}>
          <div style={{ background:"#111827", border:"1px solid #1e3a5f", borderRadius:"8px 8px 0 0", padding:"8px 10px" }}>
            <div style={{ fontSize:9, color:"#475569", marginBottom:6 }}>— SCOREBOARD —</div>
            <div style={{ display:"flex", gap:5, overflowX:"auto", paddingBottom:2 }}>
              {sortedScores.map(([id, s], rank) => (
                <div key={id} style={{
                  flex:"0 0 auto", minWidth:100,
                  background: id === me?.id ? "#0f2540" : "#0d1520",
                  border:`1px solid ${id === me?.id ? s.color : s.color+"44"}`, borderRadius:6, padding:"6px 8px",
                }}>
                  <div style={{ display:"flex", alignItems:"center", gap:4, marginBottom:3 }}>
                    <span style={{ color:"#475569", fontSize:8 }}>#{rank+1}</span>
                    <div style={{ width:6, height:6, borderRadius:"50%", background:s.color }} />
                    <span style={{ color:"#e2e8f0", fontSize:10, fontWeight:"bold", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:60 }}>{s.name}</span>
                  </div>
                  <div style={{ display:"flex", gap:6, alignItems:"flex-end" }}>
                    <div>
                      <div style={{ color:"#475569", fontSize:8 }}>SCORE</div>
                      <div style={{ color:"#f59e0b", fontSize:15, fontWeight:"bold" }}>{s.score ?? 0}</div>
                    </div>
                    <div>
                      <div style={{ color:"#475569", fontSize:8 }}>✓開</div>
                      <div style={{ color:"#34d399", fontSize:12, fontWeight:"bold" }}>{s.opened ?? 0}</div>
                    </div>
                    <div>
                      <div style={{ color:"#475569", fontSize:8 }}>💥</div>
                      <div style={{ color:"#ef4444", fontSize:12, fontWeight:"bold" }}>{s.explosions ?? 0}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {cleared && (
        <div style={{ position:"fixed", inset:0, background:"#0a0a0fcc", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:16, zIndex:100, overflowY:"auto", padding:20 }}>
          <div style={{ fontFamily:"'Press Start 2P',monospace", fontSize:18, color:"#34d399", textShadow:"0 0 30px #34d399" }}>CLEARED! 🎉</div>
          <div style={{ color:"#94a3b8", fontSize:12 }}>全マスを開きました　→ 次ゲームでスコアリセット</div>
          <div style={{ background:"#111827", border:"1px solid #334155", borderRadius:10, padding:"12px 20px", display:"flex", flexDirection:"column", gap:6, minWidth:280 }}>
            <div style={{ color:"#475569", fontSize:9, marginBottom:4 }}>— 今回の結果 —</div>
            {sortedScores.slice(0, 5).map(([id, s], rank) => (
              <div key={id} style={{ display:"flex", alignItems:"center", gap:8 }}>
                <span style={{ fontSize:13 }}>{["🥇","🥈","🥉","4️⃣","5️⃣"][rank]}</span>
                <div style={{ width:7, height:7, borderRadius:"50%", background:s.color }} />
                <span style={{ color:"#e2e8f0", fontSize:11, flex:1 }}>{s.name}</span>
                <span style={{ color:"#f59e0b", fontSize:12, fontWeight:"bold" }}>{s.score ?? 0}pt</span>
                <span style={{ color:"#34d399", fontSize:10 }}>✓{s.opened ?? 0}</span>
                <span style={{ color:"#ef4444", fontSize:10 }}>💥{s.explosions ?? 0}</span>
              </div>
            ))}
          </div>
          {history.length > 0 && (
            <div style={{ background:"#0d1520", border:"1px solid #1e3a5f", borderRadius:8, padding:"10px 14px", minWidth:280, maxHeight:180, overflowY:"auto" }}>
              <div style={{ color:"#475569", fontSize:9, marginBottom:6 }}>— 過去の記録 —</div>
              {history.map((h, hi) => (
                <div key={hi} style={{ marginBottom:8 }}>
                  <div style={{ color:"#334155", fontSize:8, marginBottom:3 }}>
                    #{hi+1}　{new Date(h.date).toLocaleDateString("ja-JP")} {new Date(h.date).toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"})}
                  </div>
                  {h.players.slice(0, 3).map((p, pi) => (
                    <div key={pi} style={{ display:"flex", alignItems:"center", gap:6, marginBottom:2 }}>
                      <div style={{ width:6, height:6, borderRadius:"50%", background:p.color, flexShrink:0 }} />
                      <span style={{ color:"#94a3b8", fontSize:10, flex:1 }}>{p.name}</span>
                      <span style={{ color:"#f59e0b", fontSize:10 }}>{p.score}pt</span>
                      <span style={{ color:"#34d399", fontSize:9 }}>✓{p.opened}</span>
                      <span style={{ color:"#ef4444", fontSize:9 }}>💥{p.explosions}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          <button className="btn btn-green" onClick={nextGame}>▶ 次のゲーム（スコアリセット）</button>
        </div>
      )}
    </div>
  );
}
