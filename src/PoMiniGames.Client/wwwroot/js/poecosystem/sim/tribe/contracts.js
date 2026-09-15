// contracts.js — multi-tribe definitions, diplomacy states, tech tiers & building specifications.
'use strict';

export const TRIBE_DIPLOMACY = Object.freeze({
  NEUTRAL: 0,
  ALLIED: 1,
  RIVAL: 2,
  WAR: 3,
});

export const TECH_TIER = Object.freeze({
  PRIMITIVE: 0,
  TOOLCRAFT: 1,
  AGRARIAN: 2,
  FORTIFICATION: 3,
});

export const BUILDING_KIND = Object.freeze({
  HUT: 0,
  GRANARY: 1,
  WATCHTOWER: 2,
  WAR_TOTEM: 3,
});

export const DEFAULT_TRIBES = Object.freeze([
  {
    id: 0,
    name: 'Amber Clan',
    bannerColor: '#d48806',
    accentColor: '#faad14',
    motto: 'Stone and Hearth',
    startingTech: TECH_TIER.PRIMITIVE,
    traits: Object.freeze({ diligenceBonus: 1.2, courageBonus: 0.9, aggression: 0.2 }),
  },
  {
    id: 1,
    name: 'Cobalt Clan',
    bannerColor: '#096dd9',
    accentColor: '#40a9ff',
    motto: 'Swift Tide',
    startingTech: TECH_TIER.PRIMITIVE,
    traits: Object.freeze({ diligenceBonus: 0.9, courageBonus: 1.3, aggression: 0.6 }),
  },
  {
    id: 2,
    name: 'Verdant Clan',
    bannerColor: '#389e0d',
    accentColor: '#73d13d',
    motto: 'Root and Leaf',
    startingTech: TECH_TIER.PRIMITIVE,
    traits: Object.freeze({ diligenceBonus: 1.1, courageBonus: 1.0, aggression: 0.1 }),
  },
]);

export const TECH_SPECS = Object.freeze({
  [TECH_TIER.PRIMITIVE]: {
    name: 'Primitive Foraging',
    researchCost: 0,
    chopMultiplier: 1.0,
    gatherMultiplier: 1.0,
    combatMultiplier: 1.0,
  },
  [TECH_TIER.TOOLCRAFT]: {
    name: 'Toolcraft & Masonry',
    researchCost: 100,
    woodCost: 40,
    stoneCost: 10,
    chopMultiplier: 1.5,
    gatherMultiplier: 1.3,
    combatMultiplier: 1.1,
  },
  [TECH_TIER.AGRARIAN]: {
    name: 'Agrarian Cultivation',
    researchCost: 250,
    woodCost: 80,
    stoneCost: 40,
    chopMultiplier: 1.8,
    gatherMultiplier: 2.0,
    combatMultiplier: 1.2,
  },
  [TECH_TIER.FORTIFICATION]: {
    name: 'Fortification & Metallurgy',
    researchCost: 500,
    woodCost: 150,
    stoneCost: 100,
    chopMultiplier: 2.2,
    gatherMultiplier: 2.5,
    combatMultiplier: 1.5,
  },
});

export const BUILDING_SPECS = Object.freeze({
  [BUILDING_KIND.HUT]: {
    name: 'Thatch Hut',
    cost: Object.freeze({ wood: 20, stone: 5 }),
    beds: 4,
    buildTicks: 160,
    maxHealth: 100,
    footprintRadius: 1.8,
  },
  [BUILDING_KIND.GRANARY]: {
    name: 'Storage Granary',
    cost: Object.freeze({ wood: 35, stone: 15 }),
    foodCapacity: 250,
    buildTicks: 240,
    maxHealth: 150,
    footprintRadius: 2.2,
  },
  [BUILDING_KIND.WATCHTOWER]: {
    name: 'Watchtower',
    cost: Object.freeze({ wood: 50, stone: 30 }),
    visionRadius: 28,
    defenseBonus: 0.35,
    buildTicks: 320,
    maxHealth: 220,
    footprintRadius: 1.5,
  },
  [BUILDING_KIND.WAR_TOTEM]: {
    name: 'War Totem',
    cost: Object.freeze({ wood: 40, stone: 40 }),
    combatBonusRadius: 20,
    combatDamageMultiplier: 1.25,
    buildTicks: 280,
    maxHealth: 180,
    footprintRadius: 2.0,
  },
});
