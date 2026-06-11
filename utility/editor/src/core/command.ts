export abstract class Command<T = void> {
  protected _desc: string;
  constructor(desc?: string) {
    this._desc = desc ?? '';
  }
  getDesc() {
    return this._desc;
  }
  setDesc(desc: string): this {
    this._desc = desc;
    return this;
  }
  abstract execute(): Promise<T>;
  abstract undo(): Promise<void>;
}

export class CommandManager {
  private _undoStack: Command<any>[];
  private _current: number;
  private _pending: Promise<void>;
  constructor() {
    this._undoStack = [];
    this._current = 0;
    this._pending = Promise.resolve();
  }
  clear() {
    this._undoStack = [];
    this._current = 0;
    this._pending = Promise.resolve();
  }
  async execute<T>(command: Command<T>): Promise<T> {
    return this.enqueue(async () => {
      const result = await command.execute();
      this._undoStack.splice(this._current);
      this._undoStack.push(command);
      this._current++;
      return result;
    });
  }
  getUndoCommand(): Command {
    return this._current > 0 ? this._undoStack[this._current - 1] : null;
  }
  getRedoCommand(): Command {
    return this._current < this._undoStack.length ? this._undoStack[this._current] : null;
  }
  async undo() {
    return this.enqueue(async () => {
      if (this._current <= 0) {
        return;
      }
      await this._undoStack[--this._current].undo();
    });
  }
  async redo() {
    return this.enqueue(async () => {
      if (this._current >= this._undoStack.length) {
        return;
      }
      await this._undoStack[this._current++].execute();
    });
  }
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    let run: Promise<T> | null = null;
    const next = this._pending.then(() => {
      run = task();
      return run.then(
        () => undefined,
        () => undefined
      );
    });
    this._pending = next;
    return next.then(() => run!);
  }
}

export class CompositeCommand extends Command<any[]> {
  private readonly _commands: Command<any>[];
  constructor(desc: string, commands: Command<any>[]) {
    super(desc);
    this._commands = commands;
  }
  get commands() {
    return this._commands;
  }
  async execute(): Promise<any[]> {
    const result: any[] = [];
    for (const command of this._commands) {
      result.push(await command.execute());
    }
    return result;
  }
  async undo(): Promise<void> {
    for (let i = this._commands.length - 1; i >= 0; i--) {
      await this._commands[i].undo();
    }
  }
}
