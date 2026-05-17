export class SFNTReader {
  private readonly _view: DataView;
  constructor(
    private readonly _buffer: ArrayBuffer,
    private readonly _byteOffset = 0
  ) {
    this._view = new DataView(_buffer);
  }
  get buffer() {
    return this._buffer;
  }
  uint8(offset: number) {
    return this._view.getUint8(this._byteOffset + offset);
  }
  int8(offset: number) {
    return this._view.getInt8(this._byteOffset + offset);
  }
  uint16(offset: number) {
    return this._view.getUint16(this._byteOffset + offset, false);
  }
  int16(offset: number) {
    return this._view.getInt16(this._byteOffset + offset, false);
  }
  uint32(offset: number) {
    return this._view.getUint32(this._byteOffset + offset, false);
  }
  int32(offset: number) {
    return this._view.getInt32(this._byteOffset + offset, false);
  }
  fixed(offset: number) {
    return this.int32(offset) / 65536;
  }
  tag(offset: number) {
    return String.fromCharCode(
      this.uint8(offset),
      this.uint8(offset + 1),
      this.uint8(offset + 2),
      this.uint8(offset + 3)
    );
  }
  slice(offset: number, length: number) {
    return new DataView(this._buffer, this._byteOffset + offset, length);
  }
}
