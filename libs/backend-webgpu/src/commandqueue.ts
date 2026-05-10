import type { Immutable, Nullable, Vector4 } from '@zephyr3d/base';
import { WebGPURenderPass } from './renderpass_webgpu';
import { WebGPUComputePass } from './computepass_webgpu';
import type { PrimitiveType, DeviceViewport } from '@zephyr3d/device';
import type { WebGPUDevice } from './device';
import type { WebGPUProgram } from './gpuprogram_webgpu';
import type { WebGPUVertexLayout } from './vertexlayout_webgpu';
import type { WebGPURenderStateSet } from './renderstates_webgpu';
import type { WebGPUBindGroup } from './bindgroup_webgpu';
import type { WebGPUFrameBuffer } from './framebuffer_webgpu';
import type { WebGPUBuffer } from './buffer_webgpu';
import type { WebGPUBaseTexture } from './basetexture_webgpu';
import { WebGPUMipmapGenerator } from './utils_webgpu';

type LogicalSegment = {
  uploadEncoder: Nullable<GPUCommandEncoder>;
  bodyEncoder: Nullable<GPUCommandEncoder>;
  hasUploadCommands: boolean;
  hasBodyCommands: boolean;
  buffersWithPendingUploads: WebGPUBuffer[];
  texturesWithPendingUploads: WebGPUBaseTexture[];
};

export class CommandQueueImmediate {
  protected _renderPass: WebGPURenderPass;
  protected _computePass: WebGPUComputePass;
  private _segments: LogicalSegment[];
  private _buffersAwaitingSyncEnd: WebGPUBuffer[];
  private _texturesAwaitingSyncEnd: WebGPUBaseTexture[];
  private readonly _device: WebGPUDevice;
  private _drawcallCounter: number;
  constructor(device: WebGPUDevice) {
    this._device = device;
    this._segments = [];
    this._buffersAwaitingSyncEnd = [];
    this._texturesAwaitingSyncEnd = [];
    this._renderPass = new WebGPURenderPass(device);
    this._computePass = new WebGPUComputePass(device);
    this._drawcallCounter = 0;
  }
  isBufferUploading(_buffer: WebGPUBuffer) {
    return false;
  }
  isTextureUploading(_tex: WebGPUBaseTexture) {
    return false;
  }
  hasActiveWork() {
    return (
      this._segments.length > 0 ||
      this._renderPass.active ||
      this._computePass.active ||
      this._drawcallCounter > 0
    );
  }
  getDrawcallCounter() {
    return this._drawcallCounter;
  }
  getEncoder() {
    const segment = this.getOrCreateCurrentSegment();
    segment.hasBodyCommands = true;
    if (!segment.bodyEncoder) {
      segment.bodyEncoder = this._device.device.createCommandEncoder();
    }
    return segment.bodyEncoder;
  }
  flushUploads() {
    this.finalizeCurrentSegmentUploads();
  }
  get currentPass(): Nullable<WebGPURenderPass | WebGPUComputePass> {
    return this._renderPass.active ? this._renderPass : this._computePass.active ? this._computePass : null;
  }
  beginFrame() {}
  endFrame() {
    this.submit();
  }
  flush() {
    this.submit();
  }
  setFramebuffer(fb: WebGPUFrameBuffer) {
    this._renderPass.setFramebuffer(fb);
  }
  getFramebuffer() {
    return this._renderPass.getFramebuffer();
  }
  getFramebufferInfo() {
    return this._renderPass.getFrameBufferInfo();
  }
  executeRenderBundle(renderBundle: GPURenderBundle) {
    this.ensureRenderBodyReady();
    this._drawcallCounter++;
    this._renderPass.executeRenderBundle(renderBundle);
    const segment = this.getOrCreateCurrentSegment();
    segment.hasBodyCommands = true;
  }
  bufferUpload(buffer: WebGPUBuffer, _offset: number, _size: number) {
    const segment = this.getSegmentForUpload();
    if (segment.buffersWithPendingUploads.indexOf(buffer) < 0) {
      segment.buffersWithPendingUploads.push(buffer);
    }
  }
  textureUpload(tex: WebGPUBaseTexture) {
    const segment = this.getSegmentForUpload();
    if (segment.texturesWithPendingUploads.indexOf(tex) < 0) {
      segment.texturesWithPendingUploads.push(tex);
    }
  }
  copyBuffer(
    srcBuffer: WebGPUBuffer,
    dstBuffer: WebGPUBuffer,
    srcOffset: number,
    dstOffset: number,
    bytes: number
  ) {
    this.endAllBodyPasses();
    const segment = this.getOrCreateCurrentSegment();
    segment.hasBodyCommands = true;
    const encoder = this.getEncoder();
    encoder.copyBufferToBuffer(srcBuffer.object!, srcOffset, dstBuffer.object!, dstOffset, bytes);
  }
  copyTexture(
    srcTexture: GPUTexture,
    dstTexture: GPUTexture,
    srcLevel: number,
    dstLevel: number,
    width: number,
    height: number,
    depthOrArrayLayers: number
  ) {
    this.endAllBodyPasses();
    const segment = this.getOrCreateCurrentSegment();
    segment.hasBodyCommands = true;
    const encoder = this.getEncoder();
    encoder.copyTextureToTexture(
      {
        texture: srcTexture,
        mipLevel: srcLevel,
        origin: { x: 0, y: 0, z: 0 }
      },
      {
        texture: dstTexture,
        mipLevel: dstLevel,
        origin: { x: 0, y: 0, z: 0 }
      },
      {
        width,
        height,
        depthOrArrayLayers
      }
    );
  }
  compute(
    program: WebGPUProgram,
    bindGroups: WebGPUBindGroup[],
    bindGroupOffsets: Nullable<Iterable<number>>[],
    workgroupCountX: number,
    workgroupCountY: number,
    workgroupCountZ: number
  ) {
    this._drawcallCounter++;
    this.ensureComputeBodyReady();
    this._computePass.compute(
      program,
      bindGroups,
      bindGroupOffsets,
      workgroupCountX,
      workgroupCountY,
      workgroupCountZ
    );
    const segment = this.getOrCreateCurrentSegment();
    segment.hasBodyCommands = true;
  }
  draw(
    program: WebGPUProgram,
    vertexData: Nullable<WebGPUVertexLayout>,
    stateSet: WebGPURenderStateSet,
    bindGroups: WebGPUBindGroup[],
    bindGroupOffsets: Nullable<Nullable<Iterable<number>>[]>,
    primitiveType: PrimitiveType,
    first: number,
    count: number,
    numInstances: number
  ) {
    this.ensureRenderBodyReady();
    this._drawcallCounter++;
    this._renderPass.draw(
      program,
      vertexData,
      stateSet,
      bindGroups,
      bindGroupOffsets,
      primitiveType,
      first,
      count,
      numInstances
    );
    const segment = this.getOrCreateCurrentSegment();
    segment.hasBodyCommands = true;
  }
  capture(
    renderBundleEncoder: GPURenderBundleEncoder,
    program: WebGPUProgram,
    vertexData: WebGPUVertexLayout,
    stateSet: WebGPURenderStateSet,
    bindGroups: WebGPUBindGroup[],
    bindGroupOffsets: Nullable<Iterable<number>>[],
    primitiveType: PrimitiveType,
    first: number,
    count: number,
    numInstances: number
  ) {
    this.ensureRenderBodyReady();
    this._renderPass.capture(
      renderBundleEncoder,
      program,
      vertexData,
      stateSet,
      bindGroups,
      bindGroupOffsets,
      primitiveType,
      first,
      count,
      numInstances
    );
  }
  setViewport(vp: Nullable<Immutable<number[] | DeviceViewport>>) {
    this._renderPass.setViewport(vp);
  }
  getViewport() {
    return this._renderPass.getViewport();
  }
  setScissor(scissor: Nullable<Immutable<number[] | DeviceViewport>>) {
    this._renderPass.setScissor(scissor);
  }
  getScissor() {
    return this._renderPass.getScissor();
  }
  clear(color: Nullable<Vector4>, depth: Nullable<number>, stencil: Nullable<number>) {
    this.ensureRenderBodyReady();
    this._renderPass.clear(color, depth, stencil);
    const segment = this.getOrCreateCurrentSegment();
    segment.hasBodyCommands = true;
  }
  finish() {
    this.submit();
    return this._device.device.queue.onSubmittedWorkDone();
  }
  private createSegment(): LogicalSegment {
    const segment: LogicalSegment = {
      uploadEncoder: null,
      bodyEncoder: null,
      hasUploadCommands: false,
      hasBodyCommands: false,
      buffersWithPendingUploads: [],
      texturesWithPendingUploads: []
    };
    this._segments.push(segment);
    return segment;
  }
  private getCurrentSegment() {
    return this._segments.length > 0 ? this._segments[this._segments.length - 1] : null;
  }
  private getOrCreateCurrentSegment() {
    return this.getCurrentSegment() ?? this.createSegment();
  }
  private getOrCreateUploadEncoder(segment: LogicalSegment) {
    if (!segment.uploadEncoder) {
      segment.uploadEncoder = this._device.device.createCommandEncoder();
    }
    return segment.uploadEncoder;
  }
  private ensureRenderBodyReady() {
    if (this._computePass.active) {
      this._computePass.end();
    }
  }
  private ensureComputeBodyReady() {
    if (this._renderPass.active) {
      this._renderPass.end();
    }
  }
  private endAllBodyPasses() {
    if (this._renderPass.active) {
      this._renderPass.end();
    }
    if (this._computePass.active) {
      this._computePass.end();
    }
  }
  private submit() {
    this.endAllBodyPasses();
    this.finalizeCurrentSegmentUploads();
    if (this._segments.length > 0) {
      const commandBuffers: GPUCommandBuffer[] = [];
      for (const segment of this._segments) {
        if (segment.uploadEncoder && segment.hasUploadCommands) {
          commandBuffers.push(segment.uploadEncoder.finish());
        }
        if (segment.bodyEncoder && segment.hasBodyCommands) {
          commandBuffers.push(segment.bodyEncoder.finish());
        }
      }
      if (commandBuffers.length > 0) {
        this._device.device.queue.submit(commandBuffers);
      }
    }
    for (const buffer of this._buffersAwaitingSyncEnd) {
      buffer.endSyncChanges();
    }
    this._buffersAwaitingSyncEnd.length = 0;
    for (const texture of this._texturesAwaitingSyncEnd) {
      texture.endSyncChanges();
    }
    this._texturesAwaitingSyncEnd.length = 0;
    this._segments.length = 0;
    this._drawcallCounter = 0;
  }
  private markBufferAwaitingSyncEnd(buffer: WebGPUBuffer) {
    if (this._buffersAwaitingSyncEnd.indexOf(buffer) < 0) {
      this._buffersAwaitingSyncEnd.push(buffer);
    }
  }
  private markTextureAwaitingSyncEnd(texture: WebGPUBaseTexture) {
    if (this._texturesAwaitingSyncEnd.indexOf(texture) < 0) {
      this._texturesAwaitingSyncEnd.push(texture);
    }
  }
  private getSegmentForUpload() {
    let segment = this.getOrCreateCurrentSegment();
    if (segment.hasBodyCommands) {
      this.endAllBodyPasses();
      this.finalizeCurrentSegmentUploads();
      segment = this.createSegment();
    }
    return segment;
  }
  private finalizeCurrentSegmentUploads() {
    const segment = this.getCurrentSegment();
    if (!segment) {
      return;
    }
    if (segment.buffersWithPendingUploads.length > 0) {
      const encoder = this.getOrCreateUploadEncoder(segment);
      for (const buffer of segment.buffersWithPendingUploads) {
        buffer.beginSyncChanges(encoder);
        segment.hasUploadCommands = true;
        this.markBufferAwaitingSyncEnd(buffer);
      }
      segment.buffersWithPendingUploads.length = 0;
    }
    if (segment.texturesWithPendingUploads.length > 0) {
      const encoder = this.getOrCreateUploadEncoder(segment);
      for (const texture of segment.texturesWithPendingUploads) {
        texture.beginSyncChanges(encoder);
        if (!texture.disposed && texture.isMipmapDirty()) {
          WebGPUMipmapGenerator.generateMipmap(this._device, texture, encoder);
        }
        segment.hasUploadCommands = true;
        this.markTextureAwaitingSyncEnd(texture);
      }
      segment.texturesWithPendingUploads.length = 0;
    }
  }
}
