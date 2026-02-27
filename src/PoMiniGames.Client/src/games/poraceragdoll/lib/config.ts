export const INITIAL_BALANCE = 1000;
export const INITIAL_BET = 100;
export const TOTAL_ROUNDS = 5;

export const RACER_SPECIES = [
    { name: "Human", mass: 70, color: "#FFCCAA", emoji: "🏃", type: "human" },
    { name: "Spider", mass: 40, color: "#9932CC", emoji: "🕷️", type: "spider" },
    { name: "Dog", mass: 50, color: "#CD853F", emoji: "🐕", type: "dog" },
    { name: "Snake", mass: 30, color: "#32CD32", emoji: "🐍", type: "snake" },
    { name: "Crab", mass: 45, color: "#FF4500", emoji: "🦀", type: "crab" },
    { name: "Dino", mass: 120, color: "#FF6B6B", emoji: "🦖", type: "dino" },
    { name: "Penguin", mass: 35, color: "#87CEEB", emoji: "🐧", type: "penguin" },
    { name: "Alien", mass: 60, color: "#00FF00", emoji: "👽", type: "alien" }
] as const;

export type RacerSpecies = typeof RACER_SPECIES[number];
