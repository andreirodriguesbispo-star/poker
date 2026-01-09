/* global io */
const socket = io();

const ALL_IN_MIN_STACK_FALLBACK = 1000;

let roomCode = null;
let me = { name: "", stack: 1000 };
let serverInfo = { allInMinStack: ALL_IN_MIN_STACK_FALLBACK };
let state = null;

const $ = (s)=>document.querySelector(s);
const fmt = (n)=>Number(n||0).toLocaleString("pt-BR");


function tryAutoJoin(){
  if(!roomCode) return;

  const auto = $("#autoJoinCheck")?.checked;
  if(!auto) return;

  const name = $("#nameInput").value.trim();
  const stack = Math.floor(Number($("#stackInput").value));

  if(!name) return; // não entra sem nome

  socket.emit("player:join", {
    roomCode,
    name,
    stack: Number.isFinite(stack) ? Math.max(0, stack) : 1000
  });
}


function show(el, v){ el.style.display = v ? "" : "none"; }
function setText(el, t){ el.textContent = t; }

function isHost(){ return true; }

function myPlayer(){
  if(!state) return null;
  return state.players.find(p => p.socketId === socket.id) || null;
}

function currentActor(){
  if(!state || !state.round) return null;
  if(state.round.turnIndex < 0) return null;
  return state.players[state.round.turnIndex] || null;
}

function toCallFor(p){
  return Math.max(0, Math.floor((state.round?.currentBet||0) - (p.streetPut||0)));
}

function totalPot(){
  return Math.floor((state?.players||[]).reduce((a,p)=>a+(p.totalPut||0),0));
}

function render(){
  const joinCard = $("#joinCard");
  const tableCard = $("#tableCard");

  show(joinCard, !roomCode);
  show(tableCard, !!roomCode);

  if(!roomCode) return;

  // Header pills
  $("#roomPill").innerHTML = `Sala: <strong>${roomCode}</strong>`;
  $("#potPill").innerHTML = `Pote: <strong>${fmt(totalPot())}</strong>`;

  const actor = currentActor();
  $("#turnPill").innerHTML = `Vez: <strong>${actor ? actor.name : "—"}</strong>`;
  $("#betPill").innerHTML = `Aposta da rodada: <strong>${fmt(state?.round?.currentBet||0)}</strong>`;
  $("#callPill").innerHTML = `Para cobrir: <strong>${actor && actor.socketId === socket.id ? fmt(toCallFor(actor)) : "—"}</strong>`;

  // Players list
  const list = $("#playersList");
  list.innerHTML = "";
  const dealerIdx = state.dealerIndex % Math.max(1, state.players.length);

  state.players.forEach((p, i) => {
    const div = document.createElement("div");
    div.className = "player";

    const tags = [];
        if(i === dealerIdx) tags.push(`<span class="tag dealer">BOTÃO</span>`);
    if(actor && p.id === actor.id && state.round?.phase === "running") tags.push(`<span class="tag turn">VEZ</span>`);
    if(p.folded) tags.push(`<span class="tag fold">DESISTIU</span>`);

    div.innerHTML = `
      <div class="pname">${p.name}</div>
      <div class="pmeta">Stack: <strong>${fmt(p.stack)}</strong> • Rodada: <strong>${fmt(p.streetPut||0)}</strong> • Total: <strong>${fmt(p.totalPut||0)}</strong></div>
      <div class="tags">${tags.join("")}</div>
    `;
    list.appendChild(div);
  });

  // Log
  const log = $("#logList");
  log.innerHTML = "";
  const empty = $("#emptyLog");
  if(!state.log || state.log.length === 0){
    show(empty, true);
  }else{
    show(empty, false);
    [...state.log].slice().reverse().forEach(line=>{
      const el = document.createElement("div");
      el.className = "evt";
      el.textContent = line;
      log.appendChild(el);
    });
  }

  // Host controls
  const hostBox = $("#hostControls");
  show(hostBox, isHost());

  $("#btnStartRound").disabled = !!state.round && state.round.phase !== "ended";
  $("#btnGoPay").disabled = !(state.round && state.round.phase === "running");
  $("#btnNextRound").disabled = !(state.round && state.round.phase === "ended");

  // Player controls (only when running & it's my turn)
  const my = myPlayer();
  const running = !!state.round && state.round.phase === "running";
  const myTurn = running && actor && my && actor.id === my.id;

  show($("#actionsBox"), true);
  $("#myStatus").textContent = my ? `Você: ${my.name} (stack ${fmt(my.stack)})` : "Você ainda não entrou como jogador.";

  $("#btnFold").disabled = !myTurn;
  $("#btnCheck").disabled = !myTurn || (my && toCallFor(my) !== 0);
  $("#btnCall").disabled = !myTurn || (my && toCallFor(my) <= 0);
  $("#btnBet").disabled = !myTurn;
  const minAllIn = serverInfo.allInMinStack ?? ALL_IN_MIN_STACK_FALLBACK;
  const canAllIn = myTurn && my && my.stack >= minAllIn;
  $("#btnAllIn").disabled = !canAllIn;

  $("#allInNote").innerHTML = myTurn
    ? (canAllIn ? `<span class="ok">Tudo-in liberado</span>` : `<span class="bad">Tudo-in só com ${fmt(minAllIn)}+</span>`)
    : "";

  // Pay UI (host only)
  const payBox = $("#payBox");
  show(payBox, isHost() && state.round && state.round.phase === "pay");

  if(state.round && state.round.phase === "pay"){ renderPayUI(); }
}

function renderPayUI(){
  const pot = totalPot();
  $("#payPotValue").textContent = fmt(pot);

  const wrap = $("#payRows");
  wrap.innerHTML = "";

  const elig = (state.players||[]).filter(p => p.inRound && !p.folded);
  elig.forEach(p=>{
    const row = document.createElement("div");
    row.className = "payRow";
    row.innerHTML = `
      <div><strong>${p.name}</strong></div>
      <div><input type="number" min="0" step="1" value="0" data-pay="${p.id}"/></div>
    `;
    wrap.appendChild(row);
  });

  const update = () => {
    const inputs = Array.from(wrap.querySelectorAll("input[data-pay]"));
    let sum = 0;
    for(const inp of inputs){
      const v = Math.floor(Number(inp.value));
      sum += Number.isFinite(v) ? Math.max(0, v) : 0;
    }
    const ok = (sum === pot);
    $("#paySummary").innerHTML = ok
      ? `<span class="ok">OK</span> Somatório: <strong>${fmt(sum)}</strong>`
      : `<span class="bad">A soma deve ser exatamente</span> <strong>${fmt(pot)}</strong> (agora: ${fmt(sum)})`;
    $("#btnPay").disabled = !ok;
  };

  wrap.querySelectorAll("input[data-pay]").forEach(inp=>inp.addEventListener("input", update));
  update();
}

// ---- Events ----
socket.on("hello", (info) => {
  serverInfo = info || serverInfo;
});

socket.on("room:created", ({ roomCode: c }) => {
  roomCode = c;
  $("#roomCodeInput").value = roomCode;
  showError("");
  tryAutoJoin();
});


socket.on("room:joined", ({ roomCode: c }) => {
  roomCode = c;
  $("#roomCodeInput").value = roomCode;
  showError("");
  tryAutoJoin();
});


socket.on("state", (s) => {
  state = s;
  render();
});

socket.on("errorMsg", (msg) => showError(msg));

function showError(msg){
  const box = $("#errorBox");
  if(!msg){
    show(box, false);
    box.textContent = "";
    return;
  }
  show(box, true);
  box.textContent = msg;
}

// ---- UI Actions ----
$("#btnCreate").addEventListener("click", () => {
  socket.emit("room:create");
});

$("#btnJoin").addEventListener("click", () => {
  const c = $("#roomCodeInput").value.trim().toUpperCase();
  if(!c) return showError("Digite o código da sala.");
  socket.emit("room:join", { roomCode: c });
});

$("#btnEnter").addEventListener("click", () => {
  if(!roomCode) return showError("Entre em uma sala primeiro.");
  const name = $("#nameInput").value.trim();
  const stack = Math.floor(Number($("#stackInput").value));
  if(!name) return showError("Digite seu nome.");
  me = { name, stack: Number.isFinite(stack) ? Math.max(0, stack) : 1000 };
  socket.emit("player:join", { roomCode, name: me.name, stack: me.stack });
  showError("");
});

// Host
$("#btnStartRound").addEventListener("click", () => socket.emit("host:startRound", { roomCode }));
$("#btnGoPay").addEventListener("click", () => socket.emit("host:goToPay", { roomCode }));
$("#btnNextRound").addEventListener("click", () => socket.emit("host:nextRound", { roomCode }));

$("#btnPay").addEventListener("click", () => {
  const rows = $("#payRows");
  const inputs = Array.from(rows.querySelectorAll("input[data-pay]"));
  const payments = inputs.map(inp => ({
    playerId: inp.getAttribute("data-pay"),
    amount: Math.floor(Number(inp.value)) || 0
  })).filter(x => x.amount > 0);

  socket.emit("host:pay", { roomCode, payments });
});

// Player actions
$("#btnFold").addEventListener("click", () => socket.emit("action:fold", { roomCode }));
$("#btnCheck").addEventListener("click", () => socket.emit("action:check", { roomCode }));
$("#btnCall").addEventListener("click", () => socket.emit("action:call", { roomCode }));
$("#btnBet").addEventListener("click", () => {
  const v = Math.floor(Number($("#betToInput").value));
  if(!Number.isFinite(v) || v <= 0) return;
  socket.emit("action:bet", { roomCode, betTo: v });
  $("#betToInput").value = "";
});
$("#btnAllIn").addEventListener("click", () => socket.emit("action:allin", { roomCode }));

render();
