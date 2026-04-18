const COLS = 200, ROWS = 250, MINES = 9999;
const TOTAL = ROWS * COLS; // 50000
const PALETTE = ["#f59e0b","#34d399","#60a5fa","#f87171","#a78bfa","#fb923c","#22d3ee","#e879f9"];

type PlayerScore = { name: string; color: string; score: number; opened: number; explosions: number };
// Compact cell sent to clients: r=revealed, e=exploded, n=number, rb=revealedBy playerId, f=flag playerIds
type ClientCell = { r: boolean; e: boolean; n: number; rb: string | null; f: string[] };

function generateMines(): Uint16Array {
  const mines = new Uint16Array(MINES);
  const placed = new Set<number>();
  let i = 0;
  while (placed.size < MINES) {
    const idx = Math.floor(Math.random() * TOTAL);
    if (!placed.has(idx)) { placed.add(idx); mines[i++] = idx; }
  }
  return mines;
}

function buildNumbers(mineSet: Set<number>): Uint8Array<ArrayBufferLike> {
  const nums = new Uint8Array(TOTAL);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c;
      if (mineSet.has(i)) continue;
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && mineSet.has(nr * COLS + nc)) n++;
      }
      nums[i] = n;
    }
  }
  return nums;
}

/**
 * MinesweeperGame Durable Object
 *
 * Board storage (per cell, 2 bytes):
 *   board[i*2]   = state byte: bit7=revealed, bit6=exploded, bits3-0=revealedBy player index (1-15, 0=none)
 *   board[i*2+1] = flags byte: bit k = player index (k+1) flagged this cell (supports up to 8 players)
 *
 * playerOrder[j] maps player index (j+1) to player ID string.
 * Mines stored as Uint16Array (~20 KB). Numbers derived at runtime.
 */
export class MinesweeperGame {
  private state: DurableObjectState;
  private gameId = '';
  private mineSet = new Set<number>();
  private nums: Uint8Array<ArrayBufferLike> = new Uint8Array(TOTAL);
  private board: Uint8Array<ArrayBufferLike> = new Uint8Array(TOTAL * 2); // 100 KB
  private playerOrder: string[] = [];        // index 0 → playerIdx 1
  private scores: Record<string, PlayerScore> = {};
  private history: unknown[] = [];

  constructor(state: DurableObjectState) {
    this.state = state;
    this.state.blockConcurrencyWhile(() => this.loadState());
  }

  // ── Storage ────────────────────────────────────────────────────────────────

  private async loadState() {
    const stored = await this.state.storage.get<unknown>([
      'gameId', 'mines', 'board', 'playerOrder', 'scores', 'history',
    ]);
    const gameId = stored.get('gameId') as string | undefined;
    const mines  = stored.get('mines')  as Uint16Array | undefined;
    if (!gameId || !mines) { await this.initNewGame(); return; }
    this.gameId      = gameId;
    this.mineSet     = new Set(Array.from(mines));
    this.nums        = buildNumbers(this.mineSet);
    this.board       = (stored.get('board') as Uint8Array | undefined) ?? new Uint8Array(TOTAL * 2);
    this.playerOrder = (stored.get('playerOrder') as string[] | undefined) ?? [];
    this.scores      = (stored.get('scores') as Record<string, PlayerScore> | undefined) ?? {};
    this.history     = (stored.get('history') as unknown[] | undefined) ?? [];
  }

  private async initNewGame() {
    const mines = generateMines();
    this.gameId  = `${Date.now()}`;
    this.mineSet = new Set(Array.from(mines));
    this.nums    = buildNumbers(this.mineSet);
    this.board   = new Uint8Array(TOTAL * 2);
    await this.saveAll(mines);
  }

  private async saveAll(mines: Uint16Array) {
    await this.state.storage.put({
      gameId: this.gameId, mines, board: this.board,
      playerOrder: this.playerOrder, scores: this.scores, history: this.history,
    });
  }

  // ── Cell bit helpers ───────────────────────────────────────────────────────

  private cellState(i: number) {
    const b = this.board[i * 2];
    return { revealed: !!(b & 0x80), exploded: !!(b & 0x40), revByIdx: b & 0x0F };
  }

  private setRevealed(i: number, exploded: boolean, revByIdx: number) {
    this.board[i * 2] = 0x80 | (exploded ? 0x40 : 0) | (revByIdx & 0x0F);
  }

  private flagBit(pIdx: number) { return 1 << ((pIdx - 1) & 7); }
  private hasFlag(i: number, pIdx: number) { return !!(this.board[i * 2 + 1] & this.flagBit(pIdx)); }
  private setFlag(i: number, pIdx: number, on: boolean) {
    const bit = this.flagBit(pIdx);
    this.board[i * 2 + 1] = on
      ? this.board[i * 2 + 1] | bit
      : this.board[i * 2 + 1] & ~bit;
  }

  // ── Player index management ────────────────────────────────────────────────

  private playerIdx(pid: string): number {
    let idx = this.playerOrder.indexOf(pid);
    if (idx === -1) { this.playerOrder.push(pid); idx = this.playerOrder.length - 1; }
    return idx + 1; // 1-based
  }

  private playerIdFromIdx(idx: number): string | null {
    return idx === 0 ? null : (this.playerOrder[idx - 1] ?? null);
  }

  // ── Client serialisation ───────────────────────────────────────────────────

  private clientCell(i: number): ClientCell {
    const { revealed, exploded, revByIdx } = this.cellState(i);
    const flags: string[] = [];
    for (let p = 0; p < 8; p++) {
      if (this.board[i * 2 + 1] & (1 << p)) {
        const pid = this.playerOrder[p];
        if (pid) flags.push(pid);
      }
    }
    return { r: revealed, e: exploded, n: revealed && !exploded ? this.nums[i] : 0, rb: this.playerIdFromIdx(revByIdx), f: flags };
  }

  /** Sparse board: only non-default (revealed or flagged) cells. */
  private boardCells(): [number, ClientCell][] {
    const out: [number, ClientCell][] = [];
    for (let i = 0; i < TOTAL; i++) {
      if (this.board[i * 2] !== 0 || this.board[i * 2 + 1] !== 0) {
        out.push([i, this.clientCell(i)]);
      }
    }
    return out;
  }

  private statePayload() {
    return { gameId: this.gameId, cells: this.boardCells(), scores: this.scores, history: this.history };
  }

  // ── Game logic ─────────────────────────────────────────────────────────────

  private floodReveal(startIdx: number, pIdx: number): number[] {
    const out: number[] = [];
    const q = [startIdx], vis = new Set<number>();
    while (q.length) {
      const i = q.shift()!;
      if (vis.has(i)) continue; vis.add(i);
      const { revealed, exploded } = this.cellState(i);
      if (revealed || exploded || this.mineSet.has(i) || this.hasFlag(i, pIdx)) continue;
      this.setRevealed(i, false, pIdx);
      out.push(i);
      if (this.nums[i] === 0) {
        const r = Math.floor(i / COLS), c = i % COLS;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) q.push(nr * COLS + nc);
        }
      }
    }
    return out;
  }

  private revealedSafeCount(): number {
    let n = 0;
    for (let i = 0; i < TOTAL; i++) {
      const b = this.board[i * 2];
      if ((b & 0x80) && !(b & 0x40)) n++;
    }
    return n;
  }

  // ── Message handlers ───────────────────────────────────────────────────────

  private async handleJoin(ws: WebSocket, player: { id: string; name: string; color: string }) {
    if (!this.scores[player.id]) {
      const usedColors = Object.values(this.scores).map(s => s.color);
      const color = usedColors.includes(player.color)
        ? (PALETTE.find(c => !usedColors.includes(c)) ?? PALETTE[Object.keys(this.scores).length % PALETTE.length])
        : player.color;
      this.scores[player.id] = { name: player.name, color, score: 0, opened: 0, explosions: 0 };
      await this.state.storage.put('scores', this.scores);
      this.broadcast({ type: 'scores', scores: this.scores });
    }
    this.playerIdx(player.id); // ensure in playerOrder
    await this.state.storage.put('playerOrder', this.playerOrder);
    ws.send(JSON.stringify({ type: 'init', ...this.statePayload() }));
  }

  private async handleOpenCell(idx: number, pid: string) {
    if (idx < 0 || idx >= TOTAL) return;
    const { revealed, exploded } = this.cellState(idx);
    if (revealed && !exploded) return;
    const pIdx = this.playerIdx(pid);
    if (this.hasFlag(idx, pIdx)) return;
    const player = this.scores[pid];
    if (!player) return;

    if (this.mineSet.has(idx)) {
      if (exploded) return;
      this.setRevealed(idx, true, pIdx);
      const penalty = player.score <= 50 ? 10 : 25;
      this.scores[pid] = { ...player, score: Math.max(0, player.score - penalty), explosions: (player.explosions ?? 0) + 1 };
      await this.state.storage.put({ board: this.board, scores: this.scores });
      this.broadcast({ type: 'patch', cells: [[idx, this.clientCell(idx)]], scores: this.scores });
    } else {
      const patched = this.floodReveal(idx, pIdx);
      if (!patched.length) return;
      this.scores[pid] = { ...player, score: player.score + patched.length, opened: (player.opened ?? 0) + patched.length };
      const cleared = this.revealedSafeCount() >= TOTAL - MINES;
      await this.state.storage.put({ board: this.board, scores: this.scores });
      this.broadcast({ type: 'patch', cells: patched.map(i => [i, this.clientCell(i)]), scores: this.scores, cleared });
    }
  }

  private async handleToggleFlag(idx: number, pid: string) {
    if (idx < 0 || idx >= TOTAL) return;
    const { revealed, exploded } = this.cellState(idx);
    if (revealed && !exploded) return;
    const pIdx = this.playerIdx(pid);
    this.setFlag(idx, pIdx, !this.hasFlag(idx, pIdx));
    await this.state.storage.put('board', this.board);
    this.broadcast({ type: 'patch', cells: [[idx, this.clientCell(idx)]] });
  }

  private async handleNextGame() {
    const entry = {
      date: new Date().toISOString(),
      players: Object.values(this.scores).sort((a, b) => b.score - a.score),
    };
    this.history = [entry, ...this.history].slice(0, 10);
    this.scores = Object.fromEntries(
      Object.entries(this.scores).map(([id, s]) => [id, { ...s, score: 0, opened: 0, explosions: 0 }])
    );
    await this.initNewGame();
    this.broadcast({ type: 'new_game', ...this.statePayload() });
  }

  // ── WebSocket broadcast ────────────────────────────────────────────────────

  private broadcast(msg: unknown) {
    const text = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(text); } catch { /* ignore closed */ }
    }
  }

  // ── DurableObject interface ────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const CORS_HEADERS = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      // Send current game state immediately so observers can see the board without joining
      pair[1].send(JSON.stringify({ type: 'init', ...this.statePayload() }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response('WebSocket required', { status: 426, headers: CORS_HEADERS });
  }

  async webSocketMessage(ws: WebSocket, msg: ArrayBuffer | string) {
    try {
      const data = JSON.parse(msg as string);
      switch (data.type) {
        case 'join':        await this.handleJoin(ws, data.player);                break;
        case 'open_cell':   await this.handleOpenCell(data.idx, data.playerId);    break;
        case 'toggle_flag': await this.handleToggleFlag(data.idx, data.playerId);  break;
        case 'next_game':   await this.handleNextGame();                           break;
      }
    } catch { /* ignore malformed messages */ }
  }

  async webSocketClose(_ws: WebSocket, _code: number, _reason: string, _clean: boolean) {}
  async webSocketError(_ws: WebSocket, _error: unknown) {}
}
