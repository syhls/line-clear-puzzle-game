"use strict";

const COLS = 8;
const ROWS = 6;
const MAX_BLOCK_WIDTH = 4;
const SKIN_COUNT = 5;
const SCORE_PER_LINE = 8;
// 四种方块的出现权重：数值越大，出现得越频繁；不需要相加为 100。
const WIDTH_1_WEIGHT = 35;
const WIDTH_2_WEIGHT = 35;
const WIDTH_3_WEIGHT = 20;
const WIDTH_4_WEIGHT = 20;
const WIDTH_WEIGHTS = {
  1: WIDTH_1_WEIGHT,
  2: WIDTH_2_WEIGHT,
  3: WIDTH_3_WEIGHT,
  4: WIDTH_4_WEIGHT,
};
const FALL_STEP_DELAY = 150;
const CLEAR_DELAY = 230;
const RISE_PAUSE = 360;
const RISE_ANIMATION_DELAY = 250;

// 皮肤接口：填入图片的相对路径或网址即可覆盖对应颜色皮肤；保留 null 则使用默认颜色。
// 例如："assets/skin-1.png"。五个槽位会被新生成的方块随机选用。
const SKIN_SOURCES = [null, null, null, null, null];

const ui = {
  board: document.querySelector("#board"),
  score: document.querySelector("#score"),
  moves: document.querySelector("#moves"),
  status: document.querySelector("#status"),
  gameOver: document.querySelector("#game-over"),
  finalScore: document.querySelector("#final-score"),
  dragGuides: document.querySelector("#drag-guides"),
  dropGuide: document.querySelector("#drop-guide"),
};

let blocks = [];
let nextId = 1;
let score = 0;
let moves = 0;
let selectedId = null;
let dragState = null;
let finished = false;
let isResolving = false;
let resolutionToken = 0;
let clearingRows = new Set();

const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function pickWeightedOption(options) {
  const totalWeight = options.reduce(
    (sum, option) => sum + WIDTH_WEIGHTS[option.width],
    0,
  );
  let point = Math.random() * totalWeight;

  for (const option of options) {
    point -= WIDTH_WEIGHTS[option.width];
    if (point < 0) return option;
  }

  return options[options.length - 1];
}

function createBlock(x, y, w) {
  return { id: nextId++, x, y, w, skin: randomInt(0, SKIN_COUNT - 1) };
}

const selectedBlock = () => blocks.find((block) => block.id === selectedId) ?? null;

function occupiedBy(blockSet, block, x, y) {
  return blockSet.some((other) => {
    if (other.id === block.id || other.y !== y) return false;
    return x < other.x + other.w && x + block.w > other.x;
  });
}

function canMove(block, direction) {
  const nextX = block.x + direction;
  return nextX >= 0 && nextX + block.w <= COLS && !occupiedBy(blocks, block, nextX, block.y);
}

function canFall(block, blockSet = blocks) {
  return block.y < ROWS - 1 && !occupiedBy(blockSet, block, block.x, block.y + 1);
}

function dropOneStep(blockSet) {
  let didFall = false;
  [...blockSet].sort((a, b) => b.y - a.y || a.x - b.x).forEach((block) => {
    if (canFall(block, blockSet)) {
      block.y += 1;
      didFall = true;
    }
  });
  return didFall;
}

function projectedDropY(block) {
  let y = block.y;
  while (y < ROWS - 1 && !occupiedBy(blocks, block, block.x, y + 1)) y += 1;
  return y;
}

const pause = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

async function fallUntilStable(token) {
  while (true) {
    if (token !== resolutionToken) return false;
    if (!dropOneStep(blocks)) return true;
    render();
    await pause(FALL_STEP_DELAY);
  }
}

function fullRows(blockSet = blocks) {
  const rows = [];
  for (let y = 0; y < ROWS; y += 1) {
    const occupied = Array(COLS).fill(false);
    blockSet.filter((block) => block.y === y).forEach((block) => {
      for (let x = block.x; x < block.x + block.w; x += 1) occupied[x] = true;
    });
    if (occupied.every(Boolean)) rows.push(y);
  }
  return rows;
}

function wouldClearAfterFalling(candidate) {
  const simulated = candidate.map((block) => ({ ...block }));
  while (dropOneStep(simulated)) {}
  return fullRows(simulated).length > 0;
}

// 按规则：先重力，后消行；消行后重新检查重力，直到没有连锁。
async function resolveChains(token) {
  let cleared = 0;
  while (true) {
    if (!(await fallUntilStable(token))) return null;
    const rows = fullRows();
    if (rows.length === 0) break;
    clearingRows = new Set(rows);
    ui.status.textContent = `消除第 ${rows.map((row) => row + 1).join("、")} 行…`;
    render();
    await pause(CLEAR_DELAY);
    if (token !== resolutionToken) return null;
    blocks = blocks.filter((block) => !rows.includes(block.y));
    clearingRows = new Set();
    cleared += rows.length;
    score += rows.length * SCORE_PER_LINE;
    render();
    await pause(100);
  }
  return cleared;
}

function availableStarts(width, row) {
  const starts = [];
  for (let x = 0; x <= COLS - width; x += 1) {
    const probe = { id: -1, x, y: row, w: width };
    if (!occupiedBy(blocks, probe, x, row)) starts.push(x);
  }
  return starts;
}

// 每一条新行严格占 4–7 格，且不可能生成时就填满 8 格。
function spawnIncomingRow(row = ROWS - 1) {
  let remainingCells = randomInt(4, 7);
  while (remainingCells > 0) {
    const options = [];
    for (let width = 1; width <= Math.min(MAX_BLOCK_WIDTH, remainingCells); width += 1) {
      const starts = availableStarts(width, row);
      if (starts.length > 0) options.push({ width, starts });
    }
    // 至少有足够的空格放下剩余格数；这里始终能得到宽 1 的方案。
    const option = pickWeightedOption(options);
    const width = option.width;
    blocks.push(createBlock(option.starts[randomInt(0, option.starts.length - 1)], row, width));
    remainingCells -= width;
  }
}

// 开局重抽至“下落后没有满行”的布局，避免玩家未操作就得到分数或消行。
function spawnSafeInitialRows(topRow) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    blocks = [];
    nextId = 1;
    spawnIncomingRow(topRow);
    spawnIncomingRow(topRow + 1);
    if (!wouldClearAfterFalling(blocks)) return;
  }

  // 极少数连续重抽失败时，使用一组固定且安全的 4 格 / 5 格布局。
  blocks = [
    { id: 1, x: 0, y: topRow, w: 2, skin: 0 },
    { id: 2, x: 4, y: topRow, w: 2, skin: 1 },
    { id: 3, x: 1, y: topRow + 1, w: 3, skin: 2 },
    { id: 4, x: 5, y: topRow + 1, w: 2, skin: 3 },
  ];
  nextId = 5;
}

async function pushNewRow(token) {
  // 若顶部已有方块，旧方块无法再上移，无法推入新底行。
  if (blocks.some((block) => block.y === 0)) {
    endGame();
    return false;
  }
  ui.status.textContent = "即将整体上移…";
  await pause(RISE_PAUSE);
  if (token !== resolutionToken) return false;
  blocks.forEach((block) => { block.y -= 1; });
  render();
  await pause(RISE_ANIMATION_DELAY);
  if (token !== resolutionToken) return false;
  spawnIncomingRow();
  render();
  return true;
}

function render() {
  const existing = new Map([...ui.board.querySelectorAll(".block")].map((node) => [Number(node.dataset.id), node]));
  blocks.forEach((block) => {
    let node = existing.get(block.id);
    if (!node) {
      node = document.createElement("button");
      node.type = "button";
      node.dataset.id = String(block.id);
      node.addEventListener("pointerdown", (event) => beginDrag(event, Number(node.dataset.id)));
      ui.board.append(node);
    }
    existing.delete(block.id);
    const skinSource = SKIN_SOURCES[block.skin];
    node.className = `block cat-${block.skin}${block.id === selectedId ? " selected" : ""}${clearingRows.has(block.y) ? " clearing" : ""}`;
    node.style.setProperty("--x", block.x);
    node.style.setProperty("--y", block.y);
    node.style.setProperty("--w", block.w);
    node.style.backgroundImage = skinSource ? `url("${skinSource}")` : "";
    node.setAttribute("aria-label", `宽${block.w}格的方块，第${block.y + 1}行第${block.x + 1}列`);
  });
  existing.forEach((node) => node.remove());
  ui.score.textContent = String(score);
  ui.moves.textContent = String(moves);
  updateDragGuides();
}

function updateDragGuides() {
  const block = selectedBlock();
  const shouldShow = block !== null && dragState !== null && !finished && !isResolving;
  ui.dragGuides.hidden = !shouldShow;
  if (!shouldShow) return;

  const dropY = projectedDropY(block);
  ui.dropGuide.style.setProperty("--guide-x", block.x);
  ui.dropGuide.style.setProperty("--guide-y", dropY);
  ui.dropGuide.style.setProperty("--guide-w", block.w);
  ui.dropGuide.hidden = dropY === block.y;
}

function beginDrag(event, id) {
  if (finished || isResolving || event.button !== 0) return;
  event.preventDefault();
  selectedId = id;
  dragState = { pointerId: event.pointerId, startClientX: event.clientX, originX: selectedBlock().x };
  ui.board.setPointerCapture(event.pointerId);
  ui.status.textContent = "正在拖动：半透明框为松手后的下落位置。";
  render();
}

function moveTowards(block, wantedX) {
  const direction = Math.sign(wantedX - block.x);
  while (direction !== 0 && block.x !== wantedX && canMove(block, direction)) {
    block.x += direction;
  }
}

async function finishDrag(cancelled) {
  if (!dragState) return;
  const activeDrag = dragState;
  const block = selectedBlock();
  dragState = null;
  if (!block) return;

  if (cancelled) block.x = activeDrag.originX;
  if (block.x === activeDrag.originX) {
    selectedId = null;
    ui.status.textContent = cancelled ? "拖动已取消，本次不计入操作。" : "拖回原位，本次不计入操作。";
    render();
    return;
  }

  selectedId = null;
  moves += 1;
  isResolving = true;
  render();
  const token = resolutionToken;
  const clearedBeforePush = await resolveChains(token);
  if (clearedBeforePush === null || token !== resolutionToken) return;
  if (!(await pushNewRow(token)) || token !== resolutionToken) return;
  // 新行推入后也必须重新检查重力与消除；例如右侧上层方块下方为空时，应立即落到底部。
  const clearedAfterPush = await resolveChains(token);
  if (clearedAfterPush === null || token !== resolutionToken) return;
  isResolving = false;
  const clearedTotal = clearedBeforePush + clearedAfterPush;
  ui.status.textContent = clearedTotal > 0 ? `消除了 ${clearedTotal} 行，已完成推行结算。` : "已完成推行结算。";
  render();
}

ui.board.addEventListener("pointermove", (event) => {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const block = selectedBlock();
  if (!block) return;
  const cellWidth = ui.board.getBoundingClientRect().width / COLS;
  const wantedX = Math.max(0, Math.min(COLS - block.w, Math.round(dragState.originX + (event.clientX - dragState.startClientX) / cellWidth)));
  const oldX = block.x;
  moveTowards(block, wantedX);
  if (block.x !== oldX) render();
});

ui.board.addEventListener("pointerup", (event) => {
  if (dragState && event.pointerId === dragState.pointerId) void finishDrag(false);
});

ui.board.addEventListener("pointercancel", (event) => {
  if (dragState && event.pointerId === dragState.pointerId) void finishDrag(true);
});

function endGame() {
  finished = true;
  selectedId = null;
  dragState = null;
  isResolving = false;
  ui.finalScore.textContent = `${score} 分`;
  ui.gameOver.hidden = false;
  ui.status.textContent = "顶部没有空间，无法再推入底行。";
  render();
}

async function newGame() {
  resolutionToken += 1;
  const token = resolutionToken;
  blocks = [];
  nextId = 1;
  score = 0;
  moves = 0;
  selectedId = null;
  dragState = null;
  finished = false;
  isResolving = true;
  clearingRows = new Set();
  ui.gameOver.hidden = true;
  // 开局先清空棋盘，再让相连的两行初始方块从中部同时出现并自然下落。
  ui.status.textContent = "棋盘已清空，初始方块即将出现…";
  render();
  await pause(300);
  if (token !== resolutionToken) return;
  const middleTopRow = Math.floor(ROWS / 2) - 1;
  spawnSafeInitialRows(middleTopRow);
  ui.status.textContent = "两行初始方块正在从中部一起落下…";
  render();
  if ((await resolveChains(token)) === null || token !== resolutionToken) return;
  isResolving = false;
  ui.status.textContent = "初始两行已完成下落检查。按住任意方块，向左或向右拖动；松手后自动结算。";
  render();
}

document.querySelector("#restart-button").addEventListener("click", () => void newGame());
document.querySelector("#again-button").addEventListener("click", () => void newGame());
document.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "r") void newGame();
});

void newGame();
