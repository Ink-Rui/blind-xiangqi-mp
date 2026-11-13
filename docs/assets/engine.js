export const CHARS = {
    red: { K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵' },
    black: { K: '将', A: '士', B: '象', N: '马', R: '车', C: '炮', P: '卒' }
};
export const NAMES = { K: '将/帅', A: '士', B: '象', N: '马', R: '车', C: '炮', P: '兵' };
export const SLOTS = (() => {
    const back = 'RNBAKABNR';
    const s = [];
    for (let c = 0; c < 9; c++)
        s.push({ r: 0, c, t: back[c] });
    s.push({ r: 2, c: 1, t: 'C' }, { r: 2, c: 7, t: 'C' });
    for (const c of [0, 2, 4, 6, 8])
        s.push({ r: 3, c, t: 'P' });
    for (const c of [0, 2, 4, 6, 8])
        s.push({ r: 6, c, t: 'P' });
    s.push({ r: 7, c: 1, t: 'C' }, { r: 7, c: 7, t: 'C' });
    for (let c = 0; c < 9; c++)
        s.push({ r: 9, c, t: back[c] });
    return s;
})();
export const opp = (s) => (s === 'red' ? 'black' : 'red');
export const halfOwner = (pos) => (pos.r <= 4 ? 'black' : 'red');
export const PIECE_XY = (r, c) => ({ x: ((80 + 100 * c) / 960) * 100, y: ((90 + 100 * r) / 1080) * 100 });
function shuffleArr(a) {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
export function newGameState(cfg) {
    const g = {
        cfg, turn: 'red', moveNum: 1, noCap: 0, over: false, winner: null, reason: '',
        pieces: [], history: [], repMap: {}, lastMove: null, selected: null, busy: false
    };
    let id = 0;
    for (const color of ['red', 'black']) {
        const roster = [['K', 1], ['A', 2], ['B', 2], ['N', 2], ['R', 2], ['C', 2], ['P', 5]];
        for (const [t, n] of roster) {
            for (let i = 0; i < n; i++) {
                g.pieces.push({ id: 'p' + id++, color, type: t, slotType: null, revealed: false, captured: false, pos: null });
            }
        }
    }
    const kings = {
        red: g.pieces.find(p => p.color === 'red' && p.type === 'K'),
        black: g.pieces.find(p => p.color === 'black' && p.type === 'K')
    };
    if (cfg.shuffle === 'B') {
        const slots = shuffleArr(SLOTS.slice());
        const ps = shuffleArr(g.pieces.slice());
        ps.forEach((p, i) => { p.pos = { r: slots[i].r, c: slots[i].c }; p.slotType = slots[i].t; p.revealed = false; });
    }
    else {
        kings.red.pos = { r: 9, c: 4 };
        kings.red.slotType = 'K';
        kings.red.revealed = true;
        kings.black.pos = { r: 0, c: 4 };
        kings.black.slotType = 'K';
        kings.black.revealed = true;
        const rest = g.pieces.filter(p => p.type !== 'K');
        if (cfg.shuffle === 'A1') {
            for (const side of ['red', 'black']) {
                const own = shuffleArr(SLOTS.filter(s => halfOwner(s) === side && !(s.r === (side === 'red' ? 9 : 0) && s.c === 4)));
                const pcs = shuffleArr(rest.filter(p => p.color === side));
                pcs.forEach((p, i) => { p.pos = { r: own[i].r, c: own[i].c }; p.slotType = own[i].t; });
            }
        }
        else {
            const slots = shuffleArr(SLOTS.filter(s => !(s.r === 9 && s.c === 4) && !(s.r === 0 && s.c === 4)));
            const pcs = shuffleArr(rest);
            pcs.forEach((p, i) => { p.pos = { r: slots[i].r, c: slots[i].c }; p.slotType = slots[i].t; });
        }
    }
    g.repMap[hashState(g)] = 1;
    return g;
}
export function hashState(g) {
    return g.pieces.map(p => p.id + ':' + (p.pos ? p.pos.r + '_' + p.pos.c : 'x') + (p.revealed ? 1 : 0)).join('|') + '#' + g.turn;
}
export const pieceAt = (g, t) => g.pieces.find(p => !p.captured && p.pos && p.pos.r === t.r && p.pos.c === t.c);
export const effType = (p) => (p.revealed ? p.type : p.slotType);
export function pseudoMoves(g, p) {
    if (!p.pos)
        return [];
    const t = effType(p);
    const { r, c } = p.pos;
    const out = [];
    const ok = (rr, cc) => rr >= 0 && rr < 10 && cc >= 0 && cc < 9;
    const palaceOf = (base) => (base <= 4 ? 'top' : 'bot');
    const inPalace = (rr, cc, pal) => cc >= 3 && cc <= 5 && (pal === 'top' ? rr <= 2 : rr >= 7);
    if (t === 'R') {
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            let rr = r + dr, cc = c + dc;
            while (ok(rr, cc)) {
                out.push({ r: rr, c: cc });
                if (pieceAt(g, { r: rr, c: cc }))
                    break;
                rr += dr;
                cc += dc;
            }
        }
    }
    else if (t === 'C') {
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            let rr = r + dr, cc = c + dc;
            while (ok(rr, cc) && !pieceAt(g, { r: rr, c: cc })) {
                out.push({ r: rr, c: cc });
                rr += dr;
                cc += dc;
            }
            if (ok(rr, cc)) {
                rr += dr;
                cc += dc;
                while (ok(rr, cc)) {
                    if (pieceAt(g, { r: rr, c: cc })) {
                        out.push({ r: rr, c: cc });
                        break;
                    }
                    rr += dr;
                    cc += dc;
                }
            }
        }
    }
    else if (t === 'N') {
        for (const [dr, dc, lr, lc] of [[-2, -1, -1, 0], [-2, 1, -1, 0], [2, -1, 1, 0], [2, 1, 1, 0], [-1, -2, 0, -1], [1, -2, 0, -1], [-1, 2, 0, 1], [1, 2, 0, 1]]) {
            if (!pieceAt(g, { r: r + lr, c: c + lc }) && ok(r + dr, c + dc))
                out.push({ r: r + dr, c: c + dc });
        }
    }
    else if (t === 'B') {
        for (const [dr, dc] of [[-2, -2], [-2, 2], [2, -2], [2, 2]]) {
            const rr = r + dr, cc = c + dc;
            if (!ok(rr, cc) || pieceAt(g, { r: r + dr / 2, c: c + dc / 2 }))
                continue;
            if (!p.revealed) {
                if (r <= 4 && rr > 4)
                    continue;
                if (r >= 5 && rr < 5)
                    continue;
            }
            out.push({ r: rr, c: cc });
        }
    }
    else if (t === 'A') {
        const pal = p.revealed ? null : palaceOf(r);
        for (const [dr, dc] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
            const rr = r + dr, cc = c + dc;
            if (!ok(rr, cc))
                continue;
            if (pal && !inPalace(rr, cc, pal))
                continue;
            out.push({ r: rr, c: cc });
        }
    }
    else if (t === 'K') {
        const pal = p.revealed ? (p.color === 'red' ? 'bot' : 'top') : palaceOf(r);
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const rr = r + dr, cc = c + dc;
            if (ok(rr, cc) && inPalace(rr, cc, pal))
                out.push({ r: rr, c: cc });
        }
        if (g.cfg.rule === 'kill' && p.revealed) {
            const ek = g.pieces.find(q => q.type === 'K' && q.color !== p.color && !q.captured && q.revealed);
            if (ek && ek.pos && ek.pos.c === c) {
                let clear = true;
                const lo = Math.min(r, ek.pos.r), hi = Math.max(r, ek.pos.r);
                for (let rr = lo + 1; rr < hi; rr++)
                    if (pieceAt(g, { r: rr, c })) {
                        clear = false;
                        break;
                    }
                if (clear && hi > lo)
                    out.push({ r: ek.pos.r, c: ek.pos.c });
            }
        }
    }
    else if (t === 'P') {
        const dir = p.revealed ? (p.color === 'red' ? -1 : 1) : (r <= 4 ? 1 : -1);
        if (ok(r + dir, c))
            out.push({ r: r + dir, c });
        if (p.revealed) {
            const crossed = p.color === 'red' ? r <= 4 : r >= 5;
            if (crossed) {
                if (ok(r, c - 1))
                    out.push({ r, c: c - 1 });
                if (ok(r, c + 1))
                    out.push({ r, c: c + 1 });
            }
        }
    }
    return out;
}
export function canCapture(g, mover, tp) {
    if (!tp)
        return true;
    if (!tp.revealed)
        return true;
    if (!mover.revealed) {
        if (!mover.pos)
            return false;
        const op = halfOwner(mover.pos);
        return tp.color !== op;
    }
    return tp.color !== mover.color;
}
export function simMove(g, p, t) {
    const pieces = g.pieces.map(q => ({ ...q, pos: q.pos ? { ...q.pos } : null }));
    const sp = pieces.find(q => q.id === p.id);
    const tp = pieces.find(q => !q.captured && q.pos && q.pos.r === t.r && q.pos.c === t.c);
    if (tp) {
        tp.captured = true;
        tp.pos = null;
    }
    sp.pos = { r: t.r, c: t.c };
    if (!sp.revealed)
        sp.revealed = true;
    return { pieces, cfg: g.cfg };
}
export function inCheck(g, side) {
    const k = g.pieces.find(q => q.type === 'K' && q.color === side && !q.captured && q.revealed);
    if (!k || !k.pos)
        return false;
    for (const e of g.pieces) {
        if (e.captured || e.color === side || !e.pos)
            continue;
        if (pseudoMoves(g, e).some(t => {
            const tp = pieceAt(g, t);
            return tp && tp.color === side && tp.type === 'K' && canCapture(g, e, tp);
        }))
            return true;
    }
    const k2 = g.pieces.find(q => q.type === 'K' && q.color !== side && !q.captured && q.revealed);
    if (k2 && k2.pos && k2.pos.c === k.pos.c) {
        let clear = true;
        const lo = Math.min(k.pos.r, k2.pos.r), hi = Math.max(k.pos.r, k2.pos.r);
        for (let rr = lo + 1; rr < hi; rr++)
            if (pieceAt(g, { r: rr, c: k.pos.c })) {
                clear = false;
                break;
            }
        if (clear && hi > lo)
            return true;
    }
    return false;
}
export function legalTargets(g, p) {
    let ms = pseudoMoves(g, p).filter(t => {
        const tp = pieceAt(g, t);
        return canCapture(g, p, tp) && !(g.cfg.rule === 'check' && tp && tp.revealed && tp.type === 'K');
    });
    if (g.cfg.rule === 'check' && p.revealed) {
        const ownK = g.pieces.find(q => q.type === 'K' && q.color === p.color && !q.captured);
        if (ownK && ownK.revealed) {
            ms = ms.filter(t => !inCheck(simMove(g, p, t), p.color));
        }
    }
    return ms;
}
export const operable = (g, q, side) => q.revealed ? q.color === side : q.pos ? halfOwner(q.pos) === side : false;
export function hasLegal(g, side) {
    return g.pieces.some(q => !q.captured && operable(g, q, side) && legalTargets(g, q).length > 0);
}
export function clonePieces(g) {
    return g.pieces.map(q => ({ ...q, pos: q.pos ? { ...q.pos } : null }));
}
const AI_VALUE = { K: 1000, R: 90, C: 45, N: 40, B: 20, A: 20, P: 10 };
function isCapturable(g, target, side) {
    if (!target.pos)
        return false;
    for (const q of g.pieces) {
        if (q.captured || q.color !== side || !q.pos)
            continue;
        if (!operable(g, q, side))
            continue;
        if (pseudoMoves(g, q).some(t2 => t2.r === target.pos.r && t2.c === target.pos.c) &&
            canCapture(g, q, target))
            return true;
    }
    return false;
}
function isDefended(g, target, side) {
    if (!target.pos)
        return false;
    for (const q of g.pieces) {
        if (q.captured || q.color !== side || !q.pos || q.id === target.id)
            continue;
        if (!operable(g, q, side))
            continue;
        if (pseudoMoves(g, q).some(t2 => t2.r === target.pos.r && t2.c === target.pos.c))
            return true;
    }
    return false;
}
function minAttackerValue(g, target, side, darkEV) {
    if (!target.pos)
        return Infinity;
    let mn = Infinity;
    let hasDark = false;
    for (const q of g.pieces) {
        if (q.captured || q.color !== side || !q.pos)
            continue;
        if (!operable(g, q, side))
            continue;
        if (!pseudoMoves(g, q).some(t2 => t2.r === target.pos.r && t2.c === target.pos.c) ||
            !canCapture(g, q, target))
            continue;
        if (q.revealed)
            mn = Math.min(mn, AI_VALUE[q.type]);
        else
            hasDark = true;
    }
    if (hasDark)
        mn = Math.min(mn, darkEV);
    return mn;
}
function aiScore(g, m, side) {
    const { p, t } = m;
    const from = p.pos;
    const enemy = opp(side);
    let s = Math.random() * 1.5;
    const H = g.pieces.filter(q => !q.captured && !q.revealed && q.pos);
    const N = H.length || 1;
    const myHArr = H.filter(q => q.color === side);
    const enHArr = H.filter(q => q.color !== side);
    const myH = myHArr.length, enH = enHArr.length;
    const sumV = (arr) => arr.reduce((a, q) => a + AI_VALUE[q.type], 0);
    const myK = g.pieces.find(q => q.type === 'K' && q.color === side && !q.captured);
    const kHidden = !!(myK && !myK.revealed);
    const enK = g.pieces.find(q => q.type === 'K' && q.color === enemy && !q.captured);
    const enKHidden = !!(enK && !enK.revealed);
    const myAvgNoK = (myH - (kHidden ? 1 : 0)) > 0 ? (sumV(myHArr) - (kHidden ? AI_VALUE.K : 0)) / (myH - (kHidden ? 1 : 0)) : 0;
    const enAvgNoK = (enH - (enKHidden ? 1 : 0)) > 0 ? (sumV(enHArr) - (enKHidden ? AI_VALUE.K : 0)) / (enH - (enKHidden ? 1 : 0)) : 0;
    const enAvg = enH ? sumV(enHArr) / enH : 0;
    const pMine = myH / N;
    const pEnemy = enH / N;
    const target = pieceAt(g, t);
    if (target) {
        if (target.revealed) {
            s += AI_VALUE[target.type];
            if (target.type === 'K')
                s += 4000;
            s += 30;
        }
        else {
            s += ((enH - (enKHidden ? 1 : 0)) / N) * enAvgNoK;
            s -= ((myH - (kHidden ? 1 : 0)) / N) * myAvgNoK;
            if (enKHidden)
                s += 2500 / N;
            if (kHidden)
                s -= 2500 / N;
            s += 15;
        }
    }
    const after = simMove(g, p, t);
    if (!p.revealed) {
        s += pMine * 12 - pEnemy * enAvg * 0.3;
    }
    const moved = after.pieces.find(q => q.id === p.id);
    const movedAtRisk = isCapturable(after, moved, enemy);
    if (movedAtRisk) {
        const riskV = p.revealed ? AI_VALUE[p.type] : (myH / N) * myAvgNoK;
        const defended = isDefended(after, moved, side);
        const atkV = minAttackerValue(after, moved, enemy, enAvgNoK);
        const cost = defended ? Math.max(0, riskV - atkV) : riskV;
        s -= cost * 0.8;
        if (!p.revealed && kHidden)
            s -= 2000 / N;
    }
    const enKr = after.pieces.find(q => q.type === 'K' && q.color === enemy && !q.captured && q.revealed);
    if (enKr && enKr.pos && isCapturable(after, enKr, side) && !movedAtRisk)
        s += 150;
    const myKrNow = g.pieces.find(q => q.type === 'K' && q.color === side && !q.captured && q.revealed);
    const dBefore = !!(myKrNow && myKrNow.pos && isCapturable(g, myKrNow, enemy));
    const myKrAfter = after.pieces.find(q => q.type === 'K' && q.color === side && !q.captured && q.revealed);
    const dAfter = !!(myKrAfter && myKrAfter.pos && isCapturable(after, myKrAfter, enemy));
    if (dAfter && !dBefore)
        s -= 800;
    if (!dAfter && dBefore)
        s += 500;
    if (!p.revealed)
        s += g.moveNum <= 20 ? 3 : 1;
    s += (side === 'black' ? t.r - from.r : from.r - t.r) * 0.1;
    if (g.cfg.rule === 'check' && inCheck(after, enemy))
        s += 12;
    const h = after.pieces.map(q => q.id + ':' + (q.pos ? q.pos.r + '_' + q.pos.c : 'x') + (q.revealed ? 1 : 0)).join('|') + '#' + enemy;
    if ((g.repMap[h] || 0) >= 2)
        s -= 300;
    return s;
}
export function pickAIMove(g, side = 'black') {
    const all = [];
    for (const q of g.pieces) {
        if (q.captured || !operable(g, q, side))
            continue;
        for (const t of legalTargets(g, q))
            all.push({ p: q, t });
    }
    if (!all.length)
        return null;
    const level = g.cfg.level || 'normal';
    if (level === 'easy')
        return all[Math.floor(Math.random() * all.length)];
    if (level === 'normal') {
        const caps = all.filter(m => pieceAt(g, m.t));
        if (caps.length && Math.random() < 0.6)
            return caps[Math.floor(Math.random() * caps.length)];
        return all[Math.floor(Math.random() * all.length)];
    }
    const winNow = all.find(m => { const tp = pieceAt(g, m.t); return tp && tp.revealed && tp.type === 'K' && tp.color !== side; });
    if (winNow)
        return winNow;
    let best = [];
    let bestScore = -Infinity;
    for (const m of all) {
        const s = aiScore(g, m, side);
        if (s > bestScore + 0.01) {
            bestScore = s;
            best = [m];
        }
        else if (s > bestScore - 0.01)
            best.push(m);
    }
    return best[Math.floor(Math.random() * best.length)];
}
