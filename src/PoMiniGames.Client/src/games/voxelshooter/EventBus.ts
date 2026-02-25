/**
 * Lightweight Event Bus for Decoupled State Transitions
 * Allows systems to communicate without tight coupling
 *
 * Usage:
 *   eventBus.emit('player-destroyed', { x: 100, y: 50 });
 *   eventBus.on('enemy-defeated', (data) => console.log(data));
 */

export type EventListener<T = any> = (data: T) => void;

export class EventBus {
  private listeners: Map<string, EventListener[]> = new Map();

  /**
   * Subscribe to an event
   */
  public on<T = any>(event: string, listener: EventListener<T>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }

    this.listeners.get(event)!.push(listener as EventListener);

    // Return unsubscribe function
    return () => this.off(event, listener as EventListener);
  }

  /**
   * Subscribe to an event once
   */
  public once<T = any>(event: string, listener: EventListener<T>): void {
    const wrapper: EventListener = (data: T) => {
      listener(data);
      this.off(event, wrapper);
    };

    this.on(event, wrapper);
  }

  /**
   * Emit an event to all subscribers
   */
  public emit<T = any>(event: string, data?: T): void {
    const listeners = this.listeners.get(event);
    if (!listeners) return;

    for (const listener of listeners) {
      try {
        listener(data);
      } catch (error) {
        console.error(`Error in event listener for "${event}":`, error);
      }
    }
  }

  /**
   * Unsubscribe from an event
   */
  public off(event: string, listener: EventListener): void {
    const listeners = this.listeners.get(event);
    if (!listeners) return;

    const index = listeners.indexOf(listener);
    if (index !== -1) {
      listeners.splice(index, 1);
    }
  }

  /**
   * Remove all listeners for an event
   */
  public clear(event?: string): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }

  /**
   * Get count of listeners for an event (for debugging)
   */
  public getListenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }
}

// Global event bus instance
export const eventBus = new EventBus();
