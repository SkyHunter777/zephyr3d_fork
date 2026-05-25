import { NullVFS } from '@zephyr3d/base';
import { SharedModel } from '@zephyr3d/scene';
import { GLTFImporter } from '../../../libs/loaders/src/gltf/gltf_importer';
import type { GLTFContent } from '../../../libs/loaders/src/gltf/gltf_importer';

describe('GLTFImporter VRM SpringBone', () => {
  test('deduplicates equivalent JointDynamics colliders and flat planes', async () => {
    const gltf = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      scene: 0,
      nodes: [
        { name: 'root', children: [1] },
        { name: 'tail' }
      ],
      extensions: {
        VRMC_springBone: {
          colliders: [
            {
              node: 0,
              shape: {
                sphere: {
                  offset: [0, 1, 0],
                  radius: 0.5
                }
              }
            },
            {
              node: 0,
              shape: {
                sphere: {
                  offset: [0, 1, 0],
                  radius: 0.5
                }
              }
            },
            {
              node: 0,
              extensions: {
                VRMC_springBone_extended_collider: {
                  shape: {
                    plane: {
                      offset: [0, 0, 0],
                      normal: [0, 1, 0]
                    }
                  }
                }
              }
            },
            {
              node: 0,
              extensions: {
                VRMC_springBone_extended_collider: {
                  shape: {
                    plane: {
                      offset: [0, 0, 0],
                      normal: [0, 1, 0]
                    }
                  }
                }
              }
            }
          ],
          colliderGroups: [
            { colliders: [0, 1, 2, 3] },
            { colliders: [0, 2] }
          ],
          joints: [
            {
              node: 0,
              hitRadius: 0.1,
              stiffness: 1,
              gravityPower: 1,
              gravityDir: [0, -1, 0],
              dragForce: 0.5
            },
            {
              node: 1,
              hitRadius: 0.1,
              stiffness: 1,
              gravityPower: 1,
              gravityDir: [0, -1, 0],
              dragForce: 0.5
            }
          ],
          springs: [
            {
              joints: [0, 1],
              colliderGroups: [0, 1]
            }
          ]
        }
      }
    } as GLTFContent;

    const model = new SharedModel();

    await new GLTFImporter().loadJson(gltf, model, '', new NullVFS());

    expect(model.springBoneColliders).toHaveLength(4);
    expect(model.jointDynamicsSpringBones).toHaveLength(1);
    expect(model.jointDynamicsSpringBones[0].colliders).toHaveLength(1);
    expect(model.jointDynamicsSpringBones[0].flatPlanes).toHaveLength(1);
  });

  test('maps VRM SpringBone physics parameters to stable per-substep JointDynamics values', async () => {
    const gltf = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      scene: 0,
      nodes: [
        { name: 'root', children: [1] },
        { name: 'tail' }
      ],
      extensions: {
        VRMC_springBone: {
          joints: [
            {
              node: 0,
              hitRadius: 0.1,
              stiffness: 1,
              gravityPower: 1,
              gravityDir: [0, -1, 0],
              dragForce: 0.5
            },
            {
              node: 1,
              hitRadius: 0.1,
              stiffness: 1,
              gravityPower: 1,
              gravityDir: [0, -1, 0],
              dragForce: 0.5
            }
          ],
          springs: [
            {
              joints: [0, 1]
            }
          ]
        }
      }
    } as GLTFContent;

    const model = new SharedModel();

    await new GLTFImporter().loadJson(gltf, model, '', new NullVFS());

    const config = model.jointDynamicsSpringBones[0].controllerConfig;

    expect(config.subSteps).toBe(3);
    expect(config.gravity!.x).toBeCloseTo(0);
    expect(config.gravity!.y).toBeCloseTo(-58.8);
    expect(config.gravity!.z).toBeCloseTo(0);
    expect(config.curves!.resistance!.evaluate(0)).toBeCloseTo(Math.pow(0.5, 1 / 3));
    expect(config.curves!.hardness!.evaluate(0)).toBeCloseTo(1 - Math.pow(0.88, 1 / 3));
    expect(config.curves!.pointRadius!.evaluate(0)).toBeCloseTo(0.1);
  });

  test('keeps base gravity when VRM SpringBone gravityPower is zero', async () => {
    const gltf = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      scene: 0,
      nodes: [
        { name: 'root', children: [1] },
        { name: 'tail' }
      ],
      extensions: {
        VRMC_springBone: {
          joints: [
            {
              node: 0,
              gravityPower: 0,
              dragForce: 0.5
            },
            {
              node: 1,
              gravityPower: 0,
              dragForce: 0.5
            }
          ],
          springs: [
            {
              joints: [0, 1]
            }
          ]
        }
      }
    } as GLTFContent;

    const model = new SharedModel();

    await new GLTFImporter().loadJson(gltf, model, '', new NullVFS());

    const gravity = model.jointDynamicsSpringBones[0].controllerConfig.gravity!;

    expect(gravity.x).toBeCloseTo(0);
    expect(gravity.y).toBeCloseTo(-29.4);
    expect(gravity.z).toBeCloseTo(0);
  });
});
