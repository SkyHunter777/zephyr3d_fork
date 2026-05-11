import type { SceneNode } from '@zephyr3d/scene';
import { RuntimeScript, scriptProp } from '@zephyr3d/scene';

export default class FloatingNodeScript extends RuntimeScript<SceneNode> {
  @scriptProp({ type: 'float', label: 'Speed', default: 1, minValue: 0 })
  speed = 1;

  @scriptProp({ type: 'float', label: 'Amplitude', default: 0.5, minValue: 0 })
  amplitude = 0.5;

  private host: SceneNode | null = null;
  private baseY = 0;
  private hasBaseY = false;

  onAttached(host: SceneNode | null): void {
    this.host = host;
    this.hasBaseY = false;
    if (host) {
      this.baseY = host.position.y;
      this.hasBaseY = true;
    }
  }

  onUpdate(_deltaTime: number, elapsedTime: number): void {
    if (!this.host || !this.hasBaseY) {
      return;
    }
    this.host.position.y = this.baseY + Math.sin(elapsedTime * this.speed) * this.amplitude;
  }

  onDetached(host: SceneNode): void {
    if (this.hasBaseY) {
      host.position.y = this.baseY;
    }
    if (this.host === host) {
      this.host = null;
    }
    this.hasBaseY = false;
  }
}
