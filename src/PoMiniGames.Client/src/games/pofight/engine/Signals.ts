type Subscriber<T> = (_value: T) => void;

export class Signal<T> {
    private _value: T;
    private subscribers: Set<Subscriber<T>> = new Set();

    constructor(initialValue: T) {
        this._value = initialValue;
    }

    get value(): T {
        return this._value;
    }

    public peek(): T {
        return this._value;
    }

    set value(newValue: T) {
        if (this._value !== newValue) {
            this._value = newValue;
            this.notify();
        }
    }

    public subscribe(callback: Subscriber<T>): () => void {
        this.subscribers.add(callback);
        // callback(this._value); // Optional: call immediately
        return () => {
            this.subscribers.delete(callback);
        };
    }

    private notify() {
        this.subscribers.forEach((callback) => callback(this._value));
    }
}

export function createSignal<T>(initialValue: T): Signal<T> {
    return new Signal<T>(initialValue);
}
