import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const ALL_IN_MIN_STACK = 1000;

// ---- Util ----
const uid = () => Math.random().toString(16).slice(2) + Date.now().toString(16);
const code4 = () => Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,4);

function safeInt(n, fallback=0){
  const x = Math.floor(Number(n));
  return Number.isFinite(x) ? x : fallback;
}

function deepClone(obj){
  return JSON.parse(JSON.stringify(obj));
}

// ---- Rooms ----
// Each room has isolated state.
const rooms = new Map(); // roomCode -> roomState

function newRoom(hostSocketId){
  const roomCode = code4();
  const room = {
    roomCode,
    createdAt: Date.now(),
    hostSocketId: null,
    players: [], // {id,name,stack,inRound,folded,streetPut,totalPut,socketId}
    dealerIndex: 0,
    round: null, // { currentBet, turnIndex, phase: 'running'|'pay'|'ended' }
    log: []
  };
  rooms.set(roomCode, room);
  return room;
}

function getRoom(code){
  return rooms.get(String(code||"").trim().toUpperCase()) || null;
}

function addLog(room, msg){
  room.log.push(String(msg));
  if(room.log.length > 80) room.log.shift();
}

function totalPot(room){
  return Math.floor(room.players.reduce((a,p)=>a+(p.totalPut||0),0));
}

function canAct(p){
  return p.inRound && !p.folded;
}

function activePlayers(room){
  return room.players.filter(p => p.inRound && !p.folded);
}

function onlyOneLeft(room){
  const left = activePlayers(room);
  return left.length === 1 ? left[0] : null;
}

function currentActor(room){
  if(!room.round) return null;
  if(room.round.turnIndex < 0) return null;
  return room.players[room.round.turnIndex] || null;
}

function toCallFor(room, p){
  return Math.max(0, Math.floor((room.round?.currentBet||0) - (p.streetPut||0)));
}

function commitChips(p, amount){
  amount = Math.floor(amount);
  if(amount <= 0) return 0;
  const pay = Math.min(amount, p.stack);
  p.stack -= pay;
  p.streetPut = Math.floor((p.streetPut||0) + pay);
  p.totalPut = Math.floor((p.totalPut||0) + pay);
  return pay;
}

function nextIndex(room, fromIdx){
  if(room.players.length === 0) return -1;
  for(let step=1; step<=room.players.length; step++){
    const idx = (fromIdx + step) % room.players.length;
    const p = room.players[idx];
    if(canAct(p)) return idx;
  }
  return -1;
}

function ensureIsActor(room, socketId){
  const actor = currentActor(room);
  return actor && actor.socketId === socketId;
}

function emitState(room){
  // send a trimmed state to clients
  const payload = deepClone(room);
  io.to(room.roomCode).emit("state", payload);
}

// ---- Round controls (host) ----
function startRound(room){
  if(room.players.length < 2) return;

  room.players.forEach(p=>{
    p.inRound = true;
    p.folded = false;
    p.streetPut = 0;
    p.totalPut = 0;
  });

  room.log = [];
  addLog(room, "Rodada começou.");

  room.round = { currentBet: 0, turnIndex: -1, phase: "running" };

  const n = room.players.length;
  const dealerIdx = (room.dealerIndex % n + n) % n;
  let first = (dealerIdx + 1) % n;
  if(!canAct(room.players[first])) first = nextIndex(room, dealerIdx);
  room.round.turnIndex = first;

  emitState(room);
}

function goToPay(room){
  if(!room.round) return;
  room.round.phase = "pay";
  room.round.turnIndex = -1;
  addLog(room, "Indo para pagamento.");
  emitState(room);
}

function endRound(room){
  if(!room.round) return;
  room.round.phase = "ended";
  room.round.turnIndex = -1;

  room.players.forEach(p=>{
    p.inRound = false;
    p.folded = false;
    p.streetPut = 0;
    p.totalPut = 0;
  });

  emitState(room);
}

function nextRound(room){
  if(!room.round || room.round.phase !== "ended") return;
  room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
  room.round = null;
  room.log = [];
  emitState(room);
}

// ---- Turn advance ----
function advanceTurnOrEnd(room){
  const winner = onlyOneLeft(room);
  if(winner){
    addLog(room, `${winner.name} ganhou (todos desistiram).`);
    winner.stack += totalPot(room);
    endRound(room);
    return;
  }

  const nxt = nextIndex(room, room.round.turnIndex);
  if(nxt === -1){
    goToPay(room);
    return;
  }
  room.round.turnIndex = nxt;
  emitState(room);
}

// ---- Cleanup ----
function cleanupRoomIfEmpty(room){
  const hasPlayers = room.players.some(p => !!p.socketId);
  if(!hasPlayers){
    rooms.delete(room.roomCode);
  }
}

// ---- Socket handlers ----
io.on("connection", (socket) => {
  socket.emit("hello", { allInMinStack: ALL_IN_MIN_STACK });

  socket.on("room:create", () => {
    const room = newRoom(null);
    socket.join(room.roomCode);
    socket.emit("room:created", { roomCode: room.roomCode });
    emitState(room);
  });

  socket.on("room:join", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if(!room){
      socket.emit("errorMsg", "Sala não encontrada.");
      return;
    }
    socket.join(room.roomCode);
    socket.emit("room:joined", { roomCode: room.roomCode });
    emitState(room);
  });

  socket.on("player:join", ({ roomCode, name, stack }) => {
    const room = getRoom(roomCode);
    if(!room){
      socket.emit("errorMsg", "Sala não encontrada.");
      return;
    }

    name = String(name||"").trim().slice(0, 24);
    if(!name){
      socket.emit("errorMsg", "Digite um nome.");
      return;
    }

    // prevent duplicate join per socket in same room
    const existing = room.players.find(p => p.socketId === socket.id);
    if(existing){
      existing.name = name;
      emitState(room);
      return;
    }

    const player = {
      id: uid(),
      name,
      stack: Math.max(0, safeInt(stack, 1000)),
      inRound: false,
      folded: false,
      streetPut: 0,
      totalPut: 0,
      socketId: socket.id
    };
    room.players.push(player);

    addLog(room, `${name} entrou.`);
    emitState(room);
  });

  // Host actions
  socket.on("host:startRound", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if(!room) return;    startRound(room);
  });

  socket.on("host:goToPay", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if(!room) return;    goToPay(room);
  });

  socket.on("host:nextRound", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if(!room) return;    nextRound(room);
  });

  socket.on("host:pay", ({ roomCode, payments }) => {
    const room = getRoom(roomCode);
    if(!room) return;    if(!room.round || room.round.phase !== "pay") return;

    const pot = totalPot(room);
    if(pot <= 0) return;

    const map = new Map();
    let sum = 0;

    try{
      for(const item of (payments||[])){
        const pid = String(item.playerId||"");
        const amt = Math.max(0, safeInt(item.amount, 0));
        if(!pid || amt<=0) continue;
        map.set(pid, amt);
        sum += amt;
      }
    }catch(e){
      socket.emit("errorMsg", "Pagamento inválido.");
      return;
    }

    if(sum !== pot){
      socket.emit("errorMsg", `A soma precisa ser exatamente ${pot}.`);
      return;
    }

    // apply
    const parts = [];
    for(const [pid, amt] of map.entries()){
      const p = room.players.find(x => x.id === pid);
      if(!p) continue;
      p.stack += amt;
      parts.push(`${p.name} +${amt}`);
    }

    addLog(room, `Pagamento: ${parts.join(" | ")}.`);
    endRound(room);
  });

  // Player actions (only on their turn)
  socket.on("action:fold", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if(!room || !room.round || room.round.phase !== "running") return;
    if(!ensureIsActor(room, socket.id)) return;

    const p = currentActor(room);
    p.folded = true;
    addLog(room, `${p.name} desistiu.`);
    advanceTurnOrEnd(room);
  });

  socket.on("action:check", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if(!room || !room.round || room.round.phase !== "running") return;
    if(!ensureIsActor(room, socket.id)) return;

    const p = currentActor(room);
    if(toCallFor(room, p) !== 0) return;

    addLog(room, `${p.name} passou.`);
    advanceTurnOrEnd(room);
  });

  socket.on("action:call", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if(!room || !room.round || room.round.phase !== "running") return;
    if(!ensureIsActor(room, socket.id)) return;

    const p = currentActor(room);
    const tc = toCallFor(room, p);
    if(tc <= 0) return;

    const paid = commitChips(p, tc);
    addLog(room, `${p.name} cobriu ${paid}.`);
    advanceTurnOrEnd(room);
  });

  socket.on("action:bet", ({ roomCode, betTo }) => {
    const room = getRoom(roomCode);
    if(!room || !room.round || room.round.phase !== "running") return;
    if(!ensureIsActor(room, socket.id)) return;

    const p = currentActor(room);
    const to = Math.floor(Number(betTo));
    if(!Number.isFinite(to) || to <= 0) return;

    const already = Math.floor(p.streetPut||0);
    const delta = to - already;
    if(delta <= 0) return;

    const paid = commitChips(p, delta);
    room.round.currentBet = Math.max(room.round.currentBet, p.streetPut);
    addLog(room, `${p.name} apostou para ${p.streetPut} (pagou ${paid}).`);
    advanceTurnOrEnd(room);
  });

  socket.on("action:allin", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if(!room || !room.round || room.round.phase !== "running") return;
    if(!ensureIsActor(room, socket.id)) return;

    const p = currentActor(room);
    if(p.stack < ALL_IN_MIN_STACK) return;

    const paid = commitChips(p, p.stack);
    room.round.currentBet = Math.max(room.round.currentBet, p.streetPut);
    addLog(room, `${p.name} foi TUDO-IN para ${p.streetPut}.`);
    advanceTurnOrEnd(room);
  });

  socket.on("disconnect", () => {
    // Remove player socket bindings and possibly host reassignment
    for(const room of rooms.values()){
      const idx = room.players.findIndex(p => p.socketId === socket.id);
      if(idx >= 0){
        const name = room.players[idx].name;
        room.players[idx].socketId = null;
        addLog(room, `${name} saiu.`);
      }      cleanupRoomIfEmpty(room);
      emitState(room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Poker multiplayer rodando em http://localhost:${PORT}`);
});
