/** 离线新旧算法赛跑：交换座次、相同随机种子，输出真实胜率，不预设胜负。 */
import { createGame, applyAction, score } from '../dist/js/engine.js';
import { chooseAIAction } from '../dist/js/ai.js';
import { chooseAIActionV1 } from '../benchmarks/ai-v1-legacy.mjs';

const seeds = Number(process.argv[2] ?? 4);
if (!Number.isSafeInteger(seeds) || seeds < 1 || seeds > 200)
  throw Error('参数为 1～200 个种子，例如：node scripts/benchmark-ai.mjs 8');
const summary = { seeds, games: 0, v2Wins: 0, v1Wins: 0, ties: 0, totalScoreDiff: 0, totalMoves: 0 };
for (let seed = 1; seed <= seeds; seed++) {
  for (let v2Seat = 0; v2Seat <= 1; v2Seat++) {
    const names = v2Seat === 0 ? ['V2.0', 'V1.2'] : ['V1.2', 'V2.0'];
    let game = createGame(names, seed, [1]);
    game.players[0].isAI = true; // 自动对战专用；正式游戏仍要求人类席位
    let moves = 0;
    while (game.phase !== 'finished' && moves < 800) {
      const agent = game.current === v2Seat ? chooseAIAction : chooseAIActionV1;
      const response = agent(game);
      game = applyAction(game, response.action);
      moves++;
    }
    if (game.phase !== 'finished') throw Error(`对战未结束：种子${seed}，V2座次${v2Seat}`);
    const diff = score(game.players[v2Seat]) - score(game.players[1 - v2Seat]);
    summary.games++;
    summary.totalScoreDiff += diff;
    summary.totalMoves += moves;
    if (diff > 0) summary.v2Wins++;
    else if (diff < 0) summary.v1Wins++;
    else {
      // 按官方规则：平分时最后行动者获胜。
      if (v2Seat === 1) summary.v2Wins++;
      else summary.v1Wins++;
      summary.ties++;
    }
  }
}
const result = {
  seeds, games: summary.games, v2Wins: summary.v2Wins, v1Wins: summary.v1Wins,
  equalScoreGames: summary.ties,
  v2WinRate: Number((100 * summary.v2Wins / summary.games).toFixed(1)) + '%',
  meanScoreDifferenceV2MinusV1: Number((summary.totalScoreDiff / summary.games).toFixed(2)),
  meanMovesPerGame: Number((summary.totalMoves / summary.games).toFixed(1)),
};
console.log(JSON.stringify(result, null, 2));
