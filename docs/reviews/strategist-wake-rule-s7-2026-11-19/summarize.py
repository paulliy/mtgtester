"""Summarize the hill-climb S7 paid duels: python3 -I summarize.py <this directory>.

In each report `bot` is the table-v2 side and `model` the table-v1 side (`--opponents bot-v1`).
"""
import json, glob, os, re, sys, math
from collections import Counter, defaultdict
S = sys.argv[1]
rows = []
for f in sorted(glob.glob(f'{S}/reports/*.json')):
    r = json.load(open(f))
    n = int(re.search(r'(\d+)$', r['seed']).group(1))
    r['_set'] = 'duels' if 'duel' in r['seed'] else ('batch' if n <= 10 else 'batch2')
    rows.append(r)
side = {'bot': 'v2', 'model': 'v1'}
def binom_two_sided(k, n):
    lo = min(k, n - k)
    p = sum(math.comb(n, i) for i in range(lo + 1)) / 2**n
    return min(1.0, 2 * p)
print('games', len(rows), Counter(r['_set'] for r in rows))
# wins
dec = [r for r in rows if r['winnerMode']]
w = Counter(side[r['winnerMode']] for r in dec)
print('decided', len(dec), dict(w), 'sign-test p', round(binom_two_sided(w['v2'], len(dec)), 3))
for d in ['duels', 'batch', 'batch2']:
    dd = [r for r in dec if r['_set'] == d]
    print('  ', d, dict(Counter(side[r['winnerMode']] for r in dd)), 'of', len([r for r in rows if r['_set']==d]))
# halts
def halted(r):
    if 'halted' in r: return r['halted']
    return r['winner'] is None
hr = Counter()
for r in rows:
    if halted(r):
        reason = r.get('haltReason') or 'unknown (old report)'
        reason = 'mana payment gap' if 'mana payment' in reason else ('turn cap' if 'turn cap' in reason else reason)
        hr[reason] += 1
print('halts', sum(hr.values()), dict(hr))
# paired by seed
pairs = defaultdict(dict)
for r in rows: pairs[r['seed']][r['swap']] = side[r['winnerMode']] if r['winnerMode'] else None
sweep = Counter(); split = 0; partial = Counter()
for s, p in pairs.items():
    a, b = p.get(False), p.get(True)
    if a and b:
        if a == b: sweep[a] += 1
        else: split += 1
    elif a or b: partial[a or b] += 1
print('seeds', len(pairs), 'both decided: sweeps', dict(sweep), 'splits', split, '| one decided', dict(partial),
      'sweep sign p', round(binom_two_sided(sweep['v2'], sweep['v2']+sweep['v1']), 3) if sweep else '-')
# winner by seat position and by v2 placement
print('winner seat', dict(Counter(r['winner'] for r in dec)))
# calls (reports with ownTurns)
new = [r for r in rows if 'ownTurns' in r['perMode']['bot']]
agg = {m: Counter() for m in ['bot', 'model']}
for r in new:
    for m in agg:
        p = r['perMode'][m]
        agg[m]['calls'] += p['strategistCalls']; agg[m]['own'] += p['ownTurns']; agg[m]['tok'] += p['promptTokens']; agg[m]['usd'] += p['costUsd'] or 0
for m in agg:
    a = agg[m]
    print(side[m], 'calls', a['calls'], 'own', a['own'], 'calls/own', round(a['calls']/a['own'], 3), 'tok/own', round(a['tok']/a['own']), 'usd', round(a['usd'], 4))
cv2 = agg['bot']['calls']/agg['bot']['own']; cv1 = agg['model']['calls']/agg['model']['own']
tv2 = agg['bot']['tok']/agg['bot']['own']; tv1 = agg['model']['tok']/agg['model']['own']
print('calls/own change', f"{(cv2/cv1-1)*100:.1f}%", 'tokens/own change', f"{(tv2/tv1-1)*100:.1f}%")
# per-game ratio distribution (games with >=10 own turns each side)
ratios = sorted((r['perMode']['bot']['strategistCalls']/max(1,r['perMode']['bot']['ownTurns']))/(max(1e-9,r['perMode']['model']['strategistCalls']/max(1,r['perMode']['model']['ownTurns']))) for r in new if r['perMode']['bot']['ownTurns']>=10 and r['perMode']['model']['ownTurns']>=10)
print('per-game v2/v1 calls-per-own-turn ratio: n', len(ratios), 'median', round(ratios[len(ratios)//2], 3), 'games where v2 lower', sum(x<1 for x in ratios))
# wakes
wk = {m: Counter() for m in agg}
for r in new:
    for m in wk: wk[m].update(r['perMode'][m]['strategistWakes'])
for m in wk: print(side[m], 'wakes', dict(wk[m].most_common()))
# who survived longer: own turns share
print('total usd all games', round(sum(r['spendCap']['spentUsd'] for r in rows), 4), 'capped', sum(r['spendCap']['reached'] for r in rows),
      'failed calls', sum(r['perMode'][m]['failedCalls'] for r in rows for m in agg))
print('turns of decided games: mean', round(sum(r['turns'] for r in dec)/len(dec),1))
# per-seed table
for s in sorted(pairs, key=lambda x: (len(x), x)):
    print('  ', s, pairs[s].get(False), pairs[s].get(True))
