import type { Nullable } from '@zephyr3d/base';
import { Vector3, Quaternion } from '@zephyr3d/base';
import type { SpringChain } from './spring_chain';
import type { SpringConstraint } from './spring_constraint';
import { IKUtils } from '../ik/ik_utils';
import type { CapsuleCollider, PlaneCollider, SphereCollider, SpringCollider } from './spring_collider';
import {
  resolveCapsuleCollision,
  resolvePlaneCollision,
  resolveSphereCollision,
  updateColliderFromNode
} from './spring_collider';
import { SpringNodePoseTracker } from './spring_node_pose_tracker';

/**
 * Constraint between particles in different chains
 *
 * @public
 */
export interface InterChainConstraint {
  /** Index of the first chain */
  chainAIndex: number;
  /** Index of the second chain */
  chainBIndex: number;
  /** Index of particle in chain A */
  particleAIndex: number;
  /** Index of particle in chain B */
  particleBIndex: number;
  /** Desired distance between particles */
  restLength: number;
  /** Constraint strength [0-1], used by Verlet solver */
  stiffness: number;
  /**
   * XPBD compliance (inverse stiffness) in m/N.
   * Only used when solver is 'xpbd'.
   */
  compliance: number;
  /** XPBD Lagrange multiplier accumulator, reset each time step. */
  lambda: number;
}

/**
 * Options for creating a MultiChainSpringSystem
 *
 * @public
 */
export interface MultiChainSpringSystemOptions {
  /** Number of constraint solver iterations (default: 5) */
  iterations?: number;
  /** Gravity force vector (default: (0, -9.8, 0)) */
  gravity?: Vector3;
  /** Wind force vector (default: (0, 0, 0)) */
  wind?: Vector3;
  /** Enable inertial forces (centrifugal/Coriolis) when root rotates (default: true) */
  enableInertialForces?: boolean;
  /** Centrifugal force multiplier (default: 1.0) */
  centrifugalScale?: number;
  /** Coriolis force multiplier (default: 1.0) */
  coriolisScale?: number;
  /**
   * Constraint solver type (default: 'verlet').
   * - 'verlet': stiffness [0-1] controls per-iteration correction strength.
   * - 'xpbd': compliance (m/N) gives physically correct, iteration-independent results.
   */
  solver?: 'verlet' | 'xpbd';
  /** How strongly particles follow the animated pose. */
  poseFollow?: number;
  poseFollowRoot?: number;
  poseFollowTip?: number;
  poseFollowExponent?: number;
  /** Maximum deviation from the animated pose; zero disables clamping. */
  maxPoseOffset?: number;
  maxPoseOffsetRoot?: number;
  maxPoseOffsetTip?: number;
}

/**
 * Physics engine for multiple spring chains with inter-chain constraints
 * Suitable for cloth, skirts, capes, and other multi-chain simulations
 *
 * @deprecated Use the new {@link JointDynamicsSystem} class instead.
 *
 * @public
 */
export class MultiChainSpringSystem {
  private _chains: SpringChain[];
  private _interChainConstraints: InterChainConstraint[];
  private _iterations: number;
  private _gravity: Vector3;
  private _wind: Vector3;
  private _enableInertialForces: boolean;
  private _centrifugalScale: number;
  private _coriolisScale: number;
  private _solver: 'verlet' | 'xpbd';
  private _poseFollow: number;
  private _maxPoseOffset: number;
  private _poseFollowRoot: number;
  private _poseFollowTip: number;
  private _poseFollowExponent: number;
  private _maxPoseOffsetRoot: number;
  private _maxPoseOffsetTip: number;
  private _colliders: SpringCollider[];
  private _nodePoseTracker: SpringNodePoseTracker;

  constructor(options?: MultiChainSpringSystemOptions) {
    this._chains = [];
    this._interChainConstraints = [];
    this._iterations = options?.iterations ?? 5;
    this._gravity = options?.gravity?.clone() ?? new Vector3(0, -9.8, 0);
    this._wind = options?.wind?.clone() ?? new Vector3(0, 0, 0);
    this._enableInertialForces = options?.enableInertialForces ?? true;
    this._centrifugalScale = options?.centrifugalScale ?? 1.0;
    this._coriolisScale = options?.coriolisScale ?? 1.0;
    this._solver = options?.solver ?? 'verlet';
    this._poseFollow = Math.max(0, Math.min(1, options?.poseFollow ?? 0.35));
    this._maxPoseOffset = Math.max(0, options?.maxPoseOffset ?? 0);
    this._poseFollowRoot = Math.max(0, Math.min(1, options?.poseFollowRoot ?? this._poseFollow));
    this._poseFollowTip = Math.max(0, Math.min(1, options?.poseFollowTip ?? this._poseFollow));
    this._poseFollowExponent = Math.max(0.1, options?.poseFollowExponent ?? 1.6);
    this._maxPoseOffsetRoot = Math.max(0, options?.maxPoseOffsetRoot ?? this._maxPoseOffset);
    this._maxPoseOffsetTip = Math.max(0, options?.maxPoseOffsetTip ?? this._maxPoseOffset);
    this._colliders = [];
    this._nodePoseTracker = new SpringNodePoseTracker();
  }

  /**
   * Adds a spring chain to the system
   * @param chain - The chain to add
   * @returns The index of the added chain
   */
  addChain(chain: SpringChain): number {
    this._chains.push(chain);
    return this._chains.length - 1;
  }

  /**
   * Adds an inter-chain constraint
   * @param constraint - The constraint to add
   */
  addInterChainConstraint(constraint: InterChainConstraint): void {
    this._interChainConstraints.push(constraint);
  }

  /**
   * Creates radial constraints between adjacent chains
   * Useful for skirts, capes, and other radial multi-chain structures
   * @param options - Configuration options
   */
  createRadialConstraints(options: {
    /** Constraint stiffness [0-1], used by Verlet solver */
    stiffness: number;
    /** Maximum distance to create constraints (particles further apart are not connected) */
    maxDistance: number;
    /** Skip first N rows of particles (e.g., anchor points at waist) */
    skipRows?: number;
    /** Connect to next N chains (default: 1, only adjacent chains) */
    connectDistance?: number;
    /** XPBD compliance in m/N (default: 0 = rigid). Only used when solver is 'xpbd'. */
    compliance?: number;
  }): void {
    const skipRows = options.skipRows ?? 0;
    const connectDistance = options.connectDistance ?? 1;
    const compliance = options.compliance ?? 0;

    for (let i = 0; i < this._chains.length; i++) {
      for (let offset = 1; offset <= connectDistance; offset++) {
        const j = (i + offset) % this._chains.length;
        const chainA = this._chains[i];
        const chainB = this._chains[j];

        const minLength = Math.min(chainA.particles.length, chainB.particles.length);

        for (let row = skipRows; row < minLength; row++) {
          const pA = chainA.particles[row];
          const pB = chainB.particles[row];
          const distance = Vector3.distance(pA.position, pB.position);

          if (distance <= options.maxDistance) {
            this.addInterChainConstraint({
              chainAIndex: i,
              chainBIndex: j,
              particleAIndex: row,
              particleBIndex: row,
              restLength: distance,
              stiffness: options.stiffness,
              compliance,
              lambda: 0
            });
          }
        }
      }
    }
  }

  /**
   * Updates the physics simulation for all chains
   * @param deltaTime - Time step in seconds
   */
  update(deltaTime: number): void {
    this._nodePoseTracker.restoreInputPose();
    const dt = Math.min(deltaTime, 0.033);

    // Save all particle positions before updating
    if (this._enableInertialForces) {
      for (const chain of this._chains) {
        for (const p of chain.particles) {
          p.lastFramePosition.set(p.position);
        }
      }
    }

    this.updateFixedParticles();

    // Calculate global rotation parameters
    let rotationCenter: Nullable<Vector3> = null;
    let angularVelocity: Nullable<Vector3> = null;

    if (this._enableInertialForces && dt > 0.0001) {
      const result = this.calculateGlobalRotation(dt);
      rotationCenter = result.center;
      angularVelocity = result.omega;
    }

    for (const chain of this._chains) {
      for (const particle of chain.particles) {
        if (particle.fixed) {
          continue;
        }

        const velocity = Vector3.sub(particle.position, particle.prevPosition, new Vector3());
        velocity.scaleBy(particle.damping);

        const acceleration = Vector3.add(this._gravity, this._wind, new Vector3());

        // Apply inertial forces
        if (this._enableInertialForces && rotationCenter && angularVelocity) {
          const inertialAccel = this.calculateInertialAcceleration(
            particle,
            rotationCenter,
            angularVelocity,
            velocity,
            this._centrifugalScale,
            this._coriolisScale
          );
          Vector3.add(acceleration, inertialAccel, acceleration);
        }

        const positionDelta = Vector3.scale(acceleration, dt * dt, new Vector3());
        Vector3.add(velocity, positionDelta, velocity);

        particle.prevPosition.set(particle.position);
        Vector3.add(particle.position, velocity, particle.position);
      }
    }

    if (this._solver === 'xpbd') {
      for (const chain of this._chains) {
        for (const c of chain.constraints) {
          c.lambda = 0;
        }
      }
      for (const c of this._interChainConstraints) {
        c.lambda = 0;
      }
    }
    for (let iter = 0; iter < this._iterations; iter++) {
      for (const chain of this._chains) {
        for (const constraint of chain.constraints) {
          if (this._solver === 'xpbd') {
            this.solveConstraintXPBD(chain, constraint, dt);
          } else {
            this.solveConstraint(chain, constraint);
          }
        }
      }

      for (const constraint of this._interChainConstraints) {
        if (this._solver === 'xpbd') {
          this.solveInterChainConstraintXPBD(constraint, dt);
        } else {
          this.solveInterChainConstraint(constraint);
        }
      }
      this.solvePosePreservation(this._iterations);
      this.solveCollisions();
    }
  }

  private updateFixedParticles(): void {
    for (const chain of this._chains) {
      for (const particle of chain.particles) {
        const sourceNode = particle.anchorNode ?? particle.node;
        if (sourceNode) {
          const worldPos = particle.anchorOffset
            ? sourceNode.worldMatrix.transformPointAffine(particle.anchorOffset)
            : new Vector3(sourceNode.worldMatrix.m03, sourceNode.worldMatrix.m13, sourceNode.worldMatrix.m23);
          particle.animPosition.set(worldPos);
          if (!particle.fixed) {
            continue;
          }
          particle.position.set(worldPos);
          particle.prevPosition.set(worldPos);

          // Maintain position history
          if (this._enableInertialForces) {
            if (!particle.positionHistory) {
              particle.positionHistory = [];
            }
            particle.positionHistory.push(worldPos.clone());
            if (particle.positionHistory.length > 5) {
              particle.positionHistory.shift();
            }
          }
        }
      }
    }
  }

  private solvePosePreservation(totalIterations: number): void {
    if (this._poseFollowRoot <= 0 && this._poseFollowTip <= 0) {
      return;
    }
    for (const chain of this._chains) {
      const lastIndex = Math.max(1, chain.particles.length - 1);
      for (let i = 0; i < chain.particles.length; i++) {
        const particle = chain.particles[i];
        if (particle.fixed) {
          continue;
        }
        const t = Math.pow(i / lastIndex, this._poseFollowExponent);
        const follow = this._poseFollowRoot + (this._poseFollowTip - this._poseFollowRoot) * t;
        const iterationFollow =
          totalIterations > 1 ? 1 - Math.pow(Math.max(0, 1 - follow), 1 / totalIterations) : follow;
        const correction = Vector3.scale(
          Vector3.sub(particle.animPosition, particle.position, new Vector3()),
          iterationFollow,
          new Vector3()
        );
        Vector3.add(particle.position, correction, particle.position);
        const maxOffset = this._maxPoseOffsetRoot + (this._maxPoseOffsetTip - this._maxPoseOffsetRoot) * t;
        if (maxOffset > 0) {
          const offset = Vector3.sub(particle.position, particle.animPosition, new Vector3());
          if (offset.magnitude > maxOffset) {
            offset.inplaceNormalize().scaleBy(maxOffset);
            Vector3.add(particle.animPosition, offset, particle.position);
          }
        }
      }
    }
  }

  private solveCollisions(): void {
    for (const collider of this._colliders) {
      if (collider.node) {
        updateColliderFromNode(collider);
      }
      if (!collider.enabled) {
        continue;
      }
      for (const chain of this._chains) {
        for (const particle of chain.particles) {
          if (particle.fixed) {
            continue;
          }
          const positionBeforeCollision = particle.position.clone();
          let collided: boolean;
          if (collider.type === 'sphere') {
            collided = resolveSphereCollision(particle.position, collider as SphereCollider);
          } else if (collider.type === 'capsule') {
            collided = resolveCapsuleCollision(particle.position, collider as CapsuleCollider);
          } else {
            collided = resolvePlaneCollision(particle.position, collider as PlaneCollider);
          }
          if (collided) {
            Vector3.add(
              particle.prevPosition,
              Vector3.sub(particle.position, positionBeforeCollision, new Vector3()),
              particle.prevPosition
            );
          }
        }
      }
    }
  }

  private calculateGlobalRotation(dt: number): { center: Vector3; omega: Vector3 } {
    const fixedParticles: any[] = [];
    const velocities: Vector3[] = [];

    for (const chain of this._chains) {
      for (const p of chain.particles) {
        if (!p.fixed) {
          continue;
        }

        const velocity = Vector3.sub(p.position, p.lastFramePosition, new Vector3());
        velocity.scaleBy(1.0 / dt);

        if (velocity.magnitudeSq > 0.001) {
          fixedParticles.push(p);
          velocities.push(velocity);
        }
      }
    }

    if (fixedParticles.length === 0) {
      return { center: new Vector3(0, 0, 0), omega: new Vector3(0, 0, 0) };
    }

    // Estimate rotation center
    let center: Vector3;

    if (fixedParticles.length === 1) {
      center = this.estimateRotationCenterFromHistory(fixedParticles[0], velocities[0]);
    } else {
      center = new Vector3(0, 0, 0);
      for (const p of fixedParticles) {
        Vector3.add(center, p.position, center);
      }
      center.scaleBy(1.0 / fixedParticles.length);
    }

    // Estimate angular velocity
    let sumOmega = new Vector3(0, 0, 0);
    let count = 0;

    for (let i = 0; i < fixedParticles.length; i++) {
      const r = Vector3.sub(fixedParticles[i].position, center, new Vector3());
      const v = velocities[i];
      const rLengthSq = r.magnitudeSq;

      if (rLengthSq > 0.0001) {
        const omega = Vector3.cross(r, v, new Vector3());
        omega.scaleBy(1.0 / rLengthSq);
        Vector3.add(sumOmega, omega, sumOmega);
        count++;
      }
    }

    if (count > 0) {
      sumOmega.scaleBy(1.0 / count);
    }

    return { center, omega: sumOmega };
  }

  private estimateRotationCenterFromHistory(particle: any, currentVelocity: Vector3): Vector3 {
    const history = particle.positionHistory;
    if (!history || history.length < 3) {
      const speed = currentVelocity.magnitude;
      if (speed < 0.001) {
        return particle.position.clone();
      }

      const estimatedRadius = Math.max(0.5, speed * 0.5);
      const up = new Vector3(0, 1, 0);
      const perpDir = Vector3.cross(currentVelocity, up, new Vector3());

      if (perpDir.magnitudeSq < 0.0001) {
        perpDir.set(new Vector3(1, 0, 0));
      } else {
        Vector3.normalize(perpDir, perpDir);
      }

      const center = Vector3.add(
        particle.position,
        Vector3.scale(perpDir, estimatedRadius, new Vector3()),
        new Vector3()
      );
      return center;
    }

    const p1 = history[0];
    const p2 = history[Math.floor(history.length / 2)];
    const p3 = history[history.length - 1];

    const center = this.calculateCircleCenter(p1, p2, p3);
    return center;
  }

  private calculateCircleCenter(p1: Vector3, p2: Vector3, p3: Vector3): Vector3 {
    const mid12 = Vector3.scale(Vector3.add(p1, p2, new Vector3()), 0.5, new Vector3());
    const mid23 = Vector3.scale(Vector3.add(p2, p3, new Vector3()), 0.5, new Vector3());

    const dir12 = Vector3.sub(p2, p1, new Vector3());
    const dir23 = Vector3.sub(p3, p2, new Vector3());

    const normal = Vector3.cross(dir12, dir23, new Vector3());

    if (normal.magnitudeSq < 0.0001) {
      return Vector3.scale(
        Vector3.add(Vector3.add(p1, p2, new Vector3()), p3, new Vector3()),
        1.0 / 3.0,
        new Vector3()
      );
    }

    Vector3.normalize(normal, normal);

    const perp12 = Vector3.cross(dir12, normal, new Vector3());
    Vector3.normalize(perp12, perp12);

    const perp23 = Vector3.cross(dir23, normal, new Vector3());
    Vector3.normalize(perp23, perp23);

    const diff = Vector3.sub(mid23, mid12, new Vector3());

    const det = perp12.x * perp23.y - perp12.y * perp23.x;

    if (Math.abs(det) > 0.0001) {
      const t = (diff.x * perp23.y - diff.y * perp23.x) / det;
      const center = Vector3.add(mid12, Vector3.scale(perp12, t, new Vector3()), new Vector3());
      return center;
    }

    return Vector3.scale(
      Vector3.add(Vector3.add(p1, p2, new Vector3()), p3, new Vector3()),
      1.0 / 3.0,
      new Vector3()
    );
  }

  private calculateInertialAcceleration(
    particle: any,
    rotationCenter: Vector3,
    angularVelocity: Vector3,
    particleVelocity: Vector3,
    centrifugalScale: number,
    coriolisScale: number
  ): Vector3 {
    const r = Vector3.sub(particle.position, rotationCenter, new Vector3());

    const omegaCrossR = Vector3.cross(angularVelocity, r, new Vector3());
    const centrifugalAccel = Vector3.cross(angularVelocity, omegaCrossR, new Vector3());
    centrifugalAccel.scaleBy(centrifugalScale);

    const coriolisAccel = Vector3.cross(angularVelocity, particleVelocity, new Vector3());
    coriolisAccel.scaleBy(-2.0 * coriolisScale);

    const totalAccel = Vector3.add(centrifugalAccel, coriolisAccel, new Vector3());
    return totalAccel;
  }

  private solveConstraint(chain: SpringChain, constraint: SpringConstraint): void {
    const pA = chain.particles[constraint.particleA];
    const pB = chain.particles[constraint.particleB];

    const delta = Vector3.sub(pB.position, pA.position, new Vector3());
    const currentLength = delta.magnitude;

    if (currentLength < 0.0001) {
      return;
    }

    const diff = (currentLength - constraint.restLength) / currentLength;
    const correction = Vector3.scale(delta, diff * constraint.stiffness * 0.5, new Vector3());

    if (!pA.fixed) {
      Vector3.add(pA.position, correction, pA.position);
    }
    if (!pB.fixed) {
      Vector3.sub(pB.position, correction, pB.position);
    }
  }

  private solveInterChainConstraint(constraint: InterChainConstraint): void {
    const chainA = this._chains[constraint.chainAIndex];
    const chainB = this._chains[constraint.chainBIndex];
    const pA = chainA.particles[constraint.particleAIndex];
    const pB = chainB.particles[constraint.particleBIndex];

    const delta = Vector3.sub(pB.position, pA.position, new Vector3());
    const currentLength = delta.magnitude;

    if (currentLength < 0.0001) {
      return;
    }

    const diff = (currentLength - constraint.restLength) / currentLength;
    const correction = Vector3.scale(delta, diff * constraint.stiffness * 0.5, new Vector3());

    if (!pA.fixed) {
      Vector3.add(pA.position, correction, pA.position);
    }
    if (!pB.fixed) {
      Vector3.sub(pB.position, correction, pB.position);
    }
  }

  private solveConstraintXPBD(chain: SpringChain, constraint: SpringConstraint, dt: number): void {
    const pA = chain.particles[constraint.particleA];
    const pB = chain.particles[constraint.particleB];

    const wA = pA.fixed ? 0 : 1.0 / pA.mass;
    const wB = pB.fixed ? 0 : 1.0 / pB.mass;
    const wSum = wA + wB;
    if (wSum < 1e-10) {
      return;
    }

    const delta = Vector3.sub(pB.position, pA.position, new Vector3());
    const currentLength = delta.magnitude;
    if (currentLength < 0.0001) {
      return;
    }

    const C = currentLength - constraint.restLength;
    const alphaTilde = constraint.compliance / (dt * dt);
    const deltaLambda = (-C - alphaTilde * constraint.lambda) / (wSum + alphaTilde);
    constraint.lambda += deltaLambda;

    const n = Vector3.scale(delta, 1.0 / currentLength, new Vector3());
    if (!pA.fixed) {
      Vector3.add(pA.position, Vector3.scale(n, -wA * deltaLambda, new Vector3()), pA.position);
    }
    if (!pB.fixed) {
      Vector3.add(pB.position, Vector3.scale(n, wB * deltaLambda, new Vector3()), pB.position);
    }
  }

  private solveInterChainConstraintXPBD(constraint: InterChainConstraint, dt: number): void {
    const chainA = this._chains[constraint.chainAIndex];
    const chainB = this._chains[constraint.chainBIndex];
    const pA = chainA.particles[constraint.particleAIndex];
    const pB = chainB.particles[constraint.particleBIndex];

    const wA = pA.fixed ? 0 : 1.0 / pA.mass;
    const wB = pB.fixed ? 0 : 1.0 / pB.mass;
    const wSum = wA + wB;
    if (wSum < 1e-10) {
      return;
    }

    const delta = Vector3.sub(pB.position, pA.position, new Vector3());
    const currentLength = delta.magnitude;
    if (currentLength < 0.0001) {
      return;
    }

    const C = currentLength - constraint.restLength;
    const alphaTilde = constraint.compliance / (dt * dt);
    const deltaLambda = (-C - alphaTilde * constraint.lambda) / (wSum + alphaTilde);
    constraint.lambda += deltaLambda;

    const n = Vector3.scale(delta, 1.0 / currentLength, new Vector3());
    if (!pA.fixed) {
      Vector3.add(pA.position, Vector3.scale(n, -wA * deltaLambda, new Vector3()), pA.position);
    }
    if (!pB.fixed) {
      Vector3.add(pB.position, Vector3.scale(n, wB * deltaLambda, new Vector3()), pB.position);
    }
  }

  /**
   * Applies simulation results to scene nodes
   * @param weight - Blend weight [0-1] (default: 1.0)
   */
  applyToNodes(weight: number = 1.0): void {
    for (const chain of this._chains) {
      this.applyChainToNodes(chain, weight);
    }
  }

  private applyChainToNodes(chain: SpringChain, weight: number): void {
    for (let i = 0; i < chain.particles.length - 1; i++) {
      const particle = chain.particles[i];
      const nextParticle = chain.particles[i + 1];

      if (!particle.node) {
        continue;
      }

      // Get current bone direction from node's world matrix (before physics)
      const currentBonePos = new Vector3(
        particle.node.worldMatrix.m03,
        particle.node.worldMatrix.m13,
        particle.node.worldMatrix.m23
      );

      const nextNode = nextParticle.node;
      if (!nextNode) {
        continue;
      }

      const nextBonePos = new Vector3(
        nextNode.worldMatrix.m03,
        nextNode.worldMatrix.m13,
        nextNode.worldMatrix.m23
      );
      const originalDir = Vector3.sub(nextBonePos, currentBonePos, new Vector3());

      // Get current bone rotation from node's world matrix
      const currentBoneRotation = new Quaternion();
      particle.node.worldMatrix.decompose(null, currentBoneRotation, null);

      // Calculate new direction from physics simulation
      const newDir = Vector3.sub(nextParticle.position, particle.position, new Vector3());

      const deltaRotation = new Quaternion();
      IKUtils.fromToRotation(originalDir, newDir, deltaRotation);

      let worldRotation = Quaternion.multiply(deltaRotation, currentBoneRotation, new Quaternion());

      if (weight < 1) {
        Quaternion.slerp(currentBoneRotation, worldRotation, weight, worldRotation);
      }

      const parent = particle.node.parent;
      const inputRotation = particle.node.rotation.clone();
      if (parent) {
        const parentWorldRotation = new Quaternion();
        parent.worldMatrix.decompose(null, parentWorldRotation, null);
        const parentInvRotation = Quaternion.conjugate(parentWorldRotation, new Quaternion());
        const localRotation = Quaternion.multiply(parentInvRotation, worldRotation, new Quaternion());
        particle.node.rotation = localRotation;
        this._nodePoseTracker.recordAppliedRotation(particle.node, inputRotation, localRotation);
      } else {
        particle.node.rotation = worldRotation;
        this._nodePoseTracker.recordAppliedRotation(particle.node, inputRotation, worldRotation);
      }
    }
  }

  /**
   * Resets the simulation to initial state
   */
  reset(): void {
    this._nodePoseTracker.clear(true);
    for (const chain of this._chains) {
      chain.reset();
      for (const particle of chain.particles) {
        particle.animPosition.set(particle.originalPosition);
        particle.lastFramePosition.set(particle.originalPosition);
        if (particle.positionHistory) {
          particle.positionHistory.length = 0;
        }
      }
    }
    for (const constraint of this._interChainConstraints) {
      constraint.lambda = 0;
    }
  }

  /**
   * Gets the spring chains
   */
  get chains(): SpringChain[] {
    return this._chains;
  }

  /**
   * Gets the inter-chain constraints
   */
  get interChainConstraints(): InterChainConstraint[] {
    return this._interChainConstraints;
  }

  /**
   * Gets the current gravity
   */
  get gravity(): Vector3 {
    return this._gravity;
  }

  set gravity(gravity: Vector3) {
    this._gravity.set(gravity);
  }

  /**
   * Gets the current wind
   */
  get wind(): Vector3 {
    return this._wind;
  }

  set wind(wind: Vector3) {
    this._wind.set(wind);
  }

  /**
   * Gets the number of iterations
   */
  get iterations(): number {
    return this._iterations;
  }

  set iterations(count: number) {
    this._iterations = Math.max(1, count);
  }

  /**
   * Gets whether inertial forces are enabled
   */
  get enableInertialForces(): boolean {
    return this._enableInertialForces;
  }

  set enableInertialForces(enabled: boolean) {
    this._enableInertialForces = enabled;
  }

  /**
   * Gets the centrifugal force scale
   */
  get centrifugalScale(): number {
    return this._centrifugalScale;
  }

  set centrifugalScale(scale: number) {
    this._centrifugalScale = Math.max(0, scale);
  }

  /**
   * Gets the Coriolis force scale
   */
  get coriolisScale(): number {
    return this._coriolisScale;
  }

  set coriolisScale(scale: number) {
    this._coriolisScale = Math.max(0, scale);
  }

  get solver(): 'verlet' | 'xpbd' {
    return this._solver;
  }

  set solver(type: 'verlet' | 'xpbd') {
    if (this._solver !== type) {
      this._solver = type;
      if (type === 'xpbd') {
        for (const chain of this._chains) {
          for (const c of chain.constraints) {
            c.lambda = 0;
          }
        }
        for (const c of this._interChainConstraints) {
          c.lambda = 0;
        }
      }
    }
  }

  get poseFollow(): number {
    return this._poseFollow;
  }

  set poseFollow(value: number) {
    const normalized = Math.max(0, Math.min(1, value));
    this._poseFollow = normalized;
    this._poseFollowRoot = normalized;
    this._poseFollowTip = normalized;
  }

  get poseFollowRoot(): number {
    return this._poseFollowRoot;
  }

  set poseFollowRoot(value: number) {
    this._poseFollowRoot = Math.max(0, Math.min(1, value));
  }

  get poseFollowTip(): number {
    return this._poseFollowTip;
  }

  set poseFollowTip(value: number) {
    this._poseFollowTip = Math.max(0, Math.min(1, value));
  }

  get poseFollowExponent(): number {
    return this._poseFollowExponent;
  }

  set poseFollowExponent(value: number) {
    this._poseFollowExponent = Math.max(0.1, value);
  }

  get maxPoseOffset(): number {
    return this._maxPoseOffset;
  }

  set maxPoseOffset(value: number) {
    const normalized = Math.max(0, value);
    this._maxPoseOffset = normalized;
    this._maxPoseOffsetRoot = normalized;
    this._maxPoseOffsetTip = normalized;
  }

  get maxPoseOffsetRoot(): number {
    return this._maxPoseOffsetRoot;
  }

  set maxPoseOffsetRoot(value: number) {
    this._maxPoseOffsetRoot = Math.max(0, value);
  }

  get maxPoseOffsetTip(): number {
    return this._maxPoseOffsetTip;
  }

  set maxPoseOffsetTip(value: number) {
    this._maxPoseOffsetTip = Math.max(0, value);
  }

  addCollider(collider: SpringCollider): void {
    this._colliders.push(collider);
  }

  removeCollider(collider: SpringCollider): boolean {
    const index = this._colliders.indexOf(collider);
    if (index < 0) {
      return false;
    }
    this._colliders.splice(index, 1);
    return true;
  }

  clearColliders(): void {
    this._colliders.length = 0;
  }

  get colliders(): SpringCollider[] {
    return this._colliders;
  }
}
