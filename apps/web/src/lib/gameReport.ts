import type { GameReport, GameReportDeckSource } from '@mtg/shared';
import { turnPositionLabel } from './turnLabels';

function deckSource(source: GameReportDeckSource): string {
  switch (source.kind) {
    case 'pool':
      return `generated (seed ${source.seed})`;
    case 'snapshot':
      return `saved snapshot ${source.snapshotId}`;
    case 'url':
      return source.url === null
        ? 'imported URL (hidden until game over)'
        : `imported ${source.url}`;
    case 'plaintext':
      return 'pasted list';
    case 'cardTestScenario':
      return 'Card Test Lab scenario';
  }
}

function build(report: GameReport): string {
  const { commit, branch, dirty } = report.build;
  if (commit === null) return 'unknown';
  return `${branch ?? '(detached)'} @ ${commit}${dirty === true ? ' (uncommitted changes)' : ''}`;
}

/**
 * The clipboard text for "Copy game report": a readable summary a person can scan in an issue,
 * followed by the full report as JSON so nothing is lost to the formatting.
 */
export function formatGameReport(report: GameReport): string {
  const { game, status, position } = report;
  const statusText = status.halt
    ? `halted (${status.halt.kind}) on turn ${status.halt.turn}`
    : status.over
      ? `over${status.winnerSeat === null ? '' : ` — winner ${status.winnerSeat}`} (${status.runner})`
      : status.runner;
  const lines = [
    '## MTG Tester game report',
    '',
    `- Build: ${build(report)}`,
    `- Game: ${game.id} · seed \`${game.seed}\`${game.cardTestScenarioId === null ? '' : ` · lab scenario ${game.cardTestScenarioId}`}`,
    `- Mode: ${game.gameMode}, you are ${game.humanSeat ?? 'spectating'} · bots: ${game.providerKind} · pace ${game.paceMs} ms (${game.playbackMode})`,
    `- Started: ${game.startedAt ?? 'unknown'} · report: ${report.generatedAt}`,
    `- Status: ${statusText}`,
    `- Position: Turn ${position.turn} · ${turnPositionLabel(position.phase, position.step)} · active ${position.activePlayer} · priority ${position.priorityPlayer ?? 'none'}`,
    '',
    '### Seats',
  ];
  for (const seat of report.seats) {
    lines.push(
      `- ${seat.seat} (${seat.controller}): ${seat.commanderNames.join(' + ') || seat.label} — ${seat.life} life` +
        `${seat.poisonCounters > 0 ? `, ${seat.poisonCounters} poison` : ''}` +
        `${seat.hasLost ? `, lost (${seat.lossReason ?? 'unknown'})` : ''}` +
        ` · deck: ${deckSource(seat.source)}${seat.deckSnapshotId === null ? '' : ` · snapshot ${seat.deckSnapshotId}`}`,
    );
  }
  lines.push('', '### Pending choice');
  if (report.pendingChoice === null) lines.push('None.');
  else {
    lines.push(`${report.pendingChoice.prompt} (${report.pendingChoice.decisionType})`);
    for (const option of report.pendingChoice.options) lines.push(`- ${option}`);
  }
  lines.push('', '### Last submitted action');
  const last = report.lastSubmittedAction;
  lines.push(
    last === null
      ? 'None.'
      : `Turn ${last.turn}: ${last.description}${last.targets.length > 0 ? ` → ${last.targets.join(', ')}` : ''} (${last.decisionType})`,
  );
  lines.push('', `### Recent log (last ${report.recentLog.length} lines)`, '```');
  lines.push(...report.recentLog);
  lines.push('```');
  for (const seat of report.seats) {
    if (seat.decklist === null) continue;
    lines.push('', `### ${seat.seat} decklist (engine order)`, '```', ...seat.decklist, '```');
  }
  lines.push('', '<details><summary>Full report (JSON)</summary>', '', '```json');
  lines.push(JSON.stringify(report, null, 2));
  lines.push('```', '', '</details>', '');
  return lines.join('\n');
}
