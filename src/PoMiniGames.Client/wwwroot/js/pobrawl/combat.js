// combat.js — health/armor/death/winner resolution for the match.
// Adapted from GameBlocks (github.com/xt4d/GameBlocks, MIT) gameplay/CombatPlay.js,
// trimmed to what a 1v1 brawler needs: two players, each its own team, armor
// absorption, a PLAYER_KILLED / COMBAT_FINISHED event queue, and winner resolution.
// The engine owns visuals/animation; this owns the numbers and the "who won" rule.

export const COMBAT_STATES = Object.freeze({
  WAITING: 'WAITING',
  STARTED: 'STARTED',
  FINISHED: 'FINISHED',
});

export const COMBAT_EVENTS = Object.freeze({
  PLAYER_KILLED: 'combat.player.killed',
  COMBAT_FINISHED: 'combat.finished',
});

export class CombatPlay {
  constructor({ maxHealth = 100, maxArmor = 100, armorAbsorption = 0.6 } = {}) {
    this.maxHealth = maxHealth;
    this.maxArmor = maxArmor;
    this.armorAbsorption = armorAbsorption;
    this.players = new Map();
    this.combatState = COMBAT_STATES.WAITING;
    this.winnerTeamId = null;
    this._events = [];
  }

  addPlayer({ playerId, teamId, health = this.maxHealth, armor = 0 }) {
    this.players.set(playerId, {
      playerId, teamId,
      maxHealth: this.maxHealth, health,
      maxArmor: this.maxArmor, armor,
      alive: health > 0,
    });
  }

  startGame() {
    this.winnerTeamId = null;
    this.combatState = COMBAT_STATES.STARTED;
  }

  getPlayer(playerId) {
    return this.players.get(playerId);
  }

  getCombatState() {
    return this.combatState;
  }

  damage({ playerId, amount, sourceId = null, bypassArmor = false }) {
    if (this.combatState !== COMBAT_STATES.STARTED) return 0;
    const p = this.players.get(playerId);
    if (!p || !p.alive) return 0;

    const armorDamage = bypassArmor ? 0 : Math.min(p.armor, amount * this.armorAbsorption);
    const healthDamage = Math.min(p.health, amount - armorDamage);
    p.armor -= armorDamage;
    p.health -= healthDamage;
    p.alive = p.health > 0;

    if (!p.alive) {
      this._events.push({ type: COMBAT_EVENTS.PLAYER_KILLED, playerId, sourceId });
    }
    return healthDamage;
  }

  getAliveTeamIds() {
    return Array.from(new Set(
      Array.from(this.players.values()).filter((p) => p.alive).map((p) => p.teamId)
    ));
  }

  // Resolves the match when one team remains, then drains queued events.
  step() {
    if (this.combatState === COMBAT_STATES.STARTED) {
      const alive = this.getAliveTeamIds();
      if (alive.length <= 1) {
        this.combatState = COMBAT_STATES.FINISHED;
        this.winnerTeamId = alive[0] ?? null;
        this._events.push({ type: COMBAT_EVENTS.COMBAT_FINISHED, winnerTeamId: this.winnerTeamId });
      }
    }
    const events = this._events;
    this._events = [];
    return events;
  }
}
