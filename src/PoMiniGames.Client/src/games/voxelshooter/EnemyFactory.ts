/**
 * Enemy Spawn Factory Pattern
 * Configurable enemy definitions with weight-based random selection
 * Decouples enemy types from EnemyShapes, allowing easy extension
 */

export interface EnemyDefinition {
  type: string;
  weight: number;  // Probability weight (0-1)
  spawnRate: number;  // Seconds between spawns of this type
}

export class EnemyFactory {
  private definitions: EnemyDefinition[];
  private totalWeight: number = 0;

  constructor(definitions: EnemyDefinition[]) {
    this.definitions = definitions;
    this.recalculateWeights();
  }

  /**
   * Recalculate total weight for weighted random selection
   */
  private recalculateWeights(): void {
    this.totalWeight = this.definitions.reduce((sum, def) => sum + def.weight, 0);
  }

  /**
   * Get a random enemy type based on weights
   */
  public getRandomType(): string {
    const random = Math.random() * this.totalWeight;
    let accumulated = 0;

    for (const def of this.definitions) {
      accumulated += def.weight;
      if (random <= accumulated) {
        return def.type;
      }
    }

    // Fallback to last definition
    return this.definitions[this.definitions.length - 1].type;
  }

  /**
   * Get definition for a specific enemy type
   */
  public getDefinition(type: string): EnemyDefinition | null {
    return this.definitions.find(def => def.type === type) ?? null;
  }

  /**
   * Update weights (useful for difficulty scaling)
   */
  public setWeight(type: string, weight: number): void {
    const def = this.getDefinition(type);
    if (def) {
      def.weight = Math.max(0, weight);
      this.recalculateWeights();
    }
  }

  /**
   * Get all definitions
   */
  public getDefinitions(): EnemyDefinition[] {
    return this.definitions;
  }
}

/**
 * Default enemy factory configuration
 * Asteroid: 60% (common, breakable rock)
 * Ship: 40% (tactical, harder to break)
 */
export const createDefaultEnemyFactory = (): EnemyFactory => {
  return new EnemyFactory([
    { type: 'asteroid', weight: 0.6, spawnRate: 3.0 },
    { type: 'ship', weight: 0.4, spawnRate: 3.0 }
  ]);
};
