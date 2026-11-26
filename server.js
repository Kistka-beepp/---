const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const TURN_TIME_LIMIT = 15; // Час на хід у секундах

let board = Array(9).fill(null);
let players = { X: null, O: null }; // { id, name, streak }
let queue = []; // [{ id, name }]
let currentTurn = 'X';
let gameActive = false;
let timeLeft = TURN_TIME_LIMIT;
let turnTimer = null;

// Таблиця рекордів: { "Нікнейм": { wins: 0, bestStreak: 0 } }
let leaderboard = {};

const WIN_COMBOS = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

function updateStats(winnerName, currentStreak) {
  if (!leaderboard[winnerName]) {
    leaderboard[winnerName] = { wins: 0, bestStreak: 0 };
  }
  leaderboard[winnerName].wins += 1;
  if (currentStreak > leaderboard[winnerName].bestStreak) {
    leaderboard[winnerName].bestStreak = currentStreak;
  }
}

function getSortedLeaderboard() {
  return Object.entries(leaderboard)
    .map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => b.bestStreak - a.bestStreak || b.wins - a.wins)
    .slice(0, 10);
}

function stopTimer() {
  if (turnTimer) {
    clearInterval(turnTimer);
    turnTimer = null;
  }
}

function startTimer() {
  stopTimer();
  if (!gameActive) return;

  timeLeft = TURN_TIME_LIMIT;
  io.emit('timer', timeLeft);

  turnTimer = setInterval(() => {
    timeLeft--;
    io.emit('timer', timeLeft);

    if (timeLeft <= 0) {
      stopTimer();
      const loserSymbol = currentTurn;
      const winnerSymbol = loserSymbol === 'X' ? 'O' : 'X';
      const loserName = players[loserSymbol]?.name || 'Гравець';
      
      handleRoundEnd(winnerSymbol, `Час вийшов! ${loserName} програв за таймером.`);
    }
  }, 1000);
}

function assignPlayers() {
  if (!players.X && queue.length > 0) {
    const next = queue.shift();
    players.X = { ...next, streak: 0 };
  }
  if (!players.O && queue.length > 0) {
    const next = queue.shift();
    players.O = { ...next, streak: 0 };
  }

  if (players.X && players.O) {
    if (!gameActive) {
      board = Array(9).fill(null);
      currentTurn = 'X';
      gameActive = true;
      startTimer();
    }
  } else {
    gameActive = false;
    board = Array(9).fill(null);
    stopTimer();
  }
}

function broadcastState(message = '') {
  io.emit('state', {
    board,
    players,
    queue,
    currentTurn,
    gameActive,
    timeLeft,
    leaderboard: getSortedLeaderboard(),
    message
  });
}

function handleRoundEnd(winnerSymbol, customMessage) {
  gameActive = false;
  stopTimer();

  const loserSymbol = winnerSymbol === 'X' ? 'O' : 'X';
  const winner = players[winnerSymbol];
  const loser = players[loserSymbol];

  if (winner) {
    winner.streak += 1;
    updateStats(winner.name, winner.streak);
  }

  broadcastState(customMessage);

  setTimeout(() => {
    if (loser) {
      queue.push({ id: loser.id, name: loser.name });
      players[loserSymbol] = null;
    }
    assignPlayers();
    broadcastState(gameActive ? 'Новий раунд розпочато!' : 'Очікування суперника...');
  }, 2500);
}

function checkWinner() {
  for (let combo of WIN_COMBOS) {
    const [a, b, c] = combo;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  return board.includes(null) ? null : 'DRAW';
}

io.on('connection', (socket) => {
  // Надсилаємо актуальний стан одразу при підключенні (щоб бачити таблицю рекордів)
  socket.emit('state', {
    board, players, queue, currentTurn, gameActive, timeLeft,
    leaderboard: getSortedLeaderboard(),
    message: ''
  });

    socket.on('join', (rawName) => {
    const cleanName = (rawName || '').trim().slice(0, 15);
    
    if (!cleanName) {
      socket.emit('join_error', 'Введіть коректний нікнейм!');
      return;
    }

    // Перевірка, чи це вікно вже у грі або в черзі
    const alreadyIn = players.X?.id === socket.id || players.O?.id === socket.id || queue.some(p => p.id === socket.id);
    if (alreadyIn) return;

    // Збираємо всі зайняті зараз імена (у нижньому регістрі)
    const activeNames = [
      players.X?.name,
      players.O?.name,
      ...queue.map(p => p.name)
    ].filter(Boolean).map(name => name.toLowerCase());

    // Якщо таке ім'я вже є онлайн — відхиляємо вхід
    if (activeNames.includes(cleanName.toLowerCase())) {
      socket.emit('join_error', `Нікнейм "${cleanName}" вже зайнятий! Оберіть інший.`);
      return;
    }

    if (!leaderboard[cleanName]) {
      leaderboard[cleanName] = { wins: 0, bestStreak: 0 };
    }

    queue.push({ id: socket.id, name: cleanName });
    socket.emit('join_success'); // Підтверджуємо успішний вхід
    assignPlayers();
    broadcastState(`${cleanName} приєднався до гри!`);
  });


  socket.on('move', (index) => {
    if (!gameActive || board[index] !== null) return;
    if (players[currentTurn]?.id !== socket.id) return;

    board[index] = currentTurn;
    const result = checkWinner();

    if (result === 'X' || result === 'O') {
      const winnerName = players[result].name;
      handleRoundEnd(result, `Переміг ${winnerName} (${result})!`);
    } else if (result === 'DRAW') {
      gameActive = false;
      stopTimer();
      broadcastState('Нічия! Обидва гравці залишаються за столом.');

      setTimeout(() => {
        if (players.X && players.O) {
          board = Array(9).fill(null);
          currentTurn = currentTurn === 'X' ? 'O' : 'X';
          gameActive = true;
          startTimer();
          broadcastState('Новий раунд після нічиєї!');
        }
      }, 2500);
    } else {
      currentTurn = currentTurn === 'X' ? 'O' : 'X';
      startTimer();
      broadcastState('');
    }
  });

  socket.on('disconnect', () => {
    let leftName = null;

    if (players.X?.id === socket.id) {
      leftName = players.X.name;
      players.X = null;
      gameActive = false;
      stopTimer();
    } else if (players.O?.id === socket.id) {
      leftName = players.O.name;
      players.O = null;
      gameActive = false;
      stopTimer();
    } else {
      const idx = queue.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        leftName = queue[idx].name;
        queue.splice(idx, 1);
      }
    }

    if (leftName) {
      assignPlayers();
      broadcastState(`${leftName} вийшов із гри.`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущено на порту ${PORT}`);
});

