import type { Immutable, Nullable, Vector4 } from '@zephyr3d/base';
import { WebGPURenderPass } from './renderpass_webgpu';
import { WebGPUComputePass } from './computepass_webgpu';
import type { PrimitiveType, DeviceViewport, VertexBufferInfo } from '@zephyr3d/device';
import { PBPrimitiveType, PBPrimitiveTypeInfo } from '@zephyr3d/device';
import type { WebGPUDevice } from './device';
import type { WebGPUProgram } from './gpuprogram_webgpu';
import type { WebGPUVertexLayout } from './vertexlayout_webgpu';
import type { WebGPURenderStateSet } from './renderstates_webgpu';
import type { WebGPUBindGroup } from './bindgroup_webgpu';
import type { WebGPUFrameBuffer } from './framebuffer_webgpu';
import type { WebGPUBuffer } from './buffer_webgpu';
import type { WebGPUBaseTexture } from './basetexture_webgpu';
import type { WebGPUIndexBuffer } from './indexbuffer_webgpu';
import { WebGPUMipmapGenerator } from './utils_webgpu';

type BufferRange = {
  offset: number;
  size: number;
};

type LogicalSegment = {
  uploadEncoder: Nullable<GPUCommandEncoder>;
  bodyEncoder: Nullable<GPUCommandEncoder>;
  hasUploadCommands: boolean;
  hasBodyCommands: boolean;
  hasOpaqueCommands: boolean;
  uploadedBuffers: Map<WebGPUBuffer, BufferRange[]>;
  consumedBuffers: Map<WebGPUBuffer, BufferRange[]>;
  consumedTextures: Set<WebGPUBaseTexture>;
  buffersWithPendingUploads: WebGPUBuffer[];
  texturesWithPendingUploads: WebGPUBaseTexture[];
};

function overlapsRange(aOffset: number, aSize: number, bOffset: number, bSize: number) {
  return aOffset < bOffset + bSize && aOffset + aSize > bOffset;
}

const typeU16 = PBPrimitiveTypeInfo.getCachedTypeInfo(PBPrimitiveType.U16);

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
    segment.hasOpaqueCommands = true;
    this.recordFramebufferUsage(segment);
  }
  bufferUpload(buffer: WebGPUBuffer, offset: number, size: number) {
    const segment = this.getSegmentForBufferUpload(buffer, offset, size);
    this.recordRange(segment.uploadedBuffers, buffer, offset, size);
    if (segment.buffersWithPendingUploads.indexOf(buffer) < 0) {
      segment.buffersWithPendingUploads.push(buffer);
    }
  }
  textureUpload(tex: WebGPUBaseTexture) {
    const segment = this.getSegmentForTextureUpload(tex);
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
    this.recordBufferConsumption(segment, srcBuffer, srcOffset, bytes);
    this.recordBufferConsumption(segment, dstBuffer, dstOffset, bytes);
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
    segment.hasOpaqueCommands = true;
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
    this.recordBindGroupUsage(segment, bindGroups);
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
    this.recordDrawUsage(segment, program, vertexData, bindGroups, first, count, numInstances);
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
    this.recordFramebufferUsage(segment);
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
      hasOpaqueCommands: false,
      uploadedBuffers: new Map(),
      consumedBuffers: new Map(),
      consumedTextures: new Set(),
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
  private recordRange(
    map: Map<WebGPUBuffer, BufferRange[]>,
    buffer: WebGPUBuffer,
    offset: number,
    size: number
  ) {
    if (size <= 0) {
      return;
    }
    const ranges = map.get(buffer) ?? [];
    let start = offset;
    let end = offset + size;
    for (let i = ranges.length - 1; i >= 0; i--) {
      const range = ranges[i];
      if (overlapsRange(start, end - start, range.offset, range.size)) {
        start = Math.min(start, range.offset);
        end = Math.max(end, range.offset + range.size);
        ranges.splice(i, 1);
      }
    }
    ranges.push({ offset: start, size: end - start });
    ranges.sort((a, b) => a.offset - b.offset);
    map.set(buffer, ranges);
  }
  private hasConsumedBufferOverlap(
    segment: LogicalSegment,
    buffer: WebGPUBuffer,
    offset: number,
    size: number
  ) {
    if (segment.hasOpaqueCommands) {
      return true;
    }
    const ranges = segment.consumedBuffers.get(buffer);
    return !!ranges?.some((range) => overlapsRange(offset, size, range.offset, range.size));
  }
  private findUploadedBufferRange(segment: LogicalSegment, buffer: WebGPUBuffer, offset: number) {
    const ranges = segment.uploadedBuffers.get(buffer);
    return ranges?.find((range) => offset >= range.offset && offset < range.offset + range.size) ?? null;
  }
  private recordBufferConsumption(
    segment: LogicalSegment,
    buffer: Nullable<WebGPUBuffer>,
    offset: number,
    size: number
  ) {
    if (buffer && size > 0) {
      this.recordRange(segment.consumedBuffers, buffer, offset, size);
    }
  }
  private recordTextureConsumption(segment: LogicalSegment, texture: Nullable<WebGPUBaseTexture>) {
    if (texture) {
      segment.consumedTextures.add(texture);
    }
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
  private getSegmentForBufferUpload(buffer: WebGPUBuffer, offset: number, size: number) {
    let segment = this.getOrCreateCurrentSegment();
    if (segment.hasBodyCommands && this.hasConsumedBufferOverlap(segment, buffer, offset, size)) {
      this.endAllBodyPasses();
      this.finalizeCurrentSegmentUploads();
      segment = this.createSegment();
    }
    return segment;
  }
  private getSegmentForTextureUpload(texture: WebGPUBaseTexture) {
    let segment = this.getOrCreateCurrentSegment();
    if (segment.hasBodyCommands && (segment.hasOpaqueCommands || segment.consumedTextures.has(texture))) {
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
  private recordFramebufferUsage(segment: LogicalSegment) {
    const frameBuffer = this._renderPass.getFrameBufferInfo().frameBuffer;
    if (!frameBuffer) {
      return;
    }
    for (const attachment of frameBuffer.getColorAttachments()) {
      this.recordTextureConsumption(segment, attachment as WebGPUBaseTexture);
    }
    this.recordTextureConsumption(segment, frameBuffer.getDepthAttachment() as WebGPUBaseTexture);
  }
  private recordBindGroupUsage(segment: LogicalSegment, bindGroups: WebGPUBindGroup[]) {
    for (const bindGroup of bindGroups) {
      if (!bindGroup) {
        continue;
      }
      for (const binding of bindGroup.getBufferBindings()) {
        this.recordBufferConsumption(segment, binding.buffer, binding.offset, binding.size);
      }
      for (const texture of bindGroup.getTextureBindings()) {
        this.recordTextureConsumption(segment, texture);
      }
    }
  }
  private recordVertexBufferUsage(
    segment: LogicalSegment,
    vertexBuffer: VertexBufferInfo,
    first: number,
    count: number,
    numInstances: number,
    indexed: boolean
  ) {
    const buffer = vertexBuffer.buffer as unknown as WebGPUBuffer;
    if (indexed) {
      const uploadedRange = this.findUploadedBufferRange(segment, buffer, vertexBuffer.drawOffset);
      if (uploadedRange) {
        this.recordBufferConsumption(
          segment,
          buffer,
          vertexBuffer.drawOffset,
          uploadedRange.offset + uploadedRange.size - vertexBuffer.drawOffset
        );
      } else {
        this.recordBufferConsumption(segment, buffer, 0, buffer.byteLength);
      }
      return;
    }
    const itemCount = vertexBuffer.stepMode === 'instance' ? numInstances : count;
    this.recordBufferConsumption(
      segment,
      buffer,
      vertexBuffer.drawOffset + first * vertexBuffer.stride,
      itemCount * vertexBuffer.stride
    );
  }
  private recordIndexBufferUsage(
    segment: LogicalSegment,
    indexBuffer: Nullable<WebGPUIndexBuffer>,
    first: number,
    count: number
  ) {
    if (!indexBuffer) {
      return;
    }
    const indexSize = indexBuffer.indexType === typeU16 ? 2 : 4;
    this.recordBufferConsumption(
      segment,
      indexBuffer as unknown as WebGPUBuffer,
      first * indexSize,
      count * indexSize
    );
  }
  private recordDrawUsage(
    segment: LogicalSegment,
    program: WebGPUProgram,
    vertexData: Nullable<WebGPUVertexLayout>,
    bindGroups: WebGPUBindGroup[],
    first: number,
    count: number,
    numInstances: number
  ) {
    this.recordBindGroupUsage(segment, bindGroups);
    this.recordFramebufferUsage(segment);
    if (!vertexData) {
      return;
    }
    const layouts = program.vertexAttributes
      ? vertexData.getLayouts(program.vertexAttributes)?.buffers
      : null;
    const indexBuffer = vertexData.getIndexBuffer() as Nullable<WebGPUIndexBuffer>;
    const indexed = !!indexBuffer;
    layouts?.forEach((vertexBuffer) => {
      this.recordVertexBufferUsage(segment, vertexBuffer, first, count, numInstances, indexed);
    });
    this.recordIndexBufferUsage(segment, indexBuffer, first, count);
  }
}
