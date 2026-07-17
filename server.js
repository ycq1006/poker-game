const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// ─── Card & Deck ────────────────────────────────────────────────
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUES = {};
RANKS.forEach((r, i) => RANK_VALUES[r] = i + 2);

function createDeck() {
  const deck = [];
  for (const suit of SUITS)
    for (const rank of RANKS)
      deck.push({ suit, rank, value: RANK_VALUES[rank] });
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ─── Hand Evaluator ──────────────────────────────────────────────
function evaluateHand(cards) {
  const combos = getCombinations(cards, 5);
  let best = { rank: -1, values: [], handName: '', bestCards: [] };
  for (const combo of combos) {
    const result = evaluate5(combo);
    if (result.rank > best.rank || (result.rank === best.rank && compareValues(result.values, best.values) > 0)) {
      best = result;
    }
  }
  return best;
}

function getCombinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length === 0) return [];
  const [first, ...rest] = arr;
  const withFirst = getCombinations(rest, k - 1).map(c => [first, ...c]);
  const withoutFirst = getCombinations(rest, k);
  return [...withFirst, ...withoutFirst];
}

function compareValues(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function evaluate5(cards) {
  const values = cards.map(c => c.value).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);
  const isStraight = checkStraight(values);
  const groups = {};
  for (const v of values) groups[v] = (groups[v] || 0) + 1;
  const counts = Object.entries(groups).sort((a, b) => b[1] - a[1] || Number(b[0]) - Number(a[0]));
  const numGroups = counts.length;

  if (isFlush && isStraight && values[0] === 14 && values[4] === 10)
    return { rank: 9, values: [14], handName: '皇家同花顺', bestCards: cards };
  if (isFlush && isStraight)
    return { rank: 8, values: [values[0]], handName: '同花顺', bestCards: cards };
  if (numGroups === 2 && counts[0][1] === 4)
    return { rank: 7, values: [Number(counts[0][0]), Number(counts[1][0])], handName: '四条', bestCards: cards };
  if (numGroups === 2 && counts[0][1] === 3)
    return { rank: 6, values: [Number(counts[0][0]), Number(counts[1][0])], handName: '葫芦', bestCards: cards };
  if (isFlush)
    return { rank: 5, values, handName: '同花', bestCards: cards };
  if (isStraight)
    return { rank: 4, values: [values[0]], handName: '顺子', bestCards: cards };
  if (counts[0][1] === 3)
    return { rank: 3, values: [Number(counts[0][0]), ...values.filter(v => v !== Number(counts[0][0])).sort((a, b) => b - a)], handName: '三条', bestCards: cards };
  if (numGroups === 3 && counts[0][1] === 2 && counts[1][1] === 2) {
    const pair1 = Math.max(Number(counts[0][0]), Number(counts[1][0]));
    const pair2 = Math.min(Number(counts[0][0]), Number(counts[1][0]));
    return { rank: 2, values: [pair1, pair2, Number(counts[2][0])], handName: '两对', bestCards: cards };
  }
  if (counts[0][1] === 2) {
    const pair = Number(counts[0][0]);
    return { rank: 1, values: [pair, ...values.filter(v => v !== pair).sort((a, b) => b - a)], handName: '一对', bestCards: cards };
  }
  return { rank: 0, values, handName: '高牌', bestCards: cards };
}

function checkStraight(values) {
  const unique = [...new Set(values)].sort((a, b) => b - a);
  if (unique.length < 5) return false;
  if (unique[0] - unique[4] === 4) return true;
  if (unique[0] === 14 && unique[1] === 5 && unique[2] === 4 && unique[3] === 3 && unique[4] === 2) return true;
  return false;
}

// ─── Rooms ───────────────────────────────────────────────────────
const rooms = {};

function getRoom(roomId) { return rooms[roomId]; }

function createRoom(hostId, hostNickname) {
  let roomId;
  do { roomId = generateRoomCode(); } while (rooms[roomId]);
  rooms[roomId] = { id: roomId, hostId, players: [], state: 'waiting', game: null, turnTimeout: null };
  return rooms[roomId];
}

// ─── Game Logic ───────────────────────────────────────────────────
const INITIAL_CHIPS = 10000;
const SMALL_BLIND = 50;
const BIG_BLIND = 100;
const MIN_RAISE = BIG_BLIND;
const TURN_TIMEOUT_MS = 30000;

class Game {
  constructor(room) {
    this.room = room;
    this.deck = [];
    this.communityCards = [];
    this.players = room.players.map(p => ({
      id: p.id, socketId: p.socketId, name: p.name, chips: INITIAL_CHIPS,
      cards: [], currentBet: 0, totalBetThisHand: 0,
      folded: false, allIn: false, actedThisRound: false, seatIndex: p.seatIndex,
    }));
    this.pot = 0;
    this.currentBet = 0;
    this.phase = null;
    this.dealerIndex = 0;
    this.currentTurnIndex = 0;
    this.lastAggressorIndex = -1;
    this.actionsCount = 0;
    this.roundActive = false;
    this.lastAction = null;
    this.minRaise = MIN_RAISE;
  }

  getActiveNonFolded() { return this.players.filter(p => !p.folded && p.chips > 0); }
  getActiveInHand() { return this.players.filter(p => !p.folded); }

  getNextPlayerIndex(from) {
    for (let i = 1; i <= this.players.length; i++) {
      const idx = (from + i) % this.players.length;
      const p = this.players[idx];
      if (!p.folded && p.chips > 0 && !p.allIn) return idx;
    }
    return -1;
  }

  getNextActiveFromPlayer(from) {
    for (let i = 1; i <= this.players.length; i++) {
      const idx = (from + i) % this.players.length;
      const p = this.players[idx];
      if (!p.folded && p.chips > 0) return idx;
    }
    return -1;
  }

  startHand() {
    const active = this.getActiveNonFolded();
    if (active.length < 2) return false;

    this.deck = shuffle(createDeck());
    this.communityCards = [];
    this.pot = 0;
    this.currentBet = 0;
    this.lastAggressorIndex = -1;
    this.actionsCount = 0;
    this.phase = 'preflop';
    this.roundActive = true;
    this.lastAction = null;
    this.minRaise = MIN_RAISE;

    for (const p of this.players) {
      if (p.chips <= 0) continue;
      p.cards = []; p.currentBet = 0; p.totalBetThisHand = 0;
      p.folded = false; p.allIn = false; p.actedThisRound = false;
    }

    // Find next dealer (skip broke)
    let found = false, tries = 0;
    while (!found && tries < this.players.length * 2) {
      this.dealerIndex = (this.dealerIndex + 1) % this.players.length;
      if (this.players[this.dealerIndex].chips > 0) found = true;
      tries++;
    }

    // Deal 2 cards
    for (const p of this.getActiveNonFolded())
      p.cards = [this.deck.pop(), this.deck.pop()];

    // Blinds
    const sbIdx = this.getNextPlayerIndex(this.dealerIndex);
    const bbIdx = this.getNextPlayerIndex(sbIdx);

    if (sbIdx >= 0) {
      const sb = this.players[sbIdx];
      const amt = Math.min(SMALL_BLIND, sb.chips);
      sb.chips -= amt; sb.currentBet = amt; sb.totalBetThisHand += amt; this.pot += amt;
      if (sb.chips === 0) sb.allIn = true;
    }
    if (bbIdx >= 0) {
      const bb = this.players[bbIdx];
      const amt = Math.min(BIG_BLIND, bb.chips);
      bb.chips -= amt; bb.currentBet = amt; bb.totalBetThisHand += amt; this.pot += amt;
      if (bb.chips === 0) bb.allIn = true;
    }

    this.currentBet = (bbIdx >= 0) ? this.players[bbIdx].currentBet : 0;
    const firstToAct = this.getNextPlayerIndex(bbIdx);
    this.currentTurnIndex = firstToAct >= 0 ? firstToAct : this.getNextPlayerIndex(this.dealerIndex);
    this.lastAggressorIndex = bbIdx;
    this.actionsCount = 0;
    return true;
  }

  getValidActions(playerIndex) {
    const p = this.players[playerIndex];
    if (!p || p.folded || p.allIn) return [];
    const toCall = this.currentBet - p.currentBet;
    const actions = [];

    if (toCall === 0) {
      actions.push({ action: 'check', label: '过牌 ✓' });
    } else {
      const minCall = Math.min(toCall, p.chips);
      actions.push({ action: 'call', label: `跟注 ${minCall}`, amount: minCall });
    }

    if (p.chips > toCall) {
      const minRaiseTotal = this.currentBet + this.minRaise;
      const raiseMin = minRaiseTotal - p.currentBet;
      const cappedMin = Math.min(raiseMin, p.chips);
      if (cappedMin < p.chips) {
        actions.push({ action: 'raise', label: '加注', minAmount: Math.max(cappedMin, MIN_RAISE), maxAmount: p.chips });
      } else {
        actions.push({ action: 'all_in', label: `All-in ${p.chips}`, amount: p.chips });
      }
    } else if (p.chips === toCall && p.chips > 0) {
      actions.splice(1, 1, { action: 'all_in', label: `All-in ${p.chips}`, amount: p.chips });
    }

    actions.push({ action: 'fold', label: '弃牌 ✋' });
    return actions;
  }

  handleAction(playerId, action, amount) {
    const p = this.players.find(pl => pl.id === playerId);
    if (!p || p.folded || p.allIn) return null;
    const idx = this.players.indexOf(p);
    if (idx !== this.currentTurnIndex) return null;

    const result = { playerId, action, amount: 0, playerName: p.name };

    switch (action) {
      case 'fold': p.folded = true; this.actionsCount++; this.lastAction = 'fold'; break;
      case 'check': this.actionsCount++; this.lastAction = 'check'; break;
      case 'call': {
        const callAmt = Math.min(this.currentBet - p.currentBet, p.chips);
        p.chips -= callAmt; p.currentBet += callAmt; p.totalBetThisHand += callAmt;
        this.pot += callAmt; if (p.chips === 0) p.allIn = true;
        this.actionsCount++; result.amount = callAmt; this.lastAction = 'call'; break;
      }
      case 'raise': case 'all_in': {
        let raiseAmt = Math.min(amount || p.chips, p.chips);
        p.currentBet += raiseAmt; p.totalBetThisHand += raiseAmt;
        p.chips -= raiseAmt; this.pot += raiseAmt;
        if (p.chips === 0) p.allIn = true;
        if (p.currentBet > this.currentBet) {
          this.minRaise = Math.max(MIN_RAISE, p.currentBet - this.currentBet);
          this.currentBet = p.currentBet;
          this.lastAggressorIndex = idx;
          this.actionsCount = 1;
        } else this.actionsCount++;
        result.amount = raiseAmt; this.lastAction = p.allIn ? 'all_in' : 'raise'; break;
      }
    }
    return result;
  }

  advanceTurn() {
    for (let i = 1; i <= this.players.length; i++) {
      const idx = (this.currentTurnIndex + i) % this.players.length;
      const p = this.players[idx];
      if (!p.folded && p.chips > 0 && !p.allIn) { this.currentTurnIndex = idx; return idx; }
    }
    return -1;
  }

  isBettingRoundOver() {
    const active = this.getActiveInHand();
    if (active.length <= 1) return true;
    const nonAllIn = active.filter(p => !p.allIn);
    if (nonAllIn.length === 0) return true;
    const allMatch = nonAllIn.every(p => p.currentBet === this.currentBet);
    if (!allMatch) return false;
    // Check that everyone who had the chance before last raise has acted
    if (this.lastAggressorIndex < 0) return this.actionsCount >= nonAllIn.length;
    const from = this.lastAggressorIndex;
    // We need to count acts from last aggressor
    return this.actionsCount >= nonAllIn.length;
  }

  dealCommunityCards(count) {
    this.deck.pop(); // burn
    for (let i = 0; i < count; i++) this.communityCards.push(this.deck.pop());
  }

  nextPhase() {
    const active = this.getActiveInHand();
    if (active.length <= 1) return 'showdown';
    switch (this.phase) {
      case 'preflop': this.dealCommunityCards(3); this.phase = 'flop'; break;
      case 'flop': this.dealCommunityCards(1); this.phase = 'turn'; break;
      case 'turn': this.dealCommunityCards(1); this.phase = 'river'; break;
      case 'river': return 'showdown';
    }
    this.currentBet = 0; this.actionsCount = 0; this.lastAggressorIndex = -1; this.minRaise = MIN_RAISE;
    for (const p of this.players) { p.currentBet = 0; p.actedThisRound = false; }
    const startIdx = this.getNextActiveFromPlayer(this.dealerIndex);
    this.currentTurnIndex = startIdx >= 0 ? startIdx : 0;
    return this.phase;
  }

  showdown() {
    const active = this.getActiveInHand();
    if (active.length === 1) return { winners: [active[0]], handName: '对手弃牌', potAmount: this.pot, winnersHands: {} };

    const results = [];
    for (const p of active) {
      const allCards = [...p.cards, ...this.communityCards];
      results.push({ player: p, result: evaluateHand(allCards) });
    }
    results.sort((a, b) => b.result.rank - a.result.rank || compareValues(b.result.values, a.result.values));
    const best = results[0];
    const winners = [best.player];
    for (let i = 1; i < results.length; i++)
      if (results[i].result.rank === best.result.rank && compareValues(results[i].result.values, best.result.values) === 0)
        winners.push(results[i].player);

    const winnersHands = {};
    for (const w of winners) {
      const r = results.find(r => r.player.id === w.id);
      winnersHands[w.id] = { handName: r.result.handName, bestCards: r.result.bestCards };
    }
    return { winners, handName: best.result.handName, potAmount: this.pot, winnersHands };
  }

  awardPot(winners, potAmount) {
    const share = Math.floor(potAmount / winners.length);
    const rem = potAmount % winners.length;
    winners.forEach((w, i) => w.chips += share + (i < rem ? 1 : 0));
  }

  eliminateBrokePlayers() {
    this.players = this.players.filter(p => p.chips > 0);
  }
}

function serializeGameState(game) {
  const dealerPlayer = game.players[game.dealerIndex];
  return {
    players: game.players.map(p => ({
      id: p.id, name: p.name, chips: p.chips, seatIndex: p.seatIndex,
      currentBet: p.currentBet, totalBetThisHand: p.totalBetThisHand,
      folded: p.folded, allIn: p.allIn,
    })),
    dealerIndex: game.dealerIndex,
    dealerSeatIndex: dealerPlayer ? dealerPlayer.seatIndex : -1,
  };
}

function serializePlayerState(game) {
  return game.players.map(p => ({
    id: p.id, name: p.name, chips: p.chips, seatIndex: p.seatIndex,
    currentBet: p.currentBet, totalBetThisHand: p.totalBetThisHand,
    folded: p.folded, allIn: p.allIn,
  }));
}

// ─── Socket.IO ────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[连接] ${socket.id}`);
  let currentRoom = null;

  socket.on('create_room', ({ nickname }) => {
    if (!nickname || !nickname.trim()) return socket.emit('error_msg', '请输入昵称');
    nickname = nickname.trim().substring(0, 12);
    const room = createRoom(socket.id, nickname);
    room.players.push({ id: socket.id, socketId: socket.id, name: nickname, chips: INITIAL_CHIPS, seatIndex: 0 });
    socket.join(room.id);
    currentRoom = room.id;
    socket.emit('room_joined', { roomId: room.id, players: serializeRoomPlayers(room), isHost: true, seatIndex: 0 });
    console.log(`[创建房间] ${nickname} -> ${room.id}`);
  });

  socket.on('join_room', ({ roomId, nickname }) => {
    if (!nickname || !nickname.trim()) return socket.emit('error_msg', '请输入昵称');
    nickname = nickname.trim().substring(0, 12);
    roomId = (roomId || '').toUpperCase().trim();
    const room = getRoom(roomId);
    if (!room) return socket.emit('error_msg', '房间不存在');
    if (room.state === 'playing') return socket.emit('error_msg', '游戏正在进行中');
    if (room.players.some(p => p.name === nickname)) return socket.emit('error_msg', '该昵称已被使用');
    if (room.players.length >= 7) return socket.emit('error_msg', '房间已满（最多7人）');
    const usedSeats = room.players.map(p => p.seatIndex);
    let seatIndex = 0;
    while (usedSeats.includes(seatIndex)) seatIndex++;
    if (seatIndex > 6) return socket.emit('error_msg', '房间已满');
    room.players.push({ id: socket.id, socketId: socket.id, name: nickname, chips: INITIAL_CHIPS, seatIndex });
    socket.join(roomId);
    currentRoom = roomId;
    socket.emit('room_joined', { roomId, players: serializeRoomPlayers(room), isHost: false, seatIndex });
    socket.to(roomId).emit('player_joined', { id: socket.id, name: nickname, chips: INITIAL_CHIPS, seatIndex });
    // Also re-sync full list to everyone
    io.to(roomId).emit('players_update', { players: serializeRoomPlayers(room) });
    console.log(`[加入房间] ${nickname} -> ${roomId}`);
  });

  socket.on('start_game', () => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit('error_msg', '只有房主才能开始游戏');
    if (room.players.length < 2) return socket.emit('error_msg', '至少需要2名玩家');
    if (room.state === 'playing') return;
    room.state = 'playing';
    room.game = new Game(room);

    io.to(room.id).emit('game_started', serializeGameState(room.game));
    io.to(room.id).emit('game_message', { text: '🎮 游戏开始了！', type: 'info' });
    setTimeout(() => startNewHand(room), 1000);
  });

  socket.on('leave_room', () => {
    handlePlayerLeave(socket, currentRoom);
    currentRoom = null;
  });

  socket.on('player_action', ({ action, amount }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room || !room.game || !room.game.roundActive) return;
    const game = room.game;
    const result = game.handleAction(socket.id, action, amount);
    if (!result) return;

    if (room.turnTimeout) { clearTimeout(room.turnTimeout); room.turnTimeout = null; }

    // Broadcast action
    io.to(room.id).emit('player_acted', {
      playerId: result.playerId, playerName: result.playerName,
      action: result.action, amount: result.amount,
      currentBet: game.currentBet, pot: game.pot,
      ...serializeGameState(game),
    });

    const activeInHand = game.getActiveInHand();
    if (activeInHand.length === 1) {
      endHand(room, activeInHand); return;
    }

    if (game.isBettingRoundOver()) {
      scheduleNextPhase(room); return;
    }

    // If all remaining players are all-in, deal out the board
    const nonAllIn = activeInHand.filter(p => !p.allIn);
    if (nonAllIn.length === 0) {
      runOutBoard(game);
      io.to(room.id).emit('board_update', {
        communityCards: game.communityCards, pot: game.pot, phase: game.phase,
        ...serializeGameState(game),
      });
      setTimeout(() => {
        const sr = game.showdown();
        endHand(room, null, sr);
      }, 1000);
      return;
    }

    const nextIdx = game.advanceTurn();
    if (nextIdx < 0) return;
    game.currentTurnIndex = nextIdx;
    startTurnTimer(room);
    sendTurnToPlayer(room);
  });

  socket.on('leave_room', () => {
    handlePlayerLeave(socket, currentRoom);
  });

  socket.on('disconnect', () => {
    handlePlayerLeave(socket, currentRoom);
  });
});

function handlePlayerLeave(socket, roomId) {
  if (!roomId) return;
  const room = getRoom(roomId);
  if (!room) return;
  console.log(`[离开] ${socket.id} 离开 ${roomId}`);

  // Auto-fold in active game
  if (room.game && room.game.roundActive) {
    const p = room.game.players.find(pl => pl.id === socket.id);
    if (p && !p.folded && !p.allIn) {
      p.folded = true;
      io.to(room.id).emit('player_acted', {
        playerId: p.id, playerName: p.name, action: 'fold', amount: 0,
        currentBet: room.game.currentBet, pot: room.game.pot,
        ...serializeGameState(room.game), autoFold: true,
      });
      const activeInHand = room.game.getActiveInHand();
      if (activeInHand.length === 1) {
        if (room.turnTimeout) clearTimeout(room.turnTimeout);
        endHand(room, activeInHand); return;
      }
      if (room.game.isBettingRoundOver()) {
        if (room.turnTimeout) clearTimeout(room.turnTimeout);
        scheduleNextPhase(room); return;
      }
      const nextIdx = room.game.advanceTurn();
      if (nextIdx >= 0) {
        room.game.currentTurnIndex = nextIdx;
        if (room.turnTimeout) clearTimeout(room.turnTimeout);
        startTurnTimer(room); sendTurnToPlayer(room);
      }
      return;
    }
  }

  // Remove from room
  room.players = room.players.filter(p => p.id !== socket.id);
  if (room.game) room.game.players = room.game.players.filter(p => p.id !== socket.id);
  io.to(room.id).emit('player_left', { id: socket.id });
  io.to(room.id).emit('players_update', { players: serializeRoomPlayers(room) });
  if (room.hostId === socket.id && room.players.length > 0) {
    room.hostId = room.players[0].id;
    io.to(room.id).emit('new_host', { hostId: room.hostId });
  }
  if (room.players.length === 0) {
    setTimeout(() => { delete rooms[roomId]; console.log(`[删除房间] ${roomId}`); }, 5000);
  }
}

function serializeRoomPlayers(room) {
  return room.players.map(p => ({ id: p.id, name: p.name, chips: p.chips, seatIndex: p.seatIndex }));
}

// ─── Game Flow ────────────────────────────────────────────────────
function startNewHand(room) {
  const game = room.game;
  if (!game) return;
  if (!game.startHand()) {
    io.to(room.id).emit('game_message', { text: '至少需要2名活跃玩家', type: 'warning' });
    room.state = 'waiting'; return;
  }
  // Send cards
  for (const p of game.getActiveNonFolded()) {
    io.to(p.id).emit('your_cards', { cards: p.cards });
  }
  io.to(room.id).emit('board_update', {
    communityCards: [], pot: game.pot, phase: 'preflop',
    ...serializeGameState(game),
  });
  io.to(room.id).emit('game_message', {
    text: `新一局开始！💵 小盲 ${SMALL_BLIND} 大盲 ${BIG_BLIND}`,
    type: 'info',
  });
  sendTurnToPlayer(room);
  startTurnTimer(room);
}

function sendTurnToPlayer(room) {
  const game = room.game;
  const p = game.players[game.currentTurnIndex];
  if (!p || p.folded || p.allIn) return;
  const actions = game.getValidActions(game.currentTurnIndex);
  const cp = game.players[game.currentTurnIndex];
  io.to(p.id).emit('your_turn', {
    actions, currentBet: game.currentBet, myBet: cp.currentBet,
    pot: game.pot, phase: game.phase, timeBank: TURN_TIMEOUT_MS,
    communityCards: game.communityCards,
    ...serializeGameState(game),
  });
  io.to(room.id).emit('turn_indicator', { playerId: p.id, playerName: p.name });
}

function startTurnTimer(room) {
  if (room.turnTimeout) clearTimeout(room.turnTimeout);
  room.turnTimeout = setTimeout(() => {
    const game = room.game;
    if (!game || !game.roundActive) return;
    const p = game.players[game.currentTurnIndex];
    if (p && !p.folded && !p.allIn) {
      const result = game.handleAction(p.id, 'fold', 0);
      if (result) {
        io.to(room.id).emit('player_acted', {
          playerId: result.playerId, playerName: result.playerName,
          action: 'fold', amount: 0, currentBet: game.currentBet, pot: game.pot,
          ...serializeGameState(game), timeout: true,
        });
        const ah = game.getActiveInHand();
        if (ah.length === 1) { endHand(room, ah); return; }
        if (game.isBettingRoundOver()) { scheduleNextPhase(room); return; }
        const next = game.advanceTurn();
        if (next >= 0) { game.currentTurnIndex = next; startTurnTimer(room); sendTurnToPlayer(room); }
      }
    }
  }, TURN_TIMEOUT_MS);
}

function scheduleNextPhase(room) {
  const game = room.game;
  if (!game) return;
  const nextPhase = game.nextPhase();
  if (nextPhase === 'showdown') {
    io.to(room.id).emit('board_update', {
      communityCards: game.communityCards, pot: game.pot, phase: game.phase,
      ...serializeGameState(game),
    });
    setTimeout(() => { const sr = game.showdown(); endHand(room, null, sr); }, 1000);
    return;
  }
  io.to(room.id).emit('board_update', {
    communityCards: game.communityCards, pot: game.pot, phase: game.phase,
    ...serializeGameState(game),
  });
  setTimeout(() => { sendTurnToPlayer(room); startTurnTimer(room); }, 800);
}

function runOutBoard(game) {
  if (game.phase === 'preflop') { game.dealCommunityCards(3); game.phase = 'flop'; }
  if (game.phase === 'flop') { game.dealCommunityCards(1); game.phase = 'turn'; }
  if (game.phase === 'turn') { game.dealCommunityCards(1); game.phase = 'river'; }
}

function endHand(room, lastMan, showdownResult) {
  const game = room.game;
  if (!game) return;
  game.roundActive = false;
  if (room.turnTimeout) { clearTimeout(room.turnTimeout); room.turnTimeout = null; }

  let winners = [], potAmount = game.pot, handName = '';
  if (lastMan) {
    winners = lastMan; handName = '获胜（其他玩家均弃牌）';
    game.awardPot(winners, potAmount);
  } else if (showdownResult) {
    winners = showdownResult.winners; potAmount = showdownResult.potAmount;
    handName = showdownResult.handName; game.awardPot(winners, potAmount);
  }

  const allCards = {};
  for (const p of game.players) {
    if (p.cards && p.cards.length > 0) allCards[p.id] = p.cards;
  }

  io.to(room.id).emit('hand_end', {
    winners: winners.map(w => ({ id: w.id, name: w.name, chips: w.chips })),
    handName, pot: potAmount, communityCards: game.communityCards,
    allCards, winnerHands: showdownResult?.winnersHands || {},
    ...serializeGameState(game),
  });

  for (const p of game.players) {
    if (p.chips <= 0) {
      io.to(room.id).emit('game_message', { text: `⚠️ ${p.name} 筹码用尽，已被淘汰！`, type: 'warning' });
    }
  }

  setTimeout(() => {
    const active = game.getActiveNonFolded();
    if (active.length >= 2) {
      game.eliminateBrokePlayers();
      room.players = game.players.map(p => ({
        id: p.id, socketId: p.socketId, name: p.name, chips: p.chips, seatIndex: p.seatIndex,
      }));
      io.to(room.id).emit('players_update', { players: serializeRoomPlayers(room) });
      setTimeout(() => startNewHand(room), 2000);
    } else {
      const winner = active[0];
      io.to(room.id).emit('game_over', { winner: { id: winner.id, name: winner.name, chips: winner.chips } });
      io.to(room.id).emit('game_message', { text: `🏆 ${winner.name} 赢得比赛！`, type: 'bigwin' });
      room.state = 'waiting';
    }
  }, 3000);
}

// ─── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || process.env.RAILWAY_PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🃏 德州扑克服务器启动！`);
  console.log(`   本地访问: http://localhost:${PORT}`);
  console.log(`   局域网访问: http://<本机IP>:${PORT}`);
});
