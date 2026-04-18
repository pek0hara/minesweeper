import { useState, useEffect, useCallback, useRef, useMemo } from "react";

const COLS = 200, ROWS = 250, MINES = 9999;
const TOTAL = ROWS * COLS;
const TOTAL_SAFE = TOTAL - MINES;
const CELL = 26, GAP = 1, PAD = 4, BORDER = 2;
const CELL_STEP = CELL + GAP;
const BOARD_W = COLS * CELL_STEP - GAP + PAD * 2 + BORDER * 2;
const BOARD_H = ROWS * CELL_STEP - GAP + PAD * 2 + BORDER * 2;
const DEFAULT_COLS_VISIBLE = 20;
const MIN_SCALE = 0.1, MAX_SCALE = 6;
const LONG_PRESS_MS = 200, MOVE_THRESHOLD = 6, BUFFER = 3;

const NUM_COLORS = ["","#60a5fa","#34d399","#f87171","#818cf8","#f97316","#22d3ee","#e879f9","#e2e8f0"];
const PALETTE    = ["#f59e0b","#34d399","#60a5fa","#f87171","#a78bfa","#fb923c","#22d3ee","#e879f9"];

interface DisplayCell {
  revealed: boolean;
  exploded: boolean;
  number: number;
  revealedBy: string | null;
  flags: Record<string, boolean>;
}
interface PlayerInfo   { id: string; name: string; color: string }
interface PlayerScore  { name: string; color: string; score: number; opened: number; explosions: number }

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDefaultBoard(): DisplayCell[] {
  return Array.from({ length: TOTAL }, () => ({
    revealed: false, exploded: false, number: 0, revealedBy: null, flags: {},
  }));
}

function toDisplayCell(c: { r: boolean; e: boolean; n: number; rb: string | null; f: string[] }): DisplayCell {
  const flags: Record<string, boolean> = {};
  for (const pid of c.f) flags[pid] = true;
  return { revealed: c.r, exploded: c.e, number: c.n, revealedBy: c.rb, flags };
}

function loadMe(): PlayerInfo | null {
  try { const s = localStorage.getItem('ms-me'); return s ? JSON.parse(s) : null; } catch { return null; }
}
function saveMe(m: PlayerInfo) { localStorage.setItem('ms-me', JSON.stringify(m)); }
function pickColor(scores: Record<string, PlayerScore>) {
  const taken = Object.values(scores).map(s => s.color);
  return PALETTE.find(c => !taken.includes(c)) ?? PALETTE[Object.keys(scores).length % PALETTE.length];
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MultiMinesweeper() {
  const [board,      setBoard]      = useState<DisplayCell[] | null>(null);
  const [gameId,     setGameId]     = useState<string | null>(null);
  const [me,         setMe]         = useState<PlayerInfo | null>(loadMe);
  const [scores,     setScores]     = useState<Record<string, PlayerScore>>({});
  const [nameInput,  setNameInput]  = useState("");
  const [loading,    setLoading]    = useState(true);
  const [flash,      setFlash]      = useState<{idx:number;type:string} | null>(null);
  const [cleared,    setCleared]    = useState(false);
  const [history,    setHistory]    = useState<unknown[]>([]);
  const [view,       setView]       = useState({ x: 0, y: 0, scale: 1 });
  const [vpSize,     setVpSize]     = useState({ w: 0, h: 0 });
  const [viewportEl, setViewportEl] = useState<HTMLElement | null>(null);

  const boardRef    = useRef<DisplayCell[] | null>(null);
  const scoresRef   = useRef<Record<string, PlayerScore>>({});
  const meRef       = useRef<PlayerInfo | null>(null);
  const viewRef     = useRef({ x: 0, y: 0, scale: 1 });
  const viewportRef = useRef<HTMLElement | null>(null);
  const wsRef       = useRef<WebSocket | null>(null);

  useEffect(() => { boardRef.current  = board;  }, [board]);
  useEffect(() => { scoresRef.current = scores; }, [scores]);
  useEffect(() => { meRef.current     = me;     }, [me]);
  useEffect(() => { viewRef.current   = view;   }, [view]);

  // ── View helpers ────────────────────────────────────────────────────────────

  const clampView = useCallback((v: {x:number;y:number;scale:number}) => {
    const vp = viewportRef.current; if (!vp) return v;
    const vpW = vp.clientWidth, vpH = vp.clientHeight;
    const bW = BOARD_W * v.scale, bH = BOARD_H * v.scale;
    const x = bW <= vpW ? (vpW - bW) / 2 : Math.max(vpW - bW, Math.min(0, v.x));
    const y = bH <= vpH ? (vpH - bH) / 2 : Math.max(vpH - bH, Math.min(0, v.y));
    return { ...v, x, y };
  }, []);

  const initView = useCallback(() => {
    const vp = viewportRef.current; if (!vp) return;
    const s = Math.min(MAX_SCALE, vp.clientWidth / (DEFAULT_COLS_VISIBLE * CELL_STEP));
    const v = clampView({ x: 0, y: 0, scale: s });
    viewRef.current = v; setView(v);
    setVpSize({ w: vp.clientWidth, h: vp.clientHeight });
  }, [clampView]);

  const viewportCbRef = useCallback((el: HTMLElement | null) => {
    viewportRef.current = el; setViewportEl(el);
    if (el) setVpSize({ w: el.clientWidth, h: el.clientHeight });
  }, []);

  // ── WebSocket ───────────────────────────────────────────────────────────────

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let active = true;

    function connect() {
      if (!active) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/api/game`);
      wsRef.current = ws;

      ws.onopen = () => {
        clearTimeout(reconnectTimer);
        const m = meRef.current;
        if (m) ws.send(JSON.stringify({ type: 'join', player: m }));
      };

      ws.onmessage = (e: MessageEvent) => {
        const msg = JSON.parse(e.data as string);
        switch (msg.type) {
          case 'init':
          case 'new_game': {
            const nb = makeDefaultBoard();
            for (const [idx, cell] of (msg.cells as [number, {r:boolean;e:boolean;n:number;rb:string|null;f:string[]}][])) {
              nb[idx] = toDisplayCell(cell);
            }
            boardRef.current = nb;
            setBoard(nb);
            setGameId(msg.gameId as string);
            if (msg.scores) { scoresRef.current = msg.scores; setScores(msg.scores); }
            if (msg.history) setHistory(msg.history as unknown[]);
            setLoading(false);
            if (msg.type === 'new_game') { setCleared(false); setTimeout(initView, 30); }
            break;
          }
          case 'patch': {
            const prev = boardRef.current; if (!prev) break;
            const nb = [...prev];
            for (const [idx, cell] of (msg.cells as [number, {r:boolean;e:boolean;n:number;rb:string|null;f:string[]}][])) {
              nb[idx] = toDisplayCell(cell);
            }
            boardRef.current = nb;
            setBoard(nb);
            if (msg.scores) { scoresRef.current = msg.scores; setScores(msg.scores); }
            if (msg.cleared) setCleared(true);
            break;
          }
          case 'scores':
            scoresRef.current = msg.scores;
            setScores(msg.scores);
            break;
        }
      };

      ws.onclose = () => {
        if (active) reconnectTimer = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      active = false;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!loading) setTimeout(initView, 30); }, [loading, initView]);

  // ── Actions ─────────────────────────────────────────────────────────────────

  const register = () => {
    const name = nameInput.trim(); if (!name) return;
    const color = pickColor(scoresRef.current);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const newMe: PlayerInfo = { id, name, color };
    setMe(newMe); saveMe(newMe);
    wsRef.current?.send(JSON.stringify({ type: 'join', player: newMe }));
  };

  const openCell = useCallback((idx: number) => {
    const b = boardRef.current, m = meRef.current; if (!b || !m) return;
    const cell = b[idx];
    if (cell.revealed && !cell.exploded) return;
    if (cell.flags[m.id]) return;
    setFlash({ idx, type: cell.exploded ? "explode" : "open" });
    setTimeout(() => setFlash(null), cell.exploded ? 600 : 300);
    wsRef.current?.send(JSON.stringify({ type: 'open_cell', idx, playerId: m.id }));
  }, []);

  const toggleFlag = useCallback((idx: number) => {
    const b = boardRef.current, m = meRef.current; if (!b || !m) return;
    if (b[idx].revealed && !b[idx].exploded) return;
    wsRef.current?.send(JSON.stringify({ type: 'toggle_flag', idx, playerId: m.id }));
  }, []);

  const nextGame = () => {
    wsRef.current?.send(JSON.stringify({ type: 'next_game' }));
  };

  // ── Pointer / wheel interaction ──────────────────────────────────────────────

  const getCellIdx = useCallback((cx: number, cy: number) => {
    const vp = viewportRef.current; if (!vp) return null;
    const rect = vp.getBoundingClientRect();
    const v = viewRef.current;
    const bx = (cx - rect.left - v.x) / v.scale - PAD;
    const by = (cy - rect.top  - v.y) / v.scale - PAD;
    const col = Math.floor(bx / CELL_STEP), row = Math.floor(by / CELL_STEP);
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null;
    if (bx - col * CELL_STEP > CELL || by - row * CELL_STEP > CELL) return null;
    return row * COLS + col;
  }, []);

  const pDist = (a: {x:number;y:number}, b: {x:number;y:number}) => Math.hypot(b.x - a.x, b.y - a.y);
  const pMid  = (a: {x:number;y:number}, b: {x:number;y:number}) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  const T = useRef({
    ptrs: {} as Record<number, {x:number;y:number}>, mode: "idle", timer: null as ReturnType<typeof setTimeout> | null, cell: null as number | null,
    panSX: 0, panSY: 0, panVX: 0, panVY: 0,
    pinchD0: 0, pinchS0: 1, pinchBX: 0, pinchBY: 0, pinchMX: 0, pinchMY: 0,
  });

  const onWheel = useCallback((e: WheelEvent) => {
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
      viewRef.current = nv; setView(nv); setVpSize({ w: vp.clientWidth, h: vp.clientHeight });
    } else {
      const nv = clampView({ ...viewRef.current, x: viewRef.current.x - e.deltaX, y: viewRef.current.y - e.deltaY });
      viewRef.current = nv; setView(nv); setVpSize({ w: vp.clientWidth, h: vp.clientHeight });
    }
  }, [clampView]);

  const onPD = useCallback((e: PointerEvent) => {
    if (!meRef.current) return;
    if (e.button === 2) { e.preventDefault(); return; }
    e.preventDefault();
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch {}
    const t = T.current;
    t.ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
    const pts = Object.values(t.ptrs);
    if (pts.length === 1) {
      if (t.timer) clearTimeout(t.timer);
      t.mode = "lp"; t.cell = getCellIdx(e.clientX, e.clientY);
      t.panSX = e.clientX; t.panSY = e.clientY;
      t.panVX = viewRef.current.x; t.panVY = viewRef.current.y;
      t.timer = setTimeout(() => { if (t.mode === "lp" && t.cell !== null) { t.mode = "fired"; toggleFlag(t.cell); } }, LONG_PRESS_MS);
    } else if (pts.length === 2) {
      if (t.timer) clearTimeout(t.timer);
      t.mode = "pinch";
      const [p1, p2] = pts;
      t.pinchD0 = pDist(p1, p2); t.pinchS0 = viewRef.current.scale;
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

  const onPM = useCallback((e: PointerEvent) => {
    if (!meRef.current) return;
    e.preventDefault();
    const t = T.current;
    if (!t.ptrs[e.pointerId]) return;
    t.ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
    const pts = Object.values(t.ptrs);
    if (t.mode === "lp" && Math.hypot(e.clientX - t.panSX, e.clientY - t.panSY) > MOVE_THRESHOLD) {
      if (t.timer) clearTimeout(t.timer); t.mode = "pan";
    }
    if (t.mode === "pan") {
      const nv = clampView({ ...viewRef.current, x: t.panVX + (e.clientX - t.panSX), y: t.panVY + (e.clientY - t.panSY) });
      viewRef.current = nv; setView(nv);
      const vp = viewportRef.current; if (vp) setVpSize({ w: vp.clientWidth, h: vp.clientHeight });
    } else if (t.mode === "pinch" && pts.length === 2) {
      const [p1, p2] = pts;
      const ns = Math.max(MIN_SCALE, Math.min(MAX_SCALE, t.pinchS0 * pDist(p1, p2) / t.pinchD0));
      const vp = viewportRef.current; if (!vp) return;
      const rect = vp.getBoundingClientRect();
      const nv = clampView({ x: t.pinchMX - rect.left - t.pinchBX * ns, y: t.pinchMY - rect.top - t.pinchBY * ns, scale: ns });
      viewRef.current = nv; setView(nv); setVpSize({ w: vp.clientWidth, h: vp.clientHeight });
    }
  }, [clampView]);

  const onPU = useCallback((e: PointerEvent) => {
    if (!meRef.current) return;
    if (e.button === 2) return;
    e.preventDefault();
    const t = T.current;
    const wasMode = t.mode, wasCell = t.cell;
    delete t.ptrs[e.pointerId];
    if (wasMode === "lp") {
      if (t.timer) clearTimeout(t.timer); t.mode = "idle";
      if (wasCell !== null) openCell(wasCell);
    } else if (Object.keys(t.ptrs).length === 0) t.mode = "idle";
  }, [openCell]);

  const onPC = useCallback((e: PointerEvent) => {
    const t = T.current;
    if (t.timer) clearTimeout(t.timer);
    delete t.ptrs[e.pointerId];
    if (Object.keys(t.ptrs).length === 0) t.mode = "idle";
  }, []);

  useEffect(() => {
    const el = viewportEl; if (!el) return;
    el.addEventListener("pointerdown",   onPD as EventListener, { passive: false });
    el.addEventListener("pointermove",   onPM as EventListener, { passive: false });
    el.addEventListener("pointerup",     onPU as EventListener, { passive: false });
    el.addEventListener("pointercancel", onPC as EventListener);
    el.addEventListener("wheel",         onWheel as EventListener, { passive: false });
    return () => {
      el.removeEventListener("pointerdown",   onPD as EventListener);
      el.removeEventListener("pointermove",   onPM as EventListener);
      el.removeEventListener("pointerup",     onPU as EventListener);
      el.removeEventListener("pointercancel", onPC as EventListener);
      el.removeEventListener("wheel",         onWheel as EventListener);
    };
  }, [viewportEl, onPD, onPM, onPU, onPC, onWheel]);

  const warp = useCallback(() => {
    const vp = viewportRef.current; if (!vp) return;
    const s = viewRef.current.scale;
    const maxX = BOARD_W * s - vp.clientWidth, maxY = BOARD_H * s - vp.clientHeight;
    const tx = maxX > 0 ? -(Math.random() * maxX) : (vp.clientWidth  - BOARD_W * s) / 2;
    const ty = maxY > 0 ? -(Math.random() * maxY) : (vp.clientHeight - BOARD_H * s) / 2;
    const nv = { ...viewRef.current, x: tx, y: ty };
    viewRef.current = nv; setView(nv); setVpSize({ w: vp.clientWidth, h: vp.clientHeight });
  }, []);

  const visibleRange = useMemo(() => {
    const { x, y, scale } = view, { w, h } = vpSize;
    const bxStart = (-x) / scale - PAD, byStart = (-y) / scale - PAD;
    return {
      c0: Math.max(0, Math.floor(bxStart / CELL_STEP) - BUFFER),
      c1: Math.min(COLS - 1, Math.ceil((bxStart + w / scale) / CELL_STEP) + BUFFER),
      r0: Math.max(0, Math.floor(byStart / CELL_STEP) - BUFFER),
      r1: Math.min(ROWS - 1, Math.ceil((byStart + h / scale) / CELL_STEP) + BUFFER),
    };
  }, [view, vpSize]);

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) return (
    <div style={{ background:"#0a0a0f", height:"100svh", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", color:"#f59e0b", fontFamily:"monospace", fontSize:18, gap:8 }}>
      接続中…
      <span style={{ fontSize:11, color:"#475569" }}>Durable Object に接続しています</span>
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
            transformOrigin:"0 0", width:BOARD_W, height:BOARD_H, willChange:"transform",
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
                  let color = "", content: React.ReactNode = null, anim = "";

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
                      left: PAD + c * CELL_STEP, top: PAD + r * CELL_STEP,
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
      ) : board && !me ? (
        // Observer mode: board visible but interaction disabled
        <div
          ref={viewportCbRef}
          style={{ flex:1, width:"100%", overflow:"hidden", position:"relative", touchAction:"none", minHeight:0, opacity:0.6 }}
        >
          <div style={{
            position:"absolute", top:0, left:0,
            transform:`translate(${view.x}px,${view.y}px) scale(${view.scale})`,
            transformOrigin:"0 0", width:BOARD_W, height:BOARD_H, willChange:"transform",
          }}>
            <div style={{ position:"absolute", inset:0, background:"#0d1520", border:"2px solid #1e3a5f", borderRadius:6 }} />
            {(() => {
              const { c0, c1, r0, r1 } = visibleRange;
              const cells = [];
              for (let r = r0; r <= r1; r++) {
                for (let c = c0; c <= c1; c++) {
                  const i = r * COLS + c;
                  const cell = board[i];
                  let bg = "#1e2a3a", borderColor = "#2d4060", boxShadow = "inset 1px 1px 0 #2d4a6a,inset -1px -1px 0 #0d1520";
                  let color = "", content: React.ReactNode = null;
                  if (cell.exploded) { bg = "#7f1d1d"; borderColor = "#ef4444"; boxShadow = ""; content = "💥"; }
                  else if (Object.keys(cell.flags).length > 0) { bg = "#1a2535"; boxShadow = ""; content = "🚩"; }
                  else if (cell.revealed) {
                    bg = "#111827"; borderColor = "#1a2535"; boxShadow = "";
                    if (cell.number > 0) { color = NUM_COLORS[cell.number]; content = cell.number; }
                    if (cell.revealedBy) { const rp = scores[cell.revealedBy]; if (rp) boxShadow = `inset 0 -2px 0 ${rp.color}`; }
                  }
                  cells.push(
                    <div key={i} style={{
                      position:"absolute", left: PAD + c * CELL_STEP, top: PAD + r * CELL_STEP,
                      width: CELL, height: CELL, background: bg, border: `1px solid ${borderColor}`,
                      boxShadow, color, borderRadius: 2,
                      display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:"bold",
                    }}>{content}</div>
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
                    <div><div style={{ color:"#475569", fontSize:8 }}>SCORE</div><div style={{ color:"#f59e0b", fontSize:15, fontWeight:"bold" }}>{s.score ?? 0}</div></div>
                    <div><div style={{ color:"#475569", fontSize:8 }}>✓開</div><div style={{ color:"#34d399", fontSize:12, fontWeight:"bold" }}>{s.opened ?? 0}</div></div>
                    <div><div style={{ color:"#475569", fontSize:8 }}>💥</div><div style={{ color:"#ef4444", fontSize:12, fontWeight:"bold" }}>{s.explosions ?? 0}</div></div>
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
          {(history as {date:string;players:{name:string;color:string;score:number;opened:number;explosions:number}[]}[]).length > 0 && (
            <div style={{ background:"#0d1520", border:"1px solid #1e3a5f", borderRadius:8, padding:"10px 14px", minWidth:280, maxHeight:180, overflowY:"auto" }}>
              <div style={{ color:"#475569", fontSize:9, marginBottom:6 }}>— 過去の記録 —</div>
              {(history as {date:string;players:{name:string;color:string;score:number;opened:number;explosions:number}[]}[]).map((h, hi) => (
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
          {me && <button className="btn btn-green" onClick={nextGame}>▶ 次のゲーム（スコアリセット）</button>}
        </div>
      )}
    </div>
  );
}
