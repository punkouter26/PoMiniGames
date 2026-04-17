// Grid Cell size determines collision bucket
export class SpatialHashGrid {
    private cellSize: number;
    private grid: Map<string, number[]>;

    constructor(cellSize: number = 1.0) {
        this.cellSize = cellSize;
        this.grid = new Map<string, number[]>();
    }

    private hash(x: number, y: number, z: number): string {
        const cx = Math.floor(x / this.cellSize);
        const cy = Math.floor(y / this.cellSize);
        const cz = Math.floor(z / this.cellSize);
        return `${cx},${cy},${cz}`;
    }

    public clear() {
        this.grid.clear();
    }

    public insert(id: number, x: number, y: number, z: number) {
        const key = this.hash(x, y, z);
        const cell = this.grid.get(key);
        if (cell) {
            cell.push(id);
        } else {
            this.grid.set(key, [id]);
        }
    }

    public getNearby(x: number, y: number, z: number): number[] {
        const cx = Math.floor(x / this.cellSize);
        const cy = Math.floor(y / this.cellSize);
        const cz = Math.floor(z / this.cellSize);

        const result: number[] = [];

        // Check 3x3x3 neighborhood
        for (let i = -1; i <= 1; i++) {
            for (let j = -1; j <= 1; j++) {
                for (let k = -1; k <= 1; k++) {
                    const key = `${cx + i},${cy + j},${cz + k}`;
                    const cell = this.grid.get(key);
                    if (cell) {
                        for (const id of cell) {
                            result.push(id);
                        }
                    }
                }
            }
        }
        return result;
    }
}
