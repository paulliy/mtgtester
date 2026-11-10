/**
 * A position in words, for a judge. Everything here is drawn from the tested seat's `PlayerView`
 * and its `DecisionRequest`: the page shows exactly what the model was allowed to know, laid out
 * for a reader instead of minified for a prompt.
 */
import type {
  DecisionRequest,
  LegalAction,
  PermanentView,
  PlayerView,
} from '../../packages/shared/src';

const BASICS = new Set(['Forest', 'Plains', 'Island', 'Swamp', 'Mountain']);

/** Table-cell safe: no pipes or newlines. */
export function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' / ');
}

function permanentLabel(permanent: PermanentView): string {
  const stats =
    permanent.power !== undefined && permanent.power !== null
      ? ` ${permanent.power}/${permanent.toughness ?? '?'}`
      : '';
  const marks = [
    ...(permanent.tapped ? ['tapped'] : []),
    ...permanent.status.filter((status) => status !== 'faceDown'),
  ];
  const keywords =
    permanent.keywords !== undefined && permanent.keywords.length > 0
      ? ` [${permanent.keywords.join(', ')}]`
      : '';
  return `${permanent.name}${stats}${keywords}${marks.length > 0 ? ` (${marks.join(', ')})` : ''}`;
}

function grouped(labels: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts].map(([label, count]) => (count > 1 ? `${label} ×${count}` : label)).join(', ');
}

function nameFor(names: Readonly<Record<string, string>>, id: string): string {
  if (id === '__no_attack__') return 'stay home';
  if (id === '__no_block__') return 'no block';
  if (id === '__attacks__') return 'attack';
  return names[id] ?? id;
}

function actionLine(action: LegalAction, names: Readonly<Record<string, string>>): string {
  const slots = action.targets ?? [];
  if (slots.length === 0) return `\`${action.id}\` ${action.description}`;
  const subjects = Array.isArray(action.data?.['subjects'])
    ? (action.data['subjects'] as Array<{ subjectId?: string }>)
    : [];
  const lines = slots.map((slot, index) => {
    const subject = subjects[index]?.subjectId;
    const who = subject === undefined ? `target ${slot.slot + 1}` : nameFor(names, subject);
    return `    - ${who}: ${slot.options.map((option) => nameFor(names, option)).join(' · ')}`;
  });
  return `\`${action.id}\` ${action.description}\n${lines.join('\n')}`;
}

/** The decision under test and the board behind it, as the tested seat sees them. */
export function renderPosition(
  request: DecisionRequest,
  view: PlayerView,
  names: Readonly<Record<string, string>>,
): string {
  const out: string[] = [];
  const where = request.step === null ? request.phase : `${request.phase}, ${request.step}`;
  out.push(
    `Turn ${request.turn}. Active player: ${request.activePlayer}. Phase: ${where}. The tested seat is **${view.seat}**.`,
    '',
    '| Seat | Life | Cards in hand | Graveyard |',
    '| --- | ---: | ---: | --- |',
    `| ${view.seat} (tested) | ${view.life} | ${view.hand.length} | ${cell(grouped(view.graveyard.map((card) => card.name))) || '-'} |`,
    ...view.opponents.map(
      (opponent) =>
        `| ${opponent.seat} | ${opponent.life} | ${opponent.handSize} | ${cell(grouped(opponent.graveyard.map((card) => card.name))) || '-'} |`,
    ),
    '',
    '**Battlefield**',
    '',
  );
  for (const seat of [view.seat, ...view.opponents.map((opponent) => opponent.seat)]) {
    const mine = view.battlefield.filter((permanent) => permanent.controller === seat);
    const isLand = (permanent: PermanentView): boolean =>
      permanent.typeLine?.includes('Land') === true;
    const lands = grouped(mine.filter(isLand).map(permanentLabel));
    const others = grouped(mine.filter((permanent) => !isLand(permanent)).map(permanentLabel));
    out.push(
      `- **${seat}**${seat === view.seat ? ' (tested)' : ''}: ${others || 'no nonland permanents'}${lands ? `. Lands: ${lands}` : ''}`,
    );
  }
  out.push('');
  if (view.hand.length > 0) {
    out.push(`**${view.seat}'s hand**`, '');
    for (const card of view.hand)
      out.push(
        `- ${card.name}${card.manaCost ? ` ${card.manaCost}` : ''}${card.typeLine ? ` (${card.typeLine})` : ''}${
          card.oracleText && !BASICS.has(card.name) ? `: ${cell(card.oracleText)}` : ''
        }`,
      );
    out.push('');
  }
  const mana = Object.entries(view.availableMana)
    .filter(([, amount]) => amount > 0)
    .map(([symbol, amount]) => `${amount} ${symbol}`)
    .join(', ');
  out.push(`**Mana ${view.seat} can produce now:** ${mana || 'none'}`, '');
  if (view.stack.length > 0) {
    out.push('**Stack** (last listed resolves first)', '');
    for (const item of view.stack)
      out.push(
        `- ${item.description} (controlled by ${item.controller})${
          item.targets.length > 0
            ? `, targeting ${item.targets.map((id) => nameFor(names, id)).join(', ')}`
            : ''
        }`,
      );
    out.push('');
  }
  const texts = new Map<string, string>();
  for (const permanent of view.battlefield)
    if (permanent.oracleText && !BASICS.has(permanent.name))
      texts.set(permanent.name, permanent.oracleText);
  if (texts.size > 0) {
    out.push('**Card text on the battlefield**', '');
    for (const [name, text] of [...texts].sort(([a], [b]) => a.localeCompare(b)))
      out.push(`- ${name}: ${cell(text)}`);
    out.push('');
  }
  // Combat detail (who attacks whom, who blocks what) reaches the model through this log.
  const log = view.recentLog.filter((line) => !/ (gameStart|startingPlayer) /.test(line));
  if (log.length > 0) {
    out.push(
      '**Recent log, as the model received it**',
      '',
      ...log.map((line) => `- ${cell(line)}`),
      '',
    );
  }
  out.push(
    `**The decision** (\`${request.decisionType}\`): ${request.prompt}`,
    '',
    'Legal actions, exactly as offered (the model answers with one `actionId`, plus a choice per listed slot):',
    '',
    ...request.legalActions.map((action) => `- ${actionLine(action, names)}`),
    '',
  );
  if (request.combatDamageSplit !== undefined)
    out.push(
      `The model must also divide ${request.combatDamageSplit.amount} damage among: ${request.combatDamageSplit.targets
        .map((id) => nameFor(names, id))
        .join(', ')}.`,
      '',
    );
  return out.join('\n');
}

/** Consecutive repeats folded: `Pass priority ×3`. */
export function foldRepeats(actions: readonly string[]): string[] {
  const folded: Array<{ text: string; count: number }> = [];
  for (const text of actions) {
    const last = folded.at(-1);
    if (last !== undefined && last.text === text) last.count += 1;
    else folded.push({ text, count: 1 });
  }
  return folded.map((entry) => (entry.count > 1 ? `${entry.text} ×${entry.count}` : entry.text));
}

/** The actions that change something: priority passes and yields carry no choice worth comparing. */
export function meaningfulActions(actions: readonly string[]): string[] {
  return actions.filter((action) => !/^Pass (priority|and yield)/.test(action));
}
