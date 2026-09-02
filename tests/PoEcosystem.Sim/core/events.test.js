import { describe, expect, it } from 'vitest';
import { createBus, createEventLog } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/events.js';

describe('event log', () => {
  it('keeps events in push order, capped at capacity, and drains once', () => {
    const log = createEventLog(3);
    log.push({ tick: 1, kind: 'birth', text: 'a' });
    log.push({ tick: 2, kind: 'death', text: 'b' });
    expect(log.drain().map(e => e.text)).toEqual(['a', 'b']);
    expect(log.drain()).toEqual([]);
    log.push({ tick: 3, kind: 'fire', text: 'c' });
    log.push({ tick: 4, kind: 'hut', text: 'd' });
    expect(log.all().map(e => e.text)).toEqual(['b', 'c', 'd']);
    expect(log.recent(2).map(e => e.text)).toEqual(['c', 'd']);
    expect(log.drain().map(e => e.text)).toEqual(['c', 'd']);
    expect(log.count).toBe(3);
  });

  it('assigns increasing ids and round-trips its state', () => {
    const log = createEventLog(5);
    const a = log.push({ tick: 1, kind: 'birth', text: 'a' });
    const b = log.push({ tick: 1, kind: 'birth', text: 'b' });
    expect(b.id).toBe(a.id + 1);
    const s = log.getState();
    const copy = createEventLog(5);
    copy.setState(s);
    expect(copy.all()).toEqual(log.all());
    expect(copy.push({ tick: 2, kind: 'x', text: 'c' }).id).toBe(b.id + 1);
  });
});

describe('bus', () => {
  it('delivers to listeners in subscription order and supports off', () => {
    const bus = createBus();
    const seen = [];
    const off = bus.on('death', p => seen.push('first:' + p));
    bus.on('death', p => seen.push('second:' + p));
    bus.on('birth', p => seen.push('birth:' + p));
    bus.emit('death', 1);
    off();
    bus.emit('death', 2);
    bus.emit('nobody', 3);
    expect(seen).toEqual(['first:1', 'second:1', 'second:2']);
  });
});
